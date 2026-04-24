// src/lethalLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

type EncounterType = 'bracken' | 'coilhead' | 'eyelessdog';
type RoleType = 'scavenger' | 'monitor' | 'none';

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    isAlive: boolean;
    hp: number;
    inventory: number;
    hasTwoHanded: boolean;
    items: { flashlight: boolean; shovel: boolean };
}

interface Corpse { userId: string; name: string; value: number; }

interface GameState {
    hostId: string;
    state: 'lobby' | 'playing';
    location: 'orbit' | 'moon';
    isProcessing: boolean;
    day: number;
    time: number;
    quota: number;
    funds: number;
    facilityDanger: number;
    corpses: Corpse[];
    players: Map<string, PlayerState>;
    activeEncounter: { userId: string; type: EncounterType } | null;
}

const activeGames = new Map<string, GameState>();

const ENEMIES = {
    'bracken': { name: 'ブラッケン', correct: 'glance', desc: '暗闇に光る二つの白い目が見える…！' },
    'coilhead': { name: 'コイルヘッド', correct: 'stare', desc: 'バネの音がして、血まみれのマネキンが現れた！' },
    'eyelessdog': { name: 'アイレスドッグ', correct: 'sneak', desc: '巨大な化け物が、音に反応して徘徊している…！' }
};

const SCRAP_NAMES = ["V型エンジン", "誰かの左靴", "ラジカセ", "トマティー40Station", "錆びた鉄パイプ", "壊れたパソコン", "謎の巨大な歯車", "古びた金庫"];
const DAMAGE_CAUSES = ["地雷の爆発💥", "タレットの銃撃🔫", "崩れた足場からの転落💀", "未知の罠🪤", "有毒ガス🌫️", "鋭い爪による切り裂き🩸"];

async function generateDescription(eventType: string, context: string = "") {
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'あなたは宇宙のブラック企業の冷酷なシステムAIです。インダストリアル・ホラーの世界観で状況を報告してください。\n【厳守事項】・カビ、錆、軋む金属音、暗闇、異常な温度、謎の粘液など多彩な表現を用いること。・箇条書きや記号は使用禁止。1〜2文の日本語のみ出力すること。' },
                { role: 'user', content: `発生イベント: ${eventType}\n詳細: ${context}` }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.8, max_tokens: 100,
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "通信エラー。暗闇しか見えない。";
    } catch (e) {
        return "システムエラー。カメラのノイズが酷くて見えません。";
    }
}

function getGame(channelId: string): GameState | undefined {
    return activeGames.get(channelId);
}

function formatTime(t: number) { return `${t.toString().padStart(2, '0')}:00`; }

// ── 新規：HUD風ステータスヘッダー ──
function getStatusHeader(game: GameState) {
    if (game.location === 'orbit') {
        return `**\`[ 🛰️ 軌道上 | DAY ${game.day} | 💰 資金: ${game.funds} / ${game.quota}円 ]\`**\n`;
    } else {
        const timeIcon = game.time >= 20 ? '🔴' : game.time >= 17 ? '🟡' : '🟢';
        return `**\`[ 🪐 衛星内 | ${timeIcon} ${formatTime(game.time)} | 💰 資金: ${game.funds} / ${game.quota}円 ]\`**\n`;
    }
}

// ============================================================
// UI構築
// ============================================================

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_join').setLabel('参加 / 退出').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lethal_role_scavenger').setLabel('現場班になる').setStyle(ButtonStyle.Danger).setEmoji('⛏️'),
        new ButtonBuilder().setCustomId('lethal_role_monitor').setLabel('モニター班になる').setStyle(ButtonStyle.Primary).setEmoji('💻'),
        new ButtonBuilder().setCustomId('lethal_start').setLabel('軌道上へ出発').setStyle(ButtonStyle.Success).setEmoji('🚀')
    );
}

function getOrbitRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_land').setLabel('衛星へ降下する').setStyle(ButtonStyle.Danger).setEmoji('🪐'),
        new ButtonBuilder().setCustomId('lethal_store').setLabel('ストアを開く').setStyle(ButtonStyle.Primary).setEmoji('🛒')
    );
}

