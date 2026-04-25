// src/lethalLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

// ── ゲームバランス定数 ────────────────────────────────────────
/** 1ゲームあたりの最大日数（これを超えるとノルマ判定） */
const MAX_DAYS = 3;

/** 初期ノルマ（円） */
const INITIAL_QUOTA = 500;

/** ノルマ達成後の増加量（円） */
const QUOTA_INCREMENT = 500;

/** ゲーム開始時刻（施設内時間、整数=時） */
const START_TIME = 8;

/** この時刻以降に移動しようとすると自動帰還が発動する */
const AUTO_RETURN_TIME = 24;

/** 時刻がこれ以上になると帰還ウィンドウ（スクラップ価値1.5倍ボーナス） */
const LATE_BONUS_TIME = 17;

/** 時刻がこれ以上になると時間アイコンが赤に */
const DANGER_TIME = 20;

/** 生成する施設の部屋数 */
const ROOM_COUNT = 15;

/** アイテム価格（円） */
const ITEM_PRICE = { flashlight: 100, shovel: 200, walkie_talkie: 150 } as const;

/** 死体回収成功時のファンド加算額（円） */
const CORPSE_VALUE = 50;

// ── 型定義 ───────────────────────────────────────────────────
type EncounterType = 'bracken' | 'coilhead' | 'eyelessdog';
type RoleType = 'scavenger' | 'monitor' | 'none';
type ZoneType = 'orbit' | 'ship' | string; // 'orbit'=軌道上, 'ship'=船内, その他=施設内ルームID
type Direction = 'forward' | 'left' | 'right' | 'back';

interface Room {
    id: string;
    name: string;
    connections: { [key in Direction]?: string };
    /** この部屋のスクラップ価値（円）。回収済みの場合は 0 */
    scraps: number;
    /** この部屋固有の危険度ボーナス（0〜30）。facilityDangerと合算して使う */
    dangerBase: number;
}

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    isAlive: boolean;
    hp: number;
    /**
     * プレイヤーが現在持ち運んでいるスクラップの合計価値（円）。
     * ※ 「アイテムの個数」ではなく「換金予定のスクラップ価値の合計」。
     * 帰還時に game.funds へ加算され、このフィールドはリセットされる。
     */
    carriedScrap: number;
    /** 両手が塞がる重量物を持っているか（移動ペナルティあり） */
    hasTwoHanded: boolean;
    items: { flashlight: boolean; shovel: boolean; walkie_talkie: boolean };
    zone: ZoneType;
    /** 移動アニメーション中の多重クリック防止フラグ */
    isMoving?: boolean;
}

interface Corpse {
    userId: string;
    name: string;
    /** 回収時に game.funds に加算される価値（円） */
    value: number;
    zone: ZoneType;
}

interface GameState {
    hostId: string;
    state: 'lobby' | 'playing';
    location: 'orbit' | 'moon';
    /** QTE等の重複処理を防ぐゲームレベルのロック */
    isProcessing: boolean;
    /** 現在の日数（MAX_DAYS を超えるとノルマ判定） */
    day: number;
    /** 施設内の時刻（整数=時。AUTO_RETURN_TIME 以上で自動帰還） */
    time: number;
    /** 今期のノルマ（円） */
    quota: number;
    /** チーム共有資金（円）。スクラップ換金・アイテム購入に使用 */
    funds: number;
    /** 施設全体の危険度（0〜100）。探索を重ねるほど上昇する */
    facilityDanger: number;
    corpses: Corpse[];
    players: Map<string, PlayerState>;
    /** 現在エンカウント中のプレイヤーと敵の情報。null=エンカウントなし */
    activeEncounter: { userId: string; type: EncounterType } | null;
    map: Map<string, Room>;
}

// ── データストア ──────────────────────────────────────────────
/** チャンネルID → GameState のマップ（メモリ上で管理） */
const activeGames = new Map<string, GameState>();

// ── 静的データ ────────────────────────────────────────────────
/** 敵ごとのデータ。correct が正解アクション */
const ENEMIES: Record<EncounterType, { name: string; correct: string; desc: string }> = {
    bracken:    { name: 'ブラッケン',     correct: 'glance', desc: '暗闇に光る二つの白い目が見える…！' },
    coilhead:   { name: 'コイルヘッド',   correct: 'stare',  desc: 'バネの音がして、血まみれのマネキンが現れた！' },
    eyelessdog: { name: 'アイレスドッグ', correct: 'sneak',  desc: '巨大な化け物が、音に反応して徘徊している…！' },
};

