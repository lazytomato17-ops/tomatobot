// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, TextChannel, VoiceChannel } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { startGhostCamera } from './voiceTranscription';

// ── Types & Interfaces ──
type RoleType = 'navigator' | 'scavenger';
type AreaType = 'ship' | 'field' | 'facility' | 'ghost';
type HPState = 'healthy' | 'injured' | 'dying' | 'dead';
type MonsterType = 'patrol' | 'ambush' | 'chaser' | 'sound';

interface Scrap { id: string; name: string; value: number; weight: 'light' | 'medium' | 'heavy'; }
interface Room { id: number; name: string; desc: string; exits: { n?: number, s?: number, e?: number, w?: number }; scrap?: Scrap; }
interface Monster { id: string; type: MonsterType; area: 'field' | 'facility'; x: number; y: number; roomId: number; isChasing?: string; }

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    hp: HPState;
    isBleeding: boolean;
    currentArea: AreaType;
    x: number;
    y: number;
    roomId: number;
    inventory: Scrap[];
    hasTransceiver: boolean;
    isRadioActive: boolean;
    encounterActive?: { monsterType: MonsterType, timestamp: number, timeout: number };
}

interface GameState {
    guildId: string;
    hostId: string;
    state: 'lobby' | 'playing' | 'ended';
    categoryId?: string;
    ghostTextId?: string;
    vcIds: Map<string, string>;
    players: Map<string, PlayerState>;
    monsters: Monster[];
    day: number;
    quota: number;
    totalCredits: number;
    shipScraps: Scrap[];
    // マップデータ
    fieldSize: number;
    fieldGrid: number[][]; // 0:空, 1:木(壁), 2:船, 3:施設
    facilityRooms: Room[];
    facilityEntrance: { x: number, y: number };
    // タイマー管理
    timeRemainingSec: number;
    gameLoopInterval?: NodeJS.Timeout;
}

const activeGames = new Map<string, GameState>();

// ── Constants & Helpers ──
const FIELD_SIZE = 20;
const DAY_TIME_SEC = 900; // 15分 = 900秒
const HP_STAGES: Record<HPState, { next: HPState, label: string, icon: string }> = {
    'healthy': { next: 'injured', label: '健康', icon: '🟢' },
    'injured': { next: 'dying', label: '負傷(速度低下)', icon: '🟡' },
    'dying': { next: 'dead', label: '瀕死(出血)', icon: '🔴' },
    'dead': { next: 'dead', label: '死亡', icon: '💀' }
};

// フィールドを5x5マスのブロックに分割し、A〜Pのエリア名を返す（VC動的作成・制限回避用）
function getFieldSector(x: number, y: number): string {
    const col = Math.floor(x / 5);
    const row = Math.floor(y / 5);
    return String.fromCharCode(65 + (row * 4 + col)); // A〜P
}

// 2点間の方角を絵文字で返す
function getDirectionEmoji(fromX: number, fromY: number, toX: number, toY: number): string {
    if (fromX === toX && fromY === toY) return '📍(現在地)';
    let ns = '', ew = '';
    if (fromY > toY) ns = '⬆️'; else if (fromY < toY) ns = '⬇️';
    if (fromX > toX) ew = '➡️'; else if (fromX < toX) ew = '⬅️';

    if (ns === '⬆️' && ew === '➡️') return '↗️';
    if (ns === '⬆️' && ew === '⬅️') return '↖️';
    if (ns === '⬇️' && ew === '➡️') return '↘️';
    if (ns === '⬇️' && ew === '⬅️') return '↙️';
    return ns || ew;
}

// ── Economy & Map Generation ──
function calculateQuota(day: number): number {
    let q = 130;
    for (let i = 1; i < day; i++) q = Math.floor(q * 1.4 + 30);
    return Math.min(q, 2000);
}

function generateField(): { grid: number[][], entrance: {x:number, y:number} } {
    const grid = Array.from({ length: FIELD_SIZE }, () => Array(FIELD_SIZE).fill(0));
    // 船 (2,2)
    grid[2][2] = 2;
    // 施設 (12,10)〜(18,18)のランダム
    const fx = Math.floor(Math.random() * 7) + 12;
    const fy = Math.floor(Math.random() * 9) + 10;
    grid[fy][fx] = 3;

    // 障害物 (約35%)
    for (let y = 0; y < FIELD_SIZE; y++) {
        for (let x = 0; x < FIELD_SIZE; x++) {
            if (grid[y][x] === 0 && Math.random() < 0.35) grid[y][x] = 1; // 木/壁
        }
    }
    return { grid, entrance: { x: fx, y: fy } };
}