function getMoonRow(game: GameState) {
    const hasHeavy = Array.from(game.players.values()).some(p => p.hasTwoHanded && p.isAlive);
    const hasCorpses = game.corpses.length > 0;
    const hasAliveScavenger = Array.from(game.players.values()).some(p => p.role === 'scavenger' && p.isAlive);

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_explore').setLabel('探索(1h)').setStyle(ButtonStyle.Danger).setEmoji('🔦').setDisabled(!hasAliveScavenger),
        new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦').setDisabled(!hasCorpses || !hasAliveScavenger),
        new ButtonBuilder().setCustomId('lethal_monitor').setLabel('モニター').setStyle(ButtonStyle.Primary).setEmoji('💻')
    );
    
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_teleport').setLabel('強制転送').setStyle(ButtonStyle.Primary).setEmoji('🌀').setDisabled(!hasAliveScavenger),
        new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️').setDisabled(!hasHeavy),
        new ButtonBuilder().setCustomId('lethal_return').setLabel('帰還する').setStyle(ButtonStyle.Success).setEmoji('🚀')
    );
    return [row1, row2];
}

function getEncounterRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_qte_glance').setLabel('一瞬だけ見る').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_stare').setLabel('ガン見する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_sneak').setLabel('しゃがんで歩く').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_run').setLabel('走って逃げる').setStyle(ButtonStyle.Danger)
    );
}

function updateLobbyMessage(game: GameState) {
    let pList = Array.from(game.players.values()).map(p => {
        const r = p.role === 'scavenger' ? '⛏️ 現場' : p.role === 'monitor' ? '💻 モニター' : '未定';
        return `・${p.name} [${r}]`;
    }).join('\n');
    if (!pList) pList = '参加者なし';

    return new EmbedBuilder()
        .setAuthor({ name: COMPANY_NAME })
        .setTitle('🪐 Lethal Company 参加募集ロビー')
        .setDescription(`ホスト: <@${game.hostId}>\n\n**【現在の参加者】**\n${pList}\n\n※各自「参加」を押し、役割を選んでください。\n全員準備ができたらホストが「出発」を押してください。`)
        .setColor(0x3498db); // ※.setTimestamp() は削除
}

// ============================================================
// パーティー＆ロビー制御
// ============================================================

export async function handleLethalStart(interaction: ChatInputCommandInteraction) {
    if (activeGames.has(interaction.channelId)) return interaction.reply({ content: '⚠️ 既に進行中のゲームがあります。', ephemeral: true });
    
    activeGames.set(interaction.channelId, {
        hostId: interaction.user.id, state: 'lobby', location: 'orbit', isProcessing: false,
        day: 1, time: 8, quota: 500, funds: 0, facilityDanger: 10,
        corpses: [], players: new Map(), activeEncounter: null
    });
    const game = activeGames.get(interaction.channelId)!;
    game.players.set(interaction.user.id, { id: interaction.user.id, name: interaction.user.username, role: 'none', isAlive: true, hp: 100, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false } });

    await interaction.reply({ embeds: [updateLobbyMessage(game)], components: [getLobbyRow()] });
}

export async function handleLobbyAction(interaction: any, action: string) {
    const game = getGame(interaction.channelId);
    if (!game || game.state !== 'lobby') return interaction.reply({ content: '⚠️ ロビーが見つかりません。', ephemeral: true });

    const userId = interaction.user.id;
    let player = game.players.get(userId);

    if (action === 'join') {
        if (player) game.players.delete(userId);
        else game.players.set(userId, { id: userId, name: interaction.user.username, role: 'none', isAlive: true, hp: 100, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false } });
    } else if (action === 'role_scavenger' || action === 'role_monitor') {
        if (!player) return interaction.reply({ content: '❌ まず「参加」を押してください。', ephemeral: true });
        player.role = action === 'role_scavenger' ? 'scavenger' : 'monitor';
    } else if (action === 'start') {
        if (interaction.user.id !== game.hostId) return interaction.reply({ content: '❌ 出発させられるのはホストのみです。', ephemeral: true });
        if (game.players.size === 0) return interaction.reply({ content: '❌ 参加者がいません。', ephemeral: true });
        const unassigned = Array.from(game.players.values()).some(p => p.role === 'none');
        if (unassigned) return interaction.reply({ content: '❌ 役割が決まっていないプレイヤーがいます。', ephemeral: true });

        await interaction.deferUpdate(); 
        game.state = 'playing'; game.location = 'orbit';
        const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('🛰️ 軌道上に到着').setDescription(`${getStatusHeader(game)}\n**THE COMPANYへようこそ。**\nこれよりスクラップの回収業務を開始します。ストアで準備を整えたら、衛星へ降下してください。`).setColor(0x000000);
        return interaction.editReply({ embeds: [embed], components: [getOrbitRow()] });
    }

    await interaction.update({ embeds: [updateLobbyMessage(game)], components: [getLobbyRow()] });
}

