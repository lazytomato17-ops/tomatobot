// src/index.ts
import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import * as http from 'http';
import * as os from 'os'; 
import { exec } from 'child_process'; 
import {
    Client, GatewayIntentBits, Interaction, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember,
    SlashCommandBuilder, TextChannel, PermissionFlagsBits,
    ActivityType
} from 'discord.js';

// 🟢 人狼用のインポートのみ
import * as GameLogic from './gameLogic';
import * as Messages from './messages';
import * as DB from './db';
import { getGame, hasGame, initGame, resetGame, findGameByUserId, getPlayingGameCount, getRecruitingGameCount, getActiveGameCount } from './state';
import * as Admin from './admin';
import * as dotenv from 'dotenv';
import cron from 'node-cron';
dotenv.config();
import * as Roles from './roles';

const DEVELOPER_ID = '1010400040797360218';
const MEMORY_LIMIT_MB = 512;
const CHAT_LOG_MAX = 200;
const TIMELINE_MAX = 500;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates, // 🎙️ 人狼のVCミュート管理などに必要
    ],
});

const port = process.env.PORT || 10000;
http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🍅 TomatoBot (Jinro) is running!');
}).listen(port, () => console.log(`🌐 ヘルスチェックサーバーがポート ${port} で起動しました！`));

process.on('unhandledRejection', r => console.error('🚨 UnhandledRejection:', r));
process.on('uncaughtException',  e => console.error('🚨 UncaughtException:', e));

