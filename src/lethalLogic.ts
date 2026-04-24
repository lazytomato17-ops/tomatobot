// src/lethalLogic.ts
import { ChatInputCommandInteraction, ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

type EncounterType = 'bracken' | 'coilhead' | 'eyelessdog';

// ── 状態管理（HPと危険度を追加） ──
interface PlayerState {
    name: string;
    isAlive: boolean;
    hp: number; // 追加: 体力
    inventory: number;
    hasTwoHanded: boolean;
    items: { flashlight: boolean; shovel: boolean };
}

interface Corpse { userId: string; name: string; value: number; }

interface GameState {
    day: number;
    time: number;
    quota: number;
    funds: number;
    facilityDanger: number; // 追加: 施設の現在の危険度(0〜100)
    corpses: Corpse[];
    players: Map<string, PlayerState>;
    activeEncounter: { userId: string; type: EncounterType } | null;
}

const activeGames = new Map<string, GameState>();

// ── 敵・アイテム・ダメージ要因データ ──
const ENEMIES = {
    'bracken': { name: 'ブラッケン', correct: 'glance', desc: '暗闇に光る二つの白い目が見える…！' },
    'coilhead': { name: 'コイルヘッド', correct: 'stare', desc: 'バネの音がして、血まみれのマネキンが目の前に現れた！' },
    'eyelessdog': { name: 'アイレスドッグ', correct: 'sneak', desc: '巨大な犬のような化け物が、音に反応して徘徊している…！' }
};

const SCRAP_NAMES = [
    "V型エンジン", "誰かの左靴", "ラジカセ", "トマティー40Station", 
    "錆びた鉄パイプ", "壊れたパソコン", "謎の巨大な歯車", 
    "古びた金庫", "業務用の大きな車軸", "汚れたフラスコ", "真鍮のベル"
];

const DAMAGE_CAUSES = [
    "地雷の爆発に巻き込まれた💥",
    "タレットの銃撃をかすった🔫",
    "崩れた足場から転落した💀",
    "未知の罠に足を挟まれた🪤",
    "有毒なガスを吸い込んでしまった🌫️",
    "暗闇から何者かに鋭い爪で切り裂かれた🩸"
];

// ── AI描写ジェネレーター（表現力強化・血痕スパム防止） ──
async function generateDescription(eventType: string, context: string = "") {
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'あなたは宇宙のブラック企業の冷酷なシステムAIです。インダストリアル・ホラーの世界観で状況を報告してください。\n【厳守事項】\n・「血」や「血痕」という単語の多用を固く禁じます。代わりに「カビ、錆、軋む金属音、暗闇、異常な温度、謎の粘液、漏れ出す蒸気」など、毎回異なる多彩な表現を用いてください。\n・マニュアルのような説教や、箇条書き、記号（. や *）は絶対に使用しないでください。1〜2文の簡潔な日本語のみ出力してください。' 
                },
                { 
                    role: 'user', 
                    content: `発生イベント: ${eventType}\n詳細: ${context}` 
                }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.8, // ランダム性を少し上げて表現を散らす
            max_tokens: 100,
        });
        
        return chatCompletion.choices[0]?.message?.content?.trim() || "通信エラー。暗闇しか見えない。";
    } catch (e) {
        return "システムエラー。カメラのノイズが酷くて見えません。";
    }
}

function getGame(channelId: string): GameState {
    if (!activeGames.has(channelId)) {
        activeGames.set(channelId, { 
            day: 1, time: 8, quota: 500, funds: 0, 
            facilityDanger: Math.floor(Math.random() * 30) + 10, // 初期危険度
            corpses: [], players: new Map(), activeEncounter: null 
        });
    }
    return activeGames.get(channelId)!;
}

function getPlayer(game: GameState, user: any): PlayerState {
    if (!game.players.has(user.id)) {
        game.players.set(user.id, { name: user.username, isAlive: true, hp: 100, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false } });
    }
    return game.players.get(user.id)!;
}

function formatTime(t: number) { return `${t.toString().padStart(2, '0')}:00`; }

