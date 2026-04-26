// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Guild } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { Pool } from 'pg';

// ── DB Setup (PostgreSQL) ──
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 初回起動時に必要なテーブルを作成
pool.query(`
    CREATE TABLE IF NOT EXISTS frequency_scraps (
        game_id VARCHAR(50),
        room_id INTEGER,
        scrap_id VARCHAR(50),
        is_picked_up BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (game_id, scrap_id)
    );
`).catch(e => console.error('DB Init Error:', e));

// ── Types & Interfaces ──
type RoleType = 'navigator' | 'scavenger';
type AreaType = 'ship' | 'field' | 'facility' | 'ghost';
type HPState = 'healthy' | 'injured' | 'dying' | 'dead';
type MonsterType = 'patrol' | 'ambush' | 'chaser' | 'sound';

interface Scrap { id: string; name: string; value: number; weight: 'light' | 'medium' | 'heavy'; isTransceiver?: boolean; }
interface Room { id: number; name: string; desc: string; exits: { n?: number, s?: number, e?: number, w?: number }; scrap?: Scrap; }
interface Monster { id: string; type: MonsterType; area: 'field' | 'facility'; x: number; y: number; roomId: number; }

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    hp: HPState;
    isBleeding: boolean;
    bleedTicks: number; // 30秒ごとの悪化カウント用
    currentArea: AreaType;
    x: number;
    y: number;
    roomId: number;
    inventory: Scrap[]; // 最大4枠
    isRadioActive: boolean;
    radarTargetId?: string; // ナビ用視点切替
    encounterActive?: { monsterType: MonsterType, timestamp: number, timeout: number };
}

interface GameState {
    guildId: string;
    hostId: string;
    state: 'lobby' | 'playing' | 'ended';
    categoryId?: string;
    ghostTextId?: string;
    vcIds: Map<string, string>; // ship, field, ghost, room-01~15
    players: Map<string, PlayerState>;
    monsters: Monster[];
    day: number;
    daysLeft: number;
    quota: number;
    totalCredits: number;
    shipScraps: Scrap[];
    fieldSize: number;
    fieldGrid: number[][]; // 0:空, 1:壁, 2:船, 3:施設
    facilityRooms: Room[];
    facilityEntrance: { x: number, y: number };
    timeRemainingSec: number;
    gameLoopInterval?: NodeJS.Timeout;
}

// リアルタイム性が高いVC制御やタイマーはメモリで管理し、競合するアイテム取得等のみDBトランザクションを利用
const activeGames = new Map<string, GameState>();

// ── Constants & Helpers ──
const FIELD_SIZE = 16;
const DAY_TIME_SEC = 900; // 15分
const HP_STAGES: Record<HPState, { next: HPState, label: string, icon: string }> = {
    'healthy': { next: 'injured', label: '健康', icon: '🟢' },
    'injured': { next: 'dying', label: '負傷(速度低下)', icon: '🟡' },
    'dying': { next: 'dead', label: '瀕死(出血)', icon: '🔴' },
    'dead': { next: 'dead', label: '死亡', icon: '💀' }
};

function getDirectionText(fromX: number, fromY: number, toX: number, toY: number): string {
    if (fromX === toX && fromY === toY) return '現在地';
    let ns = '', ew = '';
    if (fromY > toY) ns = '北'; else if (fromY < toY) ns = '南';
    if (fromX > toX) ew = '西'; else if (fromX < toX) ew = '東';
    return `${ns}${ew}`;
}

// ── Map Generation ──
function generateField(): { grid: number[][], entrance: {x:number, y:number} } {
    const grid = Array.from({ length: FIELD_SIZE }, () => Array(FIELD_SIZE).fill(0));
    grid[2][2] = 2; // 船固定
    
    // 施設ランダム (9,8) ~ (14,14)
    const fx = Math.floor(Math.random() * 6) + 9;
    const fy = Math.floor(Math.random() * 7) + 8;
    grid[fy][fx] = 3;

    for (let y = 0; y < FIELD_SIZE; y++) {
        for (let x = 0; x < FIELD_SIZE; x++) {
            // 船と施設周辺は開けておく
            if (grid[y][x] === 0 && Math.random() < 0.25) grid[y][x] = 1; // 25%の障害物
        }
    }
    // ※ MVPとして経路保証は簡易化（障害物密度を下げることで担保）
    return { grid, entrance: { x: fx, y: fy } };
}

