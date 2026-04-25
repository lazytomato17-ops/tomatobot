// src/lethalLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import Groq from 'groq-sdk';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

type EncounterType = 'bracken' | 'coilhead' | 'eyelessdog';
type RoleType = 'scavenger' | 'monitor' | 'none';
type ZoneType = 'orbit' | 'ship' | 'entrance' | 'left' | 'forward' | 'right';

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    isAlive: boolean;
    hp: number;
    inventory: number;
    hasTwoHanded: boolean;
    items: { flashlight: boolean; shovel: boolean; walkie_talkie: boolean };
    zone: ZoneType;
    isMoving?: boolean; // 移動中フラグ
}

interface Corpse { userId: string; name: string; value: number; zone: ZoneType; }

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
const SCRAP_NAMES = ["V型エンジン", "誰かの左靴", "ラジカセ", "トマティー40Station", "錆びた鉄パイプ", "壊れたパソコン", "謎の巨大な歯車", "古びた金庫", "業務用の車軸"];
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

export function findLethalGameByUserId(userId: string): { channelId: string, game: GameState } | null {
    for (const [channelId, game] of activeGames.entries()) {
        if (game.players.has(userId)) return { channelId, game };
    }
    return null;
}

export function getGameByInteraction(interaction: any): { channelId: string, game: GameState } | null {
    let game = activeGames.get(interaction.channelId);
    if (game) return { channelId: interaction.channelId, game };
    return findLethalGameByUserId(interaction.user.id);
}

function formatTime(t: number) { return `${t.toString().padStart(2, '0')}:00`; }

function getStatusHeader(game: GameState) {
    if (game.location === 'orbit') return `[ 🛰️ 軌道上 | DAY ${game.day} | 💰 資金: ${game.funds} / ${game.quota}円 ]`;
    const timeIcon = game.time >= 20 ? '🔴' : game.time >= 17 ? '🟡' : '🟢';
    return `[ 🪐 衛星内 | ${timeIcon} ${formatTime(game.time)} | 💰 資金: ${game.funds} / ${game.quota}円 ]`;
}

function getPlayerStatusLine(player: PlayerState) {
    return `\n\n\`[ ❤️ HP: ${player.hp}/100 | 🎒 所持: ${player.inventory}円 ${player.hasTwoHanded ? '| ⚠️両手塞がり' : ''} | 📍 ${player.zone} ]\``;
}

// ============================================================
// UI構築
// ============================================================

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_join').setLabel('参加/退出').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lethal_role_scavenger').setLabel('現場班').setStyle(ButtonStyle.Danger).setEmoji('⛏️'),
        new ButtonBuilder().setCustomId('lethal_role_monitor').setLabel('モニター班').setStyle(ButtonStyle.Primary).setEmoji('💻'),
        new ButtonBuilder().setCustomId('lethal_start').setLabel('出発').setStyle(ButtonStyle.Success).setEmoji('🚀')
    );
}

function getOrbitRow(game: GameState, userId: string) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (userId === game.hostId) {
        row.addComponents(new ButtonBuilder().setCustomId('lethal_land').setLabel('降下する').setStyle(ButtonStyle.Danger).setEmoji('🪐'));
    }
    row.addComponents(new ButtonBuilder().setCustomId('lethal_store').setLabel('ストア').setStyle(ButtonStyle.Primary).setEmoji('🛒'));
    return row;
}

function getPlayerUI(game: GameState, player: PlayerState) {
    if (!player.isAlive) return [];
    if (game.location === 'orbit') return [getOrbitRow(game, player.id)];
    
    // モニター班（船内）
    if (player.role === 'monitor' && player.zone === 'ship') {
        return [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('lethal_monitor').setLabel('レーダー監視').setStyle(ButtonStyle.Primary).setEmoji('💻'),
            new ButtonBuilder().setCustomId('lethal_leave_ship').setLabel('施設へ向かう').setStyle(ButtonStyle.Danger).setEmoji('🚪')
        )];
    }
    
    // 現場班・移動済みモニター
    const moveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_explore_left').setLabel('左へ').setStyle(ButtonStyle.Primary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('lethal_explore_forward').setLabel('前へ').setStyle(ButtonStyle.Primary).setEmoji('⬆️'),
        new ButtonBuilder().setCustomId('lethal_explore_right').setLabel('右へ').setStyle(ButtonStyle.Primary).setEmoji('➡️')
    );
    
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    const localCorpses = game.corpses.filter(c => c.zone === player.zone);
    if (localCorpses.length > 0) {
        actionRow.addComponents(new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('死体回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦'));
    }
    if (player.hasTwoHanded) {
        actionRow.addComponents(new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️'));
    }
    actionRow.addComponents(new ButtonBuilder().setCustomId('lethal_return').setLabel('船を発進させる').setStyle(ButtonStyle.Success).setEmoji('🚀'));
    
    return [moveRow, actionRow]; 
}

function getEncounterRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_qte_glance').setLabel('一瞬だけ見る').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_stare').setLabel('ガン見する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_sneak').setLabel('しゃがんで歩く').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_run').setLabel('走って逃げる').setStyle(ButtonStyle.Danger)
    );
}

async function prepareNewMessage(interaction: any) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
}

async function restoreAllVisibility(client: any, channelId: string, game: GameState) {
    const channel = client.channels.cache.get(channelId) as TextChannel;
    if (!channel) return;
    for (const [pId] of game.players.entries()) {
        await channel.permissionOverwrites.delete(pId).catch(()=>{});
    }
}

// ============================================================
// ハンドラ
// ============================================================

export async function handleLethalStart(interaction: ChatInputCommandInteraction) {
    if (activeGames.has(interaction.channelId)) return interaction.reply({ content: '⚠️ 既に進行中のゲームがあります。', ephemeral: true });
    activeGames.set(interaction.channelId, {
        hostId: interaction.user.id, state: 'lobby', location: 'orbit', isProcessing: false,
        day: 1, time: 8, quota: 500, funds: 0, facilityDanger: 10,
        corpses: [], players: new Map(), activeEncounter: null
    });
    const game = activeGames.get(interaction.channelId)!;
    game.players.set(interaction.user.id, { id: interaction.user.id, name: interaction.user.username, role: 'none', isAlive: true, hp: 100, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false, walkie_talkie: false }, zone: 'orbit' });
    await interaction.reply({ embeds: [updateLobbyMessage(game)], components: [getLobbyRow()] });
}

function updateLobbyMessage(game: GameState) {
    let pList = Array.from(game.players.values()).map(p => `・${p.name} [${p.role === 'scavenger' ? '⛏️現場' : p.role === 'monitor' ? '💻モニター' : '未定'}]`).join('\n');
    return new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTitle('🪐 参加募集ロビー').setDescription(`ホスト: <@${game.hostId}>\n\n**【参加者】**\n${pList || 'なし'}\n\n各自「参加」を押し、役割を選んでください。`).setColor(0x3498db);
}

export async function handleLobbyAction(interaction: any, action: string) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData || gameData.game.state !== 'lobby') return interaction.reply({ content: '⚠️ ロビーが見つかりません。', ephemeral: true });
    const { channelId, game } = gameData;
    const userId = interaction.user.id;
    let player = game.players.get(userId);

    if (action === 'join') {
        if (player) game.players.delete(userId);
        else game.players.set(userId, { id: userId, name: interaction.user.username, role: 'none', isAlive: true, hp: 100, inventory: 0, hasTwoHanded: false, items: { flashlight: false, shovel: false, walkie_talkie: false }, zone: 'orbit' });
    } else if (action === 'role_scavenger' || action === 'role_monitor') {
        if (!player) return interaction.reply({ content: '❌ まず「参加」を押してください。', ephemeral: true });
        player.role = action === 'role_scavenger' ? 'scavenger' : 'monitor';
    } else if (action === 'start') {
        if (interaction.user.id !== game.hostId) return interaction.reply({ content: '❌ 出発させられるのはホストのみです。', ephemeral: true });
        if (game.players.size === 0 || Array.from(game.players.values()).some(p => p.role === 'none')) return interaction.reply({ content: '❌ 役割未定の人がいます。', ephemeral: true });
        game.state = 'playing'; game.location = 'orbit';
        const channel = interaction.client.channels.cache.get(channelId) as TextChannel;
        for (const [pId, p] of game.players.entries()) {
            p.zone = 'orbit';
            if (channel) await channel.permissionOverwrites.create(pId, { ViewChannel: false }).catch(()=>{});
            const user = await interaction.client.users.fetch(pId).catch(()=>{});
            if (user) {
                const dmEmbed = new EmbedBuilder().setTitle('🛰️ 軌道上に到着').setDescription('**THE COMPANYへようこそ。**\nこれより回収業務を開始します。\n（※以降、すべての操作は個別のDMで行います）').setColor(0x000000);
                await user.send({ embeds: [dmEmbed], components: [getOrbitRow(game, pId)] }).catch(()=>{});
            }
        }
        await interaction.update({ content: '🚀 出発しました。全員DMを確認してください。', embeds: [], components: [] });
    } else {
        await interaction.update({ embeds: [updateLobbyMessage(game)], components: [getLobbyRow()] });
    }
}