// ── UI構築（モニター監視追加） ──
function getMainRow(game: GameState) {
    const hasHeavy = Array.from(game.players.values()).some(p => p.hasTwoHanded && p.isAlive);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_explore').setLabel('探索(1h)').setStyle(ButtonStyle.Danger).setEmoji('🔦'),
        new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
        new ButtonBuilder().setCustomId('lethal_monitor').setLabel('モニター監視').setStyle(ButtonStyle.Primary).setEmoji('💻')
    );
    
    const row2 = new ActionRowBuilder<ButtonBuilder>();
    if (hasHeavy) row2.addComponents(new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️'));
    row2.addComponents(
        new ButtonBuilder().setCustomId('lethal_return').setLabel('帰還する').setStyle(ButtonStyle.Success).setEmoji('🚀'),
        new ButtonBuilder().setCustomId('lethal_store').setLabel('ストア').setStyle(ButtonStyle.Primary).setEmoji('🛒')
    );
    
    return [row, row2]; // ボタンが増えたので2行に分割
}

function getEncounterRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_qte_glance').setLabel('一瞬だけ見る').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_stare').setLabel('ガン見する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_sneak').setLabel('しゃがんで歩く').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_run').setLabel('走って逃げる').setStyle(ButtonStyle.Danger)
    );
}

function checkWipeout(game: GameState, channelId: string): EmbedBuilder | null {
    const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
    if (game.players.size > 0 && aliveCount === 0) {
        activeGames.delete(channelId);
        return new EmbedBuilder().setTitle('💀 全滅確認').setDescription('全従業員の生命反応が途絶えました。\n船の自動帰還シークエンスを開始します。\n\n**【THE COMPANY】**\n「君たちの代わりはいくらでもいる。」').setColor(0x000000);
    }
    return null;
}

// ============================================================
// コマンド処理群
// ============================================================

export async function handleMonitor(interaction: any) {
    await interaction.deferReply();
    const game = getGame(interaction.channelId);
    
    // 現在の危険度を言語化してGroqに描写させる
    let dangerLevelText = "安全";
    if (game.facilityDanger > 80) dangerLevelText = "極めて危険。複数の巨大な生体反応が接近中。";
    else if (game.facilityDanger > 50) dangerLevelText = "危険。未知の動体反応あり。";
    else if (game.facilityDanger > 30) dangerLevelText = "警戒。かすかなノイズを検知。";
    
    const desc = await generateDescription('Terminal Scan', `現在の施設内のスキャン結果: ${dangerLevelText}`);
    
    const embed = new EmbedBuilder()
        .setTitle('💻 モニター室からの通信')
        .setDescription(`**【レーダー解析結果】**\n${desc}`)
        .setColor(game.facilityDanger > 70 ? 0xFF0000 : 0x00FF00)
        .setFooter({ text: "※探索班にVCで状況を報告してください" });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleExplore(interaction: any) {
    const game = getGame(interaction.channelId);
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 現在、他の従業員が交戦中です！', ephemeral: true });
    
    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply({ content: '❌ **[警告]** 死亡した従業員は探索できません。' });
    if (game.time >= 24) return handleReturn(interaction, true);

    game.time += 1;
    // 時間経過とともに危険度がランダムに上昇
    game.facilityDanger = Math.min(100, game.facilityDanger + Math.floor(Math.random() * 15) + 5);

    let dangerRoll = game.facilityDanger;
    if (player.hasTwoHanded) dangerRoll += 15; 
    if (player.items.flashlight) dangerRoll = Math.max(0, dangerRoll - 20); // ライトで罠回避率UP

    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();
    let isEncounter = false;

    if (roll <= dangerRoll * 0.4) {
        // 罠によるダメージ（即死ではなくHP減少）
        const damage = Math.floor(Math.random() * 40) + 20; // 20〜60ダメージ
        player.hp -= damage;
        const cause = DAMAGE_CAUSES[Math.floor(Math.random() * DAMAGE_CAUSES.length)];
        
        if (player.hp <= 0) {
            player.isAlive = false;
            game.corpses.push({ userId: interaction.user.id, name: player.name, value: Math.floor(Math.random() * 50) + 50 });
            const desc = await generateDescription('Employee Death', `死因: ${cause}`);
            embed.setTitle('🔴 従業員ロスト').setDescription(`**${cause}**\n\n${desc}`).setColor(0xe74c3c);
            player.inventory = 0; player.hasTwoHanded = false;
        } else {
            const desc = await generateDescription('Trap Triggered', `負傷要因: ${cause}`);
            embed.setTitle('⚠️ 負傷・トラップ遭遇').setDescription(`**${cause} (-${damage} HP)**\n\n${desc}`).setColor(0xe67e22)
                 .addFields({ name: '残りHP', value: `${player.hp} / 100`, inline: true });
        }
        
    } else if (roll <= dangerRoll) {
        // 敵遭遇（即死QTE）
        isEncounter = true;
        const types: EncounterType[] = ['bracken', 'coilhead', 'eyelessdog'];
        const enemyType = types[Math.floor(Math.random() * types.length)];
        game.activeEncounter = { userId: interaction.user.id, type: enemyType };
        
        embed.setTitle(`🚨 未知の生物に遭遇：${player.name}`).setDescription(`${ENEMIES[enemyType].desc}\n\n**直ちに対処行動を選択してください。**`).setColor(0x8B0000);
        
    } else {
        // スクラップ発見
        const isHeavy = Math.random() < 0.2; 
        const multiplier = game.time >= 17 ? 1.5 : 1.0; 
        const val = Math.floor((Math.random() * (isHeavy ? 150 : 80) + 20) * multiplier);
        const scrapName = SCRAP_NAMES[Math.floor(Math.random() * SCRAP_NAMES.length)];
        
        player.inventory += val;
        if (isHeavy) player.hasTwoHanded = true;

        const desc = await generateDescription('Scrap Found', `拾ったアイテム: ${scrapName}`);
        
        embed.setTitle('🟢 資産回収')
             .setDescription(`**【 ${scrapName} 】を発見した！**\n\n${desc}`)
             .setColor(0x2ecc71)
             .addFields(
                 { name: '所持スクラップ', value: `${player.inventory}円`, inline: true },
                 { name: '状態', value: player.hasTwoHanded ? '⚠️ 両手塞がり' : '身軽', inline: true },
                 { name: 'HP', value: `${player.hp} / 100`, inline: true }
             );
    }

    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) {
        await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    } else {
        embed.setFooter({ text: `現在時刻: ${formatTime(game.time)} | 残りノルマ: ${game.quota}円` });
        await interaction.editReply({ embeds: [embed], components: isEncounter ? [getEncounterRow()] : getMainRow(game) });
    }
}