function generateFacility(gameId: string): Room[] {
    const rooms: Room[] = [];
    const count = Math.floor(Math.random() * 6) + 10; // 10〜15部屋
    for (let i = 0; i < count; i++) {
        const isHeavy = Math.random() < 0.2; // 20%で大物
        const scrapId = `scrap_${Date.now()}_${i}`;
        const hasScrap = i > 0 && Math.random() < 0.5;
        
        rooms.push({
            id: i,
            name: i === 0 ? '施設エントランス' : i === count - 1 ? 'メイン倉庫' : `区画-${i.toString().padStart(2, '0')}`,
            desc: i === 0 ? '外の風が吹き込んでいる。' : '埃っぽい空気が漂っている。',
            exits: {},
            scrap: hasScrap ? { 
                id: scrapId, 
                name: isHeavy ? '重機部品' : (Math.random() < 0.5 ? '金属板' : '配線'), 
                value: isHeavy ? Math.floor(Math.random()*66)+195 : Math.floor(Math.random()*66)+65, 
                weight: isHeavy ? 'heavy' : (Math.random() < 0.5 ? 'medium' : 'light') 
            } : undefined
        });

        // DBにスクラップ情報を事前登録 (排他制御用)
        if (hasScrap) {
            pool.query('INSERT INTO frequency_scraps (game_id, room_id, scrap_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [gameId, i, scrapId]).catch(console.error);
        }
    }
    // 直列経路保証
    for (let i = 0; i < count - 1; i++) {
        rooms[i].exits.n = i + 1;
        rooms[i + 1].exits.s = i;
    }
    // ランダムな脇道
    for(let i=1; i < count - 2; i++) {
        if(Math.random() < 0.3) {
            rooms[i].exits.e = i + 2;
            rooms[i+2].exits.w = i;
        }
    }
    return rooms;
}

// ── Economy ──
function calculateQuota(day: number): number {
    let q = 130;
    for (let i = 1; i < day; i++) q = Math.floor(q * 1.4 + 30);
    return Math.min(q, 2000);
}

function getSellRate(daysLeft: number): number {
    if (daysLeft >= 3) return 0.4;
    if (daysLeft === 2) return 0.4;
    if (daysLeft === 1) return 0.8;
    return 1.0;
}

// ── Commands & Routing ──
export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    if (activeGames.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ 既に募集中のゲームがあります。' });

    const gameId = interaction.channelId;
    const game: GameState = {
        guildId: interaction.guildId!, hostId: interaction.user.id, state: 'lobby',
        vcIds: new Map(), players: new Map(), monsters: [],
        day: 1, daysLeft: 3, quota: calculateQuota(1), totalCredits: 0, shipScraps: [],
        fieldSize: FIELD_SIZE, fieldGrid: [], facilityRooms: [], facilityEntrance: { x: 0, y: 0 },
        timeRemainingSec: DAY_TIME_SEC
    };
    activeGames.set(gameId, game);
    await interaction.editReply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

function buildLobbyEmbed(game: GameState) {
    const pList = Array.from(game.players.values()).map(p => `・${p.name} [${p.role === 'navigator' ? '💻ナビ' : '⛏️探索'}]`).join('\n');
    return new EmbedBuilder()
        .setTitle('📻 FREQUENCY - ロビー')
        .setDescription(`**【参加者】**\n${pList || 'なし'}\n\n※2人プレイ時はナビゲーター廃止（自動で両者探索者+簡易ナビ付与）`)
        .setColor(0x2b2d31);
}

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_join_nav').setLabel('ナビゲーター').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('freq_join_scav').setLabel('探索者').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_launch').setLabel('🚀 着陸(開始)').setStyle(ButtonStyle.Success)
    );
}

