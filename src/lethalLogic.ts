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
// UI構築 (DM向け動的UI)
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
        row.addComponents(new ButtonBuilder().setCustomId('lethal_land').setLabel('降下する(ホストのみ)').setStyle(ButtonStyle.Danger).setEmoji('🪐'));
    }
    row.addComponents(new ButtonBuilder().setCustomId('lethal_store').setLabel('ストア').setStyle(ButtonStyle.Primary).setEmoji('🛒'));
    return row;
}

function getPlayerUI(game: GameState, player: PlayerState) {
    if (!player.isAlive) return [];
    if (game.location === 'orbit') return [getOrbitRow(game, player.id)];
    
    // 💻 モニター班が「船内」にいる場合のみレーダーと降下ボタンを表示
    if (player.role === 'monitor' && player.zone === 'ship') {
        return [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('lethal_monitor').setLabel('レーダー監視').setStyle(ButtonStyle.Primary).setEmoji('💻'),
            new ButtonBuilder().setCustomId('lethal_leave_ship').setLabel('施設へ向かう').setStyle(ButtonStyle.Danger).setEmoji('🚪')
        )];
    }
    
    // ⛏️ 現場班、または「船を降りた」モニター班のUI
    const moveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_explore_left').setLabel('左へ').setStyle(ButtonStyle.Primary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('lethal_explore_forward').setLabel('前へ').setStyle(ButtonStyle.Primary).setEmoji('⬆️'),
        new ButtonBuilder().setCustomId('lethal_explore_right').setLabel('右へ').setStyle(ButtonStyle.Primary).setEmoji('➡️')
    );
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('死体回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦').setDisabled(game.corpses.length === 0),
        new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️').setDisabled(!player.hasTwoHanded),
        new ButtonBuilder().setCustomId('lethal_return').setLabel('船を発進させる(帰還)').setStyle(ButtonStyle.Success).setEmoji('🚀')
    );
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
// コマンドハンドラ群
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
                const dmEmbed = new EmbedBuilder().setTitle('🛰️ 軌道上に到着').setDescription('**THE COMPANYへようこそ。**\nこれよりスクラップの回収業務を開始します。\n（※以降の操作と通信はすべてこのDMで行います）').setColor(0x000000);
                await user.send({ embeds: [dmEmbed], components: [getOrbitRow(game, pId)] }).catch(()=>{});
            }
        }
        await interaction.update({ content: '🚀 出発しました。全員DMを確認してください。', embeds: [], components: [] });
        return;
    }
    await interaction.update({ embeds: [updateLobbyMessage(game)], components: [getLobbyRow()] });
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
            const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('🪐 衛星へ降下完了').setDescription(p.role === 'monitor' ? '船内モニター室に配置されました。\nレーダーで支援してください。' : '施設の入口（エントランス）に到着しました。\n探索ルートを選択してください。').setColor(0x34495e);
            await user.send({ embeds: [embed], components: getPlayerUI(game, p) }).catch(()=>{});
        }
    }
    await interaction.editReply({ content: '降下シークエンスを実行しました。', embeds: [], components: [] });
}

