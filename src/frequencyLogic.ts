// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, TextChannel, VoiceChannel } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { startGhostCamera } from './voiceTranscription';

// ── Types & Interfaces ──
type RoleType = 'navigator' | 'scavenger';
type AreaType = 'ship' | 'field' | 'facility' | 'ghost';
type HPState = 'healthy' | 'injured' | 'dying' | 'dead';
type MonsterType = 'patrol' | 'ambush' | 'chaser' | 'sound';

interface Scrap { id: string; name: string; value: number; weight: 'light' | 'medium' | 'heavy'; isTransceiver?: boolean; }
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
    inventory: Scrap[]; // 4枠制限
    isRadioActive: boolean;
    radarTargetId?: string; // ナビゲーターのレーダー追跡対象
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
    daysLeft: number;
    quota: number;
    totalCredits: number;
    shipScraps: Scrap[];
    fieldSize: number;
    fieldGrid: number[][];
    facilityRooms: Room[];
    facilityEntrance: { x: number, y: number };
    timeRemainingSec: number;
    gameLoopInterval?: NodeJS.Timeout;
}

const activeGames = new Map<string, GameState>();

// ── Constants & Helpers ──
const FIELD_SIZE = 20;
const DAY_TIME_SEC = 900;
const HP_STAGES: Record<HPState, { next: HPState, label: string, icon: string }> = {
    'healthy': { next: 'injured', label: '健康', icon: '🟢' },
    'injured': { next: 'dying', label: '負傷(速度低下)', icon: '🟡' },
    'dying': { next: 'dead', label: '瀕死(出血)', icon: '🔴' },
    'dead': { next: 'dead', label: '死亡', icon: '💀' }
};

function getFieldSector(x: number, y: number): string {
    const col = Math.floor(x / 5);
    const row = Math.floor(y / 5);
    return String.fromCharCode(65 + (row * 4 + col));
}

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

// ── Economy & Maps ──
function calculateQuota(day: number): number {
    let q = 130;
    for (let i = 1; i < day; i++) q = Math.floor(q * 1.4 + 30);
    return Math.min(q, 2000);
}

function getSellRate(daysLeft: number): number {
    if (daysLeft >= 3) return 0.4;
    if (daysLeft === 2) return 0.4; // 便宜上 3日以上と同じ
    if (daysLeft === 1) return 0.8;
    return 1.0; // 最終日(0日)
}

function generateField(): { grid: number[][], entrance: {x:number, y:number} } {
    const grid = Array.from({ length: FIELD_SIZE }, () => Array(FIELD_SIZE).fill(0));
    grid[2][2] = 2; // 船
    const fx = Math.floor(Math.random() * 7) + 12;
    const fy = Math.floor(Math.random() * 9) + 10;
    grid[fy][fx] = 3; // 施設
    for (let y = 0; y < FIELD_SIZE; y++) {
        for (let x = 0; x < FIELD_SIZE; x++) {
            if (grid[y][x] === 0 && Math.random() < 0.35) grid[y][x] = 1;
        }
    }
    return { grid, entrance: { x: fx, y: fy } };
}

function generateFacility(): Room[] {
    const rooms: Room[] = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
        const isHeavy = Math.random() < 0.2;
        rooms.push({
            id: i,
            name: i === 0 ? '施設エントランス' : i === count - 1 ? 'メイン倉庫' : `区画-${i}`,
            desc: i === 0 ? '外の風が吹き込んでいる。' : '埃っぽい空気が漂っている。',
            exits: {},
            scrap: i > 0 && Math.random() < 0.5 ? { 
                id: `${Date.now()}_${i}`, 
                name: isHeavy ? '重機部品' : '金属板', 
                value: isHeavy ? 180 : 65, 
                weight: isHeavy ? 'heavy' : 'medium' 
            } : undefined
        });
    }
    for (let i = 0; i < count - 1; i++) {
        rooms[i].exits.n = i + 1;
        rooms[i + 1].exits.s = i;
    }
    return rooms;
}