export async function handleButton(interaction: any) {
    let game = activeGames.get(interaction.channelId);
    if (!game) game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    // VC接続チェック
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.voice.channelId && !interaction.customId.startsWith('freq_join')) {
        return interaction.reply({ content: '⚠️ VCに入ってからプレイしてください。', ephemeral: true });
    }

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

    if (action.startsWith('join_')) {
        const role = action === 'join_nav' ? 'navigator' : 'scavenger';
        // トランシーバーを初期配布（1枠消費）
        const initInv: Scrap[] = [{ id: `tr_${userId}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true }];
        game.players.set(userId, {
            id: userId, name: interaction.user.username, role, hp: 'healthy', isBleeding: false, bleedTicks: 0,
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
        await setupGameEnvironment(interaction.client, interaction.channelId, game);
        return;
    }

    const player = game.players.get(userId);
    if (!player || player.hp === 'dead') return;

    await executePlayerAction(interaction, action, game, player, interaction.channelId);
}

// ── Environment Setup ──
async function setupGameEnvironment(client: any, gameId: string, game: GameState) {
    const guild: Guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    const category = await guild.channels.create({ name: '🔴 FREQUENCY ZONE', type: ChannelType.GuildCategory });
    game.categoryId = category.id;
    const ghostText = await guild.channels.create({ name: '👻ghost-chat', type: ChannelType.GuildText, parent: category.id });
    game.ghostTextId = ghostText.id;
    
    const shipVc = await guild.channels.create({ name: '🛸 ship', type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
    const fieldVc = await guild.channels.create({ name: '🌍 field', type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
    const ghostVc = await guild.channels.create({ name: '👻 ghost', type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
    
    game.vcIds.set('ship', shipVc.id);
    game.vcIds.set('field', fieldVc.id);
    game.vcIds.set('ghost', ghostVc.id);

    // 施設部屋VC（固定で15個作成・使い回し）
    for (let i = 0; i <= 15; i++) {
        const rName = i === 0 ? '🚪 room-entrance' : `🚪 room-${i.toString().padStart(2, '0')}`;
        const roomVc = await guild.channels.create({ name: rName, type: ChannelType.GuildVoice, parent: category.id, rtcRegion: 'rotterdam' });
        game.vcIds.set(`room-${i}`, roomVc.id);
    }

    const fieldData = generateField();
    game.fieldGrid = fieldData.grid;
    game.facilityEntrance = fieldData.entrance;
    game.facilityRooms = generateFacility(gameId);

    // モンスター配置
    game.monsters.push({ id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 });
    game.monsters.push({ id: 'm2', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: game.facilityRooms.length - 1 }); // メイン倉庫に確実配置

    game.state = 'playing';

    startGameLoop(client, gameId, game);

    // プレイヤーDM送信と初期VC移動
    for (const [pId, p] of game.players.entries()) {
        await updatePlayerVC(client, game, p);
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, '【着陸完了】探索を開始してください。トランシーバーはインベントリにあります。');
    }
}

// ── Game Loop ──
function startGameLoop(client: any, gameId: string, game: GameState) {
    let tick = 0;
    game.gameLoopInterval = setInterval(async () => {
        game.timeRemainingSec--;
        tick++;

        // 出血処理 (30秒ごと)
        if (tick % 30 === 0) {
            for (const p of game.players.values()) {
                if (p.hp !== 'dead' && p.isBleeding) {
                    p.bleedTicks++;
                    if (p.bleedTicks >= 2 && p.hp === 'dying') {
                        p.hp = 'dead';
                        p.currentArea = 'ghost';
                        p.inventory = [];
                        await updatePlayerVC(client, game, p);
                        notifyPlayer(client, p.id, game, '🩸 出血多量により死亡した...');
                    } else {
                        takeDamage(p, game);
                        notifyPlayer(client, p.id, game, '🩸 出血により状態が悪化した...');
                    }
                }
            }
        }

        // 強制離陸通知
        if (game.timeRemainingSec === 300) broadcastToAll(client, game, '🚨 【警告】離陸まであと5分。');
        if (game.timeRemainingSec <= 60 && game.timeRemainingSec % 30 === 0) broadcastToAll(client, game, `🚨 離陸まであと${game.timeRemainingSec}秒！`);
        
        // 離陸
        if (game.timeRemainingSec <= 0) {
            clearInterval(game.gameLoopInterval);
            await handleTakeoff(client, gameId, game, true);
        }
    }, 1000);
}

// ── Actions ──
async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState, gameId: string) {
    let msg = '';

    // エンカウント時逃走アクション
    if (player.encounterActive) {
        if (action.startsWith('escape_')) {
            const timeTaken = Date.now() - player.encounterActive.timestamp;
            if (action === 'escape_stay' || timeTaken > player.encounterActive.timeout * 1000) {
                msg = handleEncounterDamage(player, game);
            } else {
                msg = '💨 間一髪で逃げ切った！';
                handleMovement(game, player, action.replace('escape_', '')); 
            }
        } else {
            msg = handleEncounterDamage(player, game); // 違うボタンを押した罰
        }
        player.encounterActive = undefined;
        await updatePlayerVC(interaction.client, game, player);
        return interaction.update({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) });
    }

    // 通常アクション
    if (action === 'toggle_radio') {
        if (!player.inventory.some(i => i.isTransceiver)) {
            msg = 'トランシーバーを持っていない！';
        } else {
            player.isRadioActive = !player.isRadioActive;
            msg = player.isRadioActive ? '📻 通信を開いた。(遭遇判定一時無効)' : '🔇 通信を切った。';
            await updatePlayerVC(interaction.client, game, player);
            if (!player.isRadioActive) msg = checkMonsterEncounter(player, game) || msg; // 切った瞬間に判定
        }
    } else if (action === 'drop_radio') {
        const idx = player.inventory.findIndex(i => i.isTransceiver);
        if (idx !== -1) {
            player.inventory.splice(idx, 1);
            player.isRadioActive = false;
            msg = '🗑️ トランシーバーを捨てた。(枠が1つ空いた)';
            await updatePlayerVC(interaction.client, game, player);
        }
    } else if (action === 'switch_radar') {
        const targets = Array.from(game.players.values()).filter(p => p.hp !== 'dead' && p.role === 'scavenger');
        if (targets.length > 0) {
            if (!player.radarTargetId) player.radarTargetId = targets[0].id;
            else {
                const idx = targets.findIndex(p => p.id === player.radarTargetId);
                player.radarTargetId = targets[(idx + 1) % targets.length]?.id || undefined;
            }
            if (!player.radarTargetId) msg = '📡 レーダー全体俯瞰に戻した。';
            else msg = `📡 レーダー対象を ${game.players.get(player.radarTargetId)?.name} に切り替えた。`;
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
        player.isBleeding = false; // 脱出で出血解除
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'enter_ship') {
        player.currentArea = 'ship'; msg = '🛸 船に戻った。安全だ。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'grab') {
        const room = game.facilityRooms[player.roomId];
        const hasHeavy = player.inventory.some(i => i.weight === 'heavy');
        
        if (!room.scrap) msg = '何もない。';
        else if (hasHeavy) msg = '⚠️ 【大物】で両手が塞がっていて、これ以上拾えない！';
        else if (room.scrap.weight === 'heavy' && player.inventory.length > 0) msg = '⚠️ 【大物】を拾うには、インベントリを空にする必要がある！';
        else if (player.inventory.length >= 4) msg = '🎒 インベントリ(4枠)が満杯だ。';
        else {
            // DB Transaction for Scrap Grabbing
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const res = await client.query('SELECT is_picked_up FROM frequency_scraps WHERE game_id = $1 AND scrap_id = $2 FOR UPDATE', [gameId, room.scrap.id]);
                if (res.rows.length > 0 && !res.rows[0].is_picked_up) {
                    await client.query('UPDATE frequency_scraps SET is_picked_up = TRUE WHERE game_id = $1 AND scrap_id = $2', [gameId, room.scrap.id]);
                    await client.query('COMMIT');
                    player.inventory.push(room.scrap);
                    msg = `📦 ${room.scrap.name} を拾った！`;
                    room.scrap = undefined;
                } else {
                    await client.query('ROLLBACK');
                    msg = '⚠️ すでに誰かに拾われていた！';
                    room.scrap = undefined; // ローカル同期
                }
            } catch (e) {
                await client.query('ROLLBACK');
                msg = 'エラーが発生しました。';
            } finally {
                client.release();
            }
        }
    } else if (action === 'store') {
        const scraps = player.inventory.filter(i => !i.isTransceiver);
        if (scraps.length > 0) {
            game.shipScraps.push(...scraps);
            player.inventory = player.inventory.filter(i => i.isTransceiver);
            msg = `📦 ${scraps.length}個のスクラップを保管した！`;
        } else msg = '保管するスクラップがない。';
    } else if (action === 'sell') {
        if (game.shipScraps.length === 0) msg = '売却するスクラップがない。';
        else {
            const raw = game.shipScraps.reduce((acc, s) => acc + s.value, 0);
            const rate = getSellRate(game.daysLeft);
            const earned = Math.floor(raw * rate);
            game.totalCredits += earned;
            game.shipScraps = [];
            msg = `💸 保管スクラップを売却した！ (レート: ${rate * 100}% -> +${earned}cr)`;
        }
    } else if (action === 'takeoff') {
        if (player.currentArea !== 'ship') return interaction.reply({ content: '船内からのみ離陸可能です。', ephemeral: true });
        await interaction.update({ content: '🚀 船を発進させました。', embeds: [], components: [] });
        await handleTakeoff(interaction.client, gameId, game, false);
        return;
    }

    await interaction.update({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) });
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
    if (player.isRadioActive && player.currentArea !== 'ship') return null; // shipチャンネル中無効
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
        takeDamage(player, game); player.isBleeding = true;
        return '💥 深手を負った！(出血開始)';
    } else {
        takeDamage(player, game);
        return '💥 攻撃を受けた！';
    }
}

function takeDamage(player: PlayerState, game: GameState, instantKill = false) {
    if (instantKill || player.hp === 'dying') {
        player.hp = 'dead'; player.currentArea = 'ghost'; player.inventory = [];
    } else {
        player.hp = HP_STAGES[player.hp].next;
    }
}

// ── Takeoff & Reset ──
async function handleTakeoff(client: any, gameId: string, game: GameState, isForced: boolean) {
    if (game.gameLoopInterval) clearInterval(game.gameLoopInterval);

    let deadCount = 0;
    let survived = false;

    for (const p of game.players.values()) {
        if (p.currentArea !== 'ship') { p.hp = 'dead'; p.inventory = []; p.currentArea = 'ghost'; }
        if (p.hp === 'dead') deadCount++; else survived = true;
    }

    if (!survived) game.shipScraps = []; // 全滅ロスト

    game.daysLeft--;
    let msg = isForced ? `🚨 **時間切れにより強制離陸しました！**\n\n` : `🚀 **船を離陸させました！**\n\n`;
    if (!survived) msg += `💀 【全滅】 保管スクラップを全てロストしました...\n`;
    msg += `💳 【現在残高】 ${game.totalCredits} / ${game.quota} cr\n\n`;

    if (game.daysLeft < 0) {
        if (game.totalCredits >= game.quota) {
            game.day++; game.daysLeft = 3; game.quota = calculateQuota(game.day);
            msg += `🎉 **ノルマ達成！**\n次回の会社目標は ${game.quota} cr です。（猶予: 3日）\n`;
        } else {
            msg += `💀 **ノルマ未達... 全員宇宙空間へ放り出されました。** [GAME OVER]`;
            game.state = 'ended';
            await broadcastToAll(client, game, msg);
            await cleanupGame(client, gameId, game);
            return;
        }
    } else {
        msg += `📅 ノルマ期限まで残り **${game.daysLeft}** 日\n`;
    }

    if (game.state !== 'ended') {
        const fieldData = generateField();
        game.fieldGrid = fieldData.grid;
        game.facilityEntrance = fieldData.entrance;
        game.facilityRooms = generateFacility(gameId); // Scrap repopulation & DB Insert
        game.monsters = [ { id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 }, { id: 'm2', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: game.facilityRooms.length - 1 } ];
        game.timeRemainingSec = DAY_TIME_SEC;
        
        for (const p of game.players.values()) {
            p.hp = 'healthy'; p.isBleeding = false; p.bleedTicks = 0; p.currentArea = 'ship'; p.x = 2; p.y = 2; p.roomId = 0; p.encounterActive = undefined;
            p.inventory = [{ id: `tr_${p.id}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true }];
            await updatePlayerVC(client, game, p);
        }
        startGameLoop(client, gameId, game);
        await broadcastToAll(client, game, msg);
    }
}