export async function handleExplore(interaction: any, direction: 'left' | 'forward' | 'right') {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    if (game.location !== 'moon') return interaction.reply({ content: '⚠️ 衛星に降下してください。', ephemeral: true });
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 交戦中です！', ephemeral: true });

    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive) return interaction.reply({ content: '👻 死亡しています。', ephemeral: true });
    if (player.role !== 'scavenger') return interaction.reply({ content: '❌ お前はモニター班だ！', ephemeral: true });
    
    // 💡 プレイヤー個別で移動中の連打をロックする
    if ((player as any).isMoving) return interaction.reply({ content: '⏳ 現在移動中です…', ephemeral: true });
    (player as any).isMoving = true;

    try {
        if (game.time >= 24) { return handleReturn(interaction, true); }
        await prepareNewMessage(interaction); 
        
        let dirLabel = direction === 'left' ? "左の通路" : direction === 'right' ? "右の通路" : "正面の扉";

        // ── 🕒 移動時間の演出（5秒待機） ──
        const movingEmbed = new EmbedBuilder()
            .setAuthor({ name: getStatusHeader(game) })
            .setTitle(`👣 移動中...`)
            .setDescription(`**${dirLabel}** の奥へと進んでいる…。\n*(※到着まで約5秒かかります。この間にチャットで状況を報告しましょう)*`)
            .setColor(0x2c3e50);
        
        // 一旦UIのボタンを消して移動中画面を表示
        await interaction.editReply({ embeds: [movingEmbed], components: [] });

        // 5秒間待機
        await new Promise(resolve => setTimeout(resolve, 5000));
        // ────────────────────────────────

        game.time += 1;
        game.facilityDanger = Math.min(100, game.facilityDanger + Math.floor(Math.random() * 15) + 5);
        player.zone = direction; // 📍 現在地（Zone）を更新
        
        let dangerModifier = direction === 'left' ? 20 : direction === 'right' ? -15 : 0;
        let scrapMulti = direction === 'left' ? 1.6 : direction === 'right' ? 0.7 : 1.0;
        let successBase = player.items.shovel ? 70 : 45;
        if(direction === 'right') successBase -= 20;
        
        let dangerRoll = game.facilityDanger + dangerModifier + (player.hasTwoHanded ? 15 : 0) - (player.items.flashlight ? 20 : 0);

        const roll = Math.floor(Math.random() * 100) + 1;
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
        let isEncounter = false;
        
        // 罠死 (サイレントキル)
        if (roll <= dangerRoll * 0.4) {
            const damage = Math.floor(Math.random() * 40) + 20;
            player.hp -= damage;
            const cause = DAMAGE_CAUSES[Math.floor(Math.random() * DAMAGE_CAUSES.length)];
            
            if (player.hp <= 0) {
                player.isAlive = false;
                game.corpses.push({ userId: player.id, name: player.name, value: 50 });
                embed.setTitle('🩸 死亡').setDescription(`あなたは罠にかかり命を落としました。\n死因: ${cause}\n（※以降、通信と操作はできません）`).setColor(0xe74c3c);
                player.inventory = 0; player.hasTwoHanded = false;
            } else {
                embed.setTitle('⚠️ 負傷・トラップ遭遇').setDescription(`**罠にかかった！**\n${cause} (-${damage} HP)\n\n*${await generateDescription('Trap', cause)}*`).setColor(0xe67e22);
            }
        } 
        // モンスター遭遇
        else if (roll <= dangerRoll) {
            isEncounter = true;
            const enemyType = ['bracken', 'coilhead', 'eyelessdog'][Math.floor(Math.random() * 3)] as EncounterType;
            game.activeEncounter = { userId: player.id, type: enemyType };
            embed.setTitle(`🚨 未知の生物に遭遇`).setDescription(`**化け物に遭遇した！**\n${ENEMIES[enemyType].desc}\n\n**直ちに対処行動を選択しろ。**`).setColor(0x8B0000);
        } 
        // スクラップ発見
        else if (roll <= dangerRoll + successBase) {
            const isHeavy = Math.random() < 0.2;
            const val = Math.floor(Math.floor((Math.random() * (isHeavy ? 150 : 80) + 20) * (game.time >= 17 ? 1.5 : 1.0)) * scrapMulti);
            const scrapName = SCRAP_NAMES[Math.floor(Math.random() * SCRAP_NAMES.length)];
            player.inventory += val;
            if (isHeavy) player.hasTwoHanded = true;
            embed.setTitle('🟢 資産回収').setDescription(`**【 ${scrapName} 】を発見！** (+${val}円)\n\n*${await generateDescription('Scrap', scrapName)}*`).setColor(0x2ecc71);
        } 
        // ハズレ
        else {
            embed.setTitle('🟡 異常なし').setDescription(`奥へ進んだが、めぼしいものは見つからなかった。\n\n*${await generateDescription('Empty Room', '何もない空間')}*`).setColor(0x7f8c8d);
        }

        // ── 足音＆環境音システム ──
        if (player.isAlive) {
            let ambientSound = "";
            const nearbyPlayers = Array.from(game.players.values()).filter(p => p.isAlive && p.zone === player.zone && p.id !== player.id);
            if (nearbyPlayers.length > 0) {
                ambientSound += "\n\n👣 *…すぐ近くで、誰かの足音が聞こえる。*";
            }
            
            if (!isEncounter && Math.random() * 100 < game.facilityDanger * 0.7) {
                const scarySounds = ["重い足音が響いている…", "金属が軋むような嫌な音がした…", "遠くで奇妙な咆哮が聞こえた…", "湿った何かが這い回る音がする…"];
                ambientSound += `\n\n🔊 *…${scarySounds[Math.floor(Math.random() * scarySounds.length)]}*`;
            }

            if (ambientSound) {
                embed.setDescription(embed.data.description + ambientSound);
            }
            embed.setDescription(embed.data.description + getPlayerStatusLine(player));
        }
        // ------------------------------

        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription(embed.data.description + '\n\n**【全滅】全従業員の生命反応が途絶えました。\n自動帰還シークエンスを開始します。**');
            await interaction.editReply({ embeds: [embed], components: [] });
            restoreAllVisibility(interaction.client, channelId, game); 
        } else {
            await interaction.editReply({ embeds: [embed], components: isEncounter ? [getEncounterRow()] : (player.isAlive ? getPlayerUI(game, player) : []) });
        }
    } finally { 
        (player as any).isMoving = false; // 移動完了でロック解除
    }
}