export async function handleLand(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    if (game.location !== 'orbit' || interaction.user.id !== game.hostId) return interaction.reply({ content: '❌ ホストのみ、または軌道上でのみ可能です。', ephemeral: true });
    await prepareNewMessage(interaction);
    game.location = 'moon'; game.facilityDanger = Math.floor(Math.random() * 30) + 10;
    for (const [pId, p] of game.players.entries()) {
        if (!p.isAlive) continue;
        p.zone = p.role === 'monitor' ? 'ship' : 'entrance';
        const user = await interaction.client.users.fetch(pId).catch(()=>{});
        if (user) {
            const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('🪐 衛星へ降下完了').setDescription(p.role === 'monitor' ? '船内モニター室に配置されました。' : '施設の入口に到着しました。').setColor(0x34495e);
            await user.send({ embeds: [embed], components: getPlayerUI(game, p) }).catch(()=>{});
        }
    }
    await interaction.editReply({ content: '降下しました。', embeds: [], components: [] });
}

export async function handleExplore(interaction: any, direction: 'left' | 'forward' | 'right') {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive) return;
    if (player.zone === 'ship') return interaction.reply({ content: '❌ 船の中からは探索できません。', ephemeral: true });
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 交戦中です！', ephemeral: true });
    if (player.isMoving) return interaction.reply({ content: '⏳ 移動中です…', ephemeral: true });

    player.isMoving = true;
    try {
        if (game.time >= 24) return handleReturn(interaction, true);
        await prepareNewMessage(interaction);
        let dirLabel = direction === 'left' ? "左の通路" : direction === 'right' ? "右の通路" : "正面の扉";
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('👣 移動中...').setDescription(`**${dirLabel}** の奥へ進んでいます…。`).setColor(0x2c3e50)], components: [] });
        await new Promise(r => setTimeout(r, 5000));

        game.time += 1;
        game.facilityDanger = Math.min(100, game.facilityDanger + Math.floor(Math.random() * 15) + 5);
        player.zone = direction;
        
        let dangerModifier = direction === 'left' ? 20 : direction === 'right' ? -15 : 0;
        let scrapMulti = direction === 'left' ? 1.6 : direction === 'right' ? 0.7 : 1.0;
        let successBase = player.items.shovel ? 70 : 45;
        if(direction === 'right') successBase -= 20;
        
        let dangerRoll = game.facilityDanger + dangerModifier + (player.hasTwoHanded ? 15 : 0) - (player.items.flashlight ? 20 : 0);
        const roll = Math.floor(Math.random() * 100) + 1;
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
        let isEncounter = false;

        if (roll <= dangerRoll * 0.4) {
            const damage = Math.floor(Math.random() * 40) + 20;
            player.hp -= damage;
            const cause = DAMAGE_CAUSES[Math.floor(Math.random() * DAMAGE_CAUSES.length)];
            if (player.hp <= 0) {
                player.isAlive = false;
                game.corpses.push({ userId: player.id, name: player.name, value: 50, zone: player.zone });
                embed.setTitle('🩸 死亡').setDescription(`あなたは罠にかかり命を落としました。\n死因: ${cause}`).setColor(0xe74c3c);
                player.inventory = 0; player.hasTwoHanded = false;
            } else {
                embed.setTitle('⚠️ 負傷').setDescription(`**罠にかかった！**\n${cause} (-${damage} HP)\n\n*${await generateDescription('Trap', cause)}*`).setColor(0xe67e22);
            }
        } else if (roll <= dangerRoll) {
            isEncounter = true;
            const enemyType = ['bracken', 'coilhead', 'eyelessdog'][Math.floor(Math.random() * 3)] as EncounterType;
            game.activeEncounter = { userId: player.id, type: enemyType };
            embed.setTitle(`🚨 未知の生物`).setDescription(`**化け物に遭遇！**\n${ENEMIES[enemyType].desc}`).setColor(0x8B0000);
        } else if (roll <= dangerRoll + successBase) {
            const isHeavy = Math.random() < 0.2;
            const val = Math.floor(Math.floor((Math.random() * (isHeavy ? 150 : 80) + 20) * (game.time >= 17 ? 1.5 : 1.0)) * scrapMulti);
            const scrapName = SCRAP_NAMES[Math.floor(Math.random() * SCRAP_NAMES.length)];
            player.inventory += val;
            if (isHeavy) player.hasTwoHanded = true;
            embed.setTitle('🟢 資産回収').setDescription(`**【 ${scrapName} 】を発見！** (+${val}円)`).setColor(0x2ecc71);
        } else {
            embed.setTitle('🟡 異常なし').setDescription(`何も見つからなかった。`).setColor(0x7f8c8d);
        }

        if (player.isAlive) {
            let sounds = "";
            const nearby = Array.from(game.players.values()).filter(p => p.isAlive && p.zone === player.zone && p.id !== player.id);
            if (nearby.length > 0) sounds += "\n\n👣 *近くで誰かの足音がする。*";
            const localCorpses = game.corpses.filter(c => c.zone === player.zone);
            if (localCorpses.length > 0) sounds += `\n\n💀 *足元に ${localCorpses.map(c=>c.name).join('と')} の遺体がある。*`;
            if (!isEncounter && Math.random() * 100 < game.facilityDanger * 0.7) sounds += `\n\n🔊 *奇妙な音が響いている…*`;
            embed.setDescription((embed.data.description || "") + sounds + getPlayerStatusLine(player));
        }

        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription((embed.data.description || "") + '\n\n**【全滅】帰還シークエンス開始。**');
            await interaction.editReply({ embeds: [embed], components: [] });
            restoreAllVisibility(interaction.client, channelId, game); 
        } else {
            await interaction.editReply({ embeds: [embed], components: isEncounter ? [getEncounterRow()] : (player.isAlive ? getPlayerUI(game, player) : []) });
        }
    } finally { player.isMoving = false; }
}

