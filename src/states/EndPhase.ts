// src/states/EndPhase.ts
import { Phase } from './Phase';
import { GameState, Player } from '../types';
import { TIMING, MSG, UI, fill } from '../gameConfig';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as Messages from '../messages';
import * as Roles from '../roles';
import * as DB from '../db';
import * as AI from '../aiUtils';
import { getGame, resetGame } from '../state';

export class EndPhase implements Phase {
    readonly name = 'end';

    public async onEnter(game: GameState): Promise<string | void> {
        return new Promise(async (resolve) => {
            // 1. 勝利陣営と基本メッセージの取得（game.winnerTeam には事前に checkWin 等で代入されている前提）
            const winner = game.winnerTeam || 'draw';
            const winMessage = this.getWinMessage(game, winner);

            // 2. MVPの計算、タイムラインの最終化、サマリーの作成
            const mvpData = this.calculateMVP(game, game.players, winner);
            this.finalizeTimeline(game, winner);
            game.resultSummary = this.buildResultSummary(game, winner);

            // 3. DB保存とレート変動の計算
            let deltas: Record<string, number> = {};
            const humanCount = game.players.filter((p: Player) => !p.isNpc).length;
            const isRanked = game.settings.matchType === 'ranked' && humanCount >= 2;
            
            try { 
                const res = await DB.saveGameResults(game, winner, mvpData.name); 
                if (res && res.deltas) deltas = res.deltas; 
            } catch (e) { console.error("DB Save Error:", e); }
            
            // 4. AIによるMVPコメントの生成
            const aiComment = await AI.generateMvpComment(mvpData, game.history);
            
            // 5. レート変動やMVPテキストの組み立て
            let matchTypeInfo = isRanked ? '🏆【ランクマッチ】' : '🔰【練習試合】';
            if (isRanked && Object.keys(deltas).length > 0) {
                matchTypeInfo += '\n**📈 レート変動**\n';
                for (const [uid, delta] of Object.entries(deltas)) {
                    const p = game.players.find((pl: any) => pl.id === uid);
                    const d = delta as number; 
                    if (p) {
                        let extraInfo = [];
                        if (p.name === mvpData.name) extraInfo.push('MVP');
                        if (p.alive) extraInfo.push('生存');
                        if (!p.alive && p.ghostBet) {
                            let hit = false;
                            if (p.ghostBet === 'villager' && winner === 'villager') hit = true;
                            if (p.ghostBet === 'wolf' && winner === 'wolf') hit = true;
                            if (p.ghostBet === 'other' && ['fox','lovers','teruteru'].includes(winner)) hit = true;
                            if (hit) extraInfo.push('賭的中');
                        }
                        const infoStr = extraInfo.length > 0 ? ` (${extraInfo.join('/')})` : '';
                        matchTypeInfo += `▪ ${d > 0 ? '+' : ''}${d} pt : **${p.name}**${infoStr}\n`;
                    }
                }
            }
            matchTypeInfo += `\n\n🏅 **MVP**: ${mvpData.name} **[${mvpData.role}]**\n「${aiComment}」`;

            const headerText = `${winMessage}\n${matchTypeInfo}`;

            // 6. 人狼チャット部屋（隠れ家）の削除予約
            this.cleanupWolfChannel(game);

            // 7. 最終結果画面の表示とチャンネルのお掃除処理
            await this.sendFinalResults(game, headerText);

            // これ以上次のフェーズはないので void で resolve してループを抜ける
            resolve();
        });
    }

    public async onExit(game: GameState): Promise<void> {}

    // ==========================================
    // 内部メソッド群（他フェーズから隠蔽）
    // ==========================================

