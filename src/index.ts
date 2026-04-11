import * as http from 'http';
import https from 'https';
// ★追加: SlashCommandBuilder と TextChannel をインポートに追加しました
import { Client, GatewayIntentBits, Interaction, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember, SlashCommandBuilder, TextChannel, PermissionFlagsBits } from 'discord.js';
import * as GameLogic from './gameLogic'; 
import * as Messages from './messages'; 
import * as DB from './db';
import { getGame, hasGame, initGame, resetGame, findGameByUserId } from './state'; 
import * as dotenv from 'dotenv';
import cron from 'node-cron'; // ★ タイマーライブラリを追加
dotenv.config();
import * as Roles from './roles';
import { startHealthCheck } from './server';

startHealthCheck();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
    console.log(`${client.user?.tag} Login Complete!`);

    // ★ 追加：10分ごとに自分自身にアクセスして居眠りを防ぐ（Self-Ping）
    setInterval(async () => {
        // タイムアウト付きself-ping（ハング防止）
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 10_000);
        try {
            const res = await fetch('https://tomatobot-xsoo.onrender.com', { signal: ctrl.signal });
            clearTimeout(tid);
            if (res.ok) console.log('[Self-Ping] 🍅 居眠り防止完了');
        } catch (error: any) {
            clearTimeout(tid);
            if (error?.name !== 'AbortError') {
                console.error('[Self-Ping] エラー:', error?.message ?? error);
            }
        }
    }, 10 * 60 * 1000); // 10分ごとに実行

    const commands = [
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('現在のチャンネルのゲームを強制終了・リセットします')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages), // ★ 追加: サーバー管理者（または管理者権限持ち）のみ実行可能に制限！
        new SlashCommandBuilder().setName('preset').setDescription('主催向け：オリジナル村設定を保存・呼出します')
            .addSubcommand(sub => sub.setName('save').setDescription('現在の募集ロビーの設定を保存します').addStringOption(opt => opt.setName('name').setDescription('プリセットの名前').setRequired(true)))
            .addSubcommand(sub => sub.setName('load').setDescription('保存済みの設定を募集ロビーに呼び出します').addStringOption(opt => opt.setName('name').setDescription('プリセットの名前').setRequired(true)))
            .addSubcommand(sub => sub.setName('list').setDescription('保存済みのプリセット一覧を表示します'))
            .addSubcommand(sub => sub.setName('delete').setDescription('不要なプリセットを削除します').addStringOption(opt => opt.setName('name').setDescription('プリセットの名前').setRequired(true))),
        
        // ==========================================
        // ★追加①: サーバー認証用の管理者コマンドを追加
        // ==========================================
        new SlashCommandBuilder()
            .setName('setup_verify')
            .setDescription('【管理者専用】このチャンネルにサーバー認証ボタンを設置します')
            .setDefaultMemberPermissions(8)
            .addRoleOption(opt => opt.setName('role').setDescription('付与するロール').setRequired(true)),
            
        new SlashCommandBuilder()
            .setName('update')
            .setDescription('【OP】Botの最新コードをGitHubから取得し、再起動します')
            .setDefaultMemberPermissions(8), // 管理者権限のみ

        new SlashCommandBuilder()
            .setName('sysinfo')
            .setDescription('【OP】サーバー（タブレット）の現在の健康状態を確認します')
            .setDefaultMemberPermissions(8), // 管理者権限のみ

        // ★追加: 処罰コマンド
        new SlashCommandBuilder()
            .setName('penalty')
          
  .setDescription('【OP】規約違反者のレートを強制没収します')
            .setDefaultMemberPermissions(8) // 管理者権限(Administrator)のみ実行可能
            .addUserOption(opt => opt.setName('target').setDescription('処罰するユーザー').setRequired(true))
            .addStringOption(opt => opt.setName('type').setDescription('処罰内容').setRequired(true)
                .addChoices(
                    { name: '🔪 レートを初期値(1500)に戻す', value: 'reset_rate' }
                ))
            .addStringOption(opt => opt.setName('reason').setDescription('処罰理由').setRequired(false)),
    ];

    try {
        console.log('🔄 スラッシュコマンドをDiscordに登録中...');
        await client.application?.commands.set(commands);
        console.log('✅ スラッシュコマンドの登録が完了しました！');
    } catch (error) {
        console.error('❌ コマンド登録エラー:', error);
    }

    // ★ 追加: 完全全自動のシーズンリセット（毎月1日の深夜0時0分に発動）
    cron.schedule('0 0 1 * *', async () => {
        console.log('🔄 月初めの自動シーズンリセットを開始します...');
        
        // DBからトップランカーの情報を取得しつつ、全員をリセット！
        const rankers = await DB.resetSeasonAllUsers();
        console.log('✅ シーズンリセットが完了しました！');

        // ==========================================
        // 👑 称号ロールの自動付与ロジック（後でIDを入れてください）
        // ==========================================
        // .env ファイルから安全に読み込むように変更！
        const GUILD_ID = process.env.GUILD_ID || '';
        const RATE_TOP_ROLE_ID = process.env.RATE_TOP_ROLE_ID || '';
        if (!GUILD_ID) return; // 設定されていなければ安全にスキップ
        
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            if (!guild) return;

            // まず、先月の覇者たちから古いロールを剥奪する（※これをしないと覇者が増え続けるため）
            // （※Discord APIの制限に配慮し、エラーが出ても止まらないようにしています）
            // キャッシュに全メンバーが存在するとは限らないため先にfetch
            await guild.members.fetch();
            guild.members.cache.forEach(async (member) => {
                if (member.roles.cache.has(RATE_TOP_ROLE_ID)) await member.roles.remove(RATE_TOP_ROLE_ID).catch(e => console.error('Silent Error:', e.message));
            });

            // 今月のレート1位にロールを付与
            if (rankers.topRate && rankers.topRate.length > 0) {
                const rateKingId = rankers.topRate[0].id;
                const member = await guild.members.fetch(rateKingId).catch(e => console.error('Silent Error:', e.message));
                if (member) await member.roles.add(RATE_TOP_ROLE_ID).catch(e => console.error('Silent Error:', e.message));
            }
            
            console.log('👑 月間ランカーへのロール付与が完了しました！');
        } catch (error) {
            console.error('ロール付与中にエラーが発生しました:', error);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Tokyo" 
    });
});

