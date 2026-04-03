// src/gameLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits, TextChannel } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();
import * as Messages from './messages';
import * as DB from './db'; 
import * as Phases from './phase';
import { getGame, initGame, resetGame, findGameByUserId, moveGameChannel } from './state'; 
import { generateGameSummary } from './aiUtils'; 
import * as NPC from './npcLogic'; 
import { GameState, Player } from './types';
import * as Roles from './roles';

const PERSONALITIES = ['aggressive', 'cautious', 'logical', 'normal', 'witty', 'joker', 'gal', 'serious'];

const activeInteractions = new Set<string>();

const verifiedDmUsers = new Set<string>();

export async function handleInteraction(interaction: any) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    
    // 【連打対策バリア】
    const lockKey = `${interaction.user.id}_${interaction.customId}`;
    if (activeInteractions.has(lockKey)) {
        return; 
    }
    activeInteractions.add(lockKey);
    setTimeout(() => activeInteractions.delete(lockKey), 1000); 

    const ignoreIds = ['vote_', 'thief_', 'divine_', 'strategy_', 'fakeresult_', 'guard_', 'kill_', 'sorcery_', 'devotee_', 'god_', 'dictator_'];
    if (ignoreIds.some(id => interaction.customId.startsWith(id))) {
        return; 
    }
    
    let game;
    if (!interaction.guildId) {
        game = findGameByUserId(interaction.user.id);
        if (!game) return; 
    } else {
        game = getGame(interaction.channel.id);
        
        if (!game.channel && interaction.channel) {
            game.channel = interaction.channel;
        }
        if (!game.hostId) {
            game.hostId = interaction.user.id; 
        }
    }
        const allowedWhenIdle = ['game_rematch', 'game_ai_analyze', 'select_profile_color', 'select_profile_title'];
        if (game.state === 'idle' && !allowedWhenIdle.includes(interaction.customId) && !interaction.customId.startsWith('shop_buy_')) {
            return;
        }
        try {
            if (interaction.customId.startsWith('bet_')) {
            const player = game.players.find((p: Player) => p.id === interaction.user.id);
            if (!player) return interaction.reply({ content: 'エラー: プレイヤー情報なし', ephemeral: true });
            if (player.alive) return interaction.reply({ content: '生きてる人は賭けられません！', ephemeral: true });
            if (player.ghostBet) return interaction.reply({ content: '既に賭けています。', ephemeral: true });

            if (player.betDeadline && Date.now() > player.betDeadline) {
                return interaction.reply({ content: '⏰ **賭けの受付時間は終了しました。**\n(死亡から90秒以内に投票する必要があります)', ephemeral: true });
            }

            const betType = interaction.customId.replace('bet_', '');
            if (betType === 'villager') player.ghostBet = 'villager';
            else if (betType === 'wolf') player.ghostBet = 'wolf';
            else player.ghostBet = 'other';
            
            const teamName = betType === 'villager' ? '村人陣営' : (betType === 'wolf' ? '人狼陣営' : '第三陣営');
            await interaction.reply({ content: `👻 **${teamName}** に魂を賭けました！的中すればボーナス！`, ephemeral: true });
            return;
        }

        if (interaction.customId === 'game_force_reset') {
            resetGame(interaction.channel.id, true);
            await interaction.reply({ content: '🔄 強制リセットしました。', ephemeral: false });
            return;
        }
        
        if (interaction.customId === 'game_rematch') {
            if (!game || !game.players || game.players.length === 0) {
                return interaction.reply({ 
                    content: '🔄 **Botの再起動（または更新）が行われたため、前回のデータがリセットされました！**\nお手数ですが、`/jinro` コマンドで新しく村を建て直してください', 
                    ephemeral: true 
                });
            }
            resetGame(interaction.channel.id, false);
            await interaction.reply({ content: '🔄 再戦準備中...', ephemeral: true });
            
            if (game.channel) {
                const payload = await Messages.getLobbyPayload(game, game.hostId, interaction.member);
                const lobbyMsg = await game.channel.send(payload);
                game.lobbyMessage = lobbyMsg;
            }
            return;
        }

        if (interaction.customId === 'game_ai_analyze') {
            await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
            await interaction.deferReply({ ephemeral: false }); 
            try {
                const summary = await generateGameSummary(game.chatLog, game.players, game.winnerTeam || "不明");
                const safeSummary = summary.length > 1950 ? summary.substring(0, 1950) + "...\n(文字数制限のため省略)" : summary;
                await interaction.editReply({ content: `🤖 **AI戦況分析**\n${safeSummary}` });
            } catch (e) {
                console.error(e);
                await interaction.editReply({ content: "解析に失敗しました。" });
            }
            return;
        }

        if (interaction.customId.startsWith('medium_publish_')) {
            if (game.state !== 'playing') return interaction.reply({ content: '⚠️ 現在ゲームは進行していません。', ephemeral: true });
            const currentPlayer = game.players.find((p: Player) => p.id === interaction.user.id);
            if (!currentPlayer || currentPlayer.role !== '霊能者') return interaction.reply({ content: '⚠️ あなたは現在のゲームの霊能者ではありません。', ephemeral: true });

            const dataStr = interaction.customId.replace('medium_publish_', '');
            const lastUnderscore = dataStr.lastIndexOf('_');
            const targetId = dataStr.substring(0, lastUnderscore);
            const executedRole = dataStr.substring(lastUnderscore + 1); 
            
            const targetPlayer = game.players.find((p: Player) => p.id === targetId);
            const targetName = targetPlayer ? targetPlayer.name : "不明なプレイヤー";

            await interaction.message.edit({ components: [] });
            await interaction.reply({ content: '📢 公表しました。', ephemeral: true });
            
            if (game.channel) {
                const medEmbed = new EmbedBuilder()
                    .setTitle('👻 霊能結果')
                    .setDescription(`**${interaction.user.username}**: 「${targetName} は **【${executedRole}】** だ…」`)
                    .setColor(0x3498DB);
                await game.channel.send({ embeds: [medEmbed] });
                
                game.chatLog.push({ id: interaction.user.id, name: interaction.user.username, content: `霊媒結果: ${targetName} は ${executedRole}`, day: game.dayCount });
                if (!game.evidence) game.evidence = [];
                game.evidence.push({ type: 'medium_co', day: game.dayCount, from: interaction.user.id, target: targetId, result: executedRole === '人狼', visible: true });
            }
            return;
        }

if (interaction.customId.startsWith('fakemedium_')) {
            if (game.state !== 'playing') return interaction.reply({ content: '⚠️ 現在ゲームは進行していません。', ephemeral: true });
            const currentPlayer = game.players.find((p: Player) => p.id === interaction.user.id);
            
            if (!currentPlayer || !currentPlayer.alive || !['狂人', '狂信者', '人狼', '妖狐', 'テルテル', '妖術師'].includes(currentPlayer.role)) {
                await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
                return interaction.reply({ content: '⚠️ 権限エラー：このボタンは過去の試合のものです。', ephemeral: true });
            }
            
            const alreadyDivining = game.actions?.some((a: any) => a.from === currentPlayer.id && a.type === 'divine') || 
                                    game.evidence?.some((e: any) => e.from === currentPlayer.id && e.type === 'divine');
            const alreadyCoroner = game.evidence?.some((e: any) => e.from === currentPlayer.id && e.type === 'coroner_co');

            if (alreadyDivining || alreadyCoroner) {
                await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
                return interaction.reply({ content: '⚠️ 既に別の役職（占い師や検死官）として行動しているため、霊能者を騙ることはできません！', ephemeral: true });
            }

            const isBlack = interaction.customId.includes('_black_');
            const executedId = interaction.customId.split('_').pop();
            const targetPlayer = game.players.find((p: Player) => p.id === executedId);
            const targetName = targetPlayer ? targetPlayer.name : "不明なプレイヤー";
            const reportedRole = isBlack ? '人狼' : '人間';

            await interaction.message.edit({ components: [] });
            await interaction.reply({ content: '📢 偽の霊能結果を公表しました。', ephemeral: true });
            
            if (game.channel) {
                const medEmbed = new EmbedBuilder()
                    .setTitle('👻 霊能結果')
                    .setDescription(`**${currentPlayer.name}**: 「${targetName} は **【${reportedRole}】** だ…」`)
                    .setColor(0x3498DB);
                await game.channel.send({ embeds: [medEmbed] });
                
                if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: currentPlayer.id, name: currentPlayer.name, content: `霊媒結果: ${targetName} は ${reportedRole}`, day: game.dayCount });
                
                if (!game.evidence) game.evidence = [];
                game.evidence.push({ type: 'medium_co', day: game.dayCount, from: currentPlayer.id, target: executedId, result: isBlack, visible: true });
            }
            return;
        }

        if (interaction.customId === 'coroner_publish') {
            if (game.state !== 'playing') return interaction.reply({ content: '⚠️ 現在ゲームは進行していません。', ephemeral: true });
            const currentPlayer = game.players.find((p: Player) => p.id === interaction.user.id);
            if (!currentPlayer || currentPlayer.role !== '検死官') return interaction.reply({ content: '⚠️ あなたは検死官ではありません。', ephemeral: true });

            await interaction.message.edit({ components: [] });
            await interaction.reply({ content: '📢 検死結果を公表しました。', ephemeral: true });
            
             if (game.channel && game.coronerReport) {
                const embed = new EmbedBuilder()
                    .setTitle('🔍 検死官の報告')
                    .setDescription(`**${currentPlayer.name}**: 「死者たちの本当の役職が判明した…！」\n\n${game.coronerReport}`)
                    .setColor(0x9B59B6);
                await game.channel.send({ embeds: [embed] });
                 if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: currentPlayer.id, name: currentPlayer.name, content: `検死結果公表`, day: game.dayCount });
                if (!game.evidence) game.evidence = [];
                game.evidence.push({ type: 'coroner_co', day: game.dayCount, from: currentPlayer.id, target: 'all', result: true, visible: true });
            }
            return;
        }