export async function handleQTE(interaction: any, action: string) {
    const game = getGame(interaction.channelId);
    if (!game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中の敵はいません。', ephemeral: true });
    if (game.activeEncounter.userId !== interaction.user.id) return interaction.reply({ content: '❌ お前じゃない！交戦中の従業員に任せろ！', ephemeral: true });

    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);
    const enemy = ENEMIES[game.activeEncounter.type];
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (action === enemy.correct) {
        embed.setTitle('🟢 危機回避').setDescription(await generateDescription('Escaped Monster', `${enemy.name}から逃げ切った。`)).setColor(0x2ecc71);
    } else {
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: 50 });
        embed.setTitle('🔴 従業員惨殺').setDescription(await generateDescription('Gruesome Death', `${enemy.name}に引き裂かれた。`)).setColor(0xe74c3c);
        player.inventory = 0; player.hasTwoHanded = false;
    }

    game.activeEncounter = null; 
    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    else await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
}

export async function handleRetrieve(interaction: any) {
    const game = getGame(interaction.channelId);
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中です！', ephemeral: true });
    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply({ content: '❌ 幽霊が死体を運ぶことはできません。' });
    if (game.corpses.length === 0) return interaction.editReply({ content: '⚠️ 回収可能な死体はありません。', components: getMainRow(game) });

    game.time += 1;
    game.facilityDanger += 10;
    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (roll <= game.facilityDanger * 0.5) {
        player.hp -= 50;
        if (player.hp <= 0) {
            player.isAlive = false;
            game.corpses.push({ userId: interaction.user.id, name: player.name, value: 50 });
            embed.setTitle('🔴 二次災害 (死亡)').setDescription(await generateDescription('Secondary Disaster Death', '死体回収中に罠にかかり死亡。')).setColor(0x8B0000);
        } else {
            embed.setTitle('⚠️ 二次災害 (負傷)').setDescription(`死体を運ぼうとして罠にかかった！ (-50 HP)\n残りHP: ${player.hp}`).setColor(0xe67e22);
        }
    } else {
        const corpse = game.corpses.shift()!;
        game.funds += corpse.value;
        player.hasTwoHanded = true; 
        embed.setTitle('📦 遺体回収').setDescription(`保険金 **${corpse.value}円** 獲得。\n(※死体を抱えたため両手が塞がりました)`).setColor(0x8A2BE2);
    }
    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    else await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
}

