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
    ActivityType, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuInteraction,
    StringSelectMenuBuilder // 👈 これを一番後ろに追加！
} from 'discord.js';
import * as GameLogic from './gameLogic';
import * as Messages from './messages';
import * as DB from './db';
import { getGame, hasGame, initGame, resetGame, findGameByUserId, getPlayingGameCount, getRecruitingGameCount, getActiveGameCount } from './state';
import * as Admin from './admin';
import * as dotenv from 'dotenv';
import cron from 'node-cron';
dotenv.config();
import * as Roles from './roles';
import { wildCommand } from './commands/wild';
import { boxCommand } from './commands/box';
import { partyCommand } from './commands/party';
import { infoCommand } from './commands/info';
import { shopCommand } from './commands/shop';
import { releaseCommand } from './commands/release';
import { battleCommand } from './commands/battle';
import { nicknameCommand } from './commands/nickname';
import { dailyCommand } from './commands/daily';
import { healCommand } from './commands/heal';
import { orderCommand } from './commands/order';
import { movesCommand } from './commands/moves';
import { tradeCommand } from './commands/trade';
import { gymCommand } from './commands/gym';
import { trainerCommand } from './commands/trainer';
import { useCommand } from './commands/use';
import { raidCommand } from './commands/raid';
import { departmentCommand } from './commands/department';
import { activeRaids, startRaidBattle, handleRaidAction } from './commands/raid';
import { equipCommand } from './commands/equip';
import * as TradeLogic from './tradeLogic';
import * as BattleLogic from './battleLogic';
import * as PokeDB from './pokeDb';
import { getTodaysOutbreak } from './pokeApiUtils';
import { hiddenWildChains } from './battleLogic';

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
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const port = process.env.PORT || 10000;
http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🍅 TomatoBot is running!');
}).listen(port, () => console.log(`🌐 ヘルスチェックサーバーがポート ${port} で起動しました！`));

process.on('unhandledRejection', r => console.error('🚨 UnhandledRejection:', r));
process.on('uncaughtException',  e => console.error('🚨 UncaughtException:', e));