// ── UI Rendering ──
function renderGrid(game: GameState, player: PlayerState, isNav: boolean): string {
    let viewArea = player.currentArea;
    let cx = player.x, cy = player.y, cRoomId = player.roomId;

    if (isNav && player.radarTargetId) {
        const target = game.players.get(player.radarTargetId);
        if (target && target.hp !== 'dead') {
            viewArea = target.currentArea; cx = target.x; cy = target.y; cRoomId = target.roomId;
        }
    }

    if (viewArea === 'field') {
        const size = isNav ? 3 : 2;
        let out = '';
        for (let y = cy - size; y <= cy + size; y++) {
            for (let x = cx - size; x <= cx + size; x++) {
                if (x === cx && y === cy) out += '👤';
                else if (isNav && game.monsters.some(m => m.area === 'field' && m.x === x && m.y === y)) out += '🔴';
                else if (isNav && Array.from(game.players.values()).some(p => p.currentArea === 'field' && p.x === x && p.y === y && p.id !== player.id)) out += '🟢';
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
        
        let pMark = '👤';
        let mMark = '';
        if (isNav) {
            pMark = (cx === player.x && cy === player.y) ? '👤' : '🟢';
            const mon = game.monsters.find(m => m.area === 'facility' && m.roomId === cRoomId);
            if (mon) mMark = mon.type === 'ambush' ? '🟠' : '🔴';
        }
        
        out += `⬛${room.exits.n !== undefined ? '🚪' : '⬛'}⬛\n`;
        out += `${room.exits.w !== undefined ? '🚪' : '⬛'}${mMark || pMark}${room.exits.e !== undefined ? '🚪' : '⬛'}\n`;
        out += `⬛${room.exits.s !== undefined ? '🚪' : '⬛'}⬛\n`;
        return `\`\`\`\n${out}\n\`\`\``;
    }
    return '';
}

function buildPlayerUIEmbed(game: GameState, player: PlayerState, msg: string = '') {
    if (player.hp === 'dead') return new EmbedBuilder().setTitle('💀 霊界').setDescription(`${msg}\n\nあなたは死にました。`).setColor(0x000000);

    const hpData = HP_STAGES[player.hp];
    let locationStr = player.currentArea === 'ship' ? '🛸 船内' : player.currentArea === 'field' ? `🌍 外 [${player.x}, ${player.y}]` : `🏭 施設 [${game.facilityRooms[player.roomId].name}]`;
    let descStr = '';

    if (player.currentArea === 'field') {
        descStr += `🛸 船の方角: ${getDirectionText(player.x, player.y, 2, 2)}\n🏭 施設建物のおおよその方角: ${getDirectionText(player.x, player.y, game.facilityEntrance.x, game.facilityEntrance.y)}\n`;
        if (player.x === game.facilityEntrance.x && player.y === game.facilityEntrance.y) descStr += '🏭 目の前に施設の入り口がある！\n';
        if (player.x === 2 && player.y === 2) descStr += '🛸 目の前に船がある。\n';
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        let exitDir = '';
        if (room.exits.n !== undefined && room.exits.n < player.roomId) exitDir = '北';
        else if (room.exits.s !== undefined && room.exits.s < player.roomId) exitDir = '南';
        else if (room.exits.e !== undefined && room.exits.e < player.roomId) exitDir = '東';
        else if (room.exits.w !== undefined && room.exits.w < player.roomId) exitDir = '西';
        if (exitDir && player.roomId !== 0) descStr += `🚪 出口のおおよその方角: ${exitDir}\n`;
    }

    const embedColor = player.encounterActive ? 0xFF0000 : (player.isRadioActive ? 0x00FF00 : 0x2b2d31);
    const invNames = player.inventory.length > 0 ? player.inventory.map(i => i.isTransceiver ? `📻 ${i.name}` : `📦 ${i.name}`).join(', ') : '空';

    const embed = new EmbedBuilder()
        .setTitle(locationStr)
        .setDescription(`💬 ${msg}\n${renderGrid(game, player, player.role === 'navigator')}\n${descStr}`)
        .addFields(
            { name: '📊 状態', value: `${hpData.icon} ${hpData.label} ${player.isBleeding ? '(🩸出血中)' : ''}`, inline: true },
            { name: '⏳ 時間', value: `残り ${Math.floor(game.timeRemainingSec/60)}分 | ${game.totalCredits}/${game.quota}cr (あと${game.daysLeft}日)`, inline: true },
            { name: `🎒 所持品 (${player.inventory.length}/4)`, value: invNames, inline: true }
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
        if (player.roomId === 0) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_exit_facility').setLabel('🌍 脱出する').setStyle(ButtonStyle.Success));
    } else if (player.currentArea === 'ship') {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_store').setLabel('📥 スクラップ保管').setStyle(ButtonStyle.Primary));
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_sell').setLabel('💸 会社に売却').setStyle(ButtonStyle.Success));
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_takeoff').setLabel('🚀 離陸する(1日終了)').setStyle(ButtonStyle.Danger));
        if (player.role === 'navigator') {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_switch_radar').setLabel('📡 レーダー切替').setStyle(ButtonStyle.Primary));
        }
    }

    const hasRadio = player.inventory.some(i => i.isTransceiver);
    if (hasRadio) {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_toggle_radio').setLabel(player.isRadioActive ? '🔇 無線を切る' : '📻 無線を入れる').setStyle(ButtonStyle.Secondary));
        if (player.currentArea !== 'ship') actionRow.addComponents(new ButtonBuilder().setCustomId('freq_drop_radio').setLabel('🗑️ 無線を捨てる').setStyle(ButtonStyle.Secondary));
    }

    if (moveRow.components.length > 0) rows.push(moveRow);
    
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
    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    let targetName = '';
    if (player.hp === 'dead') targetName = 'ghost';
    else if (player.isRadioActive || player.currentArea === 'ship') targetName = 'ship';
    else if (player.currentArea === 'field') targetName = 'field'; // 1ch運用
    else targetName = `room-${player.roomId}`;

    const targetVcId = game.vcIds.get(targetName);
    if (targetVcId) {
        const member = await guild.members.fetch(player.id).catch(() => null);
        if (member?.voice.channelId) await member.voice.setChannel(targetVcId).catch(() => {});
    }
}

async function sendPlayerUI(user: any, game: GameState, player: PlayerState, msg: string) {
    await user.send({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) }).catch(() => {});
}

async function notifyPlayer(client: any, pId: string, game: GameState, msg: string) {
    const p = game.players.get(pId);
    const user = await client.users.fetch(pId).catch(() => null);
    if (p && user) await sendPlayerUI(user, game, p, msg);
}

async function broadcastToAll(client: any, game: GameState, msg: string) {
    for (const [pId, p] of game.players.entries()) {
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, msg);
    }
}

async function cleanupGame(client: any, gameId: string, game: GameState) {
    if (game.gameLoopInterval) clearInterval(game.gameLoopInterval);
    const connection = getVoiceConnection(game.guildId);
    if (connection) connection.destroy();
    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (guild && game.categoryId) {
        const channels = guild.channels.cache.filter(c => c.parentId === game.categoryId);
        for (const [_, c] of channels) await c.delete().catch(() => {});
        await guild.channels.cache.get(game.categoryId)?.delete().catch(() => {});
    }
    pool.query('DELETE FROM frequency_scraps WHERE game_id = $1', [gameId]).catch(() => {});
    activeGames.delete(gameId);
}