    private getWinMessage(game: GameState, winner: string): string {
        let message = MSG.endGame.winText[winner as keyof typeof MSG.endGame.winText] || MSG.endGame.winText.draw;
        
        // 神の特殊勝利メッセージの上書き処理
        const aliveCount = game.players.filter((p: Player) => p.alive).length;
        const god = game.players.find((p: Player) => p.role === '神' && p.alive);
        
        if (god) {
            if (['fox', 'lovers', 'teruteru'].includes(winner)) {
                message = '✨ **神の単独勝利**\n第三陣営の勝利を退け、最後まで生き残った【神】が世界を掌握しました！';
            } else if (aliveCount <= 3) {
                message += '\n\n✨ **神の共存勝利**\n生存者が3人以下となったため、生き残った【神】も共に勝利を分かち合います！';
            }
        }
        return message;
    }

    private cleanupWolfChannel(game: GameState) {
        const wolfCh = game.wolfChannel;
        if (wolfCh) {
            game.wolfChannel = undefined; // 先にBotの記憶から切り離す
            wolfCh.send('🚪 **この隠れ家はまもなく閉鎖されます。さらばだ。**').catch(()=>{});
            setTimeout(() => {
                wolfCh.delete().catch((e: any) => console.error("隠れ家削除失敗", e));
            }, 5000); 
        }
    }

    private calculateMVP(game: GameState, players: any[], winningTeam: string) {
        if (!players || players.length === 0) return { name: 'Unknown', role: 'Unknown', reason: 'データなし' };
        let scores = players.map(p => ({ id: p.id, name: p.name, role: p.role, score: 0, reasons: [] as string[] }));

        const getEffectiveTeam = (player: any): string => {
            if (game.lovers && game.lovers.includes(player.id)) return 'lovers';
            if (player.role === '妖狐') return 'fox';
            if (player.role === 'テルテル') return 'teruteru';
            if (player.role === '純愛者' && game.devoteeTarget) {
                const target = players.find(pl => pl.id === game.devoteeTarget);
                if (target && target.id !== player.id) return getEffectiveTeam(target);
            }
            const team = Roles.ROLE_CATALOG[player.role as string]?.team as string | undefined;
            if (team === 'village' || team === 'villager') return 'villager';
            return team || 'villager';
        };

        players.forEach((p, i) => {
            const playerTeam = getEffectiveTeam(p);
            const isWin = (playerTeam === winningTeam || (playerTeam === 'villager' && winningTeam === 'villager'));

            if (isWin) {
                scores[i].score += 100;
                if (p.alive) scores[i].score += 50;
                if (p.role === '純愛者') scores[i].reasons.push('愛する人の勝利に貢献');
            }
        });
        
        if (game.actions) {
            game.actions.forEach((a: any) => {
                const idx = scores.findIndex(s => s.id === a.from);
                if (idx !== -1 && a.type === 'divine' && a.result === true) { 
                    scores[idx].score += 30; 
                    scores[idx].reasons.push('人狼発見'); 
                }
            });
        }

        const guards = players.filter(p => p.role === '騎士');
        guards.forEach(guard => {
            const idx = scores.findIndex(s => s.id === guard.id);
            if (idx !== -1 && game.timeline) {
                const successCount = game.timeline.filter((t: any) => t.type === 'action' && t.detail === 'guard' && t.from === guard.id && t.result === true).length;
                if (successCount > 0) { 
                    scores[idx].score += 40 * successCount; 
                    scores[idx].reasons.push(`護衛成功x${successCount}`); 
                }
            }
        });

        if (winningTeam === 'wolf') {
            players.filter(p => Roles.isActualWolf(p.role as string) && p.alive).forEach(w => {
                const idx = scores.findIndex(s => s.id === w.id);
                if(idx !== -1) scores[idx].score += 30; 
            });
        }

        scores.sort((a, b) => b.score - a.score);
        const mvp = scores[0];
        const reasonText = mvp.reasons.length > 0 ? mvp.reasons.join(', ') : '勝利への貢献';
        
        return { name: mvp.name, role: mvp.role, reason: reasonText };
    }