client.once('ready', async () => {
    console.log(`${client.user?.tag} Login Complete!`);
    client.user?.setActivity('🌑夜の村を監視中 | !jinro', { type: ActivityType.Playing });

    const adminOnly = (b: any) => b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
    const commands = [
        new SlashCommandBuilder().setName('reset').setDescription('現在のチャンネルのゲームを強制終了・リセットします').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder().setName('preset').setDescription('主催向け：オリジナル村設定を保存・呼出します')
            .addSubcommand(s => s.setName('save').setDescription('現在の設定を保存').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true)))
            .addSubcommand(s => s.setName('load').setDescription('設定を読み込む').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('プリセット一覧を表示'))
            .addSubcommand(s => s.setName('delete').setDescription('プリセットを削除').addStringOption(o => o.setName('name').setDescription('プリセット名').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('games').setDescription('【OP】稼働中ゲームの一覧を表示します')),
        adminOnly(new SlashCommandBuilder().setName('kick').setDescription('【OP】ロビーからプレイヤーを強制退出させます').addUserOption(o => o.setName('target').setDescription('退出させるプレイヤー').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('announce').setDescription('【OP】全ゲームチャンネルへ告知を一斉送信します').addStringOption(o => o.setName('message').setDescription('告知内容').setRequired(true)).addStringOption(o => o.setName('target').setDescription('送信先（デフォルト: 全て）').setRequired(false).addChoices({ name: '全て', value: 'all' }, { name: '進行中のみ', value: 'playing' }, { name: '募集中のみ', value: 'recruiting' }))),
        adminOnly(new SlashCommandBuilder().setName('forceskip').setDescription('【OP】フェーズタイマーを強制停止します（スタック救済）')),
        adminOnly(new SlashCommandBuilder().setName('sysinfo').setDescription('【OP】Botの稼働状況を確認します')),
        adminOnly(new SlashCommandBuilder().setName('update').setDescription('【OP】GitHubから最新コードを取得して再起動します')),
        adminOnly(new SlashCommandBuilder().setName('setup_verify').setDescription('【OP】認証ボタンを設置します').addRoleOption(o => o.setName('role').setDescription('付与するロール').setRequired(true))),
        adminOnly(new SlashCommandBuilder().setName('penalty').setDescription('【OP】規約違反者のレートを強制没収します').addUserOption(o => o.setName('target').setDescription('処罰するユーザー').setRequired(true)).addStringOption(o => o.setName('type').setDescription('処罰内容').setRequired(true).addChoices({ name: '🔪 レートを初期値(1500)に戻す', value: 'reset_rate' })).addStringOption(o => o.setName('reason').setDescription('処罰理由').setRequired(false))),
        wildCommand.data, boxCommand.data, partyCommand.data, infoCommand.data, shopCommand.data, releaseCommand.data, battleCommand.data, nicknameCommand.data, dailyCommand.data, healCommand.data, orderCommand.data, movesCommand.data, tradeCommand.data, gymCommand.data, trainerCommand.data, useCommand.data, raidCommand.data, departmentCommand.data, equipCommand.data,
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

    // 👇 ここから新しく追加！ 毎朝6時の大量発生アナウンス
    cron.schedule('0 6 * * *', async () => {
        // 👇 ①ここを実際のアナウンス用チャンネルのID（数字）に書き換える！
        const ANNOUNCE_CHANNEL_ID = '1498892635912409190'; 
        
        try {
            // 👇 ② cache.get ではなく fetch を使って確実に取得する！
            const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
            if (channel && channel.isTextBased()) {
                const outbreak = await getTodaysOutbreak();
                const embed = new EmbedBuilder()
                    .setTitle('📢 本日の大量発生ニュース！')
                    .setColor(0xFF4500)
                    .setDescription(`おはようございます！トレーナーの皆様！\n\n本日は **【${outbreak.area}】** エリアで **${outbreak.name}** の大量発生が確認されています！\n\n捕獲の大チャンスです！\`/area name:${outbreak.area}\` で移動して、\`/wild\` で探しに行きましょう！`);
                
                await (channel as TextChannel).send({ embeds: [embed] });
            }
        } catch (e) {
            console.error('アナウンス送信エラー:', e);
        }
    }, { scheduled: true, timezone: "Asia/Tokyo" });
    // 👆 追加ここまで
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || message.content.startsWith('/')) return;
    const content = message.content.trim();
    if (message.guild) {
        const channel = message.channel as TextChannel;
        if (content === '!jinro') {
            const game = getGame(channel.id);
            if (game?.state === 'playing') { await channel.send('⚠️ ゲーム進行中です。リセットコマンドを使うか、終了をお待ちください。'); return; }
            const existing = findGameByUserId(message.author.id);
            if (existing && existing.channel?.id !== channel.id) { await channel.send(`⚠️ あなたは既に別の村（<#${existing.channel?.id}>）に参加しているため、新しく村を建てることはできません。`); return; }
            initGame(channel, message.author);
            const newGame = getGame(channel.id);
            newGame.lobbyMessage = await channel.send(await Messages.getLobbyPayload(newGame, message.author.id, message.member as any));
            return;
        }
        if (content === '!stats') { await GameLogic.showStats(message.author.id, { user: message.author, editReply: async (d: any) => channel.send(d) }); return; }
        if (content === '!status') {
            let game = hasGame(channel.id) ? getGame(channel.id) : null;
            if (!game || game.state === 'idle') game = findGameByUserId(message.author.id);
            if (!game || game.state === 'idle') { await channel.send('📭 現在、参加中のゲームはありません。'); return; }
            const humans = game.players.filter(p => !p.isNpc);
            const playerList = humans.map(p => game!.state === 'playing' ? `${p.alive ? '💚' : '💀'} ${p.name}` : `👤 ${p.name}${p.id === game!.hostId ? ' 👑' : ''}`).join(' ｜ ');
            await channel.send({ embeds: [ new EmbedBuilder().setTitle('📊 現在のゲーム状況').setDescription(`**状態**: ${Admin.getGameStatusText(game)}`).addFields( { name: '👥 参加者', value: playerList || 'なし', inline: false }, { name: '📺 チャンネル', value: `<#${game.channel?.id}>`, inline: true }, { name: '📅 日数', value: `${game.dayCount}日目`, inline: true } ).setColor(game.state === 'playing' ? 0xFF4444 : 0x4444FF).setTimestamp() ]});
            return;
        }
        if (content === '!help') {
            await channel.send({ embeds: [ new EmbedBuilder().setTitle('🍅 TomatoBot コマンド一覧').setColor(0xFF6347).addFields( { name: '🎮 ゲームコマンド（誰でも使用可）', value: ['`!jinro` ── 募集ロビーを開始', '`!stats` ── 自分の戦績を表示', '`!status` ── 参加中ゲームの状態を確認', '`!help` ── このヘルプ'].join('\n') }, { name: '⚙️ スラッシュコマンド', value: ['`/preset save/load/list/delete` ── プリセット管理'].join('\n') }, { name: '🛡️ 管理者コマンド', value: ['`/reset` `/games` `/kick` `/announce` `/forceskip`', '`/sysinfo` `/penalty` `/setup_verify` `/update`'].join('\n') } ).setFooter({ text: '困ったことがあれば管理者へご連絡ください' }).setTimestamp() ]});
            return;
        }
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
    // ── スラッシュコマンド ──
    if (interaction.isChatInputCommand()) {
        if (!interaction.channel?.isTextBased()) return;
        const channel = interaction.channel as TextChannel;
        try {
            switch (interaction.commandName) {
                // (管理系コマンドは省略せず記載)
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
                    await interaction.editReply({ embeds: [ new EmbedBuilder().setTitle('📊 Tomatobot 稼働状況').setColor(pct >= 80 ? 0xFF0000 : 0x00FF00).addFields( { name: '🤖 稼働時間', value: formatUptime(process.uptime()), inline: true }, { name: `${memEmoji} メモリ`, value: `${usedMB}MB / ${MEMORY_LIMIT_MB}MB (${pct}%)`, inline: true }, { name: '\u200B', value: '\u200B', inline: true }, { name: '🎮 進行中', value: `${getPlayingGameCount()}試合`, inline: true }, { name: '🔍 募集中', value: `${getRecruitingGameCount()}試合`, inline: true }, { name: '📊 合計', value: `${getActiveGameCount()}試合`, inline: true }, { name: '🏢 サーバー', value: `CPU: ${os.cpus().length}Core / RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1000)}GB` } ).setFooter({ text: 'Hosted on Render | /games で詳細確認' }).setTimestamp() ]}); return;
                }
                case 'update': {
                    if (interaction.user.id !== DEVELOPER_ID) return interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
                    await interaction.reply({ content: '🚀 **アップデートを開始します...**' }); exec('./update.sh', async (err) => { if (err) await interaction.followUp(`❌ エラー:\n\`\`\`\n${err.message}\n\`\`\``); }); return;
                }
                case 'wild': return await wildCommand.execute(interaction as any);
                case 'box': return await boxCommand.execute(interaction as any);
                case 'party': return await partyCommand.execute(interaction as any);
                case 'info': return await infoCommand.execute(interaction as any);
                case 'shop': return await shopCommand.execute(interaction as any);
                case 'release': return await releaseCommand.execute(interaction as any);
                case 'battle': return await battleCommand.execute(interaction as any);
                case 'nickname': return await nicknameCommand.execute(interaction as any);
                case 'daily': return await dailyCommand.execute(interaction as any);
                case 'heal': return await healCommand.execute(interaction as any);
                case 'order': return await orderCommand.execute(interaction as any);
                case 'moves': return await movesCommand.execute(interaction as any);
                case 'trade': return await tradeCommand.execute(interaction as any);
                case 'gym': return await gymCommand.execute(interaction as any);
                case 'trainer': return await trainerCommand.execute(interaction as any);
                case 'use': return await useCommand.execute(interaction as any);
                case 'raid': return await raidCommand.execute(interaction as any);
                case 'department': return await departmentCommand.execute(interaction as any);
                case 'equip': return await equipCommand.execute(interaction as any);
                case 'penalty': {
                    await interaction.deferReply(); const targetUser = interaction.options.getUser('target'); const type = interaction.options.getString('type')!; const reason = interaction.options.getString('reason') ?? 'サーバー規約違反（トロール/ゴースト等）';
                    if (!targetUser) { await interaction.editReply('ユーザーが見つかりません。'); return; }
                    const res = await DB.applyPenalty(targetUser.id, targetUser.username, type, reason);
                    if (res.success) { await interaction.editReply({ embeds: [ new EmbedBuilder().setTitle('🚨 【運営制裁の執行】').setDescription(`**対象者:** ${targetUser}\n**内容:** ${res.message}\n**理由:** ${reason}`).setColor(0x000000) ]}); } else { await interaction.editReply(`❌ エラー: ${res.message}`); } return;
                }
                case 'preset': {
                    // 省略: preset処理
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

    // ── ボタン系の処理 ──
    if (interaction.isButton()) {

        // ── 通信交換のボタン ──
        if (interaction.customId.startsWith('tradebtn_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; // select, confirm, cancel
            const tradeId = parts.slice(2).join('_');
            await TradeLogic.handleTradeButton(interaction as any, tradeId, action);
            return;
        }

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

        // 🌟 レイド：バトル中の技選択・行動ボタン
        if (
            interaction.customId.startsWith('raid_act_') || 
            interaction.customId.startsWith('raid_usemove_') ||
            interaction.customId.startsWith('raid_cheer_') || 
            interaction.customId.startsWith('raid_usecheer_')
        ) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; // act, usemove, cheer, usecheer
            const raidId = parts[2];
            const args = parts.slice(3); // 技のインデックス番号など

            await handleRaidAction(interaction as any, raidId, action, args);
            return;
        }

        // 🌟 レイド：参加ボタン
        if (interaction.customId.startsWith('raid_join_')) {
            const raidId = interaction.customId.replace('raid_join_', '');
            const raidData = activeRaids.get(raidId);
            
            if (!raidData) return interaction.reply({ content: '❌ このレイドは既に終了したか、出発済みです。', ephemeral: true });
            if (raidData.participants.has(interaction.user.id)) return interaction.reply({ content: '⚠️ 既に参加しています！', ephemeral: true });
            if (raidData.participants.size >= 4) return interaction.reply({ content: '⚠️ 満員です！（最大4人）', ephemeral: true });

            raidData.participants.add(interaction.user.id);

            // 参加者リストを更新してメッセージを書き換える
            const participantText = Array.from(raidData.participants).map(id => `<@${id}>`).join('\n');
            const embed = EmbedBuilder.from(interaction.message.embeds[0]).setDescription(`強力なレイドボスが出現しました！みんなで協力して討伐しよう！\n\n**【参加者】**\n${participantText}`);
            
            await interaction.update({ embeds: [embed] });
            return;
        }

        // 🌟 レイド：出発ボタン
        if (interaction.customId.startsWith('raid_start_')) {
            const raidId = interaction.customId.replace('raid_start_', '');
            const raidData = activeRaids.get(raidId);
            
            if (!raidData) return interaction.reply({ content: '❌ このレイドは既に終了したか、出発済みです。', ephemeral: true });
            if (interaction.user.id !== raidData.hostId) return interaction.reply({ content: '⚠️ ホスト（募集者）のみが出発できます！', ephemeral: true });

            // 参加者全員のデータを読み込んでバトル画面へ！
            await startRaidBattle(interaction as any, raidId);
            return;
        }

        if (interaction.customId.startsWith('heal_')) {
            await interaction.deferUpdate();
            const action = interaction.customId.replace('heal_', ''); 

            // 手持ちのポケモンデータを取得
            const { data: party } = await PokeDB.supabase.from('poke_caught_pokemons')
                .select('*')
                .eq('owner_id', interaction.user.id)
                .eq('is_party', true);

            // 🌟 どちらの手段で回復しても、隠しチェーン(連戦ボーナス)をリセットする！
            hiddenWildChains.delete(interaction.user.id); // 👈 ここに追加！

            if (action === 'free') {
                // 🌟 無料全回復の処理
                await PokeDB.supabase.from('poke_users').update({ last_heal_at: new Date().toISOString() }).eq('discord_id', interaction.user.id);

                if (party) {
                    const updatePromises = party.map(async (poke) => {
                        let moves = typeof poke.moves === 'string' ? JSON.parse(poke.moves) : poke.moves;
                        if (Array.isArray(moves)) {
                            for (const m of moves) { if (m.maxPp) m.pp = m.maxPp; } // PP全回復
                        }
                        return PokeDB.supabase.from('poke_caught_pokemons').update({
                            current_hp: 9999,
                            status_condition: null, // 状態異常を治す
                            moves: moves
                        }).eq('id', poke.id);
                    });
                    await Promise.all(updatePromises);
                }
                await interaction.followUp({ content: '🎶 テレロレロレローン♪\n手持ちのポケモンが 全回復（HP/PP/状態異常）しました！', ephemeral: true });

            } else {
                // 🌟 回復アイテムの処理
                const itemId = action === 'potion' ? 'potion' : 'max_potion';
                const healAmount = action === 'potion' ? 50 : 9999;
                
                const { data: inv } = await PokeDB.supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', itemId).single();
                if (!inv || inv.quantity <= 0) return;
                await PokeDB.supabase.from('poke_inventory').update({ quantity: inv.quantity - 1 }).eq('user_id', interaction.user.id).eq('item_id', itemId);
                
                if (party) {
                    const updatePromises = party.map(async (poke) => {
                        let moves = typeof poke.moves === 'string' ? JSON.parse(poke.moves) : poke.moves;
                        if (healAmount === 9999 && Array.isArray(moves)) { // まんたんのくすりはPPも回復
                            for (const m of moves) { if (m.maxPp) m.pp = m.maxPp; }
                        }
                        return PokeDB.supabase.from('poke_caught_pokemons').update({
                            current_hp: poke.current_hp + healAmount,
                            status_condition: healAmount === 9999 ? null : poke.status_condition, // まんたんのくすりは状態異常も治す
                            moves: moves
                        }).eq('id', poke.id);
                    });
                    await Promise.all(updatePromises);
                }
                await interaction.followUp({ content: `✅ アイテムを使って 手持ちのポケモンを回復しました！`, ephemeral: true });
            }
            return;
        }


        if (interaction.customId.startsWith('nickbtn_')) {
            const dbId = interaction.customId.split('_')[1];
            const modal = new ModalBuilder().setCustomId(`modal_nick_${dbId}`).setTitle('ニックネームをつける');
            const nickInput = new TextInputBuilder().setCustomId('nickname_input').setLabel('新しいニックネーム（最大12文字）').setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true);
            modal.addComponents(new ActionRowBuilder<any>().addComponents(nickInput));
            await interaction.showModal(modal); 
            return;
        }

        if (interaction.customId.startsWith('battle_accept_') || interaction.customId.startsWith('battle_decline_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; 
            const challengerId = parts[2];
            const targetId = parts[3];
            if (interaction.user.id !== targetId) { await interaction.reply({ content: '❌ この挑戦状はあなた宛ではありません！', ephemeral: true }); return; }
            if (action === 'decline') { await interaction.update({ content: `💨 <@${targetId}> は 勝負から 逃げ出した！`, embeds: [], components: [] }); return; }
            if (action === 'accept') { await BattleLogic.startBattle(interaction as any, challengerId, targetId); return; }
        }

        // 📦 ボックスのページめくり処理
        if (interaction.customId.startsWith('box_page_')) {
            const page = parseInt(interaction.customId.split('_')[2], 10);
            await boxCommand.execute(interaction as any, page);
            return;
        }

        // 📊 infoコマンドのページング・戻るボタン（人狼の関所をスキップ）
        if (interaction.customId === 'back_to_list' ||
            interaction.customId === 'page_prev' ||
            interaction.customId === 'page_next') {
            return; // info.ts 内のコレクターが処理するのでここでは return のみ
        }

        if (interaction.customId.startsWith('btl_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; 
            const battleId = parts[2];
            await BattleLogic.handleBattleAction(interaction as any, battleId, action);
            return;
        }

    } // 👈 ！！！重要: isButton() のブロックをここで閉じる！！！


    // ── セレクトメニュー系の処理（ボール投擲・ロックなど） ──
    if (interaction.isStringSelectMenu()) {

        // 🌟 ここにお引越し！ ── ショップの購入処理 ──
        if (interaction.customId === 'shop_buy_select') {
            await interaction.deferUpdate();
            
            const value = interaction.values[0]; 
            const parts = value.split('_');
            const price = parseInt(parts.pop()!, 10);    
            const quantity = parseInt(parts.pop()!, 10); 
            const itemName = parts.join('_');            

            const { data: user } = await PokeDB.supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
            const currentMoney = user?.money || 0;

            if (currentMoney < price) {
                return interaction.followUp({ content: '❌ お金が足りません！', ephemeral: true });
            }

            const { data: inventory } = await PokeDB.supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', itemName).single();
            const currentQty = inventory ? inventory.quantity : 0;

            // がくしゅうそうちの重複購入チェック
            if (itemName === 'exp_share' && currentQty >= 1) {
                return interaction.followUp({ content: '⚠️ **がくしゅうそうち** は すでに 持っている！', ephemeral: true });
            }

            // お金の支払い
            const newMoney = currentMoney - price;
            await PokeDB.supabase.from('poke_users').update({ money: newMoney }).eq('discord_id', interaction.user.id);

            // アイテムの付与
            if (inventory) {
                await PokeDB.supabase.from('poke_inventory').update({ quantity: currentQty + quantity }).eq('user_id', interaction.user.id).eq('item_id', itemName);
            } else {
                await PokeDB.supabase.from('poke_inventory').insert([{ user_id: interaction.user.id, item_id: itemName, quantity: quantity }]);
            }

            const jpNames: Record<string, string> = { 
    'monster_ball': 'モンスターボール', 'super_ball': 'スーパーボール', 'hyper_ball': 'ハイパーボール', 'potion': 'きずぐすり', 'max_potion': 'まんたんのくすり', 'exp_share': 'がくしゅうそうち',
    'item_hp_up': 'マックスアップ', 'item_protein': 'タウリン', 'item_iron': 'ブロムヘキシン', 'item_calcium': 'リゾチウム', 'item_zinc': 'キトサン', 'item_carbos': 'インドメタシン',
    'item_reset_mochi': 'まっさらもち',
    'mint_adamant': 'いじっぱりミント', 'mint_modest': 'ひかえめミント', 'mint_jolly': 'ようきミント', 'mint_timid': 'おくびょうミント', 'mint_bold': 'ずぶといミント', 'mint_calm': 'おだやかミント',    'leftovers': 'たべのこし', 'life_orb': 'いのちのたま', 'choice_band': 'こだわりハチマキ', 'rusted_sword': 'くちたけん'
};
const displayName = jpNames[itemName] || itemName;

            // 🌟 追加：購入成功メッセージを送信
            await interaction.followUp({ 
                content: `✅ **${displayName}** を **${quantity}個** 購入しました！\n（支払い: **${price}円** / 残金: **${newMoney}円**）`, 
                ephemeral: true 
            });

            // 🌟 追加：元のメッセージ（ショップ画面）のセレクトメニューの選択を解除する
            const originalMessage = await interaction.message.fetch();
            if (originalMessage && originalMessage.components.length > 0) {
                // 👇 TypeScriptの型エラーを回避するために `as any` をつけます
                const actionRow = originalMessage.components[0] as any;
                const oldSelect = actionRow.components[0];
                
                if (oldSelect.type === 3) { // StringSelectMenu
                    const newSelect = new StringSelectMenuBuilder()
                        .setCustomId(oldSelect.customId)
                        .setPlaceholder('アイテムを選択してください')
                        .addOptions(oldSelect.options.map((opt: any) => ({ // 👈 ここにも any を追加
                            label: opt.label,
                            value: opt.value,
                            description: opt.description || undefined
                        })));

                    const newRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(newSelect);
                    
                    // 選択を解除した新しいメニューで上書き
                    await interaction.editReply({ components: [newRow] }).catch(() => {});
                }
            }

            return;
        }

        // 🌿 バトル中のセレクトメニュー（技選択・ボール投げ）は battleLogic に丸投げ
        if (interaction.customId.startsWith('btl_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; // 'throw' など
            const battleId = parts[2];
            await BattleLogic.handleBattleAction(interaction as any, battleId, action);
            return;
        }

        // ── 通信交換のセレクトメニュー ──
        if (interaction.customId.startsWith('tradesel_')) {
            const tradeId = interaction.customId.replace('tradesel_poke_', '');
            await TradeLogic.handleTradeSelect(interaction as any, tradeId);
            return;
        }

    // ── 🥈 銀の王冠のステータス選択処理 ──
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_iv_max_')) {
        await interaction.deferUpdate();
        const pokeId = interaction.customId.split('_')[3];
        const targetStat = interaction.values[0]; 
        const statNameMap: Record<string, string> = { iv_hp: 'HP', iv_attack: '攻撃', iv_defense: '防御', iv_sp_atk: '特攻', iv_sp_def: '特防', iv_speed: '素早さ' };

        // 🌟 対象の個体値がすでに最大かどうかチェック
        const { data: targetPoke } = await PokeDB.supabase.from('poke_caught_pokemons').select('*').eq('id', pokeId).single();
        if (!targetPoke) return interaction.editReply({ content: '❌ ポケモンが見つかりません。', components: [] });

        if (targetPoke[targetStat] >= 31) {
            return interaction.editReply({ content: `⚠️ **${targetPoke.nickname}** の **${statNameMap[targetStat]}** は すでに さいこうの 状態です！\n（※アイテムは消費されませんでした）`, components: [] });
        }

        // 1. ポケモンの個体値を31に更新
        await PokeDB.supabase.from('poke_caught_pokemons').update({ [targetStat]: 31 }).eq('id', pokeId);
        
        // 2. アイテムを1個減らす（ここで初めて消費する）
        const { data: inv } = await PokeDB.supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', 'item_silver_crown').single();
        if (inv && inv.quantity > 0) {
            await PokeDB.supabase.from('poke_inventory').update({ quantity: inv.quantity - 1 }).eq('user_id', interaction.user.id).eq('item_id', 'item_silver_crown');
        }

        await interaction.editReply({ 
            content: `🥈 すごいとっくんが 終わった！\n**${targetPoke.nickname}** の **${statNameMap[targetStat]}** の 才能が 最大になった！✨`, 
            components: [] 
        });
        return;
    }


        // 👇 既存の関所パスリストにも念のため追加
        const bypass = [
            'party_select', 'release_select', 'nickname_rename_select', 
            'order_select', 'info_select', 'moves_poke_select', 'moves_select',
            'shop_buy_select',
            'use_item_select', 'use_poke_select',
            'select_iv_max', 'tm_forget_select', 'equip_poke_select', 'equip_item_select' // 👈 追加
        ];
        if (bypass.includes(interaction.customId)) return;
    }

    // ── モーダル系の処理 ──
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('modal_nick_')) {
            const dbId = interaction.customId.split('_')[2];
            const newNick = interaction.fields.getTextInputValue('nickname_input');
            await PokeDB.supabase.from('poke_caught_pokemons').update({ nickname: newNick }).eq('id', dbId);
            await interaction.reply({ content: `✅ ニックネームを **${newNick}** に変更しました！\n（※反映には \`/party\` などの再設定が必要な場合があります）`, ephemeral: true });
            return;
        }
    }

    // ── 人狼の関所処理 ──
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
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
    }

    await GameLogic.handleInteraction(interaction).catch(e => console.error('Interaction Error:', e.message));
});

console.log("🚀 ボットを起動中...");
client.login(process.env.DISCORD_TOKEN).catch(console.error);