// ▼▼ ここから追加 ▼▼
client.on('messageCreate', async (message) => {

    // ボットやコマンドは無視する（全メッセージのログは負荷が大きいため削除）
    if (message.author.bot || message.content.startsWith('/')) return;

      // 「おみくじ」と入力されたらランダムな運勢を返す
    if (message.content.trim() === 'おみくじ') {
        const fortunes = ['大吉', '中吉', '小吉', '吉', '末吉', '凶', '大凶'];
        const result = fortunes[Math.floor(Math.random() * fortunes.length)];
        await message.reply(`今日の運勢は **${result}** です！`);
        return;
    }

// ▼▼ !jinro コマンド ▼▼
    if (message.content.trim() === '!jinro') {
        const channel = message.channel as TextChannel;
        const game = getGame(channel.id);

        if (game && game.state === 'playing') {
            await channel.send('⚠️ ゲーム進行中です。リセットコマンドを使うか、終了をお待ちください。');
            return;
        }

        const existingGame = findGameByUserId(message.author.id);
        if (existingGame && existingGame.channel?.id !== channel.id) {
            await channel.send(`⚠️ あなたは既に別の村（<#${existingGame.channel?.id}>）に参加しているため、新しく村を建てることはできません。\nまずはあちらの村を退出してください！`);
            return;
        }

        // 返信(reply)ではなく、そのまま送信(send)します。
        // 「作成中...」の待機メッセージも省いて即座にロビーを展開します。
        initGame(channel, message.author);
        const newGame = getGame(channel.id);

        const payload = await Messages.getLobbyPayload(newGame, message.author.id, message.member as any);
        newGame.lobbyMessage = await channel.send(payload);
        return;
    }

    // ▼▼ !stats コマンド ▼▼
    if (message.content.trim() === '!stats') {
        // 「戦績を取得中...」を省き、結果が取得でき次第直接送信します
        const dummyInteraction = {
            user: message.author,
            // 内部で呼ばれる editReply を channel.send に直結させるハック
            editReply: async (data: any) => await (message.channel as TextChannel).send(data)
        };

        await GameLogic.showStats(message.author.id, dummyInteraction);
        return;
    }

    // ゲームが存在しないチャンネルでは State を生成しない（メモリリーク防止）
    if (!hasGame(message.channelId)) return;
    const game = getGame(message.channelId);
    if (game.state !== 'playing') return;

    // 生きているプレイヤーの発言のみ記録する
    const player = game.players.find((p: any) => p.id === message.author.id);
    if (!player || !player.alive) return;

        // （もともとあるコード）
    if (!game.chatLog) game.chatLog = [];
    game.chatLog.push({
        id: message.author.id,
        name: message.member?.displayName || message.author.username,
        content: message.content,
        day: game.dayCount,
    });
    // chatLogを200件に制限（メモリリーク防止）
    if (game.chatLog.length > 200) game.chatLog.shift();

    if (!game.timeline) game.timeline = [];
    game.timeline.push({
        type: 'chat',
        day: game.dayCount,
        id: message.author.id,
        name: message.member?.displayName || message.author.username,
        content: message.content
    });
    // timelineを500件に制限
    if (game.timeline.length > 500) game.timeline.shift();
});    // ▲▲ ここまで追加 ▲▲

