// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Guild } from 'discord.js';

// ── 型定義と定数 ──────────────────────────────────────────────
type RoleType = 'navigator' | 'scavenger' | 'none';
type VCType = 'ship' | 'room-A' | 'room-B' | 'room-C' | 'ghost';

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    isAlive: boolean;
    currentVC: VCType;
    scraps: number;
    isRadioActive: boolean; // 無線通信中（一時的にshipにいる）か
}

interface GameState {
    guildId: string;
    hostId: string;
    state: 'lobby' | 'playing';
    categoryId?: string;
    vcIds: Record<string, string>; // 生成したVCのIDリスト
    players: Map<string, PlayerState>;
}

// チャンネルIDをキーにしてゲームを管理
const activeGames = new Map<string, GameState>();

// ── 1. ロビー作成（/frequency コマンドの入り口） ────────────────
export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    if (activeGames.has(interaction.channelId)) {
        return interaction.reply({ content: '⚠️ 既に募集中のゲームがあります。', ephemeral: true });
    }

    const game: GameState = {
        guildId: interaction.guildId!,
        hostId: interaction.user.id,
        state: 'lobby',
        vcIds: {},
        players: new Map()
    };
    activeGames.set(interaction.channelId, game);

    await interaction.reply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
}

function buildLobbyEmbed(game: GameState) {
    const pList = Array.from(game.players.values())
        .map(p => `・${p.name} [${p.role === 'navigator' ? '💻ナビゲーター' : '⛏️現場探索者'}]`)
        .join('\n');
    return new EmbedBuilder()
        .setTitle('📻 FREQUENCY - ロビー')
        .setDescription(`**【参加者】**\n${pList || 'なし'}\n\n※ゲーム開始前に、必ずどこかのVCに入っておいてください（Botが移動させるため）。`)
        .setColor(0x2b2d31);
}

function getLobbyRow() {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_join_nav').setLabel('ナビゲーター(船内)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('freq_join_scav').setLabel('探索者(現場)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_launch').setLabel('🚀 着陸(ゲーム開始)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('freq_cancel').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
    );
}