export async function handleQTE(interaction: any, action: string) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    if (!game.activeEncounter || game.activeEncounter.userId !== interaction.user.id) return interaction.reply({ content: '❌ 操作できません。', ephemeral: true });
    if (game.isProcessing) return interaction.reply({ content: '⏳ 処理中…', ephemeral: true });
    game.isProcessing = true;
    try {
        await prepareNewMessage(interaction);
        const player = game.players.get(interaction.user.id)!;
        const enemy = ENEMIES[game.activeEncounter.type];
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });

        if (action === enemy.correct) {
            embed.setTitle('🟢 危機回避').setDescription(`**${enemy.name} から逃げ切った！**\n\n*${await generateDescription('Escape', '無事逃げ切った。')}*${getPlayerStatusLine(player)}`).setColor(0x2ecc71);
        } else {
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: 50 });
            embed.setTitle('🩸 惨殺 (死亡)').setDescription(`対処を誤り、${enemy.name} に惨殺されました。\n（※以降、あなたは喋ることも操作することもできません）`).setColor(0xe74c3c);
            player.inventory = 0; player.hasTwoHanded = false;
        }

        game.activeEncounter = null; 
        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription(embed.data.description + '\n\n**【全滅】全従業員の生命反応が途絶えました。\n自動帰還シークエンスを開始します。**');
            await interaction.editReply({ embeds: [embed], components: [] });
            restoreAllVisibility(interaction.client, channelId, game);
        } else {
            await interaction.editReply({ embeds: [embed], components: player.isAlive ? getPlayerUI(game, player) : [] });
        }
    } finally { game.isProcessing = false; }
}