const SCRAP_NAMES = [
    "V型エンジン", "誰かの左靴", "ラジカセ", "トマティー40Station",
    "錆びた鉄パイプ", "壊れたパソコン", "謎の巨大な歯車", "古びた金庫", "業務用の車軸",
];
const DAMAGE_CAUSES = [
    "地雷の爆発💥", "タレットの銃撃🔫", "崩れた足場からの転落💀",
    "未知の罠🪤", "有毒ガス🌫️", "鋭い爪による切り裂き🩸",
];
const ROOM_NAMES = [
    "薄暗い廊下", "ボイラー室", "浸水した階段", "サーバールーム",
    "謎の肉片がある部屋", "崩壊した通路", "血まみれの保管庫", "カビ臭いオフィス",
    "換気扇の回る部屋", "瓦礫の山", "実験用ポッド跡", "配電室",
];

// ============================================================
// AI生成 / ユーティリティ
// ============================================================

/**
 * Groq APIでホラー演出テキストを1〜2文生成する。
 * 失敗時はフォールバック文字列を返す。
 */
async function generateDescription(eventType: string, context: string = ""): Promise<string> {
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: 'あなたは宇宙のブラック企業の冷酷なシステムAIです。インダストリアル・ホラーの世界観で状況を報告してください。\n【厳守事項】・カビ、錆、軋む金属音、暗闇、異常な温度、謎の粘液など多彩な表現を用いること。・箇条書きや記号は使用禁止。1〜2文の日本語のみ出力すること。',
                },
                { role: 'user', content: `発生イベント: ${eventType}\n詳細: ${context}` },
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.8,
            max_tokens: 100,
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "通信エラー。暗闇しか見えない。";
    } catch {
        return "システムエラー。カメラのノイズが酷くて見えません。";
    }
}

/**
 * 施設マップをBFS的に生成する。
 * 行き止まりになった場合は未接続部屋から再試行し、ルームが足りなくなるのを防ぐ。
 */
function generateMap(roomCount: number = ROOM_COUNT): Map<string, Room> {
    const map = new Map<string, Room>();
    let roomIdCounter = 1;

    const entrance: Room = { id: 'entrance', name: '施設エントランス', connections: {}, scraps: 0, dangerBase: 0 };
    map.set(entrance.id, entrance);

    const queue: string[] = ['entrance'];

    while (queue.length > 0 && map.size < roomCount) {
        const currentId = queue.shift()!;
        const currentRoom = map.get(currentId)!;

        const dirs: Direction[] = ['forward', 'left', 'right'];
        for (const dir of dirs) {
            // 既に接続済み、または60%の確率でスキップ（枝分かれ具合の調整）
            if (currentRoom.connections[dir] || Math.random() > 0.6) continue;
            if (map.size >= roomCount) break;

            const newId = `room_${roomIdCounter++}`;
            const newRoom: Room = {
                id: newId,
                name: ROOM_NAMES[Math.floor(Math.random() * ROOM_NAMES.length)],
                connections: { back: currentId }, // 必ず来た道（back）へ戻れるようにする
                scraps: Math.random() > 0.4 ? Math.floor(Math.random() * 100) + 20 : 0,
                dangerBase: Math.floor(Math.random() * 30),
            };

            map.set(newId, newRoom);
            currentRoom.connections[dir] = newId;
            queue.push(newId);
        }

        // queueが空になったがまだ部屋が足りない場合: 空き方向のある部屋から再スタート
        if (queue.length === 0 && map.size < roomCount) {
            const availableRooms = Array.from(map.values())
                .filter(r => !r.connections.forward || !r.connections.left || !r.connections.right);
            if (availableRooms.length > 0) {
                queue.push(availableRooms[Math.floor(Math.random() * availableRooms.length)].id);
            } else {
                break; // 全部屋の全方向が埋まった場合は生成終了
            }
        }
    }
    return map;
}

/**
 * モニター用レーダーマップをASCIIツリーで生成する。
 * ⚠️ 敵の生体反応は表示のたびにランダム判定されるため、呼び出しごとに変化する（意図的な演出）。
 */
function buildRadarMap(
    game: GameState,
    currentId: string = 'entrance',
    depth: number = 0,
    visited: Set<string> = new Set()
): string {
    if (visited.has(currentId)) return '';
    visited.add(currentId);

    const room = game.map.get(currentId);
    if (!room) return '';

    const playersHere = Array.from(game.players.values())
        .filter(p => p.isAlive && p.zone === currentId)
        .map(p => `👤${p.name}`)
        .join(' ');
    const corpsesHere = game.corpses.filter(c => c.zone === currentId).length > 0 ? '💀死体' : '';
    const enemyReaction = Math.random() * 100 < room.dangerBase + game.facilityDanger ? '🔴生体反応' : '';

    let text = `${'  '.repeat(depth)}┣ [${room.name}] ${playersHere} ${corpsesHere} ${enemyReaction}\n`;

    if (room.connections.forward) text += buildRadarMap(game, room.connections.forward, depth + 1, visited);
    if (room.connections.left)    text += buildRadarMap(game, room.connections.left,    depth + 1, visited);
    if (room.connections.right)   text += buildRadarMap(game, room.connections.right,   depth + 1, visited);

    return text;
}