export async function handleQTE(interaction: any, action: string) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !game.activeEncounter || game.activeEncounter.userId !== player.id) return;
    game.isProcessing = true;
    try {
        await prepareNewMessage(interaction);
        const enemy = ENEMIES[game.activeEncounter.type];
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
        if (action === enemy.correct) {
            embed.setTitle('🟢 回避成功').setDescription(`逃げ切った！`).setColor(0x2ecc71);
        } else {
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: 50, zone: player.zone });
            embed.setTitle('🩸 惨殺').setDescription(`殺された。`).setColor(0xe74c3c);
            player.inventory = 0; player.hasTwoHanded = false;
        }
        game.activeEncounter = null;
        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription((embed.data.description || "") + '\n\n**【全滅】**');
            await interaction.editReply({ embeds: [embed], components: [] });
            restoreAllVisibility(interaction.client, channelId, game);
        } else {
            await interaction.editReply({ embeds: [embed], components: player.isAlive ? getPlayerUI(game, player) : [] });
        }
    } finally { game.isProcessing = false; }
}

export async function handleMonitor(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || player.zone !== 'ship') return interaction.reply({ content: '❌ 船内でのみ可能です。', ephemeral: true });
    await prepareNewMessage(interaction);
    const dText = game.facilityDanger > 80 ? "極めて危険。" : "警戒が必要。";
    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('💻 レーダー').setDescription(`**解析結果:**\n*${await generateDescription('Scan', dText)}*`).setColor(0x00FF00);
    await interaction.editReply({ embeds: [embed], components: getPlayerUI(game, player) });
}