    private buildResultSummary(game: GameState, winner: string) {
        const getTeam = (role: string = '', id: string = ''): string => {
            if (game.lovers && game.lovers.includes(id)) return "lovers";
            if (role === 'キューピッド' && winner === 'lovers') return "lovers";
            if (role === "妖狐") return "fox";
            if (role === "テルテル") return "teruteru";
            if (role === "純愛者" && game.devoteeTarget) {
                const target = game.players.find((p: Player) => p.id === game.devoteeTarget);
                if (target && target.id !== id) return getTeam(target.role, target.id);
            }
            const team = Roles.ROLE_CATALOG[role]?.team as string | undefined;
            if (team === 'wolf') return 'wolf';
            return "villager";
        };

        const summary = { total_days: game.dayCount, winner_team: winner, players: {} as Record<string, any> };
        game.players.forEach((p: Player) => {
            let team = getTeam(p.role, p.id);
            if (game.lovers && game.lovers.includes(p.id)) team = "lovers"; 
            else if (p.role === 'キューピッド' && winner === 'lovers') team = "lovers";

            summary.players[p.id] = { 
                name: p.name, role: p.role || '不明', team: team, is_alive: !!p.alive, 
                death_day: p.alive ? null : (p.deathDay || null), 
                death_reason: p.alive ? null : (p.deathReason || null) 
            };
        });
        return summary;
    }

    private finalizeTimeline(game: any, winner: string) {
        if (game.timelineFinalized) return; 
        game.timelineFinalized = true;
        if (!game.timeline) game.timeline = [];

        let winName = MSG.endGame.winnerNames[winner as keyof typeof MSG.endGame.winnerNames] || MSG.endGame.winnerNames.draw;
        game.history.push(`🏆 勝敗: ${winName}の勝利！`);
        game.timeline.push({ type: 'winner', content: `${winName}の勝利！` });
        game.players.forEach((p: Player) => {
            game.history.push(`🎭 役職公開: ${p.name} <${p.id}> (${p.role})`);
            game.timeline.push({ type: 'system', content: `🎭 役職公開: ${p.name} <${p.id}> (${p.role})` });
        });
        game.timeline.push({ type: 'system', content: 'MATCH END: リプレイ終了' });
    }