function generateFacility(): Room[] {
    const rooms: Room[] = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
        rooms.push({
            id: i,
            name: i === 0 ? '施設エントランス' : i === count - 1 ? 'メイン倉庫' : `区画-${i}`,
            desc: i === 0 ? '外の風が吹き込んでいる。' : '埃っぽい空気が漂っている。',
            exits: {},
            scrap: i > 0 && Math.random() < 0.5 ? { id: `${Date.now()}_${i}`, name: '金属板', value: 65, weight: 'medium' } : undefined
        });
    }
    // 単純な直列ルート
    for (let i = 0; i < count - 1; i++) {
        rooms[i].exits.n = i + 1;
        rooms[i + 1].exits.s = i;
    }
    return rooms;
}

// ── Game Commands ──
export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    if (activeGames.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ 既に募集中のゲームがあります。' });

    const game: GameState = {
        guildId: interaction.guildId!,
        hostId: interaction.user.id,
        state: 'lobby',
        vcIds: new Map(),
        players: new Map(),
        monsters: [],
        day: 1,
        quota: calculateQuota(1),
        totalCredits: 0,
        shipScraps: [],
        fieldSize: FIELD_SIZE,
        fieldGrid: [],
        facilityRooms: [],
        facilityEntrance: { x: 0, y: 0 },
        timeRemainingSec: DAY_TIME_SEC
    };
    activeGames.set(interaction.channelId, game);
    await interaction.editReply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

function buildLobbyEmbed(game: GameState) {
    const pList = Array.from(game.players.values()).map(p => `・${p.name} [${p.role === 'navigator' ? '💻ナビゲーター' : '⛏️探索者'}]`).join('\n');
    return new EmbedBuilder()
        .setTitle('📻 FREQUENCY - ロビー')
        .setDescription(`**【参加者】**\n${pList || 'なし'}\n\n※2人プレイ時は自動的に両者【探索者(簡易ナビ付)】になります。`)
        .setColor(0x2b2d31);
}

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_join_nav').setLabel('ナビゲーター(船内)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('freq_join_scav').setLabel('探索者(現場)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_launch').setLabel('🚀 着陸(開始)').setStyle(ButtonStyle.Success)
    );
}

// ── Interaction Routing ──
export async function handleButton(interaction: any) {
    let game = activeGames.get(interaction.channelId);
    if (!game) game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

    if (action.startsWith('join_')) {
        const role = action === 'join_nav' ? 'navigator' : 'scavenger';
        game.players.set(userId, {
            id: userId, name: interaction.user.username, role, hp: 'healthy', isBleeding: false,
            currentArea: role === 'navigator' ? 'ship' : 'field', x: 2, y: 2, roomId: 0,
            inventory: [], hasTransceiver: true, isRadioActive: false
        });
        return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
    }
    
    if (action === 'launch') {
        if (userId !== game.hostId) return interaction.reply({ content: 'ホストのみ開始可能です。', ephemeral: true });
        
        // 2人プレイルール適用
        if (game.players.size === 2) {
            game.players.forEach(p => p.role = 'scavenger');
        }

        await interaction.deferUpdate();
        await interaction.editReply({ content: '🚀 環境を構築中...', embeds: [], components: [] });
        await setupGameEnvironment(interaction.client, game);
        return;
    }

    const player = game.players.get(userId);
    if (!player) return;

    if (player.hp === 'dead' && action === 'end_game') {
        await cleanupGame(interaction.client, game);
        return interaction.update({ content: '🛑 ゲームを終了しました。', embeds: [], components: [] });
    }

    if (player.hp === 'dead') return; // 死者は操作不可
    await executePlayerAction(interaction, action, game, player);
}

