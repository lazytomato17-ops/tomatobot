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
    ActivityType, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle 
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
import { rankCommand } from './commands/rank';
import * as BattleLogic from './battleLogic';
import * as PokeDB from './pokeDb';

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
        wildCommand.data, boxCommand.data, partyCommand.data, infoCommand.data, shopCommand.data, releaseCommand.data, battleCommand.data, nicknameCommand.data, dailyCommand.data, healCommand.data, rankCommand.data,
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
                case 'rank': return await rankCommand.execute(interaction as any);
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

        if (interaction.customId.startsWith('buy_')) {
            // ✅ 修正：アンダースコアが何個あっても、一番最後を「値段」として正しく抜き出す
            const parts = interaction.customId.split('_');
            const priceStr = parts.pop()!; // 一番最後を取り出す（例: '200'）
            parts.shift(); // 最初の 'buy' を捨てる
            const itemName = parts.join('_'); // 残りをくっつける（例: 'monster_ball'）
            const price = parseInt(priceStr, 10);

            await interaction.deferUpdate();

            const { data: user } = await PokeDB.supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
            
            // ✅ バグで所持金が NaN(無効な数値) になってしまったユーザーの応急処置
            let currentMoney = (user?.money != null && !isNaN(user.money)) ? user.money : 0;
            
            if (currentMoney < price) {
                await interaction.followUp({ content: '❌ お金が足りません！', ephemeral: true });
                return;
            }

            // お金を減らしてアイテムを増やす
            const newMoney = currentMoney - price;
            await PokeDB.supabase.from('poke_users').update({ money: newMoney }).eq('discord_id', interaction.user.id);
            
            // アイテムの存在確認をしてUPSERT
            const { data: inventory } = await PokeDB.supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', itemName).single();
            const currentQty = inventory ? inventory.quantity : 0;
            
            await PokeDB.supabase.from('poke_inventory').upsert({
                user_id: interaction.user.id,
                item_id: itemName,
                quantity: currentQty + 1
            }, { onConflict: 'user_id, item_id' });

            await interaction.followUp({ content: `✅ **${itemName}** を購入しました！ (残り **${newMoney}** 円)`, ephemeral: true });
            return;
        }

        if (interaction.customId.startsWith('heal_')) {
            await interaction.deferUpdate();
            const action = interaction.customId.replace('heal_', ''); 
            if (action === 'free') {
                await PokeDB.supabase.from('poke_users').update({ last_heal_at: new Date().toISOString() }).eq('discord_id', interaction.user.id);
                await PokeDB.supabase.from('poke_caught_pokemons').update({ current_hp: 9999 }).eq('owner_id', interaction.user.id).eq('is_party', true);
                await interaction.followUp({ content: '🎶 テレロレロレローン♪\n手持ちのポケモンが 全回復しました！', ephemeral: true });
            } else {
                const itemId = action === 'potion' ? 'potion' : 'max_potion';
                const healAmount = action === 'potion' ? 50 : 9999;
                const { data: inv } = await PokeDB.supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', itemId).single();
                if (!inv || inv.quantity <= 0) return;
                await PokeDB.supabase.from('poke_inventory').update({ quantity: inv.quantity - 1 }).eq('user_id', interaction.user.id).eq('item_id', itemId);
                const { data: party } = await PokeDB.supabase.from('poke_caught_pokemons').select('id, current_hp').eq('owner_id', interaction.user.id).eq('is_party', true);
                if (party) { for (const p of party) { await PokeDB.supabase.from('poke_caught_pokemons').update({ current_hp: p.current_hp + healAmount }).eq('id', p.id); } }
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

        // 🌿 バトル中のセレクトメニュー（技選択・ボール投げ）は battleLogic に丸投げ
        if (interaction.customId.startsWith('btl_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1]; // 'throw' など
            const battleId = parts[2];
            await BattleLogic.handleBattleAction(interaction as any, battleId, action);
            return;
        }

        // 🔒 ボックスのロック切替
        if (interaction.customId === 'box_lock_toggle') {
            await interaction.deferUpdate();
            const pokeId = interaction.values[0];
            const { data: poke } = await PokeDB.supabase.from('poke_caught_pokemons').select('is_locked, nickname').eq('id', pokeId).single();
            if (poke) {
                const newLock = !poke.is_locked;
                await PokeDB.supabase.from('poke_caught_pokemons').update({ is_locked: newLock }).eq('id', pokeId);
                await interaction.followUp({ content: `✅ **${poke.nickname}** を ${newLock ? 'ロック🔒' : 'ロック解除🔓'} しました！`, ephemeral: true });
            }
            return;
        }

        // 👇 既存のポケモンセレクトメニューはここで関所をパスさせる
        const bypass = ['party_select', 'release_select', 'nickname_rename_select', 'order_select', 'info_select'];
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