// ── Setup ──
export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    if (activeGames.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ 既に募集中のゲームがあります。' });

    const game: GameState = {
        guildId: interaction.guildId!, hostId: interaction.user.id, state: 'lobby',
        vcIds: new Map(), players: new Map(), monsters: [],
        day: 1, daysLeft: 3, quota: calculateQuota(1), totalCredits: 0, shipScraps: [],
        fieldSize: FIELD_SIZE, fieldGrid: [], facilityRooms: [], facilityEntrance: { x: 0, y: 0 },
        timeRemainingSec: DAY_TIME_SEC
    };
    activeGames.set(interaction.channelId, game);
    await interaction.editReply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

function buildLobbyEmbed(game: GameState) {
    const pList = Array.from(game.players.values()).map(p => `・${p.name} [${p.role === 'navigator' ? '💻ナビ' : '⛏️探索'}]`).join('\n');
    return new EmbedBuilder()
        .setTitle('📻 FREQUENCY - ロビー')
        .setDescription(`**【参加者】**\n${pList || 'なし'}\n\n※2人プレイ時は自動的に両者【探索者(簡易ナビ付)】になります。`)
        .setColor(0x2b2d31);
}

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_join_nav').setLabel('ナビゲーター').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('freq_join_scav').setLabel('探索者').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_launch').setLabel('🚀 着陸(開始)').setStyle(ButtonStyle.Success)
    );
}