// ── Environment Setup & Game Loop ──
async function setupGameEnvironment(client: any, game: GameState) {
    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    const category = await guild.channels.create({ name: '🔴 FREQUENCY ZONE', type: ChannelType.GuildCategory });
    game.categoryId = category.id;
    const ghostText = await guild.channels.create({ name: '👻ghost-chat', type: ChannelType.GuildText, parent: category.id });
    game.ghostTextId = ghostText.id;
    
    const shipVc = await guild.channels.create({ name: '🛸 ship', type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
    const ghostVc = await guild.channels.create({ name: '👻 ghost', type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
    game.vcIds.set('ship', shipVc.id);
    game.vcIds.set('ghost', ghostVc.id);

    // マップ初期化
    const fieldData = generateField();
    game.fieldGrid = fieldData.grid;
    game.facilityEntrance = fieldData.entrance;
    game.facilityRooms = generateFacility();

    // 怪物の初期配置 (施設内に2体、待伏型1体含む)
    game.monsters.push({ id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 });
    game.monsters.push({ id: 'm2', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: 8 });

    game.state = 'playing';

    // ゴーストカメラ起動
    const connection = joinVoiceChannel({ channelId: shipVc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator as any, selfDeaf: false, selfMute: false });
    startGhostCamera(connection, ghostText);

    // ゲームループ
    startGameLoop(client, game);

    // 初期通知
    for (const [pId, p] of game.players.entries()) {
        await updatePlayerVC(client, game, p);
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, '【着陸完了】探索を開始してください。トランシーバーは全員に支給済です。');
    }
}

function startGameLoop(client: any, game: GameState) {
    let tick = 0;
    game.gameLoopInterval = setInterval(async () => {
        game.timeRemainingSec--;
        tick++;

        // 出血ダメージ判定 (30秒ごと)
        if (tick % 30 === 0) {
            for (const p of game.players.values()) {
                if (p.hp !== 'dead' && p.isBleeding) {
                    takeDamage(p, game);
                    const user = await client.users.fetch(p.id).catch(() => null);
                    if (user) await sendPlayerUI(user, game, p, '🩸 出血により状態が悪化した...');
                }
            }
        }

        // 強制離陸通知
        if (game.timeRemainingSec === 300 || game.timeRemainingSec === 60) {
            broadcastToAll(client, game, `🚨 【警告】強制離陸まで残り ${game.timeRemainingSec / 60} 分。船に戻らない者は置き去りになります。`);
        }

        // 時間切れ
        if (game.timeRemainingSec <= 0) {
            clearInterval(game.gameLoopInterval);
            await handleForcedTakeoff(client, game);
        }
    }, 1000);
}

// ── Logic & Actions ──
async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState) {
    let msg = '';

    // エンカウント時の逃走処理
    if (player.encounterActive && action.startsWith('escape_')) {
        const timeTaken = Date.now() - player.encounterActive.timestamp;
        if (action === 'escape_stay' || timeTaken > player.encounterActive.timeout * 1000) {
            msg = handleEncounterDamage(player, game);
        } else {
            msg = '💨 間一髪で逃げ切った！';
            const dir = action.replace('escape_', '');
            handleMovement(game, player, dir); 
        }
        player.encounterActive = undefined;
        await updatePlayerVC(interaction.client, game, player);
        return interaction.update({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) });
    }

    if (action === 'toggle_radio') {
        player.isRadioActive = !player.isRadioActive;
        await updatePlayerVC(interaction.client, game, player);
        msg = player.isRadioActive ? '📻 通信を開いた。' : '🔇 通信を切った。';
    } else if (action.startsWith('move_')) {
        const dir = action.replace('move_', '');
        msg = handleMovement(game, player, dir);
        await updatePlayerVC(interaction.client, game, player);
        msg = checkMonsterEncounter(player, game) || msg;
    } else if (action === 'enter_facility') {
        player.currentArea = 'facility'; player.roomId = 0;
        msg = '🚪 施設内に侵入した。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'exit_facility') {
        player.currentArea = 'field'; player.x = game.facilityEntrance.x; player.y = game.facilityEntrance.y;
        msg = '🌍 外に出た。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'enter_ship') {
        player.currentArea = 'ship';
        msg = '🛸 船に戻った。安全だ。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'grab') {
        const room = game.facilityRooms[player.roomId];
        if (room && room.scrap && player.inventory.length < 4) {
            player.inventory.push(room.scrap);
            msg = `📦 ${room.scrap.name} を拾った！`;
            room.scrap = undefined;
        } else {
            msg = 'インベントリが満杯だ。';
        }
    } else if (action === 'store') {
        if (player.inventory.length > 0) {
            game.shipScraps.push(...player.inventory);
            msg = `📦 ${player.inventory.length}個のスクラップを格納した！`;
            player.inventory = [];
        }
    }

    await interaction.update({
        embeds: [buildPlayerUIEmbed(game, player, msg)],
        components: getPlayerControlRow(player, game)
    });
}

function handleMovement(game: GameState, player: PlayerState, dir: string): string {
    if (player.currentArea === 'field') {
        let nx = player.x, ny = player.y;
        if (dir === 'n') ny--; if (dir === 's') ny++; if (dir === 'e') nx++; if (dir === 'w') nx--;
        if (nx >= 0 && nx < FIELD_SIZE && ny >= 0 && ny < FIELD_SIZE && game.fieldGrid[ny][nx] !== 1) {
            player.x = nx; player.y = ny;
            return `足を進めた。(現在地: ${player.x}, ${player.y})`;
        }
        return '木や崖に阻まれて進めない。';
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        const nextId = room.exits[dir as keyof typeof room.exits];
        if (nextId !== undefined) {
            player.roomId = nextId;
            return `扉を抜けた。`;
        }
        return 'その方向には進めない。';
    }
    return '';
}

function checkMonsterEncounter(player: PlayerState, game: GameState): string | null {
    if (player.isRadioActive && player.currentArea !== 'ship') return null;
    
    const monster = game.monsters.find(m => m.area === player.currentArea && (player.currentArea === 'facility' ? m.roomId === player.roomId : (m.x === player.x && m.y === player.y)));
    
    if (monster) {
        if (monster.type === 'ambush') {
            takeDamage(player, game, true);
            return '🩸 **【即死】部屋の暗がりに潜んでいた化け物に襲撃された。**';
        } else {
            const timeout = monster.type === 'chaser' ? 3 : 5;
            player.encounterActive = { monsterType: monster.type, timestamp: Date.now(), timeout };
            return `⚠ **何かがいる！ [猶予: ${timeout}秒]** すぐに逃げろ！`;
        }
    }
    
    // 2人プレイ簡易ナビ
    if (game.players.size === 2 && player.currentArea === 'facility') {
        const nearMonster = game.monsters.find(m => m.area === 'facility' && Object.values(game.facilityRooms[player.roomId].exits).includes(m.roomId));
        if (nearMonster) return '⚠ [簡易ナビ] 隣の部屋から嫌な気配がする...';
    }
    return null;
}

function handleEncounterDamage(player: PlayerState, game: GameState): string {
    const type = player.encounterActive?.monsterType;
    if (type === 'chaser') {
        if (player.hp === 'dying') { takeDamage(player, game, true); return '🩸 追いつかれ、命を落とした。'; }
        takeDamage(player, game);
        player.isBleeding = true;
        return '💥 深手を負った！(出血開始)';
    } else {
        takeDamage(player, game);
        return '💥 攻撃を受けた！';
    }
}

function takeDamage(player: PlayerState, game: GameState, instantKill = false) {
    if (instantKill || player.hp === 'dying') {
        player.hp = 'dead';
        player.currentArea = 'ghost';
        player.inventory = []; 
    } else {
        player.hp = HP_STAGES[player.hp].next;
    }
}

// ── UI Rendering ──
function renderGrid(game: GameState, player: PlayerState, isNav: boolean): string {
    if (player.currentArea === 'field') {
        const size = isNav ? 3 : 2;
        let out = '';
        for (let y = player.y - size; y <= player.y + size; y++) {
            for (let x = player.x - size; x <= player.x + size; x++) {
                if (x === player.x && y === player.y) out += '👤';
                else if (x < 0 || x >= FIELD_SIZE || y < 0 || y >= FIELD_SIZE) out += '🌫';
                else if (game.fieldGrid[y][x] === 1) out += '🌲';
                else if (game.fieldGrid[y][x] === 2) out += '🛸';
                else if (game.fieldGrid[y][x] === 3) out += '🏭';
                else out += '土';
            }
            out += '\n';
        }
        return `\`\`\`\n${out}\n\`\`\``;
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        let out = '';
        out += `⬛${room.exits.n !== undefined ? '🚪' : '⬛'}⬛\n`;
        out += `${room.exits.w !== undefined ? '🚪' : '⬛'}👤${room.exits.e !== undefined ? '🚪' : '⬛'}\n`;
        out += `⬛${room.exits.s !== undefined ? '🚪' : '⬛'}⬛\n`;
        return `\`\`\`\n${out}\n\`\`\``;
    }
    return '';
}

function buildPlayerUIEmbed(game: GameState, player: PlayerState, msg: string = '') {
    if (player.hp === 'dead') {
        return new EmbedBuilder().setTitle('💀 霊界').setDescription(`${msg}\n\nあなたは死にました。#ghost-chat で生存者を監視してください。`).setColor(0x000000);
    }

    const hpData = HP_STAGES[player.hp];
    let locationStr = '';
    let descStr = '';

    if (player.currentArea === 'ship') {
        locationStr = '🛸 船内';
        descStr = '安全な船内だ。レーダーや端末がある。\n';
    } else if (player.currentArea === 'field') {
        locationStr = `🌍 外 [${player.x}, ${player.y}] (エリア${getFieldSector(player.x, player.y)})`;
        descStr = '荒野が広がっている。\n\n';
        
        const facDir = getDirectionEmoji(player.x, player.y, game.facilityEntrance.x, game.facilityEntrance.y);
        const shipDir = getDirectionEmoji(player.x, player.y, 2, 2);
        
        descStr += `🛸 船の方角: ${shipDir}\n`;
        descStr += `🏭 施設の方角: ${facDir}`;

    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        locationStr = `🏭 施設 [${room.name}]`;
        descStr = `${room.desc}\n\n`;

        let exitDir = '';
        if (room.exits.n !== undefined && room.exits.n < player.roomId) exitDir = '⬆️';
        else if (room.exits.s !== undefined && room.exits.s < player.roomId) exitDir = '⬇️';
        else if (room.exits.e !== undefined && room.exits.e < player.roomId) exitDir = '➡️';
        else if (room.exits.w !== undefined && room.exits.w < player.roomId) exitDir = '⬅️';
        
        if (exitDir && player.roomId !== 0) {
            descStr += `🚪 出口(エントランス)の気配: ${exitDir}`;
        }
    }
    
    const embedColor = player.encounterActive ? 0xFF0000 : (player.isRadioActive ? 0x00FF00 : 0x2b2d31);
    
    const embed = new EmbedBuilder()
        .setTitle(locationStr)
        .setDescription(`💬 ${msg}\n${renderGrid(game, player, player.role === 'navigator')}\n${descStr}`)
        .addFields(
            { name: '📊 状態', value: `${hpData.icon} ${hpData.label} ${player.isBleeding ? '(🩸出血中)' : ''}`, inline: true },
            { name: '⏳ 時間/ノルマ', value: `残り ${Math.floor(game.timeRemainingSec/60)}分 | ${game.totalCredits}/${game.quota}cr`, inline: true },
            { name: `🎒 所持品 (${player.inventory.length}/4)`, value: player.inventory.length > 0 ? player.inventory.map(s => s.name).join(', ') : '空', inline: false }
        )
        .setColor(embedColor);

    if (player.currentArea === 'facility' && game.facilityRooms[player.roomId].scrap) {
        embed.addFields({ name: '✨ 発見', value: `床に **${game.facilityRooms[player.roomId].scrap!.name}** がある！` });
    }
    return embed;
}

function getPlayerControlRow(player: PlayerState, game: GameState): ActionRowBuilder<ButtonBuilder>[] {
    if (player.hp === 'dead') return [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('freq_end_game').setLabel('🧹 ゲーム終了').setStyle(ButtonStyle.Danger))];

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    if (player.encounterActive) {
        const r = new ActionRowBuilder<ButtonBuilder>();
        r.addComponents(new ButtonBuilder().setCustomId('freq_escape_n').setLabel('北へ逃げる').setStyle(ButtonStyle.Primary));
        r.addComponents(new ButtonBuilder().setCustomId('freq_escape_s').setLabel('南へ逃げる').setStyle(ButtonStyle.Primary));
        r.addComponents(new ButtonBuilder().setCustomId('freq_escape_stay').setLabel('その場に留まる').setStyle(ButtonStyle.Danger));
        return [r];
    }

    const moveRow = new ActionRowBuilder<ButtonBuilder>();
    const actionRow = new ActionRowBuilder<ButtonBuilder>();

    if (player.currentArea === 'field') {
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_n').setLabel('北').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_s').setLabel('南').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_e').setLabel('東').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_w').setLabel('西').setStyle(ButtonStyle.Secondary));
        if (player.x === 2 && player.y === 2) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_enter_ship').setLabel('🛸 船に戻る').setStyle(ButtonStyle.Success));
        if (player.x === game.facilityEntrance.x && player.y === game.facilityEntrance.y) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_enter_facility').setLabel('🚪 施設に入る').setStyle(ButtonStyle.Danger));
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        if (room.exits.n !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_n').setLabel('北の扉').setStyle(ButtonStyle.Secondary));
        if (room.exits.s !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_s').setLabel('南の扉').setStyle(ButtonStyle.Secondary));
        if (room.exits.e !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_e').setLabel('東の扉').setStyle(ButtonStyle.Secondary));
        if (room.exits.w !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_w').setLabel('西の扉').setStyle(ButtonStyle.Secondary));

        if (room.scrap) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_grab').setLabel('📦 拾う').setStyle(ButtonStyle.Primary));
        if (player.roomId === 0) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_exit_facility').setLabel('🌍 外に出る').setStyle(ButtonStyle.Success));
    } else if (player.currentArea === 'ship') {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_store').setLabel('📥 スクラップ格納').setStyle(ButtonStyle.Primary));
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_exit_facility').setLabel('🌍 外に出る').setStyle(ButtonStyle.Success));
    }

    if (player.hasTransceiver) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_toggle_radio').setLabel(player.isRadioActive ? '🔇 無線を切る' : '📻 無線を入れる').setStyle(ButtonStyle.Secondary));

    if (moveRow.components.length > 0) rows.push(moveRow);
    if (actionRow.components.length > 0) rows.push(actionRow);
    return rows;
}

// ── Utils ──
async function updatePlayerVC(client: any, game: GameState, player: PlayerState) {
    const guild = await client.guilds.fetch(game.guildId);
    let targetName = '';
    
    if (player.hp === 'dead') {
        targetName = 'ghost';
    } else if (player.isRadioActive || player.currentArea === 'ship') {
        targetName = 'ship';
    } else if (player.currentArea === 'field') {
        targetName = `🌍 field-${getFieldSector(player.x, player.y)}`;
    } else {
        targetName = `🚪 room-${player.roomId}`;
    }
    
    let targetVcId = game.vcIds.get(targetName);
    if (!targetVcId && game.categoryId) {
        const newVc = await guild.channels.create({ name: targetName, type: ChannelType.GuildVoice, parent: game.categoryId, rtcRegion: 'rotterdam' });
        targetVcId = newVc.id;
        game.vcIds.set(targetName, targetVcId);
    }
    if (targetVcId) {
        const member = await guild.members.fetch(player.id).catch(() => null);
        if (member?.voice.channelId) await member.voice.setChannel(targetVcId).catch(() => {});
    }
}

async function sendPlayerUI(user: any, game: GameState, player: PlayerState, msg: string) {
    await user.send({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) }).catch(() => {});
}

async function broadcastToAll(client: any, game: GameState, msg: string) {
    for (const [pId, p] of game.players.entries()) {
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, msg);
    }
}