export async function handleLand(interaction: any) {
    const game = getGame(interaction.channelId)!;
    if (game.location !== 'orbit') return interaction.reply({ content: '⚠️ 既に降下しています。', ephemeral: true });
    if (interaction.user.id !== game.hostId) return interaction.reply({ content: '❌ 降下指示はホストのみ可能です。', ephemeral: true });

    await interaction.deferUpdate();
    game.location = 'moon'; game.facilityDanger = Math.floor(Math.random() * 30) + 10;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('🪐 衛星へ降下完了').setDescription(`${getStatusHeader(game)}\n未知の衛星に着陸しました。現場班は探索を開始してください。`).setColor(0x34495e);
    await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
}

// ============================================================
// ゲーム進行制御
// ============================================================

function getPlayerOrFail(game: GameState, userId: string, interaction: any, requireAlive = true) {
    const p = game.players.get(userId);
    if (!p) { interaction.reply({ content: '❌ あなたはこのパーティーに参加していません。', ephemeral: true }); return null; }
    if (requireAlive && !p.isAlive) { interaction.reply({ content: '👻 死亡した従業員は操作できません。', ephemeral: true }); return null; }
    return p;
}

export async function handleExplore(interaction: any) {
    const game = getGame(interaction.channelId)!;
    if (game.location !== 'moon') return interaction.reply({ content: '⚠️ まず衛星に降下してください。', ephemeral: true });
    
    if (game.activeEncounter) {
        if (game.activeEncounter.userId === interaction.user.id) return interaction.reply({ content: '❌ 目の前の化け物に対処しろ！', ephemeral: true });
        return interaction.reply({ content: '⚠️ 現在、他の従業員が交戦中です！', ephemeral: true });
    }

    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    if (player.role !== 'scavenger') return interaction.reply({ content: '❌ お前はモニター班だろ！船内で留守番してろ！', ephemeral: true });

    if (game.isProcessing) return interaction.reply({ content: '⏳ 通信中…連打しないでください。', ephemeral: true });
    game.isProcessing = true;

    try {
        if (game.time >= 24) {
            game.isProcessing = false;
            return handleReturn(interaction, true);
        }

        await interaction.deferUpdate(); 
        game.time += 1;
        game.facilityDanger = Math.min(100, game.facilityDanger + Math.floor(Math.random() * 15) + 5);

        let dangerRoll = game.facilityDanger + (player.hasTwoHanded ? 15 : 0) - (player.items.flashlight ? 20 : 0);
        const roll = Math.floor(Math.random() * 100) + 1;
        const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME });
        let isEncounter = false;

        if (roll <= dangerRoll * 0.4) {
            const damage = Math.floor(Math.random() * 40) + 20;
            player.hp -= damage;
            const cause = DAMAGE_CAUSES[Math.floor(Math.random() * DAMAGE_CAUSES.length)];
            
            if (player.hp <= 0) {
                player.isAlive = false;
                game.corpses.push({ userId: player.id, name: player.name, value: 50 });
                embed.setTitle('🔴 従業員ロスト').setDescription(`${getStatusHeader(game)}\n**${player.name} の生命反応が途絶えた。**\n死因: ${cause}\n\n${await generateDescription('Death', cause)}`).setColor(0xe74c3c);
                player.inventory = 0; player.hasTwoHanded = false;
            } else {
                embed.setTitle('⚠️ 負傷・トラップ遭遇').setDescription(`${getStatusHeader(game)}\n**${player.name} がトラップにかかった！**\n${cause} (-${damage} HP)\n\n${await generateDescription('Trap', cause)}`).setColor(0xe67e22).addFields({ name: `${player.name} のHP`, value: `${player.hp}/100`, inline: true });
            }
        } else if (roll <= dangerRoll) {
            isEncounter = true;
            const enemyType = ['bracken', 'coilhead', 'eyelessdog'][Math.floor(Math.random() * 3)] as EncounterType;
            game.activeEncounter = { userId: player.id, type: enemyType };
            embed.setTitle(`🚨 未知の生物に遭遇`).setDescription(`${getStatusHeader(game)}\n**${player.name} が化け物に遭遇した！**\n${ENEMIES[enemyType].desc}\n\n**直ちに対処行動を選択しろ。**`).setColor(0x8B0000);
        } else {
            const isHeavy = Math.random() < 0.2; 
            const val = Math.floor((Math.random() * (isHeavy ? 150 : 80) + 20) * (game.time >= 17 ? 1.5 : 1.0));
            const scrapName = SCRAP_NAMES[Math.floor(Math.random() * SCRAP_NAMES.length)];
            
            player.inventory += val;
            if (isHeavy) player.hasTwoHanded = true;
            embed.setTitle('🟢 資産回収').setDescription(`${getStatusHeader(game)}\n**${player.name} が【 ${scrapName} 】を発見した！**\n\n${await generateDescription('Scrap', scrapName)}`).setColor(0x2ecc71)
                 .addFields({ name: `${player.name} の所持額`, value: `${player.inventory}円`, inline: true }, { name: 'HP', value: `${player.hp}/100`, inline: true });
        }

        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(interaction.channelId);
            embed.setDescription(`${getStatusHeader(game)}\n全従業員の生命反応が途絶えました。\n自動帰還シークエンスを開始します。`);
            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            await interaction.editReply({ embeds: [embed], components: isEncounter ? [getEncounterRow()] : getMoonRow(game) });
        }
    } finally {
        game.isProcessing = false;
    }
}