export async function handleMonitor(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return interaction.reply({ content: '⚠️ ゲームが見つかりません。', ephemeral: true });
    const { game } = gameData;
    if (game.location !== 'moon') return interaction.reply({ content: '⚠️ 衛星降下後のみ可能です。', ephemeral: true });
    const player = game.players.get(interaction.user.id);
    if (!player || player.role !== 'monitor') return interaction.reply({ content: '❌ モニター班のみ可能です。', ephemeral: true });
    if (game.isProcessing) return interaction.reply({ content: '⏳ 通信中…', ephemeral: true });
    
    game.isProcessing = true;
    try {
        await prepareNewMessage(interaction);
        let dText = game.facilityDanger > 80 ? "極めて危険。複数の巨大な生体反応が接近中。" : game.facilityDanger > 50 ? "危険。未知の動体反応あり。" : "警戒。かすかなノイズを検知。";
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('💻 モニター解析完了').setDescription(`**【レーダー解析結果】**\n*${await generateDescription('Scan', dText)}*\n\n[現在地] 📍${player.zone}`).setColor(game.facilityDanger > 70 ? 0xFF0000 : 0x00FF00);
        await interaction.editReply({ embeds: [embed], components: getPlayerUI(game, player) });
    } finally { game.isProcessing = false; }
}

export async function handleRetrieve(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive) return;
    if (game.isProcessing) return interaction.reply({ content: '⏳ 通信中…', ephemeral: true });
    game.isProcessing = true;
    try {
        await prepareNewMessage(interaction);
        game.time += 1; game.facilityDanger += 10;
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });

        if (Math.random() * 100 <= game.facilityDanger * 0.5) {
            player.hp -= 50;
            if (player.hp <= 0) {
                player.isAlive = false;
                game.corpses.push({ userId: player.id, name: player.name, value: 50 });
                embed.setTitle('🩸 二次災害 (死亡)').setDescription(`死体回収中に罠にかかり死亡しました。`).setColor(0x8B0000);
            } else {
                embed.setTitle('⚠️ 二次災害 (負傷)').setDescription(`**死体を運ぼうとして罠にかかった！** (-50 HP)${getPlayerStatusLine(player)}`).setColor(0xe67e22);
            }
        } else {
            const corpse = game.corpses.shift()!;
            game.funds += corpse.value; player.hasTwoHanded = true; 
            embed.setTitle('📦 遺体回収').setDescription(`**${corpse.name} の遺体を回収した！**\n保険金 **${corpse.value}円** 獲得。\n(※死体を抱えたため両手が塞がりました)${getPlayerStatusLine(player)}`).setColor(0x8A2BE2);
        }
        await interaction.editReply({ embeds: [embed], components: player.isAlive ? getPlayerUI(game, player) : [] });
    } finally { game.isProcessing = false; }
}

export async function handleDropHeavy(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !player.hasTwoHanded) return interaction.reply({ content: '⚠️ 重量物は持っていません。', ephemeral: true });
    
    await prepareNewMessage(interaction);
    player.hasTwoHanded = false; player.inventory = Math.floor(player.inventory / 2); 
    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('⚠️ 重量物放棄').setDescription(`重量物を放棄し身軽になりました。\n(ペナルティ: 所持スクラップ価値半減)${getPlayerStatusLine(player)}`).setColor(0xf39c12);
    await interaction.editReply({ embeds: [embed], components: getPlayerUI(game, player) });
}