/** 指定ユーザーが参加中の Lethal ゲームを検索する */
export function findLethalGameByUserId(userId: string): { channelId: string; game: GameState } | null {
    for (const [channelId, game] of activeGames.entries()) {
        if (game.players.has(userId)) return { channelId, game };
    }
    return null;
}

/** インタラクションが発生したチャンネルのゲーム、またはユーザーが参加中のゲームを返す */
export function getGameByInteraction(interaction: any): { channelId: string; game: GameState } | null {
    const game = activeGames.get(interaction.channelId);
    if (game) return { channelId: interaction.channelId, game };
    return findLethalGameByUserId(interaction.user.id);
}

/** 時刻を `HH:00` 形式にフォーマット */
function formatTime(t: number): string {
    return `${t.toString().padStart(2, '0')}:00`;
}

/** Embed の author に表示するステータスヘッダーを生成 */
function getStatusHeader(game: GameState): string {
    if (game.location === 'orbit') {
        return `[ 🛰️ 軌道上 | DAY ${game.day} | 💰 資金: ${game.funds} / ${game.quota}円 ]`;
    }
    const timeIcon = game.time >= DANGER_TIME ? '🔴' : game.time >= LATE_BONUS_TIME ? '🟡' : '🟢';
    return `[ 🪐 衛星内 | ${timeIcon} ${formatTime(game.time)} | 💰 資金: ${game.funds} / ${game.quota}円 ]`;
}

/** プレイヤーのHP・所持スクラップ・現在地を1行で返す */
function getPlayerStatusLine(player: PlayerState, game: GameState): string {
    const roomName = game.map.get(player.zone)?.name || '船内';
    return `\n\n\`[ ❤️ HP: ${player.hp}/100 | 🎒 所持: ${player.carriedScrap}円 ${player.hasTwoHanded ? '| ⚠️両手塞がり' : ''} | 📍 ${roomName} ]\``;
}

// ============================================================
// UI構築
// ============================================================

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_join').setLabel('参加/退出').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lethal_role_scavenger').setLabel('現場班').setStyle(ButtonStyle.Danger).setEmoji('⛏️'),
        new ButtonBuilder().setCustomId('lethal_role_monitor').setLabel('モニター班').setStyle(ButtonStyle.Primary).setEmoji('💻'),
        new ButtonBuilder().setCustomId('lethal_start').setLabel('出発').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    );
}

/**
 * 軌道上メニュー。ホストのみ「降下する」ボタンが表示される。
 */
function getOrbitRow(game: GameState, userId: string) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (userId === game.hostId) {
        row.addComponents(
            new ButtonBuilder().setCustomId('lethal_land').setLabel('降下する').setStyle(ButtonStyle.Danger).setEmoji('🪐'),
        );
    }
    row.addComponents(
        new ButtonBuilder().setCustomId('lethal_store').setLabel('ストア').setStyle(ButtonStyle.Primary).setEmoji('🛒'),
    );
    return row;
}

/**
 * プレイヤーの状態に応じたボタン行を返す。
 * - 死亡: []（ボタンなし）
 * - 軌道上: 軌道メニュー
 * - 船内モニター: モニター専用メニュー
 * - 施設内: 移動ボタン＋アクションボタン
 */
function getPlayerUI(game: GameState, player: PlayerState): ActionRowBuilder<ButtonBuilder>[] {
    if (!player.isAlive) return [];
    if (game.location === 'orbit') return [getOrbitRow(game, player.id)];

    // モニター班が船内にいる場合
    if (player.role === 'monitor' && player.zone === 'ship') {
        return [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('lethal_monitor').setLabel('レーダー監視').setStyle(ButtonStyle.Primary).setEmoji('💻'),
            new ButtonBuilder().setCustomId('lethal_leave_ship').setLabel('施設へ向かう').setStyle(ButtonStyle.Danger).setEmoji('🚪'),
        )];
    }

    // 施設内の移動ボタン（接続のある方向だけ表示）
    const moveRow = new ActionRowBuilder<ButtonBuilder>();
    const currentRoom = game.map.get(player.zone);
    if (currentRoom) {
        if (currentRoom.connections.left)    moveRow.addComponents(new ButtonBuilder().setCustomId('lethal_explore_left').setLabel('左へ').setStyle(ButtonStyle.Primary).setEmoji('⬅️'));
        if (currentRoom.connections.forward) moveRow.addComponents(new ButtonBuilder().setCustomId('lethal_explore_forward').setLabel('前へ').setStyle(ButtonStyle.Primary).setEmoji('⬆️'));
        if (currentRoom.connections.right)   moveRow.addComponents(new ButtonBuilder().setCustomId('lethal_explore_right').setLabel('右へ').setStyle(ButtonStyle.Primary).setEmoji('➡️'));
        if (currentRoom.connections.back)    moveRow.addComponents(new ButtonBuilder().setCustomId('lethal_explore_back').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('🚪'));
    }

    // アクションボタン（死体・重量物・帰還）
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    const localCorpses = game.corpses.filter(c => c.zone === player.zone);
    if (localCorpses.length > 0) {
        actionRow.addComponents(
            new ButtonBuilder().setCustomId('lethal_retrieve').setLabel('死体回収(1h)').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
        );
    }
    if (player.hasTwoHanded) {
        actionRow.addComponents(
            new ButtonBuilder().setCustomId('lethal_drop_heavy').setLabel('重量物放棄').setStyle(ButtonStyle.Danger).setEmoji('⚠️'),
        );
    }
    actionRow.addComponents(
        new ButtonBuilder().setCustomId('lethal_return').setLabel('船を発進させる').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    );

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (moveRow.components.length > 0) rows.push(moveRow);
    if (actionRow.components.length > 0) rows.push(actionRow);
    return rows;
}

