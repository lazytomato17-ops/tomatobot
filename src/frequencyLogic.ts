// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Guild, TextChannel } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { Pool } from 'pg';

// ── DB Setup (PostgreSQL) ──
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

interface Scrap { id: string; name: string; value: number; weight: 'light' | 'medium' | 'heavy'; isTransceiver?: boolean; isFlashlight?: boolean; isWeapon?: boolean; isStun?: boolean; }
interface Room { id: number; name: string; desc: string; exits: { n?: number, s?: number, e?: number, w?: number }; scrap?: Scrap; }
interface Monster { id: string; type: MonsterType; area: 'field' | 'facility'; x: number; y: number; roomId: number; targetId?: string; }

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    hp: HPState;
    isBleeding: boolean;
    bleedTicks: number;
    lastMoveTime: number;
    currentArea: AreaType;
    x: number;
    y: number;
    roomId: number;
    inventory: Scrap[];
    isRadioActive: boolean;
    radarTargetId?: string;
    encounterActive?: { monsterType: MonsterType, timestamp: number, timeout: number };
}

interface GameState {
    guildId: string;
    hostId: string;
    state: 'lobby' | 'orbit' | 'exploring' | 'ended';
    currentPlanet: 'moon' | 'company'; // 現在の着陸先
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
    companyCounter: { x: number, y: number }; // 会社の窓口座標
    timeRemainingSec: number;
    gameLoopInterval?: NodeJS.Timeout;
    client?: any; 
    dropPod?: { x: number, y: number, items: Scrap[], arrivalTimeSec: number, isLanded: boolean };
}

const activeGames = new Map<string, GameState>();

const FIELD_SIZE = 16;
const DAY_TIME_SEC = 900;
const HP_STAGES: Record<HPState, { next: HPState, label: string, icon: string, cooldown: number }> = {
    'healthy': { next: 'injured', label: '健康', icon: '🟢', cooldown: 0 },
    'injured': { next: 'dying', label: '負傷(速度低下)', icon: '🟡', cooldown: 3000 },
    'dying': { next: 'dead', label: '瀕死(出血)', icon: '🔴', cooldown: 5000 },
    'dead': { next: 'dead', label: '死亡', icon: '💀', cooldown: 999999 }
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
    const sx = 2, sy = 2;
    grid[sy][sx] = 2; 
    const fx = Math.floor(Math.random() * 6) + 9;
    const fy = Math.floor(Math.random() * 7) + 8;
    grid[fy][fx] = 3; 

    for (let y = 0; y < FIELD_SIZE; y++) {
        for (let x = 0; x < FIELD_SIZE; x++) {
            if (grid[y][x] === 0 && Math.random() < 0.25) grid[y][x] = 1;
        }
    }

    for(let dy=-1; dy<=1; dy++){
        for(let dx=-1; dx<=1; dx++){
            if(sy+dy >= 0 && sy+dy < FIELD_SIZE && sx+dx >= 0 && sx+dx < FIELD_SIZE && grid[sy+dy][sx+dx] === 1) grid[sy+dy][sx+dx] = 0;
            if(fy+dy >= 0 && fy+dy < FIELD_SIZE && fx+dx >= 0 && fx+dx < FIELD_SIZE && grid[fy+dy][fx+dx] === 1) grid[fy+dy][fx+dx] = 0;
        }
    }

    let cx = sx, cy = sy;
    while(cx !== fx) { cx += (fx > cx ? 1 : -1); if(grid[cy][cx] === 1) grid[cy][cx] = 0; }
    while(cy !== fy) { cy += (fy > cy ? 1 : -1); if(grid[cy][cx] === 1) grid[cy][cx] = 0; }

    return { grid, entrance: { x: fx, y: fy } };
}

// 会社ビル専用の平和なマップ
function generateCompanyField(): { grid: number[][], counter: {x:number, y:number} } {
    const grid = Array.from({ length: FIELD_SIZE }, () => Array(FIELD_SIZE).fill(0));
    grid[2][2] = 2; // Ship
    grid[2][6] = 4; // Company Counter (ID 4)

    // カウンターの奥は壁にして進めなくする
    for(let y = 0; y < FIELD_SIZE; y++) grid[y][7] = 1;

    return { grid, counter: { x: 6, y: 2 } };
}