    private async sendFinalResults(game: GameState, text: string) {
        try { await Messages.safeSend(game.channel, { content: MSG.endGame.resultLoading }); } catch (e) { console.error("EndGame MVP Send Error:", e); }

        const timer = setTimeout(async () => { 
            let historyStr = "";
            for (let d = 1; d <= game.dayCount; d++) {
                let dailyLog = "";
                if (d === 1) {
                    if (game.lovers && game.lovers.length === 2) {
                        const l1 = game.players.find(p => p.id === game.lovers[0])?.name || '不明';
                        const l2 = game.players.find(p => p.id === game.lovers[1])?.name || '不明';
                        dailyLog += `💘 **恋人成立** : **${l1}** & **${l2}**\n`;
                    }
                    if (game.devoteeTarget) {
                        const devotee = game.players.find(p => p.role === '純愛者')?.name || '純愛者';
                        const target = game.players.find(p => p.id === game.devoteeTarget)?.name || '不明';
                        dailyLog += `❤️‍🔥 **純愛の対象** : **${devotee}** ➔ **${target}**\n`;
                    }
                }

                const nightActions = game.timeline.filter((t: any) => t.day === d && t.type === 'action');
                nightActions.forEach((act: any) => {
                    const fromPlayer = game.players.find((p: Player) => p.id === act.from);
                    const targetPName = game.players.find((p: Player) => p.id === act.target)?.name || '不明';
                    const fromPName = fromPlayer?.name || '不明';

                    switch (act.detail) {
                        case 'divine': 
                            const isFake = fromPlayer && fromPlayer.role !== '占い師';
                            dailyLog += `🔮 **${fromPName}** [${isFake ? '偽占い' : '占い'}] : **${targetPName}** ➔【${act.result ? '人狼●' : '人間○'}】\n`; 
                            break;
                        case 'guard':  dailyLog += `🛡️ **${fromPName}** [護衛] : **${targetPName}** ${act.result ? '(成功!)' : ''}\n`; break;
                        case 'kill':   dailyLog += `🐺 **${fromPName}** [襲撃] : **${targetPName}** ${act.result === false ? '(失敗)' : '(成功)'}\n`; break;
                        case 'sorcery': dailyLog += `👁️ **${fromPName}** [妖術] : **${targetPName}** ➔【${act.result}】\n`; break;
                        case 'steal':  dailyLog += `🎩 **${fromPName}** [怪盗] : **${targetPName}**\n`; break;
                        case 'divide': dailyLog += `🌀 **${fromPName}** [隔離] : **${targetPName}**\n`; break;
                        case 'revive': dailyLog += `🧟 **${fromPName}** [蘇生] : **${targetPName}**\n`; break;
                        case 'fugitive': dailyLog += `💨 **${fromPName}** [逃亡] : **${targetPName}**\n`; break;
                        case 'assassinate': 
                            const isSuicide = act.result === 'suicide';
                            dailyLog += `🌒 **${fromPName}** [暗殺] : **${targetPName}** ➔ ${isSuicide ? '💀(誤射)' : '💀(成功)'}\n`; 
                            break;
                    }
                });

                const deaths = game.timeline.filter(t => t.day === d && (t.type === 'death' || t.type === 'execution'));
                deaths.forEach(evt => {
                    let cleanContent = evt.content?.replace(/🌑 |📅 |🐈 |✨ |⚖️ /, '') || '';
                    dailyLog += `💀 ${cleanContent}\n`;
                });

                if (dailyLog) historyStr += `\n**━━━ ${d}日目 ━━━**\n${dailyLog}`;
            }

            if (historyStr.length > 1900) historyStr = "⚠️ 記録が長すぎるため、一部を省略しました。";

            let playersList = game.players.map(p => `**${p.name}** : ${p.role} (${p.alive ? '生存' : '死亡'})`).join('\n');
            const resultText = `------------------------\n${text}\n\n${MSG.endGame.playerListHeader}\n${playersList}\n\n${MSG.endGame.historyHeader}\n${historyStr}`;

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents( 
                new ButtonBuilder().setCustomId('game_rematch').setLabel(UI.vote.rematchButton).setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('game_force_reset').setLabel(UI.vote.resetButton).setStyle(ButtonStyle.Secondary)
            );

            try {
                game.channel.send({ content: resultText, components: [row] });
                const currentChannel = game.channel as any;
                if (currentChannel && currentChannel.name && currentChannel.name.startsWith('🐺人狼村')) {
                    currentChannel.send(fill(MSG.endGame.channelCloseNotice, { minutes: TIMING.channelAutoDeleteMinutes }));
                    setTimeout(async () => {
                        try {
                            const checkGame = getGame(currentChannel.id);
                            if (checkGame && checkGame.state !== 'idle') return; 
                            await currentChannel.delete('人狼ゲーム終了による自動削除');
                        } catch (err) { console.error('チャンネルの削除に失敗しました:', err); }
                    }, TIMING.channelAutoDeleteMinutes * 60 * 1000);
                }
            } catch (e) {
                console.error("EndGame Send Error:", e);
                Messages.safeSend(game.channel, MSG.endGame.errorFallback);
            }
            
            game.state = 'idle';
            setTimeout(() => {
                try {
                    const g = getGame(game.channel.id);
                    if (g && g.state === 'idle') { resetGame(game.channel.id, true); }
                } catch(e) { console.error(e); }
            }, TIMING.idleGameCleanupHours * 60 * 60 * 1000);
        }, TIMING.endGameResultDelay);
        
        if (!game.timers) game.timers = [];
        game.timers.push(timer);
    }
}