/** エンカウント時のQTE選択肢ボタン */
function getEncounterRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('lethal_qte_glance').setLabel('一瞬だけ見る').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_stare').setLabel('ガン見する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_sneak').setLabel('しゃがんで歩く').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_qte_run').setLabel('走って逃げる').setStyle(ButtonStyle.Danger),
    );
}

// ── インタラクション共通処理 ──────────────────────────────────

/**
 * 未deferのインタラクションをdeferする。
 * 既にdeferまたはreply済みの場合は何もしない。
 */
async function prepareNewMessage(interaction: any): Promise<void> {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
}

// ============================================================
// ハンドラ
// ============================================================

export async function handleLethalStart(interaction: ChatInputCommandInteraction) {
    if (activeGames.has(interaction.channelId)) {
        return interaction.reply({ content: '⚠️ 既に進行中のゲームがあります。', ephemeral: true });
    }

    const newGame: GameState = {
        hostId: interaction.user.id, state: 'lobby', location: 'orbit', isProcessing: false,
        day: 1, time: START_TIME, quota: INITIAL_QUOTA, funds: 0, facilityDanger: 10,
        corpses: [], players: new Map(), activeEncounter: null, map: new Map(),
    };
    activeGames.set(interaction.channelId, newGame);

    newGame.players.set(interaction.user.id, {
        id: interaction.user.id, name: interaction.user.username,
        role: 'none', isAlive: true, hp: 100, carriedScrap: 0, hasTwoHanded: false,
        items: { flashlight: false, shovel: false, walkie_talkie: false }, zone: 'orbit',
    });

    await interaction.reply({ embeds: [buildLobbyEmbed(newGame)], components: [getLobbyRow()] });
}

/** ロビー表示用Embedを生成 */
function buildLobbyEmbed(game: GameState): EmbedBuilder {
    const pList = Array.from(game.players.values())
        .map(p => `・${p.name} [${p.role === 'scavenger' ? '⛏️現場' : p.role === 'monitor' ? '💻モニター' : '未定'}]`)
        .join('\n');
    return new EmbedBuilder()
        .setAuthor({ name: COMPANY_NAME })
        .setTitle('🪐 参加募集ロビー')
        .setDescription(`ホスト: <@${game.hostId}>\n\n**【参加者】**\n${pList || 'なし'}\n\n各自「参加」を押し、役割を選んでください。`)
        .setColor(0x3498db);
}

