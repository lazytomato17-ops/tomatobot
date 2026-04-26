// src/frequencyLogic.ts
import { ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, TextChannel } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { startGhostCamera } from './voiceTranscription';

type RoleType = 'navigator' | 'scavenger' | 'none';
type VCType = 'ship' | 'room-A' | 'room-B' | 'room-C' | 'ghost';

interface PlayerState {
    id: string;
    name: string;
    role: RoleType;
    isAlive: boolean;
    currentVC: VCType;
    scraps: number;
    isRadioActive: boolean;
}

interface GameState {
    guildId: string;
    hostId: string;
    state: 'lobby' | 'playing';
    categoryId?: string;
    ghostTextId?: string; // 霊界テキストチャンネルのID
    vcIds: Record<string, string>;
    players: Map<string, PlayerState>;
}

const activeGames = new Map<string, GameState>();

export async function handleFrequencyStart(interaction: ChatInputCommandInteraction) {
    // ⏱️ 3秒タイムアウトを回避するために、まず「考え中...」をDiscordに返す
    await interaction.deferReply();

    if (activeGames.has(interaction.channelId)) {
        await interaction.editReply({ content: '⚠️ 既に募集中のゲームがあります。（※バグで残っている場合はBotを再起動してください）' });
        return;
    }

    const game: GameState = {
        guildId: interaction.guildId!,
        hostId: interaction.user.id,
        state: 'lobby',
        vcIds: {},
        players: new Map()
    };
    activeGames.set(interaction.channelId, game);

    // 📝 準備ができたら、考え中のメッセージを本番のロビー画面に書き換える
    await interaction.editReply({ embeds: [buildLobbyEmbed(game)], components: [getLobbyRow()] });
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

export async function handleButton(interaction: any) {
    let game = activeGames.get(interaction.channelId);
    if (!game) {
        game = Array.from(activeGames.values()).find(g => g.players.has(interaction.user.id));
    }
    if (!game) return interaction.reply({ content: '❌ ゲームが見つかりません。', ephemeral: true });

    const action = interaction.customId.replace('freq_', '');
    const userId = interaction.user.id;

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

        // 1. まず「考え中...」というローディング状態を作る（これで3秒のタイムアウトを回避）
        await interaction.deferUpdate();

        // 2. 元のロビーメッセージを「構築中」に書き換える
        await interaction.editReply({ content: '🚀 環境を構築中...しばらくお待ちください。Discordの仕様で数秒かかります。', embeds: [], components: [] });

        // 3. 重い環境構築処理を走らせる
        await setupGameEnvironment(interaction.client, interaction.channelId, game);
        return;
    }

    const player = game.players.get(userId);
    if (!player) return;

    // 霊界（死者）専用のカメラ操作
    if (!player.isAlive && action.startsWith('cam_')) {
        const targetRoom = action.replace('cam_', '');
        const targetVcId = game.vcIds[targetRoom];
        
        if (targetVcId) {
            const guild = await interaction.client.guilds.fetch(game.guildId);
            joinVoiceChannel({
                channelId: targetVcId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator as any,
                selfDeaf: false, // 録音のためにDeafを解除
                selfMute: false,  // Bot自身のマイクはオフ
            });
            
            const ghostText = await interaction.client.channels.fetch(game.ghostTextId!) as TextChannel;
            if (ghostText) {
                ghostText.send(`🎥 **霊界カメラが \`${targetRoom}\` に切り替わりました。** (操作: ${player.name})`);
            }
        }
        // DMのUIを再描画（操作メッセージだけ変える）
        return interaction.update({
            embeds: [buildPlayerUIEmbed(player, `📷 カメラを ${targetRoom} に移動しました。`)],
            components: getPlayerControlRow(player)
        });
    }

    if (action === 'end_game') { 
        // ナビゲーターか、ホストであればゲームを強制終了（削除）できる
        if (player.role !== 'navigator' && player.id !== game.hostId) {
            return interaction.reply({ content: '⚠️ 権限がありません（ナビゲーターかホストのみ可能です）。', ephemeral: true });
        }
        await interaction.update({ content: '🛑 ゲームを終了し、作成した部屋をすべて削除しました。お疲れ様でした！', embeds: [], components: [] });
        await cleanupGame(interaction.client, interaction.channelId, game);
        return;
    }

    if (!player.isAlive) return;

    await executePlayerAction(interaction, action, game, player);
}