async function generateFacility(gameId: string): Promise<Room[]> {
    const rooms: Room[] = [];
    const count = Math.floor(Math.random() * 6) + 10;
    for (let i = 0; i < count; i++) {
        const isHeavy = Math.random() < 0.2;
        const scrapId = `scrap_${Date.now()}_${i}`;
        const hasScrap = i > 0 && Math.random() < 0.5;
        rooms.push({
            id: i,
            name: i === 0 ? '施設エントランス' : i === count - 1 ? 'メイン倉庫' : `区画-${i.toString().padStart(2, '0')}`,
            desc: i === 0 ? '外の風が吹き込んでいる。' : '埃っぽい空気が漂っている。',
            exits: {},
            scrap: hasScrap ? { id: scrapId, name: isHeavy ? '重機部品' : (Math.random() < 0.5 ? '金属板' : '配線'), value: isHeavy ? Math.floor(Math.random()*66)+195 : Math.floor(Math.random()*66)+65, weight: isHeavy ? 'heavy' : (Math.random() < 0.5 ? 'medium' : 'light') } : undefined
        });
    }
    for (let i = 0; i < count - 1; i++) { rooms[i].exits.n = i + 1; rooms[i + 1].exits.s = i; }
    for(let i=1; i < count - 2; i++) { if(Math.random() < 0.3) { rooms[i].exits.e = i + 2; rooms[i+2].exits.w = i; } }

    const promises = [];
    for (const room of rooms) {
        if (room.scrap) {
            promises.push(pool.query('INSERT INTO frequency_scraps (game_id, room_id, scrap_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [gameId, room.id, room.scrap.id]));
        }
    }
    await Promise.all(promises).catch(console.error);

    return rooms;
}

function calculateQuota(day: number): number {
    let q = 130;
    for (let i = 1; i < day; i++) q = Math.floor(q * 1.4 + 30);
    return Math.min(q, 2000);
}

function getSellRate(daysLeft: number): number {
    if (daysLeft >= 2) return 0.4;  // 残り2日以上: 40%
    if (daysLeft === 1) return 0.8;  // 残り1日: 80%
    return 1.0;                      // 最終日: 100%
}

// ── Commands & Routing ──
export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    if (activeGames.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ 既に募集中のゲームがあります。' });

    const gameId = interaction.channelId;
    const game: GameState = {
        guildId: interaction.guildId!, hostId: interaction.user.id, state: 'lobby', currentPlanet: 'moon',
        vcIds: new Map(), players: new Map(), monsters: [],
        day: 1, daysLeft: 3, quota: calculateQuota(1), totalCredits: 0, shipScraps: [],
        fieldSize: FIELD_SIZE, fieldGrid: [], facilityRooms: [], facilityEntrance: { x: -1, y: -1 }, companyCounter: { x: -1, y: -1 },
        timeRemainingSec: DAY_TIME_SEC
    };
    activeGames.set(gameId, game);
    await interaction.editReply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

function buildLobbyEmbed(game: GameState) {
    const pList = Array.from(game.players.values()).map(p => `・${p.name} [${p.role === 'navigator' ? '💻ナビ' : '⛏️探索'}]`).join('\n');
    return new EmbedBuilder()
        .setTitle('📻 FREQUENCY - ロビー')
        .setDescription(`**【参加者】**\n${pList || 'なし'}\n\n※2人プレイ時はナビ自動廃止`)
        .setColor(0x2b2d31);
}

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_join_nav').setLabel('ナビゲーター').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('freq_join_scav').setLabel('探索者').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_launch').setLabel('🚀 環境構築(開始)').setStyle(ButtonStyle.Success)
    );
}

export async function handleRadarCommand(interaction: ChatInputCommandInteraction) {
    let game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    if (!game || game.state !== 'exploring') return interaction.reply({ content: '探索中ではありません。', ephemeral: true });
    
    const player = game.players.get(interaction.user.id);
    if (player?.role !== 'navigator' && game.players.size > 2) return interaction.reply({ content: 'ナビゲーター専用コマンドです。', ephemeral: true });

    const targetUser = interaction.options.getUser('target');
    if (targetUser) {
        if (!game.players.has(targetUser.id)) return interaction.reply({ content: 'そのプレイヤーは見つかりません。', ephemeral: true });
        player!.radarTargetId = targetUser.id;
        await interaction.reply({ content: `📡 レーダー対象を ${targetUser.username} に切り替えました。`, ephemeral: true });
    } else {
        player!.radarTargetId = undefined;
        await interaction.reply({ content: `📡 レーダーを全体俯瞰に戻しました。`, ephemeral: true });
    }
    await sendPlayerUI(interaction.client.users.cache.get(player!.id)!, game, player!, 'レーダーを更新しました。');
}