export async function handleQTE(interaction: any, action: string) {
    const game = getGame(interaction.channelId)!;
    if (!game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中の敵はいません。', ephemeral: true });
    if (game.activeEncounter.userId !== interaction.user.id) return interaction.reply({ content: '❌ お前じゃない！交戦中の従業員に任せろ！', ephemeral: true });

    if (game.isProcessing) return interaction.reply({ content: '⏳ 処理中…', ephemeral: true });
    game.isProcessing = true;

    try {
        await interaction.deferUpdate();
        const player = game.players.get(interaction.user.id)!;
        const enemy = ENEMIES[game.activeEncounter.type];
        const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME });

        if (action === enemy.correct) {
            embed.setTitle('🟢 危機回避').setDescription(`${getStatusHeader(game)}\n**${player.name} は ${enemy.name} から逃げ切った！**\n\n${await generateDescription('Escape', '無事逃げ切った。')}`).setColor(0x2ecc71);
        } else {
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: 50 });
            embed.setTitle('🔴 従業員惨殺').setDescription(`${getStatusHeader(game)}\n**${player.name} は対処を誤り、${enemy.name} に殺された。**\n\n${await generateDescription('Death', '惨殺された。')}`).setColor(0xe74c3c);
            player.inventory = 0; player.hasTwoHanded = false;
        }

        game.activeEncounter = null; 
        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(interaction.channelId);
            embed.setDescription(`${getStatusHeader(game)}\n全従業員の生命反応が途絶えました。\n自動帰還シークエンスを開始します。`);
            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
        }
    } finally {
        game.isProcessing = false;
    }
}