if (interaction.customId === 'fakecoroner_open_modal') {
            if (game.state !== 'playing') return interaction.reply({ content: '⚠️ 現在ゲームは進行していません。', ephemeral: true });
            
            const currentPlayer = game.players.find((p: Player) => p.id === interaction.user.id);
            if (!currentPlayer || !currentPlayer.alive || !['狂人', '狂信者', '人狼', '妖狐', 'テルテル', '妖術師'].includes(currentPlayer.role)) {
                await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
                return interaction.reply({ content: '⚠️ 権限エラー：このボタンは過去の試合のものです。', ephemeral: true });
            }

            const alreadyDivining = game.actions?.some((a: any) => a.from === currentPlayer.id && a.type === 'divine') || 
                                    game.evidence?.some((e: any) => e.from === currentPlayer.id && e.type === 'divine');
            const alreadyMedium = game.evidence?.some((e: any) => e.from === currentPlayer.id && e.type === 'medium_co');

            if (alreadyDivining || alreadyMedium) {
                await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
                return interaction.reply({ content: '⚠️ 既に別の役職（占い師や霊能者）として行動しているため、検死官を騙ることはできません！', ephemeral: true });
            }

            const deadPlayers = game.players.filter((p: Player) => !p.alive);
            if(deadPlayers.length === 0) return interaction.reply({ content: '死者がいません。', ephemeral: true });

            const modal = new ModalBuilder().setCustomId('fakecoroner_modal').setTitle('🔍 偽の検死レポート作成');
            const targets = deadPlayers.slice(0, 5); 

            targets.forEach((dead: any, i: number) => {
                const textInput = new TextInputBuilder()
                    .setCustomId(`fake_role_${i}`)
                    .setLabel(`${dead.name} の偽役職 (例: 村人, 占い師)`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
            });
            await interaction.showModal(modal);
            return;
        }

if (interaction.isModalSubmit() && interaction.customId === 'fakecoroner_modal') {
            if (game.state !== 'playing') return interaction.reply({ content: '⚠️ 現在ゲームは進行していません。', ephemeral: true });
            
            const currentPlayer = game.players.find((p: Player) => p.id === interaction.user.id);
            if (!currentPlayer || !currentPlayer.alive || !['狂人', '狂信者', '人狼', '妖狐', 'テルテル', '妖術師'].includes(currentPlayer.role)) {
                return interaction.reply({ content: '⚠️ 権限エラー：このアクションは現在実行できません。', ephemeral: true });
            }

            const deadPlayers = game.players.filter((p: Player) => !p.alive);
            const targets = deadPlayers.slice(0, 5);

            let fakeReport = "🔍 **検死レポート**\n昨晩の死者の正体は以下の通りです：\n";
            targets.forEach((dead: any, i: number) => {
                const inputRole = interaction.fields.getTextInputValue(`fake_role_${i}`);
                const safeRole = inputRole.replace(/[【】\[\]\s]/g, ''); 
                fakeReport += `▪ ${dead.name} ➔ **【${safeRole}】**\n`; 
            });

            await interaction.message.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
            await interaction.reply({ content: '📢 指定した役職で、完璧な偽の検死結果を公表しました。', ephemeral: true });
            
            if (game.channel) {
                const embed = new EmbedBuilder()
                    .setTitle('🔍 検死官の報告')
                    .setDescription(`**${currentPlayer.name}**: 「死者たちの本当の役職が判明した…！」\n\n${fakeReport}`)
                    .setColor(0x9B59B6);
                await game.channel.send({ embeds: [embed] });
                if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: currentPlayer.id, name: currentPlayer.name, content: `検死結果公表`, day: game.dayCount });
                if (!game.evidence) game.evidence = [];
                game.evidence.push({ type: 'coroner_co', day: game.dayCount, from: currentPlayer.id, target: 'all', result: false, visible: true });
            }
            return;
        }

        if (interaction.customId === 'cupid_select') {
            const selectedIds = interaction.values;
            if (selectedIds.length !== 2) return interaction.reply({ content: '2人選んでください。', ephemeral: true });
            game.lovers = selectedIds; 

            const p1 = game.players.find((p: Player) => p.id === selectedIds[0]);
            const p2 = game.players.find((p: Player) => p.id === selectedIds[1]);

            if (!p1 || !p2) {
                return interaction.reply({ content: 'プレイヤーが見つかりませんでした。', ephemeral: true });
            }

            if(!p1.isNpc) p1.user?.send(`💘 恋人に選ばれました！相手: ${p2.name}`).catch(e => console.error('Silent Error:', e.message));
            if(!p2.isNpc) p2.user?.send(`💘 恋人に選ばれました！相手: ${p1.name}`).catch(e => console.error('Silent Error:', e.message));
            
            await interaction.update({ content: `💘 **カップル成立**: ${p1.name} と ${p2.name}`, components: [] });
            return;
        }

        if (game.state === 'recruiting') {
            const updatePublicLobby = async () => {
                if (game.lobbyMessage) await game.lobbyMessage.edit(await Messages.getLobbyPayload(game, game.hostId, interaction.member)).catch(e => console.error('Silent Error:', e.message));
            };

            const hostOnlyActions = [
                'open_settings', 'setting_roles', 'setting_wolves', 
                'setting_time', 'setting_advanced', 'setting_back', 
                'game_start', 'lobby_cancel', 'lobby_preset',
                'npc_add', 'npc_remove', 'setting_vote_transparency',
                'setting_tie_vote', 'setting_continuous_guard',
                'setting_first_night', 'setting_match_type'
            ];

            if (hostOnlyActions.includes(interaction.customId)) {
                if (interaction.user.id !== game.hostId) {
                    return interaction.reply({ 
                        content: `⚠️ **権限がありません！**\n設定変更やNPCの操作は、募集者（ホスト）のみが行えます。`, 
                        ephemeral: true 
                    });
                }
            }
            
            if (interaction.customId.startsWith('lobby_preset')) {
                const preset = interaction.values[0];
                let targetTotal = 0;

                if (preset.startsWith('load_preset_')) {
                    const presetName = preset.replace('load_preset_', '');
                    const userPresets = await DB.getPresets(interaction.user.id);
                    const targetPreset = userPresets.find(p => p.name === presetName);
                    if (targetPreset) {
                        game.settings = targetPreset.settings;
                        
                        const s = targetPreset.settings;
                        const roleCount = s.roles ? s.roles.length : 1;
                        const wolfCount = s.wolfMode === 'auto' ? 1 : (typeof s.wolfMode === 'number' ? s.wolfMode : 1);
                        const extraMasons = s.roles && s.roles.includes('freemason') ? 1 : 0;
                        
                        targetTotal = s.playerCount ?? (roleCount + extraMasons + wolfCount + 1);
                        if (targetTotal < 4) targetTotal = 4;
                    }
                } else if (preset === 'preset_standard') {
                    game.settings.roles = ['seer'];
                    game.settings.wolfMode = 'auto';
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                    game.settings.voteTransparency = 'public';
                    game.settings.firstNightPeace = false;
                    game.settings.matchType = 'casual';
                    targetTotal = 0;
                } else if (preset === 'preset_ranked_5') {
                    game.settings.roles = ['seer', 'madman'];
                    game.settings.wolfMode = 1; 
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                    game.settings.voteTransparency = 'public';
                    game.settings.firstNightPeace = true; // 競技ルール：初日襲撃なし
                    game.settings.matchType = 'ranked';
                    targetTotal = 5;
                } else if (preset === 'preset_ranked_7') {
                    game.settings.roles = ['seer', 'guard']; // 霊能なし
                    game.settings.wolfMode = 2; // 2狼
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                    game.settings.voteTransparency = 'public';
                    game.settings.firstNightPeace = true;
                    game.settings.matchType = 'ranked';
                    targetTotal = 7;
                } else if (preset === 'preset_ranked_9') {
                    game.settings.roles = ['seer', 'medium', 'guard', 'madman'];
                    game.settings.wolfMode = 2; 
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                    game.settings.voteTransparency = 'public';
                    game.settings.firstNightPeace = true;
                    game.settings.matchType = 'ranked';
                    targetTotal = 9;
                } else if (preset === 'preset_ranked_13') {
                    game.settings.roles = ['seer', 'medium', 'guard', 'madman', 'freemason'];
                    game.settings.wolfMode = 3; // 3狼
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                    game.settings.voteTransparency = 'public';
                    game.settings.firstNightPeace = true;
                    game.settings.matchType = 'ranked';
                    targetTotal = 13;
                }

                const presetLabelMap: Record<string, string> = {
                    'preset_standard':     '【スタンダード】',
                    'preset_ranked_5':     '【5人村】狂人の騙り合い',
                    'preset_ranked_7':     '【7人村】2狼の脅威',
                    'preset_ranked_9':     '【9人村】ランクマッチ標準',
                    'preset_ranked_13':    '【13人村】共有者の導き',
                };

                (game as any).currentPresetName = presetLabelMap[preset] ?? null;

                if (targetTotal > 0) {
                    const currentHumans = game.players.filter((p: Player) => !p.isNpc).length;
                    game.npcCount = Math.max(0, targetTotal - currentHumans);
                }
                
                await interaction.update(await Messages.getLobbyPayload(game, game.hostId, interaction.member));
                return;
            }

            if (interaction.customId === 'lobby_cancel') {
                resetGame(interaction.channel.id, true);
                if (game.lobbyMessage) await game.lobbyMessage.delete().catch(e => console.error('Silent Error:', e.message));
                await interaction.reply({ content: '🚫 募集を中止しました。', ephemeral: false });
                return;
            }
            
            if (interaction.customId === 'join_leave') {
                const idx = game.players.findIndex((p: Player) => p.id === interaction.user.id);
                
                if (idx === -1) {
                    const existingGame = findGameByUserId(interaction.user.id);
                    if (existingGame && existingGame.channel?.id !== game.channel?.id) {
                        return interaction.reply({ 
                            content: `⚠️ あなたは既に別の村（<#${existingGame.channel?.id}>）に参加しています。\nあちらの村を退出するか、ゲームが終了してから参加してください。`, 
                            flags: ['Ephemeral'] 
                        });
                    }
                    if (game.players.length + game.npcCount >= 15) return interaction.reply({ content: '⚠️ 参加人数の上限に達しています。', flags: ['Ephemeral'] });

                    if (!verifiedDmUsers.has(interaction.user.id)) {
                        try {
                            const testMsg = await interaction.user.send('🔗 接続テスト中...');
                            await testMsg.delete().catch(() => {});
                            
                            verifiedDmUsers.add(interaction.user.id);
                        } catch (error) {
                            return interaction.reply({ content: '⚠️ **参加エラー：DMが送信できませんでした！**\n当ゲームは役職通知にDMを使用するため、サーバー設定からDMの受信許可をお願いします。', flags: ['Ephemeral'] });
                        }
                    }

                    game.players.push({ id: interaction.user.id, user: interaction.user, name: interaction.user.username, isNpc: false });

                    const presets = await DB.getPresets(interaction.user.id);
                    const profile = presets.find((p: Player) => p.name === '__profile__');
                    if (profile && profile.settings && profile.settings.entry_effect_charges > 0) {
                        profile.settings.entry_effect_charges -= 1;
                        await DB.saveProfileSetting(interaction.user.id, 'entry_effect_charges', profile.settings.entry_effect_charges);
                        
                        const effectEmbed = new EmbedBuilder()
                            .setDescription(`🔥 **地鳴りと共に、猛者 [${interaction.user.username}] がロビーに降臨した...！！**`)
                            .setColor(0xFF4500);
                        if (game.channel) await game.channel.send({ embeds: [effectEmbed] });
                    }

                } else {
                    game.players.splice(idx, 1);
                }
                
                await interaction.update(await Messages.getLobbyPayload(game, game.hostId, interaction.member));
                return;
            }

            if (interaction.customId.startsWith('tab_')) {
                game.settingsTab = interaction.customId.replace('tab_', '');
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) });
                return;
            }

            if (interaction.customId === 'setting_match_type') { 
                game.settings.matchType = interaction.values[0]; 
                
                if (game.settings.matchType === 'ranked') {
                    const banned = ['teruteru', 'cupid', 'cat', 'thief', 'sorcerer', 'baker'];
                    game.settings.roles = game.settings.roles.filter((r: string) => !banned.includes(r));
                    if (game.settings.roles.length === 0) game.settings.roles = ['seer'];
                }
                
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); 
                await updatePublicLobby(); 
                return; 
            }
            if (interaction.customId === 'setting_vote_transparency') { game.settings.voteTransparency = interaction.values[0]; const isPremium = await DB.isPremiumUser(interaction.user.id); await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); await updatePublicLobby(); return; }
            if (interaction.customId === 'setting_tie_vote') { game.settings.tieVoteHandling = interaction.values[0]; const isPremium = await DB.isPremiumUser(interaction.user.id); await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); await updatePublicLobby(); return; }
            if (interaction.customId === 'setting_continuous_guard') { game.settings.continuousGuard = interaction.values[0] === 'true'; const isPremium = await DB.isPremiumUser(interaction.user.id); await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); await updatePublicLobby(); return; }
            if (interaction.customId === 'setting_first_night') { game.settings.firstNightPeace = interaction.values[0] === 'true'; const isPremium = await DB.isPremiumUser(interaction.user.id); await interaction.update({ components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); await updatePublicLobby(); return; }

            if (interaction.customId === 'npc_add') { 
                if (game.players.length + game.npcCount >= 15) return interaction.reply({ content: '⚠️ 人数上限に達しています。', ephemeral: true });
                game.npcCount++; 
                await interaction.update(await Messages.getLobbyPayload(game, game.hostId, interaction.member)); 
                return; 
            }
            if (interaction.customId === 'npc_remove') { if (game.npcCount > 0) game.npcCount--; 
                await interaction.update(await Messages.getLobbyPayload(game, game.hostId, interaction.member)); 
                return; 
            }
            
            if (interaction.customId === 'open_settings') { 
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.reply({ content: '🛠️ **ゲーム設定メニュー**\n変更すると、自動で募集画面にも反映されます。', components: Messages.getSettingsComponents(game.settings, game.settingsTab || 'basic', isPremium), ephemeral: true }); 
                return; 
            }
            if (interaction.customId === 'setting_roles') { 
                game.settings.roles = interaction.values; 
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ content: `🛠️ **ゲーム設定メニュー**\n✅ 役職を更新しました！`, components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); 
                await updatePublicLobby(); return; 
            }
            if (interaction.customId === 'setting_wolves') { 
                const val = interaction.values[0]; game.settings.wolfMode = val === 'auto' ? 'auto' : parseInt(val); 
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ content: `🛠️ **ゲーム設定メニュー**\n✅ 人狼の数を更新しました！`, components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); 
                await updatePublicLobby(); return; 
            }
            if (interaction.customId === 'setting_time') { 
                game.settings.discussionTime = parseInt(interaction.values[0]); 
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ content: `🛠️ **ゲーム設定メニュー**\n✅ 議論時間を更新しました！`, components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); 
                await updatePublicLobby(); return; 
            }
            if (interaction.customId === 'setting_advanced') { 
                const vals = interaction.values; game.settings.autoFinishVoting = vals.includes('autofinish'); game.settings.gayaMode = vals.includes('gaya'); game.settings.willMode = vals.includes('will'); game.settings.loquaciousMode = vals.includes('loquacious');
                const isPremium = await DB.isPremiumUser(interaction.user.id);
                await interaction.update({ content: `🛠️ **ゲーム設定メニュー**\n✅ 詳細ルールを更新しました！`, components: Messages.getSettingsComponents(game.settings, game.settingsTab, isPremium) }); 
                await updatePublicLobby(); return; 
            }
            
            if (interaction.customId === 'setting_back') {
                await interaction.update({ content: '✅ 設定を完了しました。(このメッセージは消去して構いません)', components: [] });
                return;
            }
            
            if (interaction.customId === 'game_start') {
                const total = game.players.length + game.npcCount;
                if (total < 4) return interaction.reply({ content: '⚠️ 人数不足です (最低4人)。', ephemeral: true });
                
                let wolfCount = game.settings.wolfMode === 'auto' ? (total >= 9 ? 3 : (total >= 6 ? 2 : 1)) : game.settings.wolfMode;
                if (wolfCount >= total / 2) wolfCount = Math.floor((total - 1) / 2) || 1;
                
                let requiredRolesCount = wolfCount;
                game.settings.roles.forEach((r: string) => {
                    requiredRolesCount += 1;
                    if (r === 'freemason') requiredRolesCount += 1;
                });

                if (requiredRolesCount > total) {
                    return interaction.reply({ 
                        content: `⚠️ **設定エラー**\n役職の枠数（${requiredRolesCount}枠）が、現在の参加人数（${total}人）をオーバーしています。\n設定から役職を減らすか、参加者（またはNPC）を増やしてください。`, 
                        ephemeral: true 
                    });
                }

                const humanCount = game.players.filter((p: Player) => !p.isNpc).length;
                if (game.settings.matchType === 'ranked' && humanCount < 2) {
                    game.settings.matchType = 'casual';
                    (game as any).downgradeMessage = true;
                }

                if (game.settings.matchType === 'ranked') {
                    const banned = ['teruteru', 'cupid', 'cat', 'thief', 'sorcerer', 'baker', 'psycho', 'ninja', 'fox'];
                    const hasBanned = game.settings.roles.some((r: string) => banned.includes(r));
                    if (hasBanned) {
                        return interaction.reply({ content: '⚠️ **ランクマッチ開始エラー**\nランクマッチでは運要素や第三陣営（テルテル、妖狐など）は使用できません。\n設定から「練習試合」に変更するか、役職を外してください。', ephemeral: true });
                    }

                    game.settings.firstNightPeace = true;
                    game.settings.voteTransparency = 'public';
                    game.settings.continuousGuard = false;
                    game.settings.tieVoteHandling = 'random';
                }

                game.state = 'playing';
                // ★ 修正：ここで update を使ってロビーを「建設中」に書き換え、ボタンを消去！
                await interaction.update({ content: '🏗️ **専用の村（スレッド）を建設中です...**', components: [], embeds: [] });
                startGame(game, interaction);
                return;
            }
        }
   } catch (error: any) {
        console.error('Interaction Error:', error);
        const errorMsg = `⚠️ **システム内部エラーが発生しました**: ${error.message}\n(再デプロイ等の影響の可能性があります)`;
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errorMsg, ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
        }
    }
}