client.once('ready', async () => {
    console.log(`${client.user?.tag} Login Complete!`);
    client.user?.setActivity('🌑夜の村を監視中 | /jinro', { type: ActivityType.Playing });

    const adminOnly = (b: any) => b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
    
    const commands = [
        new SlashCommandBuilder().setName('jinro').setDescription('人狼の募集ロビーを開始します'), // 🟢 追加
        new SlashCommandBuilder().setName('stats').setDescription('自分の戦績を表示します'), // 🟢 追加
        new SlashCommandBuilder().setName('reset').setDescription('現在のチャンネルのゲームを強制終了・リセットします').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder().setName('preset').setDescription('主催向け：オリジナル村設定を保存・呼出します')
            .addSubcommand(s => s.setName('save').setDescription('現在の設定を保存').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true)))
            // ▼ ここに .setAutocomplete(true) を追加！
            .addSubcommand(s => s.setName('load').setDescription('設定を読み込む').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true).setAutocomplete(true)))
            .addSubcommand(s => s.setName('list').setDescription('プリセット一覧を表示'))
            // ▼ ここにも .setAutocomplete(true) を追加！
            .addSubcommand(s => s.setName('delete').setDescription('プリセットを削除').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true).setAutocomplete(true))),
        adminOnly(new SlashCommandBuilder().setName('games').setDescription('【OP】稼働中ゲームの一覧を表示します')),
        adminOnly(new SlashCommandBuilder().setName('kick').setDescription('【OP】ロビーからプレイヤーを強制退出させます').addUserOption(o => o.setName('target').setDescription('退出させるプレイヤー').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('announce').setDescription('【OP】全ゲームチャンネルへ告知を一斉送信します').addStringOption(o => o.setName('message').setDescription('告知内容').setRequired(true)).addStringOption(o => o.setName('target').setDescription('送信先（デフォルト: 全て）').setRequired(false).addChoices({ name: '全て', value: 'all' }, { name: '進行中のみ', value: 'playing' }, { name: '募集中のみ', value: 'recruiting' }))),
        adminOnly(new SlashCommandBuilder().setName('forceskip').setDescription('【OP】フェーズタイマーを強制停止します（スタック救済）')),
        adminOnly(new SlashCommandBuilder().setName('sysinfo').setDescription('【OP】Botの稼働状況を確認します')),
        adminOnly(new SlashCommandBuilder().setName('update').setDescription('【OP】GitHubから最新コードを取得して再起動します')),
        adminOnly(new SlashCommandBuilder().setName('setup_verify').setDescription('【OP】認証ボタンを設置します').addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('penalty').setDescription('【OP】規約違反者のレートを強制没収します').addUserOption(o => o.setName('target').setDescription('処罰するユーザー').setRequired(true)).addStringOption(o => o.setName('type').setDescription('処罰内容').setRequired(true).addChoices({ name: '🔪 レートを初期値(1500)に戻す', value: 'reset_rate' })).addStringOption(o => o.setName('reason').setDescription('処罰理由').setRequired(false))),
    ];

    try {
        await client.application?.commands.set(commands);
        console.log('✅ スラッシュコマンドの登録が完了しました！');
    } catch (e) { console.error('❌ コマンド登録エラー:', e); }

    cron.schedule('0 0 1 * *', async () => {
        const rankers = await DB.resetSeasonAllUsers();
        const GUILD_ID = process.env.GUILD_ID || '';
        const RATE_TOP_ROLE_ID = process.env.RATE_TOP_ROLE_ID || '';
        if (!GUILD_ID) return;
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            if (!guild) return;
            await guild.members.fetch();
            guild.members.cache.forEach(async m => { if (m.roles.cache.has(RATE_TOP_ROLE_ID)) { await m.roles.remove(RATE_TOP_ROLE_ID).catch(() => {}); } });
            if (rankers.topRate?.length) {
                const topMember = await guild.members.fetch(rankers.topRate[0].id).catch(() => null);
                if (topMember) { await topMember.roles.add(RATE_TOP_ROLE_ID).catch(() => {}); }
            }
        } catch (e) { console.error('ロール付与エラー:', e); }
    }, { scheduled: true, timezone: "Asia/Tokyo" });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || message.content.startsWith('/')) return;
    const content = message.content.trim();
    if (message.guild) {
        const channel = message.channel as TextChannel;
        
        // 人狼のログ収集処理
        if (hasGame(message.channelId)) {
            const game = getGame(message.channelId);
            if (game.state === 'playing') {
                const player = game.players.find((p: any) => p.id === message.author.id);
                if (player?.alive) {
                    const name = message.member?.displayName || message.author.username;
                    if (!game.chatLog) game.chatLog = [];
                    game.chatLog.push({ id: message.author.id, name, content: message.content, day: game.dayCount });
                    if (game.chatLog.length > CHAT_LOG_MAX) game.chatLog.shift();
                    if (!game.timeline) game.timeline = [];
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: message.author.id, name, content: message.content });
                    if (game.timeline.length > TIMELINE_MAX) game.timeline.shift();
                }
            }
        }
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    // ▼▼ ここから追加 ▼▼
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'preset') {
            try {
                // ユーザーが現在入力している文字列を取得
                const focusedValue = interaction.options.getFocused() || '';
                
                // DBから取得（もしnullやundefinedが返ってきても空配列でカバー）
                const presets = (await DB.getPresets(interaction.user.id)) || [];
                const choices = presets.map((p: any) => p.name || '名称未設定');
                
                // 入力中の文字でフィルター（大文字小文字を区別しないように強化）
                const filtered = choices
                    .filter((choice: string) => choice.toLowerCase().includes(focusedValue.toLowerCase()))
                    .slice(0, 25); // Discordの仕様で最大25個まで
                
                // サジェスト結果を返す
                await interaction.respond(
                    filtered.map((choice: string) => ({ name: choice, value: choice }))
                );
            } catch (error) {
                console.error('プリセットのサジェストでエラーが発生しました:', error);
                // エラー時も「失敗しました」と出さないよう、空の選択肢を返して安全に終了
                await interaction.respond([]).catch(() => {});
            }
        }
        return;
    }
    // ▲▲ ここまで追加 ▲▲

    // ── スラッシュコマンド ──
    if (interaction.isChatInputCommand()) {
        if (!interaction.channel?.isTextBased()) return;
        const channel = interaction.channel as TextChannel;
        try {
            switch (interaction.commandName) {
                // 🟢 追加: /jinro コマンドの処理
                case 'jinro': {
                    const game = getGame(channel.id);
                    if (game?.state === 'playing') { 
                        await interaction.reply({ content: '⚠️ ゲーム進行中です。リセットコマンドを使うか、終了をお待ちください。', ephemeral: true }); 
                        return; 
                    }
                    const existing = findGameByUserId(interaction.user.id);
                    if (existing && existing.channel?.id !== channel.id) { 
                        await interaction.reply({ content: `⚠️ あなたは既に別の村（<#${existing.channel?.id}>）に参加しているため、新しく村を建てることはできません。`, ephemeral: true }); 
                        return; 
                    }
                    
                    initGame(channel, interaction.user);
                    const newGame = getGame(channel.id);
                    
                    // ペイロードを取得して、interaction.replyとして送信し、そのメッセージオブジェクトをlobbyMessageに保存します
                    const payload = await Messages.getLobbyPayload(newGame, interaction.user.id, interaction.member as any);
                    newGame.lobbyMessage = await interaction.reply({ ...payload, fetchReply: true });
                    return;
                }

                // 🟢 追加: /stats コマンドの処理
                case 'stats': {
                    // 処理に時間がかかる可能性があるため、一旦deferReplyを挟みます
                    await interaction.deferReply();
                    await GameLogic.showStats(interaction.user.id, { 
                        user: interaction.user, 
                        editReply: async (d: any) => interaction.editReply(d) 
                    });
                    return;
                }

                case 'setup_verify': {
                    const role = interaction.options.getRole('role'); if (!role) return;
                    const embed = new EmbedBuilder().setTitle('🛡️ サーバー認証').setDescription('以下のボタンをクリックして認証を完了してください！').setColor('#5865F2');
                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`verify_role_${role.id}`).setLabel('認証する / Verify').setStyle(ButtonStyle.Success).setEmoji('✅'));
                    await interaction.reply({ embeds: [embed], components: [row] }); return;
                }
                case 'reset': {
                    if (!hasGame(channel.id)) return interaction.reply({ content: '⚠️ このチャンネルでゲームは進行していません。', ephemeral: true });
                    resetGame(channel.id, true); await interaction.reply({ content: '🔄 **ゲームを強制リセットしました。**' }); return;
                }
                case 'games': { await interaction.deferReply(); await interaction.editReply({ embeds: [Admin.buildGamesEmbed(client)] }); return; }
                case 'kick': {
                    const targetUser = interaction.options.getUser('target'); if (!targetUser) return interaction.reply({ content: '❌ ユーザーが見つかりません。', ephemeral: true });
                    const result = Admin.kickPlayerFromLobby(channel.id, targetUser.id, interaction.user.id);
                    if (result.success && hasGame(channel.id)) { const game = getGame(channel.id); if (game.lobbyMessage) { await game.lobbyMessage.edit(await Messages.getLobbyPayload(game, game.hostId, null)).catch(() => {}); } }
                    await interaction.reply({ content: result.message, ephemeral: !result.success }); return;
                }
                case 'announce': {
                    await interaction.deferReply(); const msg = interaction.options.getString('message')!; const target = (interaction.options.getString('target') ?? 'all') as 'all' | 'playing' | 'recruiting';
                    if (getActiveGameCount() === 0) { await interaction.editReply('⚠️ 現在、稼働中のゲームがありません。'); return; }
                    const r = await Admin.announceToAllGames(msg, target); const label = target === 'playing' ? '進行中' : target === 'recruiting' ? '募集中' : '全'; await interaction.editReply(`📢 **一斉告知を送信しました。**\n送信先: ${label}ゲーム ✅成功:${r.sent} ❌失敗:${r.failed}`); return;
                }
                case 'forceskip': { const result = Admin.forceSkipTimers(channel.id); await interaction.reply({ content: result.message, ephemeral: !result.success }); return; }
                case 'sysinfo': {
                    await interaction.deferReply(); const mem = process.memoryUsage(); const usedMB = Math.round(mem.rss / 1024 / 1024); const pct = Math.round(usedMB / MEMORY_LIMIT_MB * 100);
                    const formatUptime = (s: number) => `${Math.floor(s / 86400)}日 ${Math.floor(s % 86400 / 3600)}時間 ${Math.floor(s % 3600 / 60)}分`; const memEmoji = pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢';
                    await interaction.editReply({ embeds: [ new EmbedBuilder().setTitle('📊 Tomatobot (Jinro) 稼働状況').setColor(pct >= 80 ? 0xFF0000 : 0x00FF00).addFields( { name: '🤖 稼働時間', value: formatUptime(process.uptime()), inline: true }, { name: `${memEmoji} メモリ`, value: `${usedMB}MB / ${MEMORY_LIMIT_MB}MB (${pct}%)`, inline: true }, { name: '\u200B', value: '\u200B', inline: true }, { name: '🎮 進行中', value: `${getPlayingGameCount()}試合`, inline: true }, { name: '🔍 募集中', value: `${getRecruitingGameCount()}試合`, inline: true }, { name: '📊 合計', value: `${getActiveGameCount()}試合`, inline: true }, { name: '🏢 サーバー', value: `CPU: ${os.cpus().length}Core / RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1000)}GB` } ).setFooter({ text: 'Hosted on Render | /games で詳細確認' }).setTimestamp() ]}); return;
                }
                case 'update': {
                    if (interaction.user.id !== DEVELOPER_ID) return interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
                    await interaction.reply({ content: '🚀 **アップデートを開始します...**' }); exec('./update.sh', async (err) => { if (err) await interaction.followUp(`❌ エラー:\n\`\`\`\n${err.message}\n\`\`\``); }); return;
                }
                case 'penalty': {
                    await interaction.deferReply(); const targetUser = interaction.options.getUser('target'); const type = interaction.options.getString('type')!; const reason = interaction.options.getString('reason') ?? 'サーバー規約違反（トロール/ゴースト等）';
                    if (!targetUser) { await interaction.editReply('ユーザーが見つかりません。'); return; }
                    const res = await DB.applyPenalty(targetUser.id, targetUser.username, type, reason);
                    if (res.success) { await interaction.editReply({ embeds: [ new EmbedBuilder().setTitle('🚨 【運営制裁の執行】').setDescription(`**対象者:** ${targetUser}\n**内容:** ${res.message}\n**理由:** ${reason}`).setColor(0x000000) ]}); } else { await interaction.editReply(`❌ エラー: ${res.message}`); } return;
                }
                case 'preset': {
                    // presetの処理があればここに記載
                    return;
                }
            }
        } catch (e: any) {
            console.error('Command Error:', e);
            const msg = `⚠️ **エラーが発生しました**: ${e.message}`;
            if (interaction.replied || interaction.deferred) { await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {}); } 
            else { await interaction.reply({ content: msg, ephemeral: true }).catch(() => {}); }
        }
    }

    // ── 認証ボタン系の処理 ──
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('verify_role_')) {
            const roleId = interaction.customId.replace('verify_role_', '');
            const member = interaction.member as GuildMember;
            if (!member) return interaction.reply({ content: '❌ エラーが発生しました。', ephemeral: true });
            try {
                if (member.roles.cache.has(roleId)) return interaction.reply({ content: '✅ あなたは既に認証されています！', ephemeral: true });
                await member.roles.add(roleId);
                await interaction.reply({ content: '🎉 認証が完了しました！チャンネルをお楽しみください！', ephemeral: true });
            } catch { await interaction.reply({ content: '❌ 権限エラー：BotのロールがターゲットロールよりDiscord上で上位にあるか確認してください。', ephemeral: true }); }
            return;
        }
    }

    // ── 人狼の関所処理（ボタン、セレクトメニュー、モーダル） ──
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        // verify_role の場合はゲーム外なので除外
        if (interaction.isButton() && interaction.customId.startsWith('verify_role_')) return;

        const gameExists = hasGame(interaction.channelId!) || !!findGameByUserId(interaction.user.id);
        if (!gameExists) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '⚠️ 参加中のゲームが見つかりません。（Bot再起動により無効になった可能性があります）',
                    ephemeral: true,
                }).catch(() => {});
            }
            return;
        }
        
        // 全てのアクションをGameLogic（人狼の処理）へ丸投げ
        await GameLogic.handleInteraction(interaction).catch(e => console.error('Interaction Error:', e.message));
    }
});

console.log("🚀 ボットを起動中...");
client.login(process.env.DISCORD_TOKEN).catch(console.error);