export async function handleMonitor(interaction: any) {
    const game = getGame(interaction.channelId)!;
    if (game.location !== 'moon') return interaction.reply({ content: '⚠️ 衛星に降下してから監視してください。', ephemeral: true });
    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    if (player.role !== 'monitor') return interaction.reply({ content: '❌ お前は現場班だろ！船に戻らないとモニターは見えない！', ephemeral: true });

    if (game.isProcessing) return interaction.reply({ content: '⏳ 通信中…', ephemeral: true });
    game.isProcessing = true;
    try {
        await interaction.deferUpdate();
        let dText = game.facilityDanger > 80 ? "極めて危険。複数の巨大な生体反応が接近中。" : game.facilityDanger > 50 ? "危険。未知の動体反応あり。" : "警戒。かすかなノイズを検知。";
        const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('💻 モニター室からの通信').setDescription(`${getStatusHeader(game)}\n**【${player.name} のレーダー解析結果】**\n${await generateDescription('Scan', dText)}`).setColor(game.facilityDanger > 70 ? 0xFF0000 : 0x00FF00);
        await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
    } finally {
        game.isProcessing = false;
    }
}

export async function handleTeleport(interaction: any) {
    const game = getGame(interaction.channelId)!;
    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    if (player.role !== 'monitor') return interaction.reply({ content: '❌ テレポーターは船内からしか操作できない！', ephemeral: true });

    const target = Array.from(game.players.values()).find(p => p.role === 'scavenger' && p.isAlive);
    if (!target) return interaction.reply({ content: '⚠️ 現場に生存中の従業員がいません。', ephemeral: true });

    await interaction.deferUpdate();
    game.activeEncounter = null; 
    const lostItem = target.inventory;
    target.inventory = 0; target.hasTwoHanded = false; target.hp = Math.min(100, target.hp + 20); 
    
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('🌀 強制テレポート作動').setDescription(`${getStatusHeader(game)}\nモニター室の **${player.name}** の操作により、**${target.name}** を船内へ強制転送しました。\n\n命は助かりましたが、転送の衝撃で所持していたスクラップ（${lostItem}円分）は全て失われました。`).setColor(0x3498db);
    await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
}

export async function handleRetrieve(interaction: any) {
    const game = getGame(interaction.channelId)!;
    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    if (player.role !== 'scavenger') return interaction.reply({ content: '❌ お前はモニター班だ！', ephemeral: true });
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 現在交戦中です！', ephemeral: true });
    if (game.corpses.length === 0) return interaction.reply({ content: '⚠️ 回収可能な死体はありません。', ephemeral: true });

    if (game.isProcessing) return interaction.reply({ content: '⏳ 通信中…', ephemeral: true });
    game.isProcessing = true;
    try {
        await interaction.deferUpdate();
        game.time += 1; game.facilityDanger += 10;
        const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME });

        if (Math.random() * 100 <= game.facilityDanger * 0.5) {
            player.hp -= 50;
            if (player.hp <= 0) {
                player.isAlive = false; game.corpses.push({ userId: player.id, name: player.name, value: 50 });
                embed.setTitle('🔴 二次災害 (死亡)').setDescription(`${getStatusHeader(game)}\n**${player.name} は死体回収中に罠にかかり死亡した。**\n\n${await generateDescription('Death', '死体回収中に死亡。')}`).setColor(0x8B0000);
            } else {
                embed.setTitle('⚠️ 二次災害 (負傷)').setDescription(`${getStatusHeader(game)}\n**${player.name} が死体を運ぼうとして罠にかかった！** (-50 HP)\n残りHP: ${player.hp}`).setColor(0xe67e22);
            }
        } else {
            const corpse = game.corpses.shift()!;
            game.funds += corpse.value; player.hasTwoHanded = true; 
            embed.setTitle('📦 遺体回収').setDescription(`${getStatusHeader(game)}\n**${player.name} が ${corpse.name} の遺体を回収した！**\n保険金 **${corpse.value}円** 獲得。\n(※死体を抱えたため両手が塞がりました)`).setColor(0x8A2BE2);
        }
        await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
    } finally {
        game.isProcessing = false;
    }
}