export async function handleLobbyAction(interaction: any, action: string) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData || gameData.game.state !== 'lobby') {
        return interaction.reply({ content: '⚠️ ロビーが見つかりません。Botが再起動した可能性があります。', ephemeral: true });
    }

    const { game } = gameData;
    const userId = interaction.user.id;
    let player = game.players.get(userId);

    if (action === 'join') {
        // 既に参加中なら退出、未参加なら参加
        if (player) {
            game.players.delete(userId);
        } else {
            game.players.set(userId, {
                id: userId, name: interaction.user.username,
                role: 'none', isAlive: true, hp: 100, carriedScrap: 0, hasTwoHanded: false,
                items: { flashlight: false, shovel: false, walkie_talkie: false }, zone: 'orbit',
            });
        }
    } else if (action === 'role_scavenger' || action === 'role_monitor') {
        if (!player) return interaction.reply({ content: '❌ まず「参加」を押してください。', ephemeral: true });
        player.role = action === 'role_scavenger' ? 'scavenger' : 'monitor';
    } else if (action === 'start') {
        if (userId !== game.hostId) {
            return interaction.reply({ content: '❌ 出発させられるのはホストのみです。', ephemeral: true });
        }
        // 参加者が0人、または役割未定の人がいる場合は出発不可
        const hasUnassigned = Array.from(game.players.values()).some(p => p.role === 'none');
        if (game.players.size === 0 || hasUnassigned) {
            return interaction.reply({ content: '❌ 役割未定の人がいます。全員が役割を選んでから出発してください。', ephemeral: true });
        }

        game.state = 'playing';
        game.location = 'orbit';

        // 全プレイヤーにDMでゲーム開始通知を送信
        for (const [pId, p] of game.players.entries()) {
            p.zone = 'orbit';
            const user = await interaction.client.users.fetch(pId).catch(() => {});
            if (user) {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('🛰️ 軌道上に到着')
                    .setDescription('**THE COMPANYへようこそ。**\nこれより回収業務を開始します。\n（※以降、すべての操作は個別のDMで行います）')
                    .setColor(0x000000);
                await user.send({ embeds: [dmEmbed], components: [getOrbitRow(game, pId)] }).catch(() => {});
            }
        }
        return await interaction.update({ content: '🚀 出発しました。全員DMを確認してください。', embeds: [], components: [] });
    }

    // 出発以外は全アクション後にロビー画面を更新
    await interaction.update({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

export async function handleLand(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;

    if (game.location !== 'orbit' || interaction.user.id !== game.hostId) {
        return interaction.reply({ content: '❌ ホストのみ、または軌道上でのみ可能です。', ephemeral: true });
    }
    await prepareNewMessage(interaction);

    game.location = 'moon';
    game.facilityDanger = Math.floor(Math.random() * 30) + 10; // 10〜40のランダム危険度で開始
    game.map = generateMap(ROOM_COUNT);

    // 役割に応じて初期Zoneを設定し、全員にDMを送信
    for (const [pId, p] of game.players.entries()) {
        if (!p.isAlive) continue;
        p.zone = p.role === 'monitor' ? 'ship' : 'entrance';
        const user = await interaction.client.users.fetch(pId).catch(() => {});
        if (user) {
            const embed = new EmbedBuilder()
                .setAuthor({ name: getStatusHeader(game) })
                .setTitle('🪐 衛星へ降下完了')
                .setDescription(p.role === 'monitor'
                    ? '船内モニター室に配置されました。'
                    : '施設の入口に到着しました。'
                )
                .setColor(0x34495e);
            await user.send({ embeds: [embed], components: getPlayerUI(game, p) }).catch(() => {});
        }
    }
    await interaction.editReply({ content: '降下しました。', embeds: [], components: [] });
}

export async function handleExplore(interaction: any, direction: Direction) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;

    const player = game.players.get(interaction.user.id);
    if (!player || !player.isAlive) return;
    if (player.zone === 'ship') return interaction.reply({ content: '❌ 船の中からは探索できません。', ephemeral: true });
    if (game.activeEncounter)   return interaction.reply({ content: '⚠️ 交戦中です！', ephemeral: true });
    if (player.isMoving)        return interaction.reply({ content: '⏳ 移動中です…', ephemeral: true });

    const currentRoom = game.map.get(player.zone);
    if (!currentRoom || !currentRoom.connections[direction]) {
        return interaction.reply({ content: '❌ その方向には進めません。', ephemeral: true });
    }

    player.isMoving = true;
    try {
        // 深夜になった場合は強制的に自動帰還（この時点ではまだdeferしていない）
        if (game.time >= AUTO_RETURN_TIME) return handleReturn(interaction, true);

        await prepareNewMessage(interaction);

        const dirLabel = direction === 'left' ? "左の扉" : direction === 'right' ? "右の扉" : direction === 'forward' ? "正面の通路" : "来た道";
        await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('👣 移動中...').setDescription(`**${dirLabel}** を進んでいます…。`).setColor(0x2c3e50)],
            components: [],
        });
        // 5秒の移動演出（プレイヤーが連打できないようにするためのウェイト）
        await new Promise(r => setTimeout(r, 5000));

        // 時間経過と危険度の上昇
        game.time += 1;
        game.facilityDanger = Math.min(100, game.facilityDanger + Math.floor(Math.random() * 15) + 5);

        // 部屋の移動
        player.zone = currentRoom.connections[direction]!;
        const newRoom = game.map.get(player.zone)!;

        /**
         * 危険度ロール計算：
         *   dangerRoll = facilityDanger + 部屋固有危険度 + 重量物ペナルティ - 懐中電灯ボーナス
         *
         * 抽選結果：
         *   roll ≤ dangerRoll * 0.4          → 罠ダメージ（即死または負傷）
         *   roll ≤ dangerRoll                → 敵エンカウント（QTE発生）
         *   roll ≤ dangerRoll + successBase  → スクラップ発見（部屋にスクラップがある場合）
         *   それ以外                          → 異常なし
         */
        const dangerRoll = game.facilityDanger
            + newRoom.dangerBase
            + (player.hasTwoHanded ? 15 : 0)   // 重量物を持っていると被弾しやすい
            - (player.items.flashlight ? 20 : 0); // 懐中電灯があると罠回避率アップ
        const successBase = player.items.shovel ? 70 : 45; // シャベルがあるとスクラップ取れやすい
        const roll = Math.floor(Math.random() * 100) + 1;

        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });
        let isEncounter = false;

        if (roll <= dangerRoll * 0.4) {
            // ── 罠ダメージ ──
            const damage = Math.floor(Math.random() * 40) + 20;
            player.hp -= damage;
            const cause = DAMAGE_CAUSES[Math.floor(Math.random() * DAMAGE_CAUSES.length)];
            if (player.hp <= 0) {
                player.isAlive = false;
                game.corpses.push({ userId: player.id, name: player.name, value: CORPSE_VALUE, zone: player.zone });
                embed.setTitle('🩸 死亡').setDescription(`あなたは罠にかかり命を落としました。\n死因: ${cause}`).setColor(0xe74c3c);
                player.carriedScrap = 0;
                player.hasTwoHanded = false;
            } else {
                embed.setTitle('⚠️ 負傷')
                    .setDescription(`**罠にかかった！**\n${cause} (-${damage} HP)\n\n*${await generateDescription('Trap', cause)}*`)
                    .setColor(0xe67e22);
            }
        } else if (roll <= dangerRoll) {
            // ── 敵エンカウント → QTE ──
            isEncounter = true;
            const enemyType = (['bracken', 'coilhead', 'eyelessdog'] as EncounterType[])[Math.floor(Math.random() * 3)];
            game.activeEncounter = { userId: player.id, type: enemyType };
            embed.setTitle(`🚨 未知の生物`).setDescription(`**化け物に遭遇！**\n${ENEMIES[enemyType].desc}`).setColor(0x8B0000);
        } else if (roll <= dangerRoll + successBase && newRoom.scraps > 0) {
            // ── スクラップ回収 ──
            const isHeavy = Math.random() < 0.2; // 20%の確率で両手が塞がる大型スクラップ
            // 深夜帯(LATE_BONUS_TIME以降)は高リスク・高リターンでスクラップ価値が1.5倍
            const val = Math.floor(newRoom.scraps * (game.time >= LATE_BONUS_TIME ? 1.5 : 1.0));
            newRoom.scraps = 0; // 回収済みフラグ
            const scrapName = SCRAP_NAMES[Math.floor(Math.random() * SCRAP_NAMES.length)];
            player.carriedScrap += val;
            if (isHeavy) player.hasTwoHanded = true;
            embed.setTitle('🟢 資産回収').setDescription(`**【 ${scrapName} 】を発見！** (+${val}円)`).setColor(0x2ecc71);
        } else {
            // ── 異常なし ──
            embed.setTitle('🟡 異常なし').setDescription(`【${newRoom.name}】に到着した。特に何もないようだ。`).setColor(0x7f8c8d);
        }

        // 周囲の状況（他のプレイヤー・死体・不審音）をembedに追記
        if (player.isAlive) {
            let sounds = "";
            const nearby = Array.from(game.players.values())
                .filter(p => p.isAlive && p.zone === player.zone && p.id !== player.id);
            if (nearby.length > 0) sounds += "\n\n👣 *近くで誰かの足音がする。*";
            const localCorpses = game.corpses.filter(c => c.zone === player.zone);
            if (localCorpses.length > 0) {
                sounds += `\n\n💀 *足元に ${localCorpses.map(c => c.name).join('と')} の遺体がある。*`;
            }
            if (!isEncounter && Math.random() * 100 < game.facilityDanger * 0.7) {
                sounds += `\n\n🔊 *奇妙な音が響いている…*`;
            }
            embed.setDescription((embed.data.description || "") + sounds + getPlayerStatusLine(player, game));
        }

        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription((embed.data.description || "") + '\n\n**【全滅】帰還シークエンス開始。**');
            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            await interaction.editReply({
                embeds: [embed],
                components: isEncounter ? [getEncounterRow()] : (player.isAlive ? getPlayerUI(game, player) : []),
            });
        }
    } finally {
        player.isMoving = false;
    }
}