client.on('interactionCreate', async (interaction: Interaction) => {

    // ==========================================
    // ★追加②: 認証ボタンが押されたときの処理を追加
    // ==========================================
    if (interaction.isButton() && interaction.customId.startsWith('verify_role_')) {
        const roleId = interaction.customId.replace('verify_role_', '');
        const member = interaction.member as GuildMember;
        
        if (!member) {
            return interaction.reply({ content: '❌ エラーが発生しました。', ephemeral: true });
        }

        try {
            // 既にロールを持っているか確認
            if (member.roles.cache.has(roleId)) {
                return interaction.reply({ content: '✅ あなたは既に認証されています！ (Already verified)', ephemeral: true });
            }

            // ロールを付与
            await member.roles.add(roleId);
            await interaction.reply({ content: '🎉 認証が完了しました！チャンネルをお楽しみください！ (Verification complete!)', ephemeral: true });
        } catch (error) {
            console.error('Role Add Error:', error);
            await interaction.reply({ content: '❌ 権限エラー：Botのロール（役職）が、付与したいロールより上に配置されているか確認してください。', ephemeral: true });
        }
        return;
    }


    if (interaction.isChatInputCommand()) {
        if (!interaction.channel?.isTextBased()) return;
        const channel = interaction.channel as TextChannel;

        // ==========================================
        // ★追加③: /setup_verify コマンドが打たれたときの処理を追加
        // ==========================================
        if (interaction.commandName === 'setup_verify') {
            const role = interaction.options.getRole('role');
            if (!role) return;

            const embed = new EmbedBuilder()
                .setTitle('🛡️ サーバー認証 / Server Verification')
                .setDescription('以下のボタンをクリックして認証を完了し、\nサーバーのチャンネルを解放してください！\n\nClick the button below to verify and unlock the server!')
                .setColor('#5865F2');

            const button = new ButtonBuilder()
                .setCustomId(`verify_role_${role.id}`)
                .setLabel('認証する / Verify')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

            await interaction.reply({ embeds: [embed], components: [row] });
            return;
        }

        if (interaction.commandName === 'reset') {
            if (!hasGame(channel.id)) return interaction.reply({ content: '⚠️ このチャンネルでゲームは進行していません。', ephemeral: true });
            // ここで初めてリセット等の処理を行う
            resetGame(channel.id, true);
            await interaction.reply({ content: '🔄 **ゲームを強制リセットしました。**' });
            return;
        }

        if (interaction.commandName === 'preset') {
            const sub = interaction.options.getSubcommand();
            const name = interaction.options.getString('name');
            const userId = interaction.user.id;

            if (sub === 'list') {
                await interaction.deferReply({ ephemeral: true });
                const presets = await DB.getPresets(userId);
                if (presets.length === 0) return interaction.editReply('保存されたプリセットはありません。\n募集ロビーを作成し、`/preset save` で設定を保存できます！');
                
                const listText = presets.map((p, i) => {
                    const s = p.settings;
                    // 役職を日本語に変換
                    const rolesStr = s.roles ? s.roles.map((r: string) => Roles.ROLE_MAP[r] || r).join(', ') : 'なし';
                    
                    // 詳細ルールの文字列化
                    let adv = [];
                    adv.push(s.matchType === 'ranked' ? '🏆ランク' : '🔰カジュアル');
                    adv.push(s.voteTransparency === 'public' ? '記名投票' : '無記名投票');
                    if (s.tieVoteHandling === 'peace') adv.push('同票平和');
                    else if (s.tieVoteHandling === 'random') adv.push('同票ランダム');
                    else adv.push('決選投票');
                    adv.push(s.continuousGuard ? '連続護衛あり' : '連続護衛なし');
                    adv.push(s.firstNightPeace ? '初日襲撃なし' : '初日襲撃あり');
                    if (s.autoFinishVoting) adv.push('時短投票');
                    if (s.gayaMode) adv.push('NPCガヤ');
                    if (s.willMode) adv.push('遺言あり');

                    return `**${i+1}. ${p.name}**\n> 役職: ${rolesStr}\n> 狼: ${s.wolfMode === 'auto' ? '自動' : s.wolfMode+'人'} / 時間: ${s.discussionTime}秒\n> 📋詳細: ${adv.join(' / ')}`;
                }).join('\n\n');

                await interaction.editReply(`📂 **あなたの保存済みプリセット (${presets.length}/20枠)**\n\n${listText}`);
                return;
            }


            if (sub === 'delete') {
                await interaction.deferReply({ ephemeral: true });
                const res = await DB.deletePreset(userId, name!);
                await interaction.editReply(res.message);
                return;
            }

            // ▼▼ ここが修正ポイント！ game を安全に取得 ▼▼
            if (!hasGame(channel.id)) {
                return interaction.reply({ content: '⚠️ このコマンドは、`/jinro` で募集ロビーを開いている最中にのみ使用できます。', ephemeral: true });
            }
            const game = getGame(channel.id);
            // ▲▲ ここまで ▲▲

            if (game.state !== 'recruiting') {
                return interaction.reply({ content: '⚠️ このコマンドは、`/jinro` で募集ロビーを開いている最中にのみ使用できます。', ephemeral: true });
            }
            if (game.hostId !== userId) {
                return interaction.reply({ content: '⚠️ プリセットの保存・呼び出しは、そのロビーの主催者（ホスト）しか実行できません。', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            if (sub === 'save') {
                game.settings.playerCount = game.players.length + game.npcCount;
                const res = await DB.savePreset(userId, name!, game.settings, interaction.member as any);
                await interaction.editReply(res.message);
            } 
            else if (sub === 'load') {
                const presets = await DB.getPresets(userId);
                const target = presets.find(p => p.name === name);
                if (!target) return interaction.editReply(`❌ プリセット「${name}」が見つかりませんでした。`);

                 game.settings = target.settings;
                if (game.lobbyMessage) {
                    await game.lobbyMessage.edit(await Messages.getLobbyPayload(game, userId, interaction.member as any)).catch((e: any) => console.error('Silent Error:', e.message));
                }
                await interaction.editReply(`✨ プリセット「**${name}**」を読み込み、ロビーの設定を上書きしました！`);
            }
            return;
        }

        // ★追加: ペナルティコマンドの処理
        if (interaction.commandName === 'penalty') {
            await interaction.deferReply({ ephemeral: false });
            const targetUser = interaction.options.getUser('target');
            const type = interaction.options.getString('type');
            const reason = interaction.options.getString('reason') || 'サーバー規約違反（トロール/ゴースト等）';

            if (!targetUser) return interaction.editReply('ユーザーが見つかりません。');

            const res = await DB.applyPenalty(targetUser.id, targetUser.username, type!, reason);
            
            if (res.success) {
                const embed = new EmbedBuilder()
                    .setTitle('🚨 【運営制裁の執行】')
                    .setDescription(`以下のプレイヤーに対して処罰が下されました。\n\n**対象者:** ${targetUser.toString()}\n**内容:** ${res.message}\n**理由:** ${reason}`)
                    .setColor(0x000000); // 漆黒
                await interaction.editReply({ embeds: [embed] });
            } else {
                await interaction.editReply(`❌ エラー: ${res.message}`);
            }
            return;
        }

        // ▼▼▼ updateコマンドはここ！(isChatInputCommandの閉じカッコの「内側」) ▼▼▼
        if (interaction.commandName === 'update') {
            // あなたのDiscord ID
            const YOUR_DISCORD_ID = '1010400040797360218'; 
            
            if (interaction.user.id !== YOUR_DISCORD_ID) {
                return interaction.reply({ content: '❌ 権限がありません。このコマンドは開発者のみ実行可能です。', ephemeral: true });
            }

            await interaction.reply({ content: '🚀 **アップデートを開始します...**\n（GitHubから最新コードを取得し、ビルドして再起動します）' });

            const { exec } = require('child_process');
            exec('./update.sh', async (error: any, stdout: any, stderr: any) => {
                if (error) {
                    console.error(`exec error: ${error}`);
                    await interaction.followUp(`❌ アップデート中にエラーが発生しました:\n\`\`\`bash\n${error.message}\n\`\`\``);
                    return;
                }
            });
            return;
        }
        // ▲▲▲ ここまで ▲▲▲

        // ▼▼▼ ここから追加 ▼▼▼
        if (interaction.commandName === 'sysinfo') {
            await interaction.deferReply({ ephemeral: false });

            // Node.js内蔵の 'os' モジュールを使って端末情報を取得
            const os = require('os');
            
            // メモリの計算（バイトからMBに変換）
            const totalMem = Math.round(os.totalmem() / 1024 / 1024);
            const freeMem = Math.round(os.freemem() / 1024 / 1024);
            const usedMem = totalMem - freeMem;
            const memUsage = Math.round((usedMem / totalMem) * 100);

            // 稼働時間のフォーマット関数
            const formatUptime = (seconds: number) => {
                const d = Math.floor(seconds / (3600 * 24));
                const h = Math.floor(seconds % (3600 * 24) / 3600);
                const m = Math.floor(seconds % 3600 / 60);
                return `${d}日 ${h}時間 ${m}分`;
            };

            // タブレット本体の起動時間と、Botアプリの起動時間
            const serverUptime = formatUptime(os.uptime());
            const botUptime = formatUptime(process.uptime());

            const embed = new EmbedBuilder()
                .setTitle('サーバー稼働状況')
                .setColor(0x00FF00) // 稼働中を表す緑色
                .addFields(
                    { name: 'Bot連続稼働時間', value: `${botUptime}`, inline: true },
                    { name: '端末連続稼働時間', value: `${serverUptime}`, inline: true },
                    { name: 'メモリ使用量', value: `${usedMem}MB / ${totalMem}MB (${memUsage}%)`, inline: false },
                    { name: 'CPUコア数', value: `${os.cpus().length} Core`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
        }
        // ▲▲▲ ここまで追加 ▲▲▲

    } // <--- ★ 超重要：これが isChatInputCommand() の正しい閉じカッコです！

    // ★ ここから追加・変更（古いボタンを押した時のクラッシュ防止）
    // index.ts の下部のボタン処理
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        // ❌ const game = getGame(interaction.channelId!); を削除
        if (!hasGame(interaction.channelId!)) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ Bot再起動により無効なボタンです。新しく村を立ててください。', flags: ['Ephemeral'] }).catch(() => {});
            }
            return;
        }
    }
    await GameLogic.handleInteraction(interaction).catch(e => console.error('Interaction Error:', e.message));
}); // <--- interactionCreate の閉じカッコ

// ▼▼ ここから追加（絶対にBotを落とさないための防御壁） ▼▼
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 予期せぬPromiseエラーをキャッチ（Botのクラッシュを防ぎました）:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 予期せぬ例外エラーをキャッチ（Botのクラッシュを防ぎました）:', error);
});
// ▲▲ ここまで追加 ▲▲

console.log("🚀 ボットを起動中...");
client.login(process.env.DISCORD_TOKEN).catch(console.error);