export async function handleDropHeavy(interaction: any) {
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);
    if (!player.hasTwoHanded) return interaction.reply({ content: '⚠️ 重量物は持っていません。', ephemeral: true });
    
    player.hasTwoHanded = false;
    player.inventory = Math.floor(player.inventory / 2); 
    await interaction.reply({ content: `✅ **${player.name}** が重量物を放棄しました！身軽になりましたが、所持スクラップの価値が半減しました。` });
}

export async function handleReturn(interaction: any, isAuto = false) {
    const game = getGame(interaction.channelId);
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 仲間が交戦中です！見捨てることはできません。', ephemeral: true });
    
    if (!isAuto) await interaction.deferReply();
    let totalDeposited = 0;
    game.players.forEach(p => { if (p.isAlive) { totalDeposited += p.inventory; p.inventory = 0; p.hasTwoHanded = false; } });
    game.funds += totalDeposited;
    game.day += 1;
    
    let embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();
    const prefix = isAuto ? '🕛 深夜0時経過：自動発進\n' : '';

    if (game.day > 3) {
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setDescription(`${prefix}要求額 ${game.quota}円 に対して ${game.funds}円 を納品しました。\n次のノルマを設定します。`).setColor(0x00FF00);
            game.day = 1; game.time = 8; game.quota += 500; game.funds = 0; game.corpses = []; game.facilityDanger = Math.floor(Math.random() * 30) + 10;
            game.players.forEach(p => { p.isAlive = true; p.hp = 100; p.items = { flashlight: false, shovel: false }; });
            if (isAuto) await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
            else await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
        } else {
            embed.setTitle('🚀 船外放出（強制解雇）').setDescription(`${prefix}ノルマ ${game.quota}円 未達（現在: ${game.funds}円）。\nあなた達は会社にとって不要です。`).setColor(0x000000);
            activeGames.delete(interaction.channelId);
            if (isAuto) await interaction.editReply({ embeds: [embed], components: [] });
            else await interaction.editReply({ embeds: [embed], components: [] });
        }
    } else {
        embed.setTitle('🌙 軌道上へ帰還').setDescription(`${prefix}本日分の納品が完了しました。\n共有資金: **${game.funds}円** / ノルマ: **${game.quota}円**\n残り日数: **${4 - game.day}日**`).setColor(0x3498db);
        game.corpses = []; game.time = 8; game.facilityDanger = Math.floor(Math.random() * 30) + 10;
        game.players.forEach(p => { if (!p.isAlive) p.isAlive = true; p.hp = 100; }); 
        if (isAuto) await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
        else await interaction.editReply({ embeds: [embed], components: getMainRow(game) });
    }
}

export async function handleStore(interaction: any) {
    const game = getGame(interaction.channelId);
    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel('懐中電灯(100円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel('シャベル(200円)').setStyle(ButtonStyle.Primary)
    );
    const embed = new EmbedBuilder().setTitle('🛒 カンパニー・ストア').setDescription(`現在の共有資金: **${game.funds}円**\n\n・🔦 懐中電灯 (100円) : トラップ回避率UP\n・⛏️ シャベル (200円) : 成功率UP`).setColor(0xFFA500);
    await interaction.reply({ embeds: [embed], components: [storeRow], ephemeral: true });
}

export async function handleBuy(interaction: any, item: 'flashlight' | 'shovel') {
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);
    const price = item === 'flashlight' ? 100 : 200;
    const itemName = item === 'flashlight' ? '🔦 懐中電灯' : '⛏️ プロのシャベル';

    if (game.funds < price) return interaction.reply({ content: `❌ 共有資金が足りません。(現在: ${game.funds}円)`, ephemeral: true });
    game.funds -= price;
    player.items[item] = true;
    await interaction.reply({ content: `✅ 共有資金を使って **${itemName}** を購入し、装備しました！\n(残り資金: ${game.funds}円)` });
}