// src/index.ts
import * as dns from 'dns';                     // 👈 追加
dns.setDefaultResultOrder('ipv4first');         // 👈 追加
import * as http from 'http';
import * as os from 'os'; // ✅ 修正: require('os')をトップレベルimportに移動
import { exec } from 'child_process'; // ✅ 修正: require('child_process')をトップレベルimportに移動
import {
    Client, GatewayIntentBits, Interaction, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember,
    SlashCommandBuilder, TextChannel, PermissionFlagsBits,
    ActivityType, ChannelType// ✅ 修正: ActivityTypeをトップレベルimportに移動
} from 'discord.js';
import * as GameLogic from './gameLogic';
import * as Messages from './messages';
import * as DB from './db';
import { getGame, hasGame, initGame, resetGame, findGameByUserId, getPlayingGameCount, getRecruitingGameCount, getActiveGameCount } from './state';
import * as Admin from './admin';
import * as dotenv from 'dotenv';
import cron from 'node-cron';
dotenv.config();
import * as FrequencyLogic from './frequencyLogic';
import * as Roles from './roles';
import { wildCommand } from './commands/wild';

// ── 定数 ─────────────────────────────────────────────────────
const DEVELOPER_ID = '1010400040797360218';

/** メモリ使用率の警告しきい値（MB） */
const MEMORY_LIMIT_MB = 512;

/** chatLogの最大保持件数 */
const CHAT_LOG_MAX = 200;

/** タイムラインの最大保持件数 */
const TIMELINE_MAX = 500;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// ── ヘルスチェック用サーバー ─────────────────────────────────
const port = process.env.PORT || 10000;
http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🍅 TomatoBot is running!');
}).listen(port, () => console.log(`🌐 ヘルスチェックサーバーがポート ${port} で起動しました！`));

// ── クラッシュ防止 ───────────────────────────────────────────
process.on('unhandledRejection', r => console.error('🚨 UnhandledRejection:', r));
process.on('uncaughtException',  e => console.error('🚨 UncaughtException:', e));

// ============================================================
// 起動時処理
// ============================================================
client.once('ready', async () => {
    console.log(`${client.user?.tag} Login Complete!`);

    // ✅ 修正: ActivityTypeはトップレベルimport済みなので require は不要
    client.user?.setActivity('🌑夜の村を監視中 | !jinro', { type: ActivityType.Playing });

    // ── スラッシュコマンド登録 ─────────────────────────────
    // ✅ 修正: 8 (マジックナンバー) → PermissionFlagsBits.Administrator で意味を明確に
    const adminOnly = (b: any) =>
    b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
    const commands = [
        adminOnly(new SlashCommandBuilder().setName('freq_nuke').setDescription('【OP】残ってしまったFREQUENCYのゲーム部屋を一括削除します')),
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('現在のチャンネルのゲームを強制終了・リセットします')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

        new SlashCommandBuilder().setName('preset').setDescription('主催向け：オリジナル村設定を保存・呼出します')
            .addSubcommand(s => s.setName('save').setDescription('現在の設定を保存').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true)))
            .addSubcommand(s => s.setName('load').setDescription('設定を読み込む').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('プリセット一覧を表示'))
            .addSubcommand(s => s.setName('delete').setDescription('プリセットを削除').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true))),

        adminOnly(new SlashCommandBuilder().setName('games').setDescription('【OP】稼働中ゲームの一覧を表示します')),
        adminOnly(new SlashCommandBuilder().setName('kick').setDescription('【OP】ロビーからプレイヤーを強制退出させます')
            .addUserOption(o => o.setName('target').setDescription('退出させるプレイヤー').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('announce').setDescription('【OP】全ゲームチャンネルへ告知を一斉送信します')
            .addStringOption(o => o.setName('message').setDescription('告知内容').setRequired(true))
            .addStringOption(o => o.setName('target').setDescription('送信先（デフォルト: 全て）').setRequired(false)
                .addChoices({ name: '全て', value: 'all' }, { name: '進行中のみ', value: 'playing' }, { name: '募集中のみ', value: 'recruiting' }))),
        adminOnly(new SlashCommandBuilder().setName('forceskip').setDescription('【OP】フェーズタイマーを強制停止します（スタック救済）')),
        adminOnly(new SlashCommandBuilder().setName('sysinfo').setDescription('【OP】Botの稼働状況を確認します')),
        adminOnly(new SlashCommandBuilder().setName('update').setDescription('【OP】GitHubから最新コードを取得して再起動します')),
        adminOnly(new SlashCommandBuilder().setName('setup_verify').setDescription('【OP】認証ボタンを設置します')
            .addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('penalty').setDescription('【OP】規約違反者のレートを強制没収します')
            .addUserOption(o => o.setName('target').setDescription('処罰するユーザー').setRequired(true))
            .addStringOption(o => o.setName('type').setDescription('処罰内容').setRequired(true).addChoices({ name: '🔪 レートを初期値(1500)に戻す', value: 'reset_rate' }))
            .addStringOption(o => o.setName('reason').setDescription('処罰理由').setRequired(false))),
        wildCommand.data,
    ];

    try {
        await client.application?.commands.set(commands);
        console.log('✅ スラッシュコマンドの登録が完了しました！');
    } catch (e) {
        console.error('❌ コマンド登録エラー:', e);
    }

    // ── 月初シーズンリセット（毎月1日 00:00 JST） ────────────
    cron.schedule('0 0 1 * *', async () => {
        console.log('🔄 月初めの自動シーズンリセットを開始します...');
        const rankers = await DB.resetSeasonAllUsers();
        const GUILD_ID = process.env.GUILD_ID || '';
        const RATE_TOP_ROLE_ID = process.env.RATE_TOP_ROLE_ID || '';
        if (!GUILD_ID) return;
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            if (!guild) return;
            await guild.members.fetch();

            // 全員から月間ランカーロールを剥奪
            guild.members.cache.forEach(async m => {
                if (m.roles.cache.has(RATE_TOP_ROLE_ID)) {
                    await m.roles.remove(RATE_TOP_ROLE_ID).catch(() => {});
                }
            });

            // 先月1位にロールを付与
            if (rankers.topRate?.length) {
                // ✅ 修正: GuildMemberには roles.add() があるため as any は不要
                const topMember = await guild.members.fetch(rankers.topRate[0].id).catch(() => null);
                if (topMember) {
                    await topMember.roles.add(RATE_TOP_ROLE_ID).catch(() => {});
                }
            }
            console.log('👑 月間ランカーへのロール付与が完了しました！');
        } catch (e) {
            console.error('ロール付与エラー:', e);
        }
    }, { scheduled: true, timezone: "Asia/Tokyo" });
});