// ★ 修正：interaction を受け取るように変更
async function startGame(game: GameState, interaction: any) {
    const guild = game.channel?.guild;
    const oldChannelId = game.channel?.id;

    const isAlreadyDedicated = game.channel?.name.startsWith('🐺人狼村') && game.channel?.isThread();

    if (guild && game.channel && !isAlreadyDedicated) {
        try {
            const newThread = await (game.channel as TextChannel).threads.create({
                name: `🐺人狼村-${Math.floor(1000 + Math.random() * 9000)}`,
                autoArchiveDuration: 60,
                type: ChannelType.PrivateThread, 
                invitable: false 
            });

            for (const p of game.players) {
                if (!p.isNpc) {
                    await newThread.members.add(p.id).catch(() => {});
                }
            }

            if (oldChannelId) {
                moveGameChannel(oldChannelId, newThread.id);
                game.channel = newThread; 
            }

            // ★ 修正：editReply を使って「完成報告」にメッセージを上書きする
            await interaction.editReply({ 
                content: `🏠 **専用の村が完成しました！**\n参加者の皆さんはこちらへ移動してください！ 👉 <#${newThread.id}>` 
            });

        } catch (error) {
            console.error('スレッド作成に失敗しました:', error);
            // ★ エラー時も上書きで表示
            await interaction.editReply({ 
                content: '⚠️ **スレッドの作成に失敗しました。**\nBotに「プライベートスレッドの作成」権限が付与されているか確認してください。' 
            });
            return;
        }
    } else if (isAlreadyDedicated) {
        // ★ 既存の村の場合も上書きで完了報告
        await interaction.editReply({ content: '🔄 **このままこの村で続けてプレイします！**' });
    }

    const finalPlayers = [...game.players];
    for (let i = 0; i < game.npcCount; i++) {
        const personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
        finalPlayers.push({
            id: `npc_${game.channel?.id}_${i}`, user: null, name: `🤖NPC${i + 1}`, isNpc: true, personality: personality,
            settings: undefined
        });
    }

    const streakPromises = finalPlayers.map(async p => { 
        if (p.isNpc) return; 
        const s = await DB.getCurrentStreak(p.id); 
        if (s >= 2) p.user?.send(`🔥 あなたは現在 **${s}連勝中** です！この調子で頑張りましょう！`).catch(e => console.error('Silent Error:', e.message));
    });
    await Promise.all(streakPromises);
    const streakAnnounce = '';

    const total = finalPlayers.length;
    const rolesSource = Phases.decideRoles(game, total);

    const roleCounts: any = {};
    rolesSource.forEach((r: any) => { roleCounts[r] = (roleCounts[r] || 0) + 1; });
    const roleOrder = ['人狼', '狂信者', '狂人', '妖狐', '妖術師', 'テルテル', 'キューピッド', '猫又', '怪盗', '占い師', '霊能者', '騎士', 'パン屋', '共有者', '逃亡者', '検死官', '市長', 'タフガイ', '村人'];
    const roleBreakdown = Object.entries(roleCounts)
        .sort((a, b) => {
            const idxA = roleOrder.indexOf(a[0]);
            const idxB = roleOrder.indexOf(b[0]);
            if (idxA === -1) return 1; 
            if (idxB === -1) return -1;
            return idxA - idxB;
        })
        .map(([r, c]) => `${r}**${c}**`)
        .join(' / ');

    for (let i = rolesSource.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rolesSource[i], rolesSource[j]] = [rolesSource[j], rolesSource[i]]; }

    game.players = finalPlayers.map((p, i) => ({ 
        ...p, role: rolesSource[i], alive: true, isFakeSeer: false, knownWolf: null, isHiding: false, hideStrategy: false 
    }));
    Phases.setupSpecialRoles(game, total);

    for (const p of game.players) {
        if (!p.isNpc) {
            let alliesNames: string[] = [];
            const isWolf = Roles.ROLE_CATALOG[p.role]?.isWolfCount;
            if (isWolf || p.role === '狂信者') {
                alliesNames = game.players
                    .filter((x: any) => Roles.ROLE_CATALOG[x.role]?.isWolfCount && x.id !== p.id)
                    .map((x: any) => x.name);
            }

            let partnerName = null;
            if (game.lovers?.includes(p.id)) { 
                const partnerId = game.lovers.find((l: string) => l !== p.id);
                const partner = game.players.find((pl: any) => pl.id === partnerId);
                if (partner) partnerName = partner.name;
            }

            const embedCard = Messages.createRoleCard(p, alliesNames, partnerName);
            p.user.send({ embeds: [embedCard] }).catch(e => {
                console.error('Silent Error:', e.message);
                // DM送信失敗時にチャンネルでメンションして通知
                game.channel?.send(`⚠️ **緊急警告**: <@${p.id}> さん、役職DMの送信に失敗しました！\nサーバーの「プライバシー設定」から「サーバーメンバーからのダイレクトメッセージを許可する」をオンにしてください。`);
            });
        }
    }

    if ((game as any).downgradeMessage) {
        await game.channel?.send('⚠️ **人数が足りないため、自動的に「練習試合」として開始します。**\n(ランクマッチには人間プレイヤーが最低2人必要です)');
        delete (game as any).downgradeMessage;
    }

    // ★ 修正：役職の確認を促し、15秒待ってからゲームを動かす
    await game.channel?.send(`🌙 **ゲーム開始**${streakAnnounce}\nここは参加者だけの専用スレッドです！\n参加: ${total}名\n📜 **内訳**: ${roleBreakdown}\n\n📩 **各自のDM（ダイレクトメッセージ）に役職を送信しました！**\n能力や仲間の確認をしてください。**15秒後**に1日目の朝が始まります...`);
    
    setTimeout(() => {
        Phases.startDayPhase(game);
    }, 15000); // 15000ミリ秒 ＝ 15秒の猶予
}

export async function showStats(userId: string, interaction: any) { await DB.showStats(userId, interaction); }