// ── Routing ──
export async function handleButton(interaction: any) {
    let game = activeGames.get(interaction.channelId);
    if (!game) game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

    if (action.startsWith('join_')) {
        const role = action === 'join_nav' ? 'navigator' : 'scavenger';
        // ★修正: トランシーバーを所持品として初期付与（枠を1つ消費）
        const initInv: Scrap[] = [{ id: `tr_${userId}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true }];
        game.players.set(userId, {
            id: userId, name: interaction.user.username, role, hp: 'healthy', isBleeding: false,
            currentArea: role === 'navigator' ? 'ship' : 'field', x: 2, y: 2, roomId: 0,
            inventory: initInv, isRadioActive: false
        });
        return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
    }
    
    if (action === 'launch') {
        if (userId !== game.hostId) return interaction.reply({ content: 'ホストのみ開始可能です。', ephemeral: true });
        if (game.players.size === 2) game.players.forEach(p => p.role = 'scavenger');

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

    if (player.hp === 'dead') return;
    await executePlayerAction(interaction, action, game, player);
}

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

    const fieldData = generateField();
    game.fieldGrid = fieldData.grid;
    game.facilityEntrance = fieldData.entrance;
    game.facilityRooms = generateFacility();

    game.monsters.push({ id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 });
    game.monsters.push({ id: 'm2', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: 8 });

    game.state = 'playing';

    const connection = joinVoiceChannel({ channelId: shipVc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator as any, selfDeaf: false, selfMute: false });
    startGhostCamera(connection, ghostText);

    startGameLoop(client, game);

    for (const [pId, p] of game.players.entries()) {
        await updatePlayerVC(client, game, p);
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, '【着陸完了】探索を開始してください。トランシーバーはインベントリにあります。');
    }
}

function startGameLoop(client: any, game: GameState) {
    let tick = 0;
    game.gameLoopInterval = setInterval(async () => {
        game.timeRemainingSec--;
        tick++;

        if (tick % 30 === 0) {
            for (const p of game.players.values()) {
                if (p.hp !== 'dead' && p.isBleeding) {
                    takeDamage(p, game);
                    const user = await client.users.fetch(p.id).catch(() => null);
                    if (user) await sendPlayerUI(user, game, p, '🩸 出血により状態が悪化した...');
                }
            }
        }

        if (game.timeRemainingSec === 300 || game.timeRemainingSec === 60) {
            broadcastToAll(client, game, `🚨 【警告】本日の強制離陸まで残り ${game.timeRemainingSec / 60} 分。船に戻らない者は置き去りになります。`);
        }

        if (game.timeRemainingSec <= 0) {
            await handleTakeoff(client, game, true);
        }
    }, 1000);
}

// ── Actions ──
async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState) {
    let msg = '';

    if (player.encounterActive && action.startsWith('escape_')) {
        const timeTaken = Date.now() - player.encounterActive.timestamp;
        if (action === 'escape_stay' || timeTaken > player.encounterActive.timeout * 1000) {
            msg = handleEncounterDamage(player, game);
        } else {
            msg = '💨 間一髪で逃げ切った！';
            handleMovement(game, player, action.replace('escape_', '')); 
        }
        player.encounterActive = undefined;
        await updatePlayerVC(interaction.client, game, player);
        return interaction.update({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) });
    }

    if (action === 'toggle_radio') {
        const hasRadio = player.inventory.some(i => i.isTransceiver);
        if (!hasRadio) {
            msg = 'トランシーバーを持っていない！';
            player.isRadioActive = false;
        } else {
            player.isRadioActive = !player.isRadioActive;
            msg = player.isRadioActive ? '📻 通信を開いた。' : '🔇 通信を切った。';
        }
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'drop_radio') {
        const idx = player.inventory.findIndex(i => i.isTransceiver);
        if (idx !== -1) {
            player.inventory.splice(idx, 1);
            player.isRadioActive = false;
            msg = '🗑️ トランシーバーを捨てた。(枠が1つ空いた)';
            await updatePlayerVC(interaction.client, game, player);
        }
    } else if (action === 'switch_radar') {
        // レーダー対象の切り替え (ナビ専用)
        const alivePlayers = Array.from(game.players.values()).filter(p => p.hp !== 'dead' && p.role === 'scavenger');
        if (alivePlayers.length > 0) {
            const currentIndex = alivePlayers.findIndex(p => p.id === player.radarTargetId);
            const nextPlayer = alivePlayers[(currentIndex + 1) % alivePlayers.length];
            player.radarTargetId = nextPlayer.id;
            msg = `📡 レーダー対象を ${nextPlayer.name} に切り替えた。`;
        }
    } else if (action.startsWith('move_')) {
        msg = handleMovement(game, player, action.replace('move_', ''));
        await updatePlayerVC(interaction.client, game, player);
        msg = checkMonsterEncounter(player, game) || msg;
    } else if (action === 'enter_facility') {
        player.currentArea = 'facility'; player.roomId = 0; msg = '🚪 施設内に侵入した。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'exit_facility') {
        player.currentArea = 'field'; player.x = game.facilityEntrance.x; player.y = game.facilityEntrance.y; msg = '🌍 外に出た。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'enter_ship') {
        player.currentArea = 'ship'; msg = '🛸 船に戻った。安全だ。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'grab') {
        const room = game.facilityRooms[player.roomId];
        const hasHeavy = player.inventory.some(i => i.weight === 'heavy');
        
        if (!room.scrap) {
            msg = '何もない。';
        } else if (hasHeavy) {
            // ★修正: 重いアイテムによる所持制限
            msg = '⚠️ 【大物】で両手が塞がっていて、これ以上拾えない！';
        } else if (room.scrap.weight === 'heavy' && player.inventory.length > 0) {
            msg = '⚠️ 【大物】を拾うには、インベントリを空(0個)にする必要がある！';
        } else if (player.inventory.length >= 4) {
            msg = '🎒 インベントリ(4枠)が満杯だ。';
        } else {
            player.inventory.push(room.scrap);
            msg = `📦 ${room.scrap.name} を拾った！`;
            room.scrap = undefined;
        }
    } else if (action === 'store') {
        const scrapsToStore = player.inventory.filter(i => !i.isTransceiver);
        if (scrapsToStore.length > 0) {
            game.shipScraps.push(...scrapsToStore);
            player.inventory = player.inventory.filter(i => i.isTransceiver);
            msg = `📦 ${scrapsToStore.length}個のスクラップを保管庫に置いた！`;
        } else {
            msg = '保管するスクラップがない。';
        }
    } else if (action === 'sell') {
        // ★修正: 手動での売却処理（日によってレート変動）
        if (game.shipScraps.length === 0) {
            msg = '売却するスクラップがない。';
        } else {
            const rawValue = game.shipScraps.reduce((acc, s) => acc + s.value, 0);
            const rate = getSellRate(game.daysLeft);
            const earned = Math.floor(rawValue * rate);
            game.totalCredits += earned;
            game.shipScraps = [];
            msg = `💸 保管していた全スクラップを売却した！\n(レート: ${rate * 100}% -> +${earned}cr)`;
        }
    } else if (action === 'takeoff') {
        if (player.currentArea !== 'ship') return interaction.reply({ content: '船内からのみ離陸可能です。', ephemeral: true });
        await interaction.update({ content: '🚀 船を発進させました。', embeds: [], components: [] });
        await handleTakeoff(interaction.client, game, false);
        return;
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

// ── Reset/Takeoff ──
async function handleTakeoff(client: any, game: GameState, isForced: boolean) {
    if (game.gameLoopInterval) clearInterval(game.gameLoopInterval);

    let deadCount = 0;
    let survived = false;

    for (const p of game.players.values()) {
        if (p.currentArea !== 'ship') {
            p.hp = 'dead'; p.inventory = [];
        }
        if (p.hp === 'dead') deadCount++;
        else survived = true;
    }

    if (!survived) game.shipScraps = []; // 全滅ロスト

    const penalty = deadCount * 40;
    game.totalCredits = Math.max(0, game.totalCredits - penalty);
    game.daysLeft--;

    let msg = isForced ? `🚨 **時間切れにより強制離陸しました！**\n\n` : `🚀 **船を離陸させました！**\n\n`;
    msg += `📦 【船内保管】 現在 ${game.shipScraps.length}個 のスクラップを保管中\n`;
    if (deadCount > 0) msg += `🩸 【死傷者ペナルティ】 -${penalty}cr (${deadCount}名死亡)\n`;
    if (!survived) msg += `💀 【全滅】 船内に保管していたスクラップを全てロストしました...\n`;
    msg += `💳 【現在残高】 ${game.totalCredits} / ${game.quota} cr\n\n`;

    if (game.daysLeft < 0) {
        if (game.totalCredits >= game.quota) {
            game.day++; game.daysLeft = 3; game.quota = calculateQuota(game.day);
            msg += `🎉 **ノルマ達成！**\n次回の会社目標は ${game.quota} cr です。（猶予: 3日）\n`;
        } else {
            msg += `💀 **ノルマ未達... 全員宇宙空間へ放り出されました。** [GAME OVER]`;
            game.state = 'ended';
            await broadcastToAll(client, game, msg);
            await cleanupGame(client, game);
            return;
        }
    } else {
        msg += `📅 ノルマ期限まで残り **${game.daysLeft}** 日\n`;
    }

    if (game.state !== 'ended') {
        const fieldData = generateField();
        game.fieldGrid = fieldData.grid;
        game.facilityEntrance = fieldData.entrance;
        game.facilityRooms = generateFacility();
        game.monsters = [ { id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 }, { id: 'm2', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: 8 } ];
        game.timeRemainingSec = DAY_TIME_SEC;
        
        for (const p of game.players.values()) {
            p.hp = 'healthy'; p.isBleeding = false; p.currentArea = 'ship'; p.x = 2; p.y = 2; p.roomId = 0; p.encounterActive = undefined;
            // 復活時、トランシーバーのみ再支給
            p.inventory = [{ id: `tr_${p.id}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true }];
            await updatePlayerVC(client, game, p);
        }
        startGameLoop(client, game);
        await broadcastToAll(client, game, msg);
    }
}

