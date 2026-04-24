// src/lethalLogic.ts
import { ChatInputCommandInteraction, ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

// ── 状態管理 ──
type EncounterType = 'bracken' | 'coilhead' | 'eyelessdog';

interface PlayerState {
    name: string;
    isAlive: boolean;
    inventory: number;
    hasTwoHanded: boolean; // 重量物を持っているか
    items: { flashlight: boolean; shovel: boolean };
}

interface Corpse { userId: string; name: string; value: number; }

interface GameState {
    day: number;
    time: number; // 8〜24
    quota: number;
    funds: number;
    corpses: Corpse[];
    players: Map<string, PlayerState>;
    activeEncounter: { userId: string; type: EncounterType } | null;
}

const activeGames = new Map<string, GameState>();

// ── 敵データ ──
const ENEMIES = {
    'bracken': { name: 'ブラッケン', correct: 'glance', desc: '暗闇に光る二つの白い目が見える…！' },
    'coilhead': { name: 'コイルヘッド', correct: 'stare', desc: 'バネの音がして、血まみれのマネキンが目の前に現れた！' },
    'eyelessdog': { name: 'アイレスドッグ', correct: 'sneak', desc: '巨大な犬のような化け物が、音に反応して徘徊している…！' }
};

async function generateDescription(eventType: string, context: string = "") {
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: `Role: Cold corporate AI. Event: ${eventType}. ${context} Instruction: Write 1-2 bleak, professional Japanese sentences of industrial horror.` }],
            model: 'llama-3.3-70b-versatile',
        });
        return chatCompletion.choices[0]?.message?.content || "通信エラー。状況を確認できません。";
    } catch (e) {
        return "システムエラー。視界がぼやけている…。";
    }
}

function getGame(channelId: string): GameState {
    if (!activeGames.has(channelId)) activeGames.set(channelId, { day: 1, time: 8, quota: 500, funds: 0, corpses: [], players: new Map(), activeEncounter: null });
    return activeGames.get(channelId)!;
}

function getPlayer(game: GameState, user: any): PlayerState {
    if (!game.players.has(user.id)) game.players.set(user.id, { name: user.username, isAlive: true, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false } });
    return game.players.get(user.id)!;
}

function formatTime(t: number) { return `${t.toString().padStart(2, '0')}:00`; }

// ── UI構築 ──
function getMainRow(game: GameState) {
    const hasHeavy = Array.from(game.players.values()).some(p => p.hasTwoHanded && p.isAlive);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_explore').setLabel('探索(1h)').setStyle(ButtonStyle.Danger).setEmoji('🔦'),
        new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦')
    );
    if (hasHeavy) row.addComponents(new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️'));
    row.addComponents(
        new ButtonBuilder().setCustomId('lethal_return').setLabel('帰還する').setStyle(ButtonStyle.Success).setEmoji('🚀'),
        new ButtonBuilder().setCustomId('lethal_store').setLabel('ストア').setStyle(ButtonStyle.Primary).setEmoji('🛒')
    );
    return row;
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
// 1. 探索コマンド
// ============================================================
export async function handleExplore(interaction: any) {
    const game = getGame(interaction.channelId);
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 現在、他の従業員が交戦中です！', ephemeral: true });
    
    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply({ content: '❌ **[警告]** 死亡した従業員は探索できません。' });

    if (game.time >= 24) return handleReturn(interaction, true); // 時間切れ強制帰還

    game.time += 1; // 時間経過

    // 時間と重量によるリスク計算
    let baseDeath = game.time >= 20 ? 30 : game.time >= 17 ? 15 : 5;
    let baseEncounter = game.time >= 20 ? 30 : game.time >= 17 ? 20 : 10;
    
    if (player.hasTwoHanded) baseDeath += 15; // 重量物ペナルティ
    if (player.items.flashlight) baseDeath = Math.max(0, baseDeath - 10);
    let successChance = player.items.shovel ? 80 : 60;

    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();
    let isEncounter = false;

    if (roll <= baseDeath) {
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: Math.floor(Math.random() * 50) + 50 });
        embed.setTitle('🔴 従業員ロスト').setDescription(await generateDescription('Employee Death', player.hasTwoHanded ? '重量物で逃げ遅れた。' : '')).setColor(0xe74c3c);
        player.inventory = 0; player.hasTwoHanded = false;
    } else if (roll <= baseDeath + baseEncounter) {
        // モンスター遭遇イベント
        isEncounter = true;
        const types: EncounterType[] = ['bracken', 'coilhead', 'eyelessdog'];
        const enemyType = types[Math.floor(Math.random() * types.length)];
        game.activeEncounter = { userId: interaction.user.id, type: enemyType };
        
        embed.setTitle(`⚠️ 未知の生物に遭遇：${player.name}`).setDescription(`${ENEMIES[enemyType].desc}\n\n**直ちに対処行動を選択してください。**`).setColor(0x8B0000);
    } else if (roll <= baseDeath + baseEncounter + successChance) {
        // 成功
        const isHeavy = Math.random() < 0.2; // 20%で重量物
        const multiplier = game.time >= 17 ? 1.5 : 1.0; // 夕方以降は価値1.5倍
        const val = Math.floor((Math.random() * (isHeavy ? 150 : 80) + 20) * multiplier);
        
        player.inventory += val;
        if (isHeavy) player.hasTwoHanded = true;

        embed.setTitle('🟢 資産回収').setDescription(await generateDescription('Scrap Found', isHeavy ? '両手が塞がる重いスクラップだ。' : '')).setColor(0x2ecc71)
             .addFields(
                 { name: '所持スクラップ', value: `${player.inventory}円`, inline: true },
                 { name: '状態', value: player.hasTwoHanded ? '⚠️ 両手塞がり (死亡率UP)' : '身軽', inline: true }
             );
    } else {
        embed.setTitle('🟡 異常なし').setDescription(await generateDescription('Empty Room')).setColor(0xf1c40f);
    }

    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) {
        await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    } else {
        embed.setFooter({ text: `現在時刻: ${formatTime(game.time)} | 残りノルマ: ${game.quota}円` });
        await interaction.editReply({ embeds: [embed], components: [isEncounter ? getEncounterRow() : getMainRow(game)] });
    }
}