export async function handleReturn(interaction: any, isAuto = false) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    if (game.activeEncounter) return interaction.reply({ content: '⚠️ 仲間が交戦中です！', ephemeral: true });
    
    if (!isAuto) await prepareNewMessage(interaction);
    let total = 0;
    game.players.forEach(p => { if (p.isAlive) { total += p.inventory; p.inventory = 0; p.hasTwoHanded = false; p.zone = 'orbit'; } });
    game.funds += total;
    game.day += 1; game.location = 'orbit'; 
    let embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
    const prefix = isAuto ? '🕛 深夜0時経過：自動発進\n' : '';

    await restoreAllVisibility(interaction.client, channelId, game);

    if (game.day > 3) {
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setDescription(`${prefix}要求額 ${game.quota}円 に対して ${game.funds}円 を納品しました。`).setColor(0x00FF00);
            game.day = 1; game.time = 8; game.quota += 500; game.funds = 0; game.corpses = []; game.facilityDanger = 10;
            game.players.forEach(p => { p.isAlive = true; p.hp = 100; p.items = { flashlight: false, shovel: false, walkie_talkie: false }; p.zone = 'orbit'; });
        } else {
            embed.setTitle('🚀 船外放出').setDescription(`${prefix}ノルマ未達（現在: ${game.funds}円）。あなた達は会社にとって不要です。`).setColor(0x000000);
            activeGames.delete(channelId);
        }
    } else {
        embed.setTitle('🛰️ 軌道上へ帰還').setDescription(`${prefix}本日分の納品完了。\nストアで準備を整え、再び降下してください。`).setColor(0x3498db);
        game.corpses = []; game.time = 8; game.facilityDanger = 10;
        game.players.forEach(p => { if (!p.isAlive) p.isAlive = true; p.hp = 100; p.zone = 'orbit'; });
    }

    // 全員のDMに結果を送信
    for (const [pId, p] of game.players.entries()) {
        const user = await interaction.client.users.fetch(pId).catch(()=>{});
        if (user) {
            await user.send({ embeds: [embed], components: activeGames.has(channelId) ? [getOrbitRow(game, pId)] : [] }).catch(()=>{});
        }
    }
    if (!isAuto) await interaction.editReply({ content: '船を発進させました。', embeds: [], components: [] });
}

export async function handleStore(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    if (game.location !== 'orbit') return interaction.reply({ content: '❌ ストアは軌道上でしか開けません！', ephemeral: true });
    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel('懐中電灯(100円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel('シャベル(200円)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_walkie').setLabel('無線機(150円)').setStyle(ButtonStyle.Success)
    );
    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) }).setTitle('🛒 カンパニー・ストア').setDescription(`共有資金: **${game.funds}円**\n\n・🔦 懐中電灯 (100円) : トラップ回避率UP\n・⛏️ シャベル (200円) : ハズレ部屋を減らす\n・📻 無線機 (150円) : これがないと遠くの味方へ通信不可`).setColor(0xFFA500);
    await interaction.reply({ embeds: [embed], components: [storeRow], ephemeral: true });
}

export async function handleBuy(interaction: any, item: 'flashlight' | 'shovel' | 'walkie_talkie') {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const price = item === 'flashlight' ? 100 : item === 'shovel' ? 200 : 150;
    if (game.funds < price) return interaction.reply({ content: `❌ 資金不足です。`, ephemeral: true });
    
    game.players.get(interaction.user.id)!.items[item] = true; game.funds -= price;
    const itemName = item === 'flashlight' ? '🔦懐中電灯' : item === 'shovel' ? '⛏️シャベル' : '📻無線機';
    await interaction.reply({ content: `✅ **${itemName}** を購入しました！(残金: ${game.funds}円)` });
}

export async function handleLeaveShip(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive || player.zone !== 'ship') return;
    
    await prepareNewMessage(interaction);
    player.zone = 'entrance'; // 船からエントランスへ移動
    
    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) })
        .setTitle('🚪 船外へ')
        .setDescription(`**${player.name}** はモニターから離れ、自ら施設のエントランスへ向かった！\n（※もう船には戻れず、レーダーも使えません）${getPlayerStatusLine(player)}`)
        .setColor(0xe67e22);
    
    await interaction.editReply({ embeds: [embed], components: getPlayerUI(game, player) });

    // エントランスにいる他のプレイヤーに「合流した」ことを通知
    const nearbyPlayers = Array.from(game.players.values()).filter(p => p.isAlive && p.zone === 'entrance' && p.id !== player.id);
    for (const target of nearbyPlayers) {
        const targetUser = await interaction.client.users.fetch(target.id).catch(()=>{});
        if (targetUser) await targetUser.send(`🚪 **[${player.name}]** が船を降りてエントランスへ合流してきた！`).catch(()=>{});
    }
}