// ── UI ──
function renderGrid(game: GameState, player: PlayerState, isNav: boolean): string {
    // ★修正: ナビゲーターは追跡対象(radarTargetId)の座標を中心に表示する
    let viewArea = player.currentArea;
    let cx = player.x, cy = player.y, cRoomId = player.roomId;

    if (isNav && player.radarTargetId) {
        const target = game.players.get(player.radarTargetId);
        if (target && target.hp !== 'dead') {
            viewArea = target.currentArea;
            cx = target.x; cy = target.y; cRoomId = target.roomId;
        }
    }

    if (viewArea === 'field') {
        const size = isNav ? 3 : 2;
        let out = '';
        for (let y = cy - size; y <= cy + size; y++) {
            for (let x = cx - size; x <= cx + size; x++) {
                if (x === cx && y === cy) out += '👤';
                else if (x < 0 || x >= FIELD_SIZE || y < 0 || y >= FIELD_SIZE) out += '🌫';
                else if (game.fieldGrid[y][x] === 1) out += '🌲';
                else if (game.fieldGrid[y][x] === 2) out += '🛸';
                else if (game.fieldGrid[y][x] === 3) out += '🏭';
                else out += '土';
            }
            out += '\n';
        }
        return `\`\`\`\n${out}\n\`\`\``;
    } else if (viewArea === 'facility') {
        const room = game.facilityRooms[cRoomId];
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
        return new EmbedBuilder().setTitle('💀 霊界').setDescription(`${msg}\n\nあなたは死にました。#ghost-chat でお待ちください。`).setColor(0x000000);
    }

    const hpData = HP_STAGES[player.hp];
    let locationStr = player.currentArea === 'ship' ? '🛸 船内' : player.currentArea === 'field' ? `🌍 外 [${player.x}, ${player.y}]` : `🏭 施設 [${game.facilityRooms[player.roomId].name}]`;
    let descStr = '';

    if (player.currentArea === 'field') {
        descStr += `🛸 船の方角: ${getDirectionEmoji(player.x, player.y, 2, 2)}\n🏭 施設の方角: ${getDirectionEmoji(player.x, player.y, game.facilityEntrance.x, game.facilityEntrance.y)}\n`;
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        let exitDir = '';
        if (room.exits.n !== undefined && room.exits.n < player.roomId) exitDir = '⬆️';
        else if (room.exits.s !== undefined && room.exits.s < player.roomId) exitDir = '⬇️';
        else if (room.exits.e !== undefined && room.exits.e < player.roomId) exitDir = '➡️';
        else if (room.exits.w !== undefined && room.exits.w < player.roomId) exitDir = '⬅️';
        if (exitDir && player.roomId !== 0) descStr += `🚪 出口(エントランス)の気配: ${exitDir}\n`;
    }

    const embedColor = player.encounterActive ? 0xFF0000 : (player.isRadioActive ? 0x00FF00 : 0x2b2d31);
    
    // インベントリ表示 (トランシーバー等も含める)
    const invNames = player.inventory.length > 0 ? player.inventory.map(i => i.isTransceiver ? `📻 ${i.name}` : `📦 ${i.name}`).join(', ') : '空';
    const rate = getSellRate(game.daysLeft);

    const embed = new EmbedBuilder()
        .setTitle(locationStr)
        .setDescription(`💬 ${msg}\n${renderGrid(game, player, player.role === 'navigator')}\n${descStr}`)
        .addFields(
            { name: '📊 状態', value: `${hpData.icon} ${hpData.label} ${player.isBleeding ? '(🩸出血中)' : ''}`, inline: true },
            { name: '⏳ 時間/ノルマ', value: `残り ${Math.floor(game.timeRemainingSec/60)}分 | ${game.totalCredits}/${game.quota}cr (あと${game.daysLeft}日)`, inline: true },
            { name: `🎒 所持品 (${player.inventory.length}/4)`, value: invNames, inline: true },
            { name: `📦 保管スクラップ`, value: `${game.shipScraps.length} 個 (現在売却レート: ${rate * 100}%)`, inline: true }
        )
        .setColor(embedColor);

    if (player.currentArea === 'facility' && game.facilityRooms[player.roomId].scrap) {
        embed.addFields({ name: '✨ 発見', value: `床に **${game.facilityRooms[player.roomId].scrap!.name}** (${game.facilityRooms[player.roomId].scrap!.weight}) がある！` });
    }
    return embed;
}