export async function handleLeaveShip(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || player.zone !== 'ship') return;
    await prepareNewMessage(interaction);
    player.zone = 'entrance';
    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('🚪 船外へ').setDescription('施設のエントランスに向かった。').setColor(0xe67e22);
    await interaction.editReply({ embeds: [embed], components: getPlayerUI(game, player) });
}

export async function handleRetrieve(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive || player.zone === 'ship') return;
    const idx = game.corpses.findIndex(c => c.zone === player.zone);
    if (idx === -1) return interaction.reply({ content: 'ここには死体がありません。', ephemeral: true });
    await prepareNewMessage(interaction);
    game.time += 1;
    if (Math.random() * 100 <= game.facilityDanger * 0.5) {
        player.hp -= 50;
        if (player.hp <= 0) {
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: 50, zone: player.zone });
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🩸 二次災害').setDescription('死体回収中に死亡。').setColor(0x8B0000)], components: [] });
        } else {
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⚠️ 負傷').setDescription('回収中に罠にかかった！').setColor(0xe67e22)], components: getPlayerUI(game, player) });
        }
    } else {
        const corpse = game.corpses.splice(idx, 1)[0];
        game.funds += corpse.value; player.hasTwoHanded = true;
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('📦 回収完了').setDescription(`${corpse.name}の遺体を回収した。`).setColor(0x8A2BE2)], components: getPlayerUI(game, player) });
    }
}

export async function handleDropHeavy(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const player = gameData.game.players.get(interaction.user.id);
    if (!player || !player.hasTwoHanded) return;
    await prepareNewMessage(interaction);
    player.hasTwoHanded = false; player.inventory = Math.floor(player.inventory / 2);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⚠️ 放棄').setDescription('荷物を捨てて身軽になった。').setColor(0xf39c12)], components: getPlayerUI(gameData.game, player) });
}

export async function handleReturn(interaction: any, isAuto = false) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    if (!isAuto) await prepareNewMessage(interaction);
    let total = 0;
    game.players.forEach(p => { if (p.isAlive) { total += p.inventory; p.inventory = 0; p.hasTwoHanded = false; p.zone = 'orbit'; } });
    game.funds += total;
    game.day += 1; game.location = 'orbit';
    await restoreAllVisibility(interaction.client, channelId, game);
    
    let embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
    if (game.day > 3) {
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setColor(0x00FF00);
            game.day = 1; game.quota += 500; game.funds = 0;
            game.players.forEach(p => { p.isAlive = true; p.hp = 100; p.items = { flashlight: false, shovel: false, walkie_talkie: false }; });
        } else {
            embed.setTitle('🚀 放出').setDescription('ノルマ未達。解雇です。').setColor(0x000000);
            activeGames.delete(channelId);
        }
    } else {
        embed.setTitle('🛰️ 帰還').setDescription('本日分納品完了。').setColor(0x3498db);
        game.corpses = []; game.time = 8;
        game.players.forEach(p => { if (!p.isAlive) p.isAlive = true; p.hp = 100; });
    }

    for (const [pId] of game.players.entries()) {
        const u = await interaction.client.users.fetch(pId).catch(()=>{});
        if (u) await u.send({ embeds: [embed], components: activeGames.has(channelId) ? [getOrbitRow(game, pId)] : [] }).catch(()=>{});
    }
    if (!isAuto) await interaction.editReply({ content: '帰還しました。', embeds: [], components: [] });
}

export async function handleStore(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData || gameData.game.location !== 'orbit') return;
    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel('懐中電灯(100円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel('シャベル(200円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_walkie').setLabel('無線機(150円)').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ content: `共有資金: ${gameData.game.funds}円`, components: [storeRow], ephemeral: true });
}

export async function handleBuy(interaction: any, item: 'flashlight' | 'shovel' | 'walkie_talkie') {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const price = item === 'flashlight' ? 100 : item === 'shovel' ? 200 : 150;
    if (gameData.game.funds < price) return interaction.reply({ content: `❌ 資金不足`, ephemeral: true });
    gameData.game.players.get(interaction.user.id)!.items[item] = true; gameData.game.funds -= price;
    await interaction.reply({ content: `✅ 購入しました。` });
}