// ── 2. ボタンインタラクションのルーティング ────────────────────────
export async function handleButton(interaction: any) {
    // サーバーからのアクションか、DMからのアクションかでGameを探す
    let game = activeGames.get(interaction.channelId);
    if (!game) {
        // DMからの操作の場合、自分が参加しているゲームを探す
        game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    }
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

    // ── ロビーでの操作 ──
    if (action.startsWith('join_')) {
        const role = action === 'join_nav' ? 'navigator' : 'scavenger';
        game.players.set(userId, {
            id: userId, name: interaction.user.username, role,
            isAlive: true, currentVC: role === 'navigator' ? 'ship' : 'room-A',
            scraps: 0, isRadioActive: false
        });
        return interaction.update({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
    }
    if (action === 'cancel') {
        if (userId !== game.hostId) return interaction.reply({ content: 'ホストのみキャンセル可能です。', ephemeral: true });
        activeGames.delete(interaction.channelId);
        return interaction.update({ content: '🛑 ゲームをキャンセルしました。', embeds: [], components: [] });
    }
    if (action === 'launch') {
        if (userId !== game.hostId) return interaction.reply({ content: 'ホストのみ開始可能です。', ephemeral: true });
        if (game.players.size === 0) return interaction.reply({ content: '参加者がいません。', ephemeral: true });
        
        await interaction.update({ content: '🚀 環境を構築中...しばらくお待ちください。', embeds: [], components: [] });
        await setupGameEnvironment(interaction.client, interaction.channelId, game);
        return;
    }

    // ── ゲーム中（DM）での操作 ──
    const player = game.players.get(userId);
    if (!player || !player.isAlive) return;

    if (action === 'end_game') { // ナビゲーターが終了させる
        if (player.role !== 'navigator') return;
        await interaction.update({ content: '🛑 船を離陸させ、ゲームを終了しました。', embeds: [], components: [] });
        await cleanupGame(interaction.client, interaction.channelId, game);
        return;
    }

    await executePlayerAction(interaction, action, game, player);
}

// ── 3. ゲーム環境構築（VCの一括作成とDM送信） ──────────────────
async function setupGameEnvironment(client: any, channelId: string, game: GameState) {
    const guild = await client.guilds.fetch(game.guildId);
    if (!guild) return;

    // カテゴリとVCの作成
    const category = await guild.channels.create({ name: '🔴 FREQUENCY ZONE', type: ChannelType.GuildCategory });
    game.categoryId = category.id;

    const vcNames = ['ship', 'room-A', 'room-B', 'room-C', 'ghost'];
    for (const name of vcNames) {
        const vc = await guild.channels.create({
            name: name === 'ghost' ? '👻 ghost' : `🚪 ${name}`,
            type: ChannelType.GuildVoice,
            parent: category.id,
        });
        game.vcIds[name] = vc.id;
    }

    game.state = 'playing';

    // プレイヤーをVCに移動させ、DMでコントロールパネルを送信
    const fragments = [
        '【極秘】「room-B」には敵が潜んでいる確率が高い。',
        '【極秘】「room-C」には高額なスクラップがある。',
        '【極秘】敵に襲われた時、無理に逃げると死ぬ。'
    ];
    let f_idx = 0;

    for (const [pId, p] of game.players.entries()) {
        await movePlayerVC(client, game, p, game.vcIds[p.currentVC]);

        const user = await client.users.fetch(pId).catch(() => null);
        if (!user) continue;

        let info = '';
        if (p.role === 'scavenger') {
            info = fragments[f_idx % fragments.length];
            f_idx++;
        } else {
            info = 'あなたは船のナビゲーターです。皆の無事を祈りましょう。';
        }

        await user.send({
            embeds: [buildPlayerUIEmbed(p, info)],
            components: getPlayerControlRow(p)
        }).catch(() => console.error('DM送信失敗'));
    }
}

// ── 4. プレイヤーのアクション処理 ──────────────────────────────
async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState) {
    const guild = await interaction.client.guilds.fetch(game.guildId);
    let messageInfo = '';

    // 無線切り替え
    if (action === 'toggle_radio') {
        player.isRadioActive = !player.isRadioActive;
        const targetVC = player.isRadioActive ? game.vcIds['ship'] : game.vcIds[player.currentVC];
        await movePlayerVC(interaction.client, game, player, targetVC);
        messageInfo = player.isRadioActive ? '📻 【無線接続】船と繋がりました。元の部屋の音は聞こえません。' : '🔇 【無線切断】元の部屋の音声に戻りました。';
    }

    // 部屋移動
    if (action.startsWith('move_')) {
        const targetRoom = action.replace('move_', '') as VCType;
        player.currentVC = targetRoom;
        
        // 移動時にランダムで即死判定（20%で罠や敵に遭遇して死亡）
        if (targetRoom !== 'ship' && Math.random() < 0.20) {
            player.isAlive = false;
            player.currentVC = 'ghost';
            messageInfo = '🩸 **【死亡】未知の化け物に遭遇し、あなたは命を落としました。**';
            await movePlayerVC(interaction.client, game, player, game.vcIds['ghost']);
        } else {
            messageInfo = `🚪 ${targetRoom} に移動しました。`;
            if (!player.isRadioActive) {
                await movePlayerVC(interaction.client, game, player, game.vcIds[player.currentVC]);
            }
        }
    }

    // スクラップ回収
    if (action === 'grab') {
        if (Math.random() < 0.15) { // 15%で回収時に罠で死亡
            player.isAlive = false;
            player.currentVC = 'ghost';
            messageInfo = '🩸 **【死亡】スクラップの下に地雷が仕掛けられていました。**';
            await movePlayerVC(interaction.client, game, player, game.vcIds['ghost']);
        } else {
            player.scraps += 1;
            messageInfo = '📦 スクラップを1つ回収しました。';
        }
    }

    // DMのUIを更新（再描画）
    await interaction.update({
        embeds: [buildPlayerUIEmbed(player, messageInfo)],
        components: getPlayerControlRow(player)
    });
}

// ── UI構築関数（DM用） ─────────────────────────────────────────
function buildPlayerUIEmbed(player: PlayerState, message: string = '') {
    if (!player.isAlive) {
        return new EmbedBuilder().setTitle('💀 死亡').setDescription(message + '\n\nあなたは死にました。Ghostチャンネルで観戦してください。').setColor(0x000000);
    }
    return new EmbedBuilder()
        .setTitle(`📍 現在地: ${player.currentVC}`)
        .setDescription(`**役割:** ${player.role === 'navigator' ? '💻ナビ' : '⛏️現場'}\n**所持スクラップ:** ${player.scraps}個\n\n💬 ${message}`)
        .setColor(player.isRadioActive ? 0x00FF00 : 0x2b2d31);
}

function getPlayerControlRow(player: PlayerState): ActionRowBuilder<ButtonBuilder>[] {
    if (!player.isAlive) return []; // 死体は操作不可

    if (player.role === 'navigator') {
        return [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('freq_end_game').setLabel('強制離陸(ゲーム終了)').setStyle(ButtonStyle.Danger)
        )];
    }

    const moveRow = new ActionRowBuilder<ButtonBuilder>();
    if (player.currentVC === 'room-A') {
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_room-B').setLabel('奥へ(room-B)').setStyle(ButtonStyle.Primary));
    } else if (player.currentVC === 'room-B') {
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_room-A').setLabel('戻る(room-A)').setStyle(ButtonStyle.Secondary));
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_room-C').setLabel('奥へ(room-C)').setStyle(ButtonStyle.Primary));
    } else if (player.currentVC === 'room-C') {
        moveRow.addComponents(new ButtonBuilder().setCustomId('freq_move_room-B').setLabel('戻る(room-B)').setStyle(ButtonStyle.Secondary));
    }

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('freq_grab').setLabel('📦 拾う(死のリスク)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('freq_toggle_radio').setLabel(player.isRadioActive ? '🔇 無線を切る' : '📻 無線を入れる').setStyle(ButtonStyle.Success)
    );

    return moveRow.components.length > 0 ? [moveRow, actionRow] : 