// ============================================================
// メッセージコマンド
// ============================================================
client.on('messageCreate', async (message) => {
    if (message.author.bot || message.content.startsWith('/')) return;
    const content = message.content.trim();

    // ── ギルド（サーバー）内のメッセージ処理 ──────────────
    if (message.guild) {
        const channel = message.channel as TextChannel;

        // ── !jinro ──
        if (content === '!jinro') {
            const game = getGame(channel.id);
            if (game?.state === 'playing') {
                await channel.send('⚠️ ゲーム進行中です。リセットコマンドを使うか、終了をお待ちください。');
                return;
            }
            const existing = findGameByUserId(message.author.id);
            if (existing && existing.channel?.id !== channel.id) {
                await channel.send(`⚠️ あなたは既に別の村（<#${existing.channel?.id}>）に参加しているため、新しく村を建てることはできません。`);
                return;
            }
            initGame(channel, message.author);
            const newGame = getGame(channel.id);
            newGame.lobbyMessage = await channel.send(await Messages.getLobbyPayload(newGame, message.author.id, message.member as any));
            return;
        }

        // ── !stats ──
        if (content === '!stats') {
            await GameLogic.showStats(message.author.id, { user: message.author, editReply: async (d: any) => channel.send(d) });
            return;
        }

        // ── !status ──
        if (content === '!status') {
            let game = hasGame(channel.id) ? getGame(channel.id) : null;
            if (!game || game.state === 'idle') game = findGameByUserId(message.author.id);
            if (!game || game.state === 'idle') {
                await channel.send('📭 現在、参加中のゲームはありません。');
                return;
            }

            const humans = game.players.filter(p => !p.isNpc);
            const playerList = humans.map(p =>
                game!.state === 'playing'
                    ? `${p.alive ? '💚' : '💀'} ${p.name}`
                    : `👤 ${p.name}${p.id === game!.hostId ? ' 👑' : ''}`
            ).join(' ｜ ');

            await channel.send({ embeds: [
                new EmbedBuilder()
                    .setTitle('📊 現在のゲーム状況')
                    .setDescription(`**状態**: ${Admin.getGameStatusText(game)}`)
                    .addFields(
                        { name: '👥 参加者', value: playerList || 'なし', inline: false },
                        { name: '📺 チャンネル', value: `<#${game.channel?.id}>`, inline: true },
                        { name: '📅 日数', value: `${game.dayCount}日目`, inline: true },
                    )
                    .setColor(game.state === 'playing' ? 0xFF4444 : 0x4444FF)
                    .setTimestamp()
            ]});
            return;
        }

        // ── !help ──
        if (content === '!help') {
            await channel.send({ embeds: [
                new EmbedBuilder()
                    .setTitle('🍅 TomatoBot コマンド一覧')
                    .setColor(0xFF6347)
                    .addFields(
                        { name: '🎮 ゲームコマンド（誰でも使用可）', value: ['`!jinro` ── 募集ロビーを開始', '`!stats` ── 自分の戦績を表示', '`!status` ── 参加中ゲームの状態を確認', '`!help` ── このヘルプ'].join('\n') },
                        { name: '⚙️ スラッシュコマンド', value: ['`/preset save/load/list/delete` ── プリセット管理'].join('\n') },
                        { name: '🛡️ 管理者コマンド', value: ['`/reset` `/games` `/kick` `/announce` `/forceskip`', '`/sysinfo` `/penalty` `/setup_verify` `/update`'].join('\n') },
                    )
                    .setFooter({ text: '困ったことがあれば管理者へご連絡ください' })
                    .setTimestamp()
            ]});
            return;
        }

        // ── ゲーム中の発言記録 (Jinro用) ──
        // 進行中ゲームのチャンネルなら、生存プレイヤーの発言をログ・タイムラインに記録する
        if (hasGame(message.channelId)) {
            const game = getGame(message.channelId);
            if (game.state === 'playing') {
                const player = game.players.find((p: any) => p.id === message.author.id);
                if (player?.alive) {
                    const name = message.member?.displayName || message.author.username;
                    if (!game.chatLog) game.chatLog = [];
                    game.chatLog.push({ id: message.author.id, name, content: message.content, day: game.dayCount });
                    // 古いログを破棄してメモリを節約
                    if (game.chatLog.length > CHAT_LOG_MAX) game.chatLog.shift();

                    if (!game.timeline) game.timeline = [];
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: message.author.id, name, content: message.content });
                    if (game.timeline.length > TIMELINE_MAX) game.timeline.shift();
                }
            }
        }
    }
});