export async function handleQTE(interaction: any, action: string) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;
    const player = game.players.get(interaction.user.id);

    // 自分のエンカウントでない場合（他のプレイヤーのQTEに横からボタンを押した場合）は無視
    if (!player || !game.activeEncounter || game.activeEncounter.userId !== player.id) return;

    game.isProcessing = true;
    try {
        await prepareNewMessage(interaction);
        const enemy = ENEMIES[game.activeEncounter.type];
        const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });

        if (action === enemy.correct) {
            // 正解アクション → 回避成功
            embed.setTitle('🟢 回避成功').setDescription(`逃げ切った！`).setColor(0x2ecc71);
        } else {
            // 不正解アクション → 即死
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: CORPSE_VALUE, zone: player.zone });
            embed.setTitle('🩸 惨殺').setDescription(`殺された。`).setColor(0xe74c3c);
            player.carriedScrap = 0;
            player.hasTwoHanded = false;
        }

        game.activeEncounter = null;

        const aliveCount = Array.from(game.players.values()).filter(p => p.isAlive).length;
        if (aliveCount === 0) {
            activeGames.delete(channelId);
            embed.setDescription((embed.data.description || "") + '\n\n**【全滅】**');
            await interaction.editReply({ embeds: [embed], components: [] });
            // ゲーム終了処理（現在は将来実装のため空）
        } else {
            await interaction.editReply({
                embeds: [embed],
                components: player.isAlive ? getPlayerUI(game, player) : [],
            });
        }
    } finally {
        game.isProcessing = false;
    }
}