async function setupGameEnvironment(client: any, channelId: string, game: GameState) {
    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (!guild) return;

    const category = await guild.channels.create({ name: '🔴 FREQUENCY ZONE', type: ChannelType.GuildCategory });
    game.categoryId = category.id;

    // ゴースト用のテキストチャンネル作成
    const ghostText = await guild.channels.create({
        name: '👻ghost-chat',
        type: ChannelType.GuildText,
        parent: category.id,
    });
    game.ghostTextId = ghostText.id;

    const vcNames = ['ship', 'room-A', 'room-B', 'room-C', 'ghost'];
    for (const name of vcNames) {
        const vc = await guild.channels.create({
            name: name === 'ghost' ? '👻 ghost-vc' : `🚪 ${name}`,
            type: ChannelType.GuildVoice,
            parent: category.id,
        });
        game.vcIds[name] = vc.id;
    }

    game.state = 'playing';

    // Bot自身がroom-AにVC接続し、カメラと文字起こしを開始
    const connection = joinVoiceChannel({
        channelId: game.vcIds['room-A'],
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as any,
        selfDeaf: false,
        selfMute: false,
    });
    startGhostCamera(connection, ghostText);

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

async function executePlayerAction(interaction: any, action: string, game: GameState, player: PlayerState) {
    let messageInfo = '';

    if (action === 'toggle_radio') {
        player.isRadioActive = !player.isRadioActive;
        const targetVC = player.isRadioActive ? game.vcIds['ship'] : game.vcIds[player.currentVC];
        await movePlayerVC(interaction.client, game, player, targetVC);
        messageInfo = player.isRadioActive ? '📻 【無線接続】船と繋がりました。元の部屋の音は聞こえません。' : '🔇 【無線切断】元の部屋の音声に戻りました。';
    }

    if (action.startsWith('move_')) {
        const targetRoom = action.replace('move_', '') as VCType;
        player.currentVC = targetRoom;
        
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

    if (action === 'grab') {
        if (Math.random() < 0.15) {
            player.isAlive = false;
            player.currentVC = 'ghost';
            messageInfo = '🩸 **【死亡】スクラップの下に地雷が仕掛けられていました。**';
            await movePlayerVC(interaction.client, game, player, game.vcIds['ghost']);
        } else {
            player.scraps += 1;
            messageInfo = '📦 スクラップを1つ回収しました。';
        }
    }

    await interaction.update({
        embeds: [buildPlayerUIEmbed(player, messageInfo)],
        components: getPlayerControlRow(player)
    });
}

function buildPlayerUIEmbed(player: PlayerState, message: string = '') {
    if (!player.isAlive) {
        return new EmbedBuilder()
            .setTitle('💀 霊界 (Ghost)')
            .setDescription(message + '\n\nあなたは死にました。以下のボタンで「霊界カメラ」を操作し、生存者の部屋の音声（文字起こし）を #ghost-chat で監視できます。')
            .setColor(0x000000);
    }
    return new EmbedBuilder()
        .setTitle(`📍 現在地: ${player.currentVC}`)
        .setDescription(`**役割:** ${player.role === 'navigator' ? '💻ナビ' : '⛏️現場'}\n**所持スクラップ:** ${player.scraps}個\n\n💬 ${message}`)
        .setColor(player.isRadioActive ? 0x00FF00 : 0x2b2d31);
}

function getPlayerControlRow(player: PlayerState): ActionRowBuilder<ButtonBuilder>[] {
    // 死者用のカメラ操作パネル
    if (!player.isAlive) {
        return [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('freq_cam_room-A').setLabel('📷 room-A').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('freq_cam_room-B').setLabel('📷 room-B').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('freq_cam_room-C').setLabel('📷 room-C').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('freq_end_game').setLabel('🧹 ゲーム終了＆部屋削除').setStyle(ButtonStyle.Danger)
            )
        ];
    }

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

    return moveRow.components.length > 0 ? [moveRow, actionRow] : [actionRow];
}

async function movePlayerVC(client: any, game: GameState, player: PlayerState, targetVcId: string) {
    try {
        const guild = await client.guilds.fetch(game.guildId);
        const member = await guild.members.fetch(player.id);
        if (member && member.voice.channelId) {
            await member.voice.setChannel(targetVcId);
        }
    } catch (e) {
        console.error('VC移動エラー: 事前にどこかのVCに入っていないと移動できません');
    }
}

async function cleanupGame(client: any, channelId: string, game: GameState) {
    // 録音BotをVCから切断
    const connection = getVoiceConnection(game.guildId);
    if (connection) connection.destroy();

    const guild = await client.guilds.fetch(game.guildId).catch(() => null);
    if (guild) {
        if (game.ghostTextId) await guild.channels.delete(game.ghostTextId).catch(() => {});
        for (const vcId of Object.values(game.vcIds)) {
            await guild.channels.delete(vcId).catch(() => {});
        }
        if (game.categoryId) await guild.channels.delete(game.categoryId).catch(() => {});
    }
    
    // 🚨 【修正ポイント】
    // DMのチャンネルIDではなく、「game」本体と一致する記憶を確実に探し出して削除する
    for (const [key, val] of activeGames.entries()) {
        if (val === game) {
            activeGames.delete(key);
            break;
        }
    }
}