// ============================================================
// インタラクション
// ============================================================
client.on('interactionCreate', async (interaction: Interaction) => {

    // ── 認証ボタン ──
    if (interaction.isButton() && interaction.customId.startsWith('verify_role_')) {
        const roleId = interaction.customId.replace('verify_role_', '');
        const member = interaction.member as GuildMember;
        if (!member) return interaction.reply({ content: '❌ エラーが発生しました。', ephemeral: true });
        try {
            if (member.roles.cache.has(roleId)) {
                return interaction.reply({ content: '✅ あなたは既に認証されています！', ephemeral: true });
            }
            await member.roles.add(roleId);
            await interaction.reply({ content: '🎉 認証が完了しました！チャンネルをお楽しみください！', ephemeral: true });
        } catch {
            await interaction.reply({ content: '❌ 権限エラー：BotのロールがターゲットロールよりDiscord上で上位にあるか確認してください。', ephemeral: true });
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        if (!interaction.channel?.isTextBased()) return;
        const channel = interaction.channel as TextChannel;

        try {
            switch (interaction.commandName) {

                // ── /setup_verify ──
                case 'setup_verify': {
                    const role = interaction.options.getRole('role');
                    if (!role) return;
                    const embed = new EmbedBuilder()
                        .setTitle('🛡️ サーバー認証')
                        .setDescription('以下のボタンをクリックして認証を完了してください！')
                        .setColor('#5865F2');
                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`verify_role_${role.id}`)
                            .setLabel('認証する / Verify')
                            .setStyle(ButtonStyle.Success)
                            .setEmoji('✅')
                    );
                    await interaction.reply({ embeds: [embed], components: [row] });
                    return;
                }

                // ── /reset ──
                case 'reset': {
                    if (!hasGame(channel.id)) {
                        return interaction.reply({ content: '⚠️ このチャンネルでゲームは進行していません。', ephemeral: true });
                    }
                    resetGame(channel.id, true);
                    await interaction.reply({ content: '🔄 **ゲームを強制リセットしました。**' });
                    return;
                }

                // ── /games ──
                case 'games': {
                    await interaction.deferReply();
                    await interaction.editReply({ embeds: [Admin.buildGamesEmbed(client)] });
                    return;
                }

                // ── /kick ──
                case 'kick': {
                    const targetUser = interaction.options.getUser('target');
                    if (!targetUser) return interaction.reply({ content: '❌ ユーザーが見つかりません。', ephemeral: true });
                    const result = Admin.kickPlayerFromLobby(channel.id, targetUser.id, interaction.user.id);
                    if (result.success && hasGame(channel.id)) {
                        const game = getGame(channel.id);
                        if (game.lobbyMessage) {
                            await game.lobbyMessage.edit(await Messages.getLobbyPayload(game, game.hostId, null)).catch(() => {});
                        }
                    }
                    await interaction.reply({ content: result.message, ephemeral: !result.success });
                    return;
                }

                // ── /announce ──
                case 'announce': {
                    await interaction.deferReply();
                    const msg = interaction.options.getString('message')!;
                    const target = (interaction.options.getString('target') ?? 'all') as 'all' | 'playing' | 'recruiting';
                    if (getActiveGameCount() === 0) {
                        await interaction.editReply('⚠️ 現在、稼働中のゲームがありません。');
                        return;
                    }
                    const r = await Admin.announceToAllGames(msg, target);
                    const label = target === 'playing' ? '進行中' : target === 'recruiting' ? '募集中' : '全';
                    await interaction.editReply(`📢 **一斉告知を送信しました。**\n送信先: ${label}ゲーム ✅成功:${r.sent} ❌失敗:${r.failed}`);
                    return;
                }

                // ── /forceskip ──
                case 'forceskip': {
                    const result = Admin.forceSkipTimers(channel.id);
                    await interaction.reply({ content: result.message, ephemeral: !result.success });
                    return;
                }

                // ── /sysinfo ──
                case 'sysinfo': {
                    await interaction.deferReply();
                    // ✅ 修正: osをトップレベルimportに移動済み
                    const mem = process.memoryUsage();
                    const usedMB = Math.round(mem.rss / 1024 / 1024);
                    const pct = Math.round(usedMB / MEMORY_LIMIT_MB * 100);
                    const formatUptime = (s: number) =>
                        `${Math.floor(s / 86400)}日 ${Math.floor(s % 86400 / 3600)}時間 ${Math.floor(s % 3600 / 60)}分`;
                    const memEmoji = pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢';
                    await interaction.editReply({ embeds: [
                        new EmbedBuilder()
                            .setTitle('📊 Tomatobot 稼働状況')
                            .setColor(pct >= 80 ? 0xFF0000 : 0x00FF00)
                            .addFields(
                                { name: '🤖 稼働時間',        value: formatUptime(process.uptime()), inline: true },
                                { name: `${memEmoji} メモリ`,  value: `${usedMB}MB / ${MEMORY_LIMIT_MB}MB (${pct}%)`, inline: true },
                                { name: '\u200B',              value: '\u200B', inline: true },
                                { name: '🎮 進行中',           value: `${getPlayingGameCount()}試合`, inline: true },
                                { name: '🔍 募集中',           value: `${getRecruitingGameCount()}試合`, inline: true },
                                { name: '📊 合計',             value: `${getActiveGameCount()}試合`, inline: true },
                                { name: '🏢 サーバー',         value: `CPU: ${os.cpus().length}Core / RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1000)}GB` },
                            )
                            .setFooter({ text: 'Hosted on Render | /games で詳細確認' })
                            .setTimestamp()
                    ]});
                    return;
                }

                // ── /update ──
                case 'update': {
                    if (interaction.user.id !== DEVELOPER_ID) {
                        return interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
                    }
                    await interaction.reply({ content: '🚀 **アップデートを開始します...**' });
                    // ✅ 修正: execをトップレベルimportに移動済み
                    exec('./update.sh', async (err) => {
                        if (err) await interaction.followUp(`❌ エラー:\n\`\`\`\n${err.message}\n\`\`\``);
                    });
                    return;
                }

                case 'frequency': return await FrequencyLogic.handleFrequencyStart(interaction);

                // ── /freq_nuke (お掃除コマンド) ──
                case 'freq_nuke': {
                    await interaction.deferReply();
                    const guild = interaction.guild;
                    if (!guild) return;

                    // 「🔴 FREQUENCY ZONE」という名前のカテゴリをすべて探す
                    const categories = guild.channels.cache.filter(c => 
                        c.type === ChannelType.GuildCategory && c.name === '🔴 FREQUENCY ZONE'
                    );

                    if (categories.size === 0) {
                        return interaction.editReply('🧹 削除対象の部屋は見つかりませんでした。');
                    }

                    let deletedCount = 0;
                    for (const [_, category] of categories) {
                        // カテゴリの中にあるチャンネル（テキスト・音声）を全部消す
                        const children = guild.channels.cache.filter(c => c.parentId === category.id);
                        for (const [_, child] of children) {
                            await child.delete().catch(() => {});
                        }
                        // 最後に空になったカテゴリ自体を消す
                        await category.delete().catch(() => {});
                        deletedCount++;
                    }

                    return interaction.editReply(`🧹 完了！ ${deletedCount}個のゲームエリア（カテゴリと中身すべて）を完全に消去しました！`);
                }

                // ── /penalty ──
                case 'penalty': {
                    await interaction.deferReply();
                    const targetUser = interaction.options.getUser('target');
                    const type = interaction.options.getString('type')!;
                    const reason = interaction.options.getString('reason') ?? 'サーバー規約違反（トロール/ゴースト等）';
                    if (!targetUser) { await interaction.editReply('ユーザーが見つかりません。'); return; }
                    const res = await DB.applyPenalty(targetUser.id, targetUser.username, type, reason);
                    if (res.success) {
                        await interaction.editReply({ embeds: [
                            new EmbedBuilder()
                                .setTitle('🚨 【運営制裁の執行】')
                                .setDescription(`**対象者:** ${targetUser}\n**内容:** ${res.message}\n**理由:** ${reason}`)
                                .setColor(0x000000)
                        ]});
                    } else {
                        await interaction.editReply(`❌ エラー: ${res.message}`);
                    }
                    return;
                }

                // ── /preset ──
                case 'preset': {
                    const sub = interaction.options.getSubcommand();
                    const name = interaction.options.getString('name');
                    const userId = interaction.user.id;

                    if (sub === 'list') {
                        await interaction.deferReply({ ephemeral: true });
                        const presets = await DB.getPresets(userId);
                        if (!presets.length) return interaction.editReply('保存されたプリセットはありません。');
                        const listText = presets.map((p, i) => {
                            const s = p.settings;
                            const rolesStr = s.roles?.map((r: string) => Roles.ROLE_MAP[r] || r).join(', ') ?? 'なし';
                            const adv = [
                                s.matchType === 'ranked' ? '🏆ランク' : '🔰カジュアル',
                                s.voteTransparency === 'public' ? '記名投票' : '無記名投票',
                                s.tieVoteHandling === 'peace' ? '同票平和' : s.tieVoteHandling === 'random' ? '同票ランダム' : '決選投票',
                                s.continuousGuard ? '連続護衛あり' : '連続護衛なし',
                                s.firstNightPeace ? '初日平和' : '初日襲撃',
                                ...(s.autoFinishVoting ? ['時短投票'] : []),
                                ...(s.gayaMode ? ['NPCガヤ'] : []),
                                ...(s.willMode ? ['遺言あり'] : []),
                            ];
                            return `**${i+1}. ${p.name}**\n> 役職: ${rolesStr}\n> 狼: ${s.wolfMode === 'auto' ? '自動' : s.wolfMode+'人'} / 時間: ${s.discussionTime}秒\n> 📋 ${adv.join(' / ')}`;
                        }).join('\n\n');
                        return interaction.editReply(`📂 **保存済みプリセット (${presets.length}/20枠)**\n\n${listText}`);
                    }

                    if (sub === 'delete') {
                        await interaction.deferReply({ ephemeral: true });
                        return interaction.editReply((await DB.deletePreset(userId, name!)).message);
                    }

                    if (!hasGame(channel.id)) {
                        return interaction.reply({ content: '⚠️ 募集ロビーが開いている最中にのみ使用できます。', ephemeral: true });
                    }
                    const game = getGame(channel.id);
                    if (game.state !== 'recruiting') {
                        return interaction.reply({ content: '⚠️ 募集ロビーが開いている最中にのみ使用できます。', ephemeral: true });
                    }
                    if (game.hostId !== userId) {
                        return interaction.reply({ content: '⚠️ ホストのみ実行できます。', ephemeral: true });
                    }

                    await interaction.deferReply({ ephemeral: true });

                    if (sub === 'save') {
                        game.settings.playerCount = game.players.length + game.npcCount;
                        return interaction.editReply((await DB.savePreset(userId, name!, game.settings, interaction.member as any)).message);
                    }
                    if (sub === 'load') {
                        const presets = await DB.getPresets(userId);
                        const target = presets.find(p => p.name === name);
                        if (!target) return interaction.editReply(`❌ プリセット「${name}」が見つかりませんでした。`);
                        game.settings = target.settings;
                        if (game.lobbyMessage) {
                            await game.lobbyMessage.edit(await Messages.getLobbyPayload(game, userId, interaction.member as any)).catch(() => {});
                        }
                        return interaction.editReply(`✨ プリセット「**${name}**」を読み込みました！`);
                    }
                    return;
                }
            }
        } catch (e: any) {
            console.error('Command Error:', e);
            const msg = `⚠️ **エラーが発生しました**: ${e.message}`;
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
            }
        }
    }

    // ── ボタン / セレクト / モーダル ──
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('freq_')) {
            await FrequencyLogic.handleButton(interaction);
            return; // 忘れずにreturn
        }
    }
    if (interaction.isButton()) {
        
        // 🔴 ポケモン捕獲ボタンの処理
        if (interaction.customId.startsWith('catch_')) {
            // customIdから情報を抽出 (例: catch_25_ピカチュウ → ['catch', '25', 'ピカチュウ'])
            const [, pokeId, pokeName] = interaction.customId.split('_');

            // 処理落ちで「インタラクションに失敗しました」と出るのを防ぐため、まずは画面を更新状態にする
            await interaction.deferUpdate();

            // --- 🎲 捕獲判定ロジック ---
            // 簡易的に 50% の確率で捕獲成功とする
            const catchRate = 0.5;
            const isCaught = Math.random() < catchRate;

            // ボタンを「無効化（押せなくする）」して連打を防止する
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(interaction.customId)
                    .setLabel(isCaught ? '捕まえた！' : '逃げられた…')
                    .setStyle(isCaught ? ButtonStyle.Success : ButtonStyle.Secondary) // 成功は緑、失敗はグレー
                    .setEmoji(isCaught ? '✨' : '💨')
                    .setDisabled(true)
            );

            // 元のメッセージのEmbed（画像など）を引き継ぐ
            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);

            if (isCaught) {
                // 🌟 捕獲成功
                originalEmbed
                    .setTitle(`やったー！ **${pokeName}** を つかまえた！`)
                    .setColor(0x00FF00) // 成功の緑色
                    .setDescription(`🎊 <@${interaction.user.id}> の手持ちに加わりました！`);

                // データベースに保存する関数を呼び出す（※後で実装します）
                // await DB.savePokemon(interaction.user.id, pokeId, pokeName);

            } else {
                // 💨 捕獲失敗
                originalEmbed
                    .setTitle(`あぁっと！ **${pokeName}** は 逃げ出してしまった！`)
                    .setColor(0x808080) // 失敗の灰色
                    .setDescription('また `/wild` で草むらを探してみよう。');
            }

            // メッセージを結果に書き換える
            await interaction.editReply({ embeds: [originalEmbed], components: [disabledRow] });
            return;
        }
    }

    // ── Jinro 系インタラクション（ボタン・セレクト・モーダル共通の前処理） ──
    // ※ 上の Lethal ブロックで return しているため、lethal系がここに来ることはない
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        const gameExists = hasGame(interaction.channelId!) || !!findGameByUserId(interaction.user.id);
        if (!gameExists) {
            if (!interaction.replied && !interaction.deferred) {
                // ✅ 修正: ephemeral: true に統一（flags配列は非推奨）
                await interaction.reply({
                    content: '⚠️ 参加中のゲームが見つかりません。（Bot再起動により無効になった可能性があります）',
                    ephemeral: true,
                }).catch(() => {});
            }
            return;
        }
    }

    await GameLogic.handleInteraction(interaction).catch(e => console.error('Interaction Error:', e.message));
});

console.log("🚀 ボットを起動中...");
client.login(process.env.DISCORD_TOKEN).catch(console.error);