// ============================================================
// 2. モンスター対処 (QTE) コマンド
// ============================================================
export async function handleQTE(interaction: any, action: string) {
    const game = getGame(interaction.channelId);
    if (!game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中の敵はいません。', ephemeral: true });
    if (game.activeEncounter.userId !== interaction.user.id) return interaction.reply({ content: '❌ お前じゃない！交戦中の従業員に任せろ！', ephemeral: true });

    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);
    const enemy = ENEMIES[game.activeEncounter.type];
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (action === enemy.correct) {
        // 成功
        embed.setTitle('🟢 危機回避').setDescription(await generateDescription('Escaped Monster', `${enemy.name}から見事に逃げ切った。`)).setColor(0x2ecc71);
    } else {
        // 失敗
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: 50 });
        embed.setTitle('🔴 従業員惨殺').setDescription(await generateDescription('Gruesome Death', `対処を誤り、${enemy.name}に引き裂かれた。`)).setColor(0xe74c3c);
        player.inventory = 0; player.hasTwoHanded = false;
    }

    game.activeEncounter = null; // 交戦状態解除

    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) {
        await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    } else {
        embed.setFooter({ text: `現在時刻: ${formatTime(game.time)}` });
        await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
    }
}

// ============================================================
// その他コマンド (死体回収、重量物放棄、帰還、ストア)
// ============================================================
export async function handleRetrieve(interaction: any) {
    const game = getGame(interaction.channelId);
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中です！', ephemeral: true });
    await interaction.deferReply();
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply({ content: '❌ 幽霊が死体を運ぶことはできません。' });
    if (game.corpses.length === 0) return interaction.editReply({ content: '⚠️ 回収可能な死体はありません。', components: [getMainRow(game)] });

    game.time += 1;
    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (roll <= 30) {
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: 50 });
        embed.setTitle('🔴 二次災害発生').setDescription(await generateDescription('Secondary Disaster')).setColor(0x8B0000);
    } else {
        const corpse = game.corpses.shift()!;
        game.funds += corpse.value;
        player.hasTwoHanded = true; // 死体も両手塞がり扱い
        embed.setTitle('📦 遺体回収').setDescription(`保険金 **${corpse.value}円** 獲得。\n(※死体を抱えたため両手が塞がりました)`).setColor(0x8A2BE2);
    }
    const wipeoutEmbed = checkWipeout(game, interaction.channelId);
    if (wipeoutEmbed) await interaction.editReply({ embeds: [embed, wipeoutEmbed], components: [] });
    else await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
}

export async function handleDropHeavy(interaction: any) {
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);
    if (!player.hasTwoHanded) return interaction.reply({ content: '⚠️ 重量物は持っていません。', ephemeral: true });
    
    player.hasTwoHanded = false;
    player.inventory = Math.floor(player.inventory / 2); // 価値半減
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
            game.day = 1; game.time = 8; game.quota += 500; game.funds = 0; game.corpses = [];
            game.players.forEach(p => { p.isAlive = true; p.items = { flashlight: false, shovel: false }; });
            if (isAuto) await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
            else await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
        } else {
            embed.setTitle('🚀 船外放出（強制解雇）').setDescription(`${prefix}ノルマ ${game.quota}円 未達（現在: ${game.funds}円）。\nあなた達は会社にとって不要です。`).setColor(0x000000);
            activeGames.delete(interaction.channelId);
            if (isAuto) await interaction.editReply({ embeds: [embed], components: [] });
            else await interaction.editReply({ embeds: [embed], components: [] });
        }
    } else {
        embed.setTitle('🌙 軌道上へ帰還').setDescription(`${prefix}本日分の納品が完了しました。\n共有資金: **${game.funds}円** / ノルマ: **${game.quota}円**\n残り日数: **${4 - game.day}日**`).setColor(0x3498db);
        game.corpses = []; game.time = 8;
        game.players.forEach(p => { if (!p.isAlive) p.isAlive = true; }); 
        if (isAuto) await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
        else await interaction.editReply({ embeds: [embed], components: [getMainRow(game)] });
    }
}

export async function handleStore(interaction: any) {
    const game = getGame(interaction.channelId);
    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel('懐中電灯(100円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel('シャベル(200円)').setStyle(ButtonStyle.Primary)
    );
    const embed = new EmbedBuilder().setTitle('🛒 カンパニー・ストア').setDescription(`現在の共有資金: **${game.funds}円**\n\n・🔦 懐中電灯 (100円) : 死亡率大幅ダウン\n・⛏️ シャベル (200円) : 成功率大幅アップ`).setColor(0xFFA500);
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