export async function handleMonitor(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { game } = gameData;
    const player = game.players.get(interaction.user.id);
    if (!player || player.zone !== 'ship') {
        return interaction.reply({ content: '❌ 船内でのみ可能です。', ephemeral: true });
    }

    await prepareNewMessage(interaction);

    let mapText = buildRadarMap(game);
    if (mapText.length > 3000) mapText = mapText.substring(0, 3000) + '... (通信帯域不足)';

    const dText = game.facilityDanger > 80 ? "極めて危険。" : "警戒が必要。";
    const embed = new EmbedBuilder()
        .setAuthor({ name: getStatusHeader(game) })
        .setTitle('💻 レーダー・モニターシステム')
        .setDescription(`**【施設内部スキャンデータ】**\n\`\`\`\n${mapText}\n\`\`\`\n*${await generateDescription('Scan', dText)}*`)
        .setColor(0x00FF00);

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
    const embed = new EmbedBuilder()
        .setAuthor({ name: getStatusHeader(game) })
        .setTitle('🚪 船外へ')
        .setDescription('施設のエントランスに向かった。')
        .setColor(0xe67e22);
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
    game.time += 1; // 死体回収には1時間かかる

    // 死体回収中に罠にかかる確率（facilityDangerの50%）
    if (Math.random() * 100 <= game.facilityDanger * 0.5) {
        player.hp -= 50;
        if (player.hp <= 0) {
            player.isAlive = false;
            game.corpses.push({ userId: player.id, name: player.name, value: CORPSE_VALUE, zone: player.zone });
            await interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('🩸 二次災害').setDescription('死体回収中に死亡。').setColor(0x8B0000)],
                components: [],
            });
        } else {
            await interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('⚠️ 負傷').setDescription('回収中に罠にかかった！').setColor(0xe67e22)],
                components: getPlayerUI(game, player),
            });
        }
    } else {
        const corpse = game.corpses.splice(idx, 1)[0];
        // 遺体の価値は共有資金に加算（個人所持ではなく直接funds化）
        game.funds += corpse.value;
        player.hasTwoHanded = true; // 遺体を担ぐと両手が塞がる
        await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('📦 回収完了').setDescription(`${corpse.name}の遺体を回収した。`).setColor(0x8A2BE2)],
            components: getPlayerUI(game, player),
        });
    }
}

export async function handleDropHeavy(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const player = gameData.game.players.get(interaction.user.id);
    if (!player || !player.hasTwoHanded) return;

    await prepareNewMessage(interaction);

    /**
     * 重量物を捨てると同時に、積んでいたスクラップの半分も失う（ゲームルール）。
     * 重量物とスクラップは一緒に運ばれている想定のため。
     */
    player.hasTwoHanded = false;
    player.carriedScrap = Math.floor(player.carriedScrap / 2);

    await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('⚠️ 放棄').setDescription('荷物を捨てて身軽になった。（所持スクラップが半減した）').setColor(0xf39c12)],
        components: getPlayerUI(gameData.game, player),
    });
}

/**
 * 船を発進させてその日の成果を確定する。
 * @param isAuto true の場合は handleExplore から時間超過で自動発動。
 */