async function handleForcedTakeoff(client: any, game: GameState) {
    let survived = false;
    for (const [pId, p] of game.players.entries()) {
        if (p.currentArea !== 'ship') {
            p.hp = 'dead'; p.inventory = []; p.currentArea = 'ghost';
            await updatePlayerVC(client, game, p);
        } else { survived = true; }
    }

    const dayEarnings = game.shipScraps.reduce((acc, s) => acc + s.value, 0); 
    game.totalCredits += dayEarnings;
    
    let msg = `🚀 **強制離陸しました！**\n\n【結果】回収: ${dayEarnings}cr | 累計: ${game.totalCredits}/${game.quota}cr\n`;
    if (game.totalCredits >= game.quota) {
        msg += `🎉 **ノルマ達成！** (ゲームは一旦終了となります)`;
    } else {
        msg += `💀 **ノルマ未達... 全員宇宙空間へ放り出されました。** [GAME OVER]`;
    }
    game.state = 'ended';
    await broadcastToAll(client, game, msg);
}

async function cleanupGame(client: any, game: GameState) {
    if (game.gameLoopInterval) clearInterval(game.gameLoopInterval);
    const connection = getVoiceConnection(game.guildId);
    if (connection) connection.destroy();

    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (guild && game.categoryId) {
        const channels = guild.channels.cache.filter(c => c.parentId === game.categoryId);
        for (const [_, c] of channels) await c.delete().catch(() => {});
        await guild.channels.cache.get(game.categoryId)?.delete().catch(() => {});
    }
    
    for (const [key, val] of activeGames.entries()) if (val === game) activeGames.delete(key);
}