export async function handleButton(interaction: any) {
    let realGameId = interaction.channelId;
    let game = activeGames.get(realGameId);

    if (!game) {
        const entry = Array.from(activeGames.entries()).find(([id, g]) => g.players.has(interaction.user.id));
        if (entry) {
            realGameId = entry[0];
            game = entry[1];
        }
    }
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

    if (action.startsWith('join_')) {
        const role = action === 'join_nav' ? 'navigator' : 'scavenger';
        game.players.set(userId, {
            id: userId, name: interaction.user.username, role, hp: 'healthy', isBleeding: false, bleedTicks: 0, lastMoveTime: 0,
            currentArea: 'ship', x: 2, y: 2, roomId: 0,
            inventory: [{ id: `tr_${userId}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true }], isRadioActive: false
        });
        return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
    }
    
    if (action === 'launch') {
        if (userId !== game.hostId) return interaction.reply({ content: 'ホストのみ開始可能です。', ephemeral: true });
        if (game.players.size === 2) game.players.forEach(p => p.role = 'scavenger');
        await interaction.deferUpdate();
        await interaction.editReply({ content: '🚀 環境を構築中...', embeds: [], components: [] });
        await setupGameEnvironment(interaction.client, realGameId, game);
        return;
    }

    const player = game.players.get(userId);
    if (!player || player.hp === 'dead') return;

    if (action.startsWith('move_')) {
        const cooldown = HP_STAGES[player.hp].cooldown;
        if (Date.now() - player.lastMoveTime < cooldown) {
            return interaction.reply({ content: '⚠️ 負傷で足がもつれている...（移動クールダウン中）', ephemeral: true });
        }
        player.lastMoveTime = Date.now();
    }

    await executePlayerAction(interaction, action, game, player, realGameId);
}

// ── Environment Setup ──
async function setupGameEnvironment(client: any, gameId: string, game: GameState) {
    const guild: Guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    const category = await guild.channels.create({ name: '🔴 FREQUENCY ZONE', type: ChannelType.GuildCategory });
    game.categoryId = category.id;
    const ghostText = await guild.channels.create({ name: '👻ghost-chat', type: ChannelType.GuildText, parent: category.id });
    game.ghostTextId = ghostText.id;
    
    game.vcIds.set('ship', (await guild.channels.create({ name: '🛸 ship', type: ChannelType.GuildVoice, parent: category.id })).id);
    game.vcIds.set('field', (await guild.channels.create({ name: '🌍 field', type: ChannelType.GuildVoice, parent: category.id })).id);
    game.vcIds.set('ghost', (await guild.channels.create({ name: '👻 ghost', type: ChannelType.GuildVoice, parent: category.id })).id);

    for (let i = 0; i <= 15; i++) {
        const rName = i === 0 ? '🚪 room-entrance' : `🚪 room-${i.toString().padStart(2, '0')}`;
        game.vcIds.set(`room-${i}`, (await guild.channels.create({ name: rName, type: ChannelType.GuildVoice, parent: category.id })).id);
    }

    await pool.query('DELETE FROM frequency_scraps WHERE game_id = $1', [gameId]).catch(console.error);

    game.state = 'orbit';
    game.timeRemainingSec = DAY_TIME_SEC;

    for (const [pId, p] of game.players.entries()) {
        p.currentArea = 'ship'; 
        await updatePlayerVC(client, game, p);
        const user = await client.users.fetch(pId).catch(() => null);
        if (user) await sendPlayerUI(user, game, p, '【軌道上】着陸準備が完了しました。惑星か会社に向かってください。');
    }
}

// ── Game Loop ──
function startGameLoop(client: any, gameId: string, game: GameState) {
    let tick = 0;
    game.gameLoopInterval = setInterval(async () => {
        game.timeRemainingSec--;
        tick++;

        const alivePlayers = Array.from(game.players.values()).filter(p => p.hp !== 'dead' && p.currentArea !== 'ghost');
        if (alivePlayers.length === 0 && game.players.size > 0) {
            clearInterval(game.gameLoopInterval);
            await handleTakeoff(client, gameId, game, true);
            return;
        }

        if (game.dropPod && !game.dropPod.isLanded && game.timeRemainingSec <= game.dropPod.arrivalTimeSec) {
            game.dropPod.isLanded = true;
            broadcastToAll(client, game, '💥 【通知】ズドーン！船のすぐ近く[3, 2]に物資ポッドが着陸した！');
        }

        if (tick % 30 === 0 && game.currentPlanet === 'moon') {
            for (const p of game.players.values()) {
                if (p.hp !== 'dead' && p.isBleeding) {
                    p.bleedTicks++;
                    if (p.bleedTicks >= 2 && p.hp === 'dying') {
                        p.hp = 'dead'; p.currentArea = 'ghost'; p.inventory = [];
                        await updatePlayerVC(client, game, p);
                        notifyPlayer(client, p.id, game, '🩸 出血多量により死亡した...');
                        sendToGhostChat(client, game, `💀 ${p.name} が出血多量で死亡しました。`);
                    } else {
                        takeDamage(p, game);
                        notifyPlayer(client, p.id, game, '🩸 出血により状態が悪化した...');
                    }
                }
            }
        }

        if (game.timeRemainingSec === 300) broadcastToAll(client, game, '🚨 【警告】自動離陸まであと5分。');
        if (game.timeRemainingSec <= 60 && game.timeRemainingSec % 30 === 0) broadcastToAll(client, game, `🚨 自動離陸まであと${game.timeRemainingSec}秒！`);
        
        if (game.timeRemainingSec <= 0) {
            clearInterval(game.gameLoopInterval);
            await handleTakeoff(client, gameId, game, true);
        }
    }, 1000);
}

// ── Actions ──
async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState, gameId: string) {
    let msg = '';

    if (player.encounterActive) {
        if (action.startsWith('escape_')) {
            const timeTaken = Date.now() - player.encounterActive.timestamp;
            
            if (action === 'escape_fight' || action === 'escape_stun') {
                const isStun = action === 'escape_stun';
                const itemIdx = player.inventory.findIndex(i => isStun ? i.isStun : i.isWeapon);
                if (itemIdx !== -1) {
                    player.inventory.splice(itemIdx, 1);
                    msg = isStun ? '⚡ スタンガンで怪物を足止めして難を逃れた！（消費）' : '⛏️ シャベルで怪物を殴り飛ばした！（壊れた）';
                } else {
                    msg = handleEncounterDamage(player, game); 
                }
            } else if (action === 'escape_stay' || timeTaken > player.encounterActive.timeout * 1000) {
                msg = handleEncounterDamage(player, game);
            } else {
                msg = '💨 間一髪で逃げ切った！';
                handleMovement(game, player, action.replace('escape_', '')); 
            }
        } else msg = handleEncounterDamage(player, game); 
        
        player.encounterActive = undefined;
        await updatePlayerVC(interaction.client, game, player);
        return interaction.update({ embeds: [buildPlayerUIEmbed(game, player, msg)], components: getPlayerControlRow(player, game) });
    }

    if (action === 'land_moon' || action === 'land_company') {
        if (game.state !== 'orbit') return interaction.reply({ content: '既に探索中です。', ephemeral: true });
        game.state = 'exploring';
        game.currentPlanet = action === 'land_moon' ? 'moon' : 'company';
        
        await pool.query('DELETE FROM frequency_scraps WHERE game_id = $1', [gameId]).catch(console.error);
        
        if (game.currentPlanet === 'moon') {
            const fieldData = generateField();
            game.fieldGrid = fieldData.grid; game.facilityEntrance = fieldData.entrance;
            game.facilityRooms = await generateFacility(gameId); 
            game.monsters = [ { id: 'm1', type: 'patrol', area: 'facility', x: 0, y: 0, roomId: 5 }, { id: 'm2', type: 'chaser', area: 'facility', x: 0, y: 0, roomId: 8 }, { id: 'm3', type: 'ambush', area: 'facility', x: 0, y: 0, roomId: game.facilityRooms.length - 1 } ];
            msg = '🛬 未開の惑星に着陸しました！';
        } else {
            const compData = generateCompanyField();
            game.fieldGrid = compData.grid; game.companyCounter = compData.counter;
            game.facilityRooms = []; game.facilityEntrance = { x: -1, y: -1 }; game.monsters = [];
            msg = '🏢 会社ビルに着陸しました！窓口にアイテムを納品してください。';
        }
        
        game.timeRemainingSec = DAY_TIME_SEC;
        game.dropPod = undefined;
        
        startGameLoop(interaction.client, gameId, game);
        
        for (const [pId, p] of game.players.entries()) {
            if (pId !== player.id) notifyPlayer(interaction.client, pId, game, msg);
        }
        
    } else if (action === 'exit_ship') {
        player.currentArea = 'field'; player.x = 2; player.y = 2; msg = '🌍 船から外に出た。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action.startsWith('buy_')) {
        const itemType = action.replace('buy_', '');
        const shopData: Record<string, {name: string, price: number, props: any}> = {
            'radio': { name: 'トランシーバー', price: 15, props: { isTransceiver: true } },
            'flash': { name: 'フラッシュライト', price: 15, props: { isFlashlight: true } },
            'shovel': { name: 'シャベル', price: 30, props: { isWeapon: true } },
            'stun': { name: 'スタンガン', price: 400, props: { isStun: true } }
        };
        const targetItem = shopData[itemType];
        if (targetItem) {
            if (game.totalCredits < targetItem.price) {
                msg = '⚠️ クレジットが足りない！';
            } else {
                game.totalCredits -= targetItem.price;
                let items = (game.dropPod && !game.dropPod.isLanded) ? game.dropPod.items : [];
                items.push({ id: `item_${Date.now()}`, name: targetItem.name, value: 0, weight: 'light', ...targetItem.props });
                const arrivalTime = (game.dropPod && !game.dropPod.isLanded) ? game.dropPod.arrivalTimeSec : game.timeRemainingSec - 30;
                game.dropPod = { x: 3, y: 2, items: items, arrivalTimeSec: arrivalTime, isLanded: false };
                msg = `🛒 ${targetItem.name} を発注した！ (-${targetItem.price}cr) ポッドに積載されます。`;
            }
        }
    } else if (action === 'open_pod') {
        if (game.dropPod && game.dropPod.isLanded) {
            const spaceLeft = 4 - player.inventory.length;
            if (spaceLeft > 0) {
                const taken = game.dropPod.items.splice(0, spaceLeft);
                player.inventory.push(...taken);
                msg = `📦 ポッドから ${taken.map(i=>i.name).join(', ')} を回収した！`;
                if (game.dropPod.items.length === 0) game.dropPod = undefined;
            } else msg = `⚠️ インベントリに空きがない！`;
        }
    } else if (action === 'toggle_radio') {
        if (!player.inventory.some(i => i.isTransceiver)) msg = 'トランシーバーを持っていない！';
        else {
            player.isRadioActive = !player.isRadioActive;
            msg = player.isRadioActive ? '📻 通信を開いた。(遭遇判定無効)' : '🔇 通信を切った。';
            await updatePlayerVC(interaction.client, game, player);
            if (!player.isRadioActive) msg = checkMonsterEncounter(player, game) || msg;
        }
    } else if (action === 'drop_radio') {
        const idx = player.inventory.findIndex(i => i.isTransceiver);
        if (idx !== -1) {
            player.inventory.splice(idx, 1); player.isRadioActive = false;
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
            msg = !player.radarTargetId ? '📡 全体俯瞰に戻した。' : `📡 対象を ${game.players.get(player.radarTargetId)?.name} に切替。`;
        }
    } else if (action.startsWith('move_')) {
        msg = handleMovement(game, player, action.replace('move_', ''));
        if (game.currentPlanet === 'moon') moveMonsters(game); 
        await updatePlayerVC(interaction.client, game, player);
        msg = checkMonsterEncounter(player, game) || msg;
    } else if (action === 'enter_facility') {
        player.currentArea = 'facility'; player.roomId = 0; msg = '🚪 施設内に侵入した。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'exit_facility') {
        player.currentArea = 'field'; player.x = game.facilityEntrance.x; player.y = game.facilityEntrance.y; msg = '🌍 施設から外に出た。';
        player.isBleeding = false; 
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'enter_ship') {
        player.currentArea = 'ship'; msg = '🛸 船に戻った。安全だ。';
        await updatePlayerVC(interaction.client, game, player);
    } else if (action === 'grab') {
        const room = game.facilityRooms[player.roomId];
        const hasHeavy = player.inventory.some(i => i.weight === 'heavy');
        
        if (!room.scrap) msg = '何もない。';
        else if (hasHeavy) msg = '⚠️ 【大物】で両手が塞がっていて拾えない！';
        else if (room.scrap.weight === 'heavy' && player.inventory.length > 0) msg = '⚠️ 【大物】を拾うにはインベントリを空にする必要がある！';
        else if (player.inventory.length >= 4) msg = '🎒 インベントリ(4枠)が満杯だ。';
        else {
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
                    room.scrap = undefined;
                }
            } catch (e) {
                await client.query('ROLLBACK');
                msg = 'エラーが発生しました。';
            } finally {
                client.release();
            }
        }
    } else if (action === 'store') {
        const scraps = player.inventory.filter(i => !i.isTransceiver && !i.isFlashlight && !i.isWeapon && !i.isStun);
        if (scraps.length > 0) {
            game.shipScraps.push(...scraps);
            player.inventory = player.inventory.filter(i => i.isTransceiver || i.isFlashlight || i.isWeapon || i.isStun);
            msg = `📦 ${scraps.length}個のスクラップを保管した！(装備品は残しました)`;
        } else msg = '保管するスクラップがない。';
    } else if (action === 'deliver') {
        if (game.shipScraps.length === 0) msg = '⚠️ 船の「スクラップ保管」に納品するアイテムがない！';
        else {
            const raw = game.shipScraps.reduce((acc, s) => acc + s.value, 0);
            const rate = getSellRate(game.daysLeft);
            const earned = Math.floor(raw * rate);
            game.totalCredits += earned; game.shipScraps = [];
            msg = `🔔 窓口のベルを鳴らし、スクラップを一括納品した！ (レート: ${rate * 100}% -> +${earned}cr)`;
            sendToGhostChat(interaction.client, game, `🔔 チリンチリン！ ${player.name} が納品しました。`);
        }
    } else if (action === 'takeoff') {
        if (player.currentArea !== 'ship') return interaction.reply({ content: '船内からのみ離陸可能です。', ephemeral: true });
        await interaction.update({ content: '🚀 船を離陸させています...', embeds: [], components: [] });
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
        return '木や壁に阻まれて進めない。';
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

function moveMonsters(game: GameState) {
    if (game.currentPlanet !== 'moon') return;
    for (const m of game.monsters) {
        if (m.area !== 'facility') continue;
        if (m.type === 'ambush') continue; 

        const currentRoom = game.facilityRooms[m.roomId];
        if (!currentRoom) continue;
        const exits = Object.values(currentRoom.exits).filter(id => id !== undefined) as number[];
        
        if (exits.length > 0) {
            if (m.type === 'patrol') {
                m.roomId = exits[Math.floor(Math.random() * exits.length)];
            } else if (m.type === 'chaser') {
                const targets = Array.from(game.players.values()).filter(p => p.currentArea === 'facility' && p.hp !== 'dead');
                if (targets.length > 0) {
                    const target = targets[0]; 
                    if (target.roomId !== m.roomId) m.roomId = exits[Math.floor(Math.random() * exits.length)]; 
                }
            }
        }
    }
}

function checkMonsterEncounter(player: PlayerState, game: GameState): string | null {
    if (game.currentPlanet !== 'moon') return null; // 会社は平和
    if (player.isRadioActive && player.currentArea !== 'ship') return null; 
    const monster = game.monsters.find(m => m.area === player.currentArea && (player.currentArea === 'facility' ? m.roomId === player.roomId : (m.x === player.x && m.y === player.y)));
    
    if (monster) {
        if (monster.type === 'ambush') {
            takeDamage(player, game, true);
            sendToGhostChat(game.client, game, `💀 ${player.name} が待伏型の怪物に暗殺されました。`);
            return '🩸 **【即死】部屋の暗がりに潜んでいた化け物に襲撃された。**';
        } else {
            const timeout = monster.type === 'chaser' ? 3 : 5;
            player.encounterActive = { monsterType: monster.type, timestamp: Date.now(), timeout };
            return `⚠ **何かがいる！ [猶予: ${timeout}秒]** すぐに逃避行動をとれ！`;
        }
    }
    
    if (game.players.size === 2 && player.currentArea === 'facility') {
        const nearMonster = game.monsters.find(m => m.area === 'facility' && Object.values(game.facilityRooms[player.roomId].exits).includes(m.roomId));
        if (nearMonster) return '⚠ [簡易ナビ] 隣の部屋から嫌な気配がする...';
    }
    return null;
}

function handleEncounterDamage(player: PlayerState, game: GameState): string {
    const type = player.encounterActive?.monsterType;
    if (type === 'chaser') {
        if (player.hp === 'dying') { 
            takeDamage(player, game, true); 
            sendToGhostChat(game.client, game, `💀 ${player.name} が追跡型に追いつかれ死亡しました。`);
            return '🩸 追いつかれ、命を落とした。'; 
        }
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

    let survived = false;
    for (const p of game.players.values()) {
        if (p.currentArea !== 'ship') { p.hp = 'dead'; p.inventory = []; p.currentArea = 'ghost'; }
        if (p.hp !== 'dead') survived = true;
    }

    if (!survived) game.shipScraps = []; 
    game.dropPod = undefined;

    await pool.query('DELETE FROM frequency_scraps WHERE game_id = $1', [gameId]).catch(console.error);

    game.daysLeft--; // 1日消費
    game.state = 'orbit';

    let msg = isForced ? `🚨 **強制離陸しました！**\n\n` : `🚀 **船を離陸させ、軌道上に退避しました！**\n\n`;
    if (!survived) msg += `💀 【全滅】 保管スクラップを全てロストしました...\n`;
    msg += `💳 【現在残高】 ${game.totalCredits} / ${game.quota} cr\n\n`;

    // 残り日数がマイナス（0日目の探索を終えて離陸した）場合、ノルマ判定
    if (game.daysLeft < 0) {
        if (game.totalCredits >= game.quota) {
            game.day++; game.daysLeft = 3; game.quota = calculateQuota(game.day);
            msg += `🎉 **ノルマ達成！素晴らしい働きです。**\n次回の会社目標は ${game.quota} cr です。（猶予: 3日）\n`;
        } else {
            msg += `💀 **【ノルマ未達】 価値を満たせませんでした。あなた方は宇宙空間へ放り出されます。** [GAME OVER]`;
            game.state = 'ended';
            await broadcastToAll(client, game, msg);
            await cleanupGame(client, gameId, game);
            return;
        }
    } else {
        msg += `📅 ノルマ期限まで残り **${game.daysLeft}** 日\n`;
        if (game.daysLeft === 0) msg += `⚠️ **【警告】 残り0日です！** 今日中に会社ビルへ向かい納品しないと解雇されます。\n`;
    }

    for (const p of game.players.values()) {
        p.hp = 'healthy'; p.isBleeding = false; p.bleedTicks = 0; p.currentArea = 'ship'; p.x = 2; p.y = 2; p.roomId = 0; p.encounterActive = undefined; p.lastMoveTime = 0;
        if (!p.inventory.some(i => i.isTransceiver)) p.inventory.unshift({ id: `tr_${p.id}`, name: 'トランシーバー', value: 0, weight: 'light', isTransceiver: true });
        await updatePlayerVC(client, game, p);
    }

    msg += `\n準備ができたら行き先を選択してください。`;
    await broadcastToAll(client, game, msg);
}

// ── UI Rendering ──
function renderGrid(game: GameState, player: PlayerState, isNav: boolean): string {
    let viewArea = player.currentArea;
    let cx = player.x, cy = player.y, cRoomId = player.roomId;

    if (isNav && player.radarTargetId) {
        const target = game.players.get(player.radarTargetId);
        if (target && target.hp !== 'dead') { viewArea = target.currentArea; cx = target.x; cy = target.y; cRoomId = target.roomId; }
    } else if (isNav && !player.radarTargetId && viewArea === 'facility') {
        const target = Array.from(game.players.values()).find(p => p.role === 'scavenger' && p.hp !== 'dead' && p.currentArea === 'facility');
        if (target) { viewArea = target.currentArea; cx = target.x; cy = target.y; cRoomId = target.roomId; }
    }

    if (viewArea === 'field') {
        const size = isNav ? 3 : 2;
        let out = '';
        for (let y = cy - size; y <= cy + size; y++) {
            for (let x = cx - size; x <= cx + size; x++) {
                if (x === cx && y === cy) out += '👤';
                else if (game.dropPod?.isLanded && x === game.dropPod.x && y === game.dropPod.y) out += '📦'; 
                else if (isNav && game.monsters.some(m => m.area === 'field' && m.x === x && m.y === y)) out += '🔴';
                else if (isNav && Array.from(game.players.values()).some(p => p.currentArea === 'field' && p.x === x && p.y === y && p.id !== player.id)) out += '🟢';
                else if (x < 0 || x >= FIELD_SIZE || y < 0 || y >= FIELD_SIZE) out += '🌫';
                else if (game.fieldGrid[y][x] === 1) out += '🌲';
                else if (game.fieldGrid[y][x] === 2) out += '🛸';
                else if (game.fieldGrid[y][x] === 3) out += '🏭';
                else if (game.fieldGrid[y][x] === 4) out += '🏢'; // 会社カウンター
                else out += '土';
            }
            out += '\n';
        }
        return `\`\`\`\n${out}\n\`\`\``;
    } else if (viewArea === 'facility') {
        if (!isNav) {
            const room = game.facilityRooms[cRoomId];
            if (!room) return '';
            let out = `⬛${room.exits.n !== undefined ? '🚪' : '⬛'}⬛\n`;
            out += `${room.exits.w !== undefined ? '🚪' : '⬛'}👤${room.exits.e !== undefined ? '🚪' : '⬛'}\n`;
            out += `⬛${room.exits.s !== undefined ? '🚪' : '⬛'}⬛\n`;
            return `\`\`\`\n${out}\n\`\`\``;
        } else {
            const getRoomChar = (rid: number | undefined) => {
                if (rid === undefined) return '⬛';
                const mon = game.monsters.find(m => m.area === 'facility' && m.roomId === rid);
                if (mon) return mon.type === 'ambush' ? '🟠' : '🔴';
                const p = Array.from(game.players.values()).find(pl => pl.currentArea === 'facility' && pl.roomId === rid);
                if (p) return '🟢';
                return '⬜';
            };
            const cRoom = game.facilityRooms[cRoomId];
            if (!cRoom) return '';
            const nRoom = cRoom.exits.n !== undefined ? game.facilityRooms[cRoom.exits.n] : null;
            const sRoom = cRoom.exits.s !== undefined ? game.facilityRooms[cRoom.exits.s] : null;

            let out = '';
            out += `⬛⬛${nRoom?.exits.n !== undefined ? '🚪' : '⬛'}⬛⬛\n`;
            out += `⬛${nRoom?.exits.w !== undefined ? '🚪' : '⬛'}${getRoomChar(cRoom.exits.n)}${nRoom?.exits.e !== undefined ? '🚪' : '⬛'}⬛\n`;
            out += `${cRoom.exits.w !== undefined ? '🚪' : '⬛'}⬛${getRoomChar(cRoomId)}⬛${cRoom.exits.e !== undefined ? '🚪' : '⬛'}\n`;
            out += `⬛${sRoom?.exits.w !== undefined ? '🚪' : '⬛'}${getRoomChar(cRoom.exits.s)}${sRoom?.exits.e !== undefined ? '🚪' : '⬛'}⬛\n`;
            out += `⬛⬛${sRoom?.exits.s !== undefined ? '🚪' : '⬛'}⬛⬛\n`;
            return `\`\`\`\n${out}\n\`\`\``;
        }
    }
    return '';
}

function buildPlayerUIEmbed(game: GameState, player: PlayerState, msg: string = '') {
    if (player.hp === 'dead') return new EmbedBuilder().setTitle('💀 霊界').setDescription(`${msg}\n\nあなたは死にました。`).setColor(0x000000);

    const hpData = HP_STAGES[player.hp];
    let locationStr = player.currentArea === 'ship' ? (game.state === 'orbit' ? '🛸 船内 (軌道上)' : '🛸 船内 (着陸中)') : player.currentArea === 'field' ? `🌍 外 [${player.x}, ${player.y}]` : `🏭 施設 [${game.facilityRooms[player.roomId]?.name || '不明'}]`;
    let descStr = '';

    const hasFlashlight = player.inventory.some(i => i.isFlashlight);

    if (player.currentArea === 'field') {
        descStr += `🛸 船の方角: ${getDirectionText(player.x, player.y, 2, 2)}\n`;
        if (game.currentPlanet === 'moon') {
            descStr += `🏭 施設の方角: ${getDirectionText(player.x, player.y, game.facilityEntrance.x, game.facilityEntrance.y)}\n`;
            if (player.x === game.facilityEntrance.x && player.y === game.facilityEntrance.y) descStr += '🏭 目の前に施設の入り口がある！\n';
        } else if (game.currentPlanet === 'company') {
            descStr += `🏢 会社の窓口: ${getDirectionText(player.x, player.y, game.companyCounter.x, game.companyCounter.y)}\n`;
            if (player.x === game.companyCounter.x && player.y === game.companyCounter.y) descStr += '🛎️ 目の前に不気味な納品窓口がある。\n';
        }
        
        if (player.x === 2 && player.y === 2) descStr += '🛸 目の前に船がある。\n';
        if (game.dropPod?.isLanded && player.x === game.dropPod.x && player.y === game.dropPod.y) descStr += '📦 物資ポッドがここにある！\n';
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        if (room) {
            let exitDir = '';
            if (room.exits.n !== undefined && room.exits.n < player.roomId) exitDir = '北';
            else if (room.exits.s !== undefined && room.exits.s < player.roomId) exitDir = '南';
            else if (room.exits.e !== undefined && room.exits.e < player.roomId) exitDir = '東';
            else if (room.exits.w !== undefined && room.exits.w < player.roomId) exitDir = '西';
            if (exitDir && player.roomId !== 0) descStr += `🚪 出口のおおよその方角: ${exitDir}\n`;
            
            if (hasFlashlight) descStr += '🔦 ライトの明かりで部屋の隅々までよく見える。\n';
        }
    }

    const embedColor = player.encounterActive ? 0xFF0000 : (player.isRadioActive ? 0x00FF00 : 0x2b2d31);
    const invNames = player.inventory.length > 0 ? player.inventory.map(i => i.isTransceiver ? `📻 ${i.name}` : i.isFlashlight ? `🔦 ${i.name}` : i.isWeapon || i.isStun ? `⚔️ ${i.name}` : `📦 ${i.name}`).join(', ') : '空';

    const embed = new EmbedBuilder()
        .setTitle(locationStr)
        .setDescription(`💬 ${msg}\n${renderGrid(game, player, player.role === 'navigator')}\n${descStr}`)
        .addFields(
            { name: '📊 状態', value: `${hpData.icon} ${hpData.label} ${player.isBleeding ? '(🩸出血中)' : ''}`, inline: true },
            { name: '⏳ 時間', value: `残り ${Math.floor(game.timeRemainingSec/60)}分 | ${game.totalCredits}/${game.quota}cr (あと${game.daysLeft}日)`, inline: true },
            { name: `🎒 所持品 (${player.inventory.length}/4)`, value: invNames, inline: true }
        )
        .setColor(embedColor);

    if (player.currentArea === 'facility' && game.facilityRooms[player.roomId]?.scrap) {
        embed.addFields({ name: '✨ 発見', value: `床に **${game.facilityRooms[player.roomId].scrap!.name}** (${game.facilityRooms[player.roomId].scrap!.weight}) が落ちている。` });
    }
    
    if (player.role === 'navigator' && game.players.size > 2) {
        let radarDesc = '\n--- レーダー情報 ---\n';
        game.players.forEach(p => {
            if (p.role !== 'navigator' && p.hp !== 'dead') radarDesc += `🟢 ${p.name} - ${p.currentArea === 'field' ? '外' : '施設内(Room '+p.roomId+')'}\n`;
        });
        embed.addFields({ name: '💻 ナビゲーションシステム', value: radarDesc });
        sendToGhostChat(game.client as any, game, `[レーダー定期更新]\n${radarDesc}`);
    }

    return embed;
}

function getPlayerControlRow(player: PlayerState, game: GameState): ActionRowBuilder<ButtonBuilder>[] {
    if (player.hp === 'dead') return [];
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    if (player.encounterActive) {
        const r = new ActionRowBuilder<ButtonBuilder>();
        r.addComponents(
            new ButtonBuilder().setCustomId('freq_escape_n').setLabel('北へ逃げる').setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId('freq_escape_s').setLabel('南へ逃げる').setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId('freq_escape_stay').setLabel('その場に留まる').setStyle(ButtonStyle.Danger)
        );
        if (player.inventory.some(i => i.isWeapon)) r.addComponents(new ButtonBuilder().setCustomId('freq_escape_fight').setLabel('⛏️ シャベルで迎撃').setStyle(ButtonStyle.Success));
        if (player.inventory.some(i => i.isStun)) r.addComponents(new ButtonBuilder().setCustomId('freq_escape_stun').setLabel('⚡ スタンガン使用').setStyle(ButtonStyle.Success));
        return [r];
    }

    const moveRow = new ActionRowBuilder<ButtonBuilder>();
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    const shopRow = new ActionRowBuilder<ButtonBuilder>();

    if (player.currentArea === 'field') {
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_n').setLabel('北').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_s').setLabel('南').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_e').setLabel('東').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('freq_move_w').setLabel('西').setStyle(ButtonStyle.Secondary));
        if (player.x === 2 && player.y === 2) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_enter_ship').setLabel('🛸 船に戻る').setStyle(ButtonStyle.Success));
        
        if (game.currentPlanet === 'moon' && player.x === game.facilityEntrance.x && player.y === game.facilityEntrance.y) {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_enter_facility').setLabel('🚪 施設に入る').setStyle(ButtonStyle.Danger));
        } else if (game.currentPlanet === 'company' && player.x === game.companyCounter.x && player.y === game.companyCounter.y) {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_deliver').setLabel('🛎️ 窓口で納品する').setStyle(ButtonStyle.Success));
        }

        if (game.dropPod?.isLanded && player.x === game.dropPod.x && player.y === game.dropPod.y) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_open_pod').setLabel('📦 ポッドから回収').setStyle(ButtonStyle.Success));
    } else if (player.currentArea === 'facility') {
        const room = game.facilityRooms[player.roomId];
        if (room) {
            if (room.exits.n !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_n').setLabel('北の扉').setStyle(ButtonStyle.Secondary));
            if (room.exits.s !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_s').setLabel('南の扉').setStyle(ButtonStyle.Secondary));
            if (room.exits.e !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_e').setLabel('東の扉').setStyle(ButtonStyle.Secondary));
            if (room.exits.w !== undefined) moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_w').setLabel('西の扉').setStyle(ButtonStyle.Secondary));

            if (room.scrap) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_grab').setLabel('📦 拾う').setStyle(ButtonStyle.Primary));
            if (player.roomId === 0) actionRow.addComponents(new ButtonBuilder().setCustomId('freq_exit_facility').setLabel('🌍 施設から出る').setStyle(ButtonStyle.Success));
        }
    } else if (player.currentArea === 'ship') {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_store').setLabel('📥 スクラップ保管').setStyle(ButtonStyle.Primary));
        
        if (game.state === 'orbit') {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_land_moon').setLabel(`🛬 惑星に着陸 (残り${game.daysLeft}日)`).setStyle(ButtonStyle.Danger));
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_land_company').setLabel('🏢 会社ビルに着陸').setStyle(ButtonStyle.Success));
        } else if (game.state === 'exploring') {
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_exit_ship').setLabel('🚪 船から外に出る').setStyle(ButtonStyle.Success));
            actionRow.addComponents(new ButtonBuilder().setCustomId('freq_takeoff').setLabel('🚀 離陸する(1日経過)').setStyle(ButtonStyle.Danger));
        }

        if (player.role === 'navigator') {
            if (game.currentPlanet === 'moon') actionRow.addComponents(new ButtonBuilder().setCustomId('freq_switch_radar').setLabel('📡 レーダー切替').setStyle(ButtonStyle.Primary));
            shopRow.addComponents(new ButtonBuilder().setCustomId('freq_buy_radio').setLabel('無線機(15)').setStyle(ButtonStyle.Secondary));
            shopRow.addComponents(new ButtonBuilder().setCustomId('freq_buy_flash').setLabel('ライト(15)').setStyle(ButtonStyle.Secondary));
            shopRow.addComponents(new ButtonBuilder().setCustomId('freq_buy_shovel').setLabel('シャベル(30)').setStyle(ButtonStyle.Secondary));
            shopRow.addComponents(new ButtonBuilder().setCustomId('freq_buy_stun').setLabel('スタン(400)').setStyle(ButtonStyle.Secondary));
        }
    }

    if (player.inventory.some(i => i.isTransceiver)) {
        actionRow.addComponents(new ButtonBuilder().setCustomId('freq_toggle_radio').setLabel(player.isRadioActive ? '🔇 無線を切る' : '📻 無線を入れる').setStyle(ButtonStyle.Secondary));
    }

    if (moveRow.components.length > 0) rows.push(moveRow);
    if (actionRow.components.length > 5) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actionRow.components.slice(0, 5)), new ActionRowBuilder<ButtonBuilder>().addComponents(actionRow.components.slice(5)));
    } else if (actionRow.components.length > 0) {
        rows.push(actionRow);
    }
    if (shopRow.components.length > 0) rows.push(shopRow);
    return rows;
}

// ── Utils ──
async function updatePlayerVC(client: any, game: GameState, player: PlayerState) {
    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    let targetName = '';
    if (player.hp === 'dead') targetName = 'ghost';
    else if (player.isRadioActive || player.currentArea === 'ship') targetName = 'ship';
    else if (player.currentArea === 'field') targetName = 'field';
    else targetName = `room-${player.roomId}`;

    const targetVcId = game.vcIds.get(targetName);
    if (targetVcId) {
        const member = await guild.members.fetch(player.id).catch(() => null);
        if (member?.voice.channelId) await member.voice.setChannel(targetVcId).catch(() => {});
    }
}

async function sendPlayerUI(user: any, game: GameState, player: PlayerState, msg: string) {
    game.client = user.client; 
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

async function sendToGhostChat(client: any, game: GameState, msg: string) {
    if (!game.ghostTextId) return;
    const channel = await client.channels.fetch(game.ghostTextId).catch(() => null);
    if (channel && channel.isTextBased()) await (channel as TextChannel).send(msg).catch(() => {});
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