export async function handleReturn(interaction: any, isAuto = false) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;
    const { channelId, game } = gameData;

    // ✅ 修正: isAuto=true (handleExploreからの自動発進) の場合も必ずdeferが必要。
    //          元のコードでは isAuto=true 時にdeferをスキップしていたため、
    //          editReply が未deferのinteractionに対して失敗していた。
    await prepareNewMessage(interaction);

    let total = 0;
    const leftBehind: string[] = [];

    // 船内(ship)または軌道上(orbit)にいる生存者のみ生還扱い。それ以外は置き去り死亡。
    game.players.forEach(p => {
        if (p.isAlive) {
            if (p.zone === 'ship' || p.zone === 'orbit') {
                // 生還: スクラップを換金
                total += p.carriedScrap;
                p.carriedScrap = 0;
                p.hasTwoHanded = false;
                p.zone = 'orbit';
            } else {
                // 置き去り: 死亡扱い・アイテム全ロス
                p.isAlive = false;
                p.carriedScrap = 0;
                p.hasTwoHanded = false;
                leftBehind.push(p.name);
            }
        }
    });

    game.funds += total;
    game.day += 1;
    game.location = 'orbit';
    game.activeEncounter = null; // 置き去りの場合もエンカウント状態を強制リセット

    const embed = new EmbedBuilder().setAuthor({ name: getStatusHeader(game) });

    // 置き去り者がいる場合のホラーテキスト
    const descText = leftBehind.length > 0
        ? `🚀 **船は緊急発進した！**\n\n💀 **【置き去り】**\n${leftBehind.join('、')} は衛星に取り残され、絶望の中で消息を絶った…。\n`
        : `🚀 **船は無事に発進した。**\n`;

    if (game.day > MAX_DAYS) {
        // ── ノルマ判定日 ──
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setColor(0x00FF00);
            embed.setDescription(descText + `\n素晴らしい仕事だ。新たなノルマを設定する。`);
            game.day = 1;
            game.quota += QUOTA_INCREMENT;
            game.funds = 0;
            // 全員クローンとして完全復活（HPとアイテムもリセット）
            game.players.forEach(p => {
                p.isAlive = true;
                p.hp = 100;
                p.items = { flashlight: false, shovel: false, walkie_talkie: false };
            });
        } else {
            embed.setTitle('🚀 放出')
                .setDescription(descText + `\nノルマ未達。あなたたちは宇宙空間に放出されました。`)
                .setColor(0x000000);
            activeGames.delete(channelId);
        }
    } else {
        // ── 通常帰還日 ──
        embed.setTitle('🛰️ 帰還').setDescription(descText + `\n本日分納品完了。`).setColor(0x3498db);
        game.corpses = [];
        game.time = START_TIME; // 翌日の朝8時にリセット
        // ✅ 明確化: 翌日は死亡者もクローンとして復活し、全員HPを100に回復する
        game.players.forEach(p => {
            p.isAlive = true; // 死亡者も含めて全員復活
            p.hp = 100;       // 生存者も含めて全員HP満タンに回復
        });
    }

    // 全員にリザルトをDM送信
    for (const [pId] of game.players.entries()) {
        const u = await interaction.client.users.fetch(pId).catch(() => {});
        if (u) {
            await u.send({
                embeds: [embed],
                components: activeGames.has(channelId) ? [getOrbitRow(game, pId)] : [],
            }).catch(() => {});
        }
    }

    // ボタンを押したチャンネルの表示を更新
    if (isAuto) {
        await interaction.editReply({ content: '⏳ 深夜0時を回ったため、自動パイロットで船が緊急発進しました…', embeds: [], components: [] });
    } else {
        await interaction.editReply({ content: '🚀 帰還しました。', embeds: [], components: [] });
    }
}

export async function handleStore(interaction: any) {
    const gameData = getGameByInteraction(interaction);
    if (!gameData || gameData.game.location !== 'orbit') return;

    const storeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        // ✅ 修正: IDを 'lethal_buy_walkie' → 'lethal_buy_walkie_talkie' に変更。
        //          元のコードでは customId.replace('lethal_buy_', '') で 'walkie' になり、
        //          PlayerState.items の 'walkie_talkie' キーと一致せずアイテムが付与されなかった。
        new ButtonBuilder().setCustomId('lethal_buy_flashlight').setLabel(`懐中電灯(${ITEM_PRICE.flashlight}円)`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_shovel').setLabel(`シャベル(${ITEM_PRICE.shovel}円)`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('lethal_buy_walkie_talkie').setLabel(`無線機(${ITEM_PRICE.walkie_talkie}円)`).setStyle(ButtonStyle.Success),
    );
    await interaction.reply({ content: `共有資金: ${gameData.game.funds}円`, components: [storeRow], ephemeral: true });
}

export async function handleBuy(interaction: any, item: 'flashlight' | 'shovel' | 'walkie_talkie') {
    const gameData = getGameByInteraction(interaction);
    if (!gameData) return;

    const player = gameData.game.players.get(interaction.user.id);
    if (!player) {
        return interaction.reply({ content: '❌ プレイヤーが見つかりません。', ephemeral: true });
    }

    const price = ITEM_PRICE[item];
    if (gameData.game.funds < price) {
        return interaction.reply({ content: `❌ 資金不足（必要: ${price}円 / 現在: ${gameData.game.funds}円）`, ephemeral: true });
    }

    player.items[item] = true;
    gameData.game.funds -= price;
    await interaction.reply({ content: `✅ **${item === 'flashlight' ? '懐中電灯' : item === 'shovel' ? 'シャベル' : '無線機'}** を購入しました。` });
}