export async function handleDropHeavy(interaction: any) {
    const game = getGame(interaction.channelId)!;
    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    if (!player.hasTwoHanded) return interaction.reply({ content: '⚠️ 重量物は持っていません。', ephemeral: true });
    
    await interaction.deferUpdate();
    player.hasTwoHanded = false; player.inventory = Math.floor(player.inventory / 2); 
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('⚠️ 重量物放棄').setDescription(`${getStatusHeader(game)}\n**${player.name}** が重量物を放棄し身軽になりました。\n(ペナルティ: 所持スクラップ価値半減)`).setColor(0xf39c12);
    await interaction.editReply({ embeds: [embed], components: getMoonRow(game) });
}

export async function handleReturn(interaction: any, isAuto = false) {
    const game = getGame(interaction.channelId)!;
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 仲間が交戦中です！見捨てることはできません。', ephemeral: true });
    if (game.location !== 'moon') return interaction.reply({ content: '⚠️ すでに軌道上です。', ephemeral: true });
    
    if (!isAuto) await interaction.deferUpdate();
    
    let total = 0;
    game.players.forEach(p => { if (p.isAlive) { total += p.inventory; p.inventory = 0; p.hasTwoHanded = false; } });
    game.funds += total; game.day += 1;
    game.location = 'orbit'; 
    let embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME });
    const prefix = isAuto ? '🕛 深夜0時経過：自動発進\n' : '';

    if (game.day > 3) {
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setDescription(`${getStatusHeader(game)}\n${prefix}要求額 ${game.quota}円 に対して ${game.funds}円 を納品しました。`).setColor(0x00FF00);
            game.day = 1; game.time = 8; game.quota += 500; game.funds = 0; game.corpses = []; game.facilityDanger = 10;
            game.players.forEach(p => { p.isAlive = true; p.hp = 100; p.items = { flashlight: false, shovel: false }; });
            await interaction.editReply({ embeds: [embed], components: [getOrbitRow()] });
        } else {
            embed.setTitle('🚀 船外放出').setDescription(`${getStatusHeader(game)}\n${prefix}ノルマ未達（現在: ${game.funds}円）。あなた達は会社にとって不要です。`).setColor(0x000000);
            activeGames.delete(interaction.channelId);
            await interaction.editReply({ embeds: [embed], components: [] });
        }
    } else {
        embed.setTitle('🛰️ 軌道上へ帰還').setDescription(`${getStatusHeader(game)}\n${prefix}本日分の納品完了。\nストアで準備を整え、再び降下してください。`).setColor(0x3498db);
        game.corpses = []; game.time = 8; game.facilityDanger = 10;
        game.players.forEach(p => { if (!p.isAlive) p.isAlive = true; p.hp = 100; }); 
        await interaction.editReply({ embeds: [embed], components: [getOrbitRow()] });
    }
}

export async function handleStore(interaction: any) {
    const game = getGame(interaction.channelId)!;
    if (game.location !== 'orbit') return interaction.reply({ content: '❌ ストアは軌道上（帰還後）でしか開けません！', ephemeral: true });

    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel('懐中電灯(100円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel('シャベル(200円)').setStyle(ButtonStyle.Primary)
    );
    // ストア画面のEmbedからも.setTimestamp()を外してあります
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('🛒 カンパニー・ストア').setDescription(`共有資金: **${game.funds}円**\n\n・🔦 懐中電灯 (100円) : トラップ回避率UP\n・⛏️ シャベル (200円) : 成功率UP`).setColor(0xFFA500);
    await interaction.reply({ embeds: [embed], components: [storeRow], ephemeral: true });
}

export async function handleBuy(interaction: any, item: 'flashlight' | 'shovel') {
    const game = getGame(interaction.channelId)!;
    const player = getPlayerOrFail(game, interaction.user.id, interaction);
    if (!player) return;
    const price = item === 'flashlight' ? 100 : 200;
    if (game.funds < price) return interaction.reply({ content: `❌ 共有資金が足りません。(現在: ${game.funds}円)`, ephemeral: true });
    game.funds -= price; player.items[item] = true;
    await interaction.reply({ content: `✅ 共有資金を使って **${item === 'flashlight' ? '🔦懐中電灯' : '⛏️シャベル'}** を購入・装備しました！\n(残り資金: ${game.funds}円)` });
}