function getPlayerControlRow(player: PlayerState, game: GameState): ActionRowBuilder<ButtonBuilder>[] {
    if (player.hp === 'dead') return [];

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    if (player.encounterActive) {
        const r = new ActionRowBuilder<ButtonBuilder>();
        r.addComponents(new ButtonBuilder().setCustomId('freq_escape_n').setLabel('北へ逃げる').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('freq_escape_s').setLabel('南へ逃げる').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('freq_escape_stay').setLabel('その場に留まる').setStyle(ButtonStyle.Danger));
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
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_store').setLabel('📥 スクラップ保管').setStyle(ButtonStyle.Primary));
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_sell').setLabel('💸 会社に売却').setStyle(ButtonStyle.Success));
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_takeoff').setLabel('🚀 離陸する(1日終了)').setStyle(ButtonStyle.Danger));
        if (player.role === 'navigator') {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_switch_radar').setLabel('📡 レーダー切替').setStyle(ButtonStyle.Primary));
        }
        const hasRadio = player.inventory.some(i => i.isTransceiver);
        if (!hasRadio) {
            // トランシーバーを持たずに船に戻った場合に備えて、再配布する仕組みを入れることも可能ですが今回は割愛
        }
    }

    const hasRadio = player.inventory.some(i => i.isTransceiver);
    if (hasRadio) {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_toggle_radio').setLabel(player.isRadioActive ? '🔇 無線を切る' : '📻 無線を入れる').setStyle(ButtonStyle.Secondary));
        if (player.currentArea !== 'ship') actionRow.addComponents(new ButtonBuilder().setCustomId('freq_drop_radio').setLabel('🗑️ 無線を捨てる').setStyle(ButtonStyle.Secondary));
    }

    if (moveRow.components.length > 0) rows.push(moveRow);
    
    // コンポーネントが5つを超える場合は分割
    if (actionRow.components.length > 5) {
        const actionRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(actionRow.components.slice(5));
        actionRow.components = actionRow.components.slice(0, 5);
        rows.push(actionRow, actionRow2);
    } else if (actionRow.components.length > 0) {
        rows.push(actionRow);
    }
    return rows;
}

// ── Utils ──
async function updatePlayerVC(client: any, game: GameState, player: PlayerState) {
    const guild = await client.guilds.fetch(game.guildId);
    let targetName = player.hp === 'dead' ? 'ghost' : (player.isRadioActive || player.currentArea === 'ship') ? 'ship' : player.currentArea === 'field' ? `🌍 field-${getFieldSector(player.x, player.y)}` : `🚪 room-${player.roomId}`;
    let targetVcId = game.vcIds.get(targetName);
    if (!targetVcId && game.categoryId) {
        const newVc = await guild.channels.create({ name: targetName, type: ChannelType.GuildVoice, parent: game.categoryId, rtcRegion: 'rotterdam' });
        targetVcId = newVc.id; game.vcIds.set(targetName, targetVcId);
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
