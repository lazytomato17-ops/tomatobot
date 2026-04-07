// src/phase.ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import * as Messages from './messages';
import * as DB from './db';
import * as AI from './aiUtils'; 
import * as NPC from './npcLogic';
import { GameState, Player, TimelineEvent } from './types'; 
import * as TextData from './textData';
import * as Roles from './roles';

// 任意の秒数だけ処理を一時停止する関数（1000 = 1秒）
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function setSafeTimeout(game: GameState, callback: () => void, ms: number) {
    if (!game.timers) game.timers = [];
    const timer = setTimeout(() => {
        game.timers = game.timers.filter((t: any) => t !== timer);
        // ゲームが既にリセット・終了済みの場合はコールバックを実行しない
        if (game.state === 'idle') return;
        try {
            callback();
        } catch (e) {
            console.error('[setSafeTimeout] コールバック内でエラーが発生しました:', e);
        }
    }, ms);
    game.timers.push(timer);
}

/** Collectorをゲームに登録し、リセット時に自動停止できるようにする */
export function trackCollector(game: GameState, collector: { stop: () => void } & { once?: (event: string, fn: () => void) => void }): void {
    if (!game.collectors) game.collectors = [];
    game.collectors.push(collector);
    // Collector終了時に自動でリストから除去（メモリリーク防止）
    if (typeof collector.once === 'function') {
        collector.once('end', () => {
            if (game.collectors) {
                game.collectors = game.collectors.filter(c => c !== collector);
            }
        });
    }
}

export function decideRoles(game: GameState, total: number) {
    let wolfCount = game.settings.wolfMode === 'auto' ? (total >= 9 ? 3 : (total >= 6 ? 2 : 1)) : game.settings.wolfMode;
    if (wolfCount >= total / 2) wolfCount = Math.floor((total - 1) / 2) || 1;
    
    const roles = [];
    const wolfRoleName = game.settings.loquaciousMode ? '饒舌な人狼' : '人狼';
    for (let i = 0; i < wolfCount; i++) roles.push(wolfRoleName);
    
    game.settings.roles.forEach((k: string) => { 
        if (Roles.ROLE_MAP[k] && k !== 'loquacious') {
            roles.push(Roles.ROLE_MAP[k]);
            if (k === 'freemason') roles.push(Roles.ROLE_MAP[k]);
        } 
    });
    while (roles.length < total) roles.push('村人');
    return roles;
}

export function setupSpecialRoles(game: GameState, total: number) {
    const naturalLiars = game.players.filter((p: Player) => p.isNpc && ['狂人', '妖狐', '狂信者', 'テルテル', '妖術師'].includes(p.role as string));
    const wolves = game.players.filter((p: Player) => p.isNpc && Roles.isActualWolf(p.role as string));

    const isSeerInSettings = game.settings.roles.includes('seer');
    if (isSeerInSettings) {
        if (naturalLiars.length > 0 && Math.random() < 0.6) { 
            naturalLiars[Math.floor(Math.random() * naturalLiars.length)].isFakeSeer = true;
        } else if (wolves.length > 0 && Math.random() < 0.2) { 
            wolves[Math.floor(Math.random() * wolves.length)].isFakeSeer = true;
        }
    }

    const isMediumInSettings = game.settings.roles.includes('medium');
    const madmenForMedium = game.players.filter((p: Player) => p.isNpc && !p.isFakeSeer && ['狂人', '狂信者'].includes(p.role as string));
    const wolvesForMedium = game.players.filter((p: Player) => p.isNpc && !p.isFakeSeer && Roles.isActualWolf(p.role as string));

    if (isMediumInSettings) {
        if (madmenForMedium.length > 0 && Math.random() < 0.3) { 
            madmenForMedium[Math.floor(Math.random() * madmenForMedium.length)].isFakeMedium = true;
        } else if (wolvesForMedium.length > 0 && Math.random() < 0.1) { 
            wolvesForMedium[Math.floor(Math.random() * wolvesForMedium.length)].isFakeMedium = true;
        }
    }

    if (game.settings.roles.includes('cupid') && total >= 2) {
       const cupid = game.players.find((p: Player) => p.role === 'キューピッド');
       if (cupid && cupid.isNpc) {
           const idx = [...Array(total).keys()];
           const l1 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
           const l2 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
           game.lovers = [l1.id, l2.id];
       }
   }
}

function generateDeepReasonPhrase(speaker: any, targetName: string, reason: string) {
    const p = speaker.personality || 'normal';
    
    if (TextData.GAYA_DICTIONARY[reason] && TextData.GAYA_DICTIONARY[reason][p]) {
        const list = TextData.GAYA_DICTIONARY[reason][p];
        const template = list[Math.floor(Math.random() * list.length)];
        return template.replace('TARGET', targetName);
    }

    return Messages.getDynamicGayaPhrase('attacking', p, targetName);
}

function startGaya(game: GameState) {
    if (game.gayaInterval) clearInterval(game.gayaInterval);
    game.gayaInterval = setInterval(async () => {
        if (Math.random() < 0.2) return; 
        const aliveNpcs = game.players.filter((p: Player) => p.isNpc && p.alive);
        if (aliveNpcs.length === 0) return;
        const speaker = aliveNpcs[Math.floor(Math.random() * aliveNpcs.length)];
        
        let phrase = "";
        const accused = game.evidence.some((e: any) => e.target === speaker.id && e.result === true && e.visible); 
        if (accused) {
            phrase = Messages.getDynamicGayaPhrase('defensive', speaker.personality, null);
        } else {
             const voteInfo = NPC.getNpcVoteTarget(speaker, game);
             if (voteInfo && voteInfo !== 'skip') {
                 const targetId = typeof voteInfo === 'string' ? voteInfo : voteInfo.targetId;
                 const reason = typeof voteInfo === 'string' ? 'gray' : voteInfo.reasonType;
                 
                 if (targetId !== 'skip' && targetId !== speaker.id) {
                     const t = game.players.find((p: Player) => p.id === targetId);
                     if (t) phrase = generateDeepReasonPhrase(speaker, t.name, reason);
                 }
             }
             if (!phrase) phrase = Messages.getDynamicGayaPhrase('neutral', speaker.personality, null);
        }
        if (!game.chatLog) game.chatLog = [];
        if (!game.timeline) game.timeline = []; 
        
        game.chatLog.push({ id: speaker.id, name: speaker.name, content: phrase, day: game.dayCount });
        game.timeline.push({ type: 'chat', day: game.dayCount, id: speaker.id, name: speaker.name, content: phrase });

        if (game.chatLog.length > 100) game.chatLog.shift();

        // ゲームが終了・リセット済みであれば送信しない（null channel クラッシュ防止）
        if (game.state !== 'playing' || !game.channel) return;

        Messages.safeSend(game.channel, `**${speaker.name}**: 「${phrase}」`);
    }, 8000); 
}

export async function startDayPhase(game: GameState) {
    game.dayCount++;
    if (!game.timeline) game.timeline = [];

    if (game.dayCount === 1) {
        game.timeline = [];
        game.timeline.push({ type: 'system', content: 'LINK START: リプレイデータを展開します...' });
    }

    game.timeline.push({ type: 'phase', content: `☀️ DAY ${game.dayCount}`, detail: '昼のフェーズ' });

    const aliveCount = game.players.filter((p: Player) => p.alive).length;
    const bakerAlive = game.players.some((p: Player) => p.role === 'パン屋' && p.alive);
    
    let duration = game.settings.discussionTime;
    if (game.dayCount === 1) duration = Math.floor(duration / 2);

    let textMsg = `------------------------\n🌅 **${game.dayCount}日目の朝**\n生存: ${aliveCount}名\n📢 **議論開始 (${duration}秒)**`;
    if (bakerAlive) {
        textMsg += `\n🍞 パン屋: 今日はおいしいパンが焼けました！`;
    }
    const dayMsg = await Messages.safeSend(game.channel, { content: textMsg });
    
    announceSeerResults(game).catch(e => console.error(e));
    if (game.settings.gayaMode && game.npcCount > 0) startGaya(game);

    const loquaciousWolves = game.dayCount > 1 
        ? game.players.filter((p: Player) => 
            p.alive && (p.role === '饒舌な人狼' || (game.settings.loquaciousMode && Roles.isActualWolf(p.role as string)))
        )
        : [];

    const msgCollector = game.channel.createMessageCollector({ 
        filter: (m: any) => !m.author.bot, 
        time: duration * 1000 
    });
    // リセット時に停止できるよう登録
    trackCollector(game, msgCollector);

    if (loquaciousWolves.length > 0) {
        loquaciousWolves.forEach((w: any) => {
            w.wordToSay = TextData.EASY_WORDS[Math.floor(Math.random() * TextData.EASY_WORDS.length)];
            w.hasSaidWord = false;
            
            if (!w.isNpc) {
                Messages.safeDM(w.user, `🐺 **饒舌ミッション**\n議論中に **「${w.wordToSay}」** と発言してください。言えないと突然死します！`);
            } else {
                w.hasSaidWord = true; 
            }
        });

        msgCollector.on('collect', (m: any) => {
            const player = game.players.find((p: Player) => p.id === m.author.id);
            if (player && loquaciousWolves.some((w: any) => w.id === player.id) && !player.hasSaidWord) {
                if (m.content.includes(player.wordToSay!)) {
                    player.hasSaidWord = true;
                    Messages.safeDM(player.user, `✅ お題ワード「${player.wordToSay}」を確認！突然死を回避しました。`);
                }
            }
        });
    }

    setSafeTimeout(game, async () => {
        try {
            await Messages.safeSend(game.channel, { content: `------------------------\n⏰ **議論終了。**\n投票の時間です。` });

            if (game.gayaInterval) clearInterval(game.gayaInterval);
            msgCollector.stop();

            let suddenDeaths: string[] = [];
            loquaciousWolves.forEach((w: any) => {
                if (!w.hasSaidWord && w.alive) {
                    w.alive = false;
                    w.deathDay = game.dayCount;
                    w.deathReason = 'sudden_death';

                    suddenDeaths.push(w.name);
                    game.history.push(`🌑 突然死: ${w.name} (饒舌なお題未達成)`);
                    game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 突然死: ${w.name}` });
                }
            });

            if (suddenDeaths.length > 0) {
                await Messages.safeSend(game.channel, `------------------------\n⚡ **突然死が発生しました**\n**${suddenDeaths.join('**, **')}** が突然ショック死しました…`);
                if (await checkWin(game)) return;
            }

            startVotingPhase(game);
        } catch (e) {
            console.error("Day End Error:", e);
            startVotingPhase(game);
        }
    }, duration * 1000);
}

async function announceSeerResults(game: GameState) {
    if (game.dayCount <= 1) return;
    let seers = game.players.filter((p: Player) => p.alive && (p.role === '占い師' || p.isFakeSeer || (!p.isNpc && game.actions.some((a: any) => a.type === 'divine' && a.from === p.id))));
    if (seers.length === 0) return;
    seers.sort(() => Math.random() - 0.5);

    setSafeTimeout(game, async () => {
        for (const seer of seers) {
            try {
                let act: any = null;
                let shouldReveal = true;

                if (seer.role === '占い師' && seer.isNpc) {
                    act = game.actions.find((a: any) => a.type === 'divine' && a.from === seer.id);
                } 
                else if (seer.isNpc && seer.isFakeSeer) {
                    const myHistory = game.evidence.filter((e: any) => e.type === 'divine' && e.from === seer.id).map((e: any) => e.target);
                    const others = game.players.filter((p: Player) => p.id !== seer.id && p.alive && !myHistory.includes(p.id));
                    
                    if (others.length > 0) {
                        let target = others[Math.floor(Math.random() * others.length)];
                        const rivalWhites = game.evidence.filter((e: any) => e.type === 'divine' && e.result === false && e.from !== seer.id && e.visible);
                        if (rivalWhites.length > 0 && Math.random() < 0.5) {
                            const panda = rivalWhites.filter((e: any) => 
                                e.target !== seer.id && 
                                !myHistory.includes(e.target) &&
                                game.players.some((p: Player) => p.id === e.target && p.alive)
                            );
                            if (panda.length > 0) {
                                const randomPanda = panda[Math.floor(Math.random() * panda.length)];
                                const foundPlayer = game.players.find((p: Player) => p.id === randomPanda.target);
                                if (foundPlayer) target = foundPlayer;
                            }
                        }
                        const myBlacks = game.evidence.filter((e: any) => e.type === 'divine' && e.from === seer.id && e.result === true).length;
                        const wolfCount = game.settings.wolfMode === 'auto' ? (game.players.length >= 9 ? 3 : (game.players.length >= 6 ? 2 : 1)) : (typeof game.settings.wolfMode === 'number' ? game.settings.wolfMode : 2);
                        
                        let isBlack = game.dayCount >= 3 ? (Math.random() < 0.4) : (Math.random() < 0.2);
                        if (myBlacks >= wolfCount) isBlack = false;

                        if (seer.role === '狂信者' || seer.role === '妖術師' || Roles.isActualWolf(seer.role as string)) {
                            const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string)).map((p: Player) => p.id);
                            if (wolves.includes(target.id)) isBlack = false; 
                        }
                        act = { type: 'divine', from: seer.id, target: target.id, result: isBlack };
                        game.actions.push(act);
                    }
                } else if (!seer.isNpc) {
                    act = game.actions.find((a: any) => a.type === 'divine' && a.from === seer.id);
                }

                if (!act) continue;

                if (seer.isNpc) {
                    if (seer.isHiding) {
                        let forceReveal = act.result === true || game.dayCount >= 3;
                        if (forceReveal) seer.isHiding = false; else shouldReveal = false;
                    }
                } else {
                    if (seer.hideStrategy) {
                        if (act.result) { 
                            seer.hideStrategy = false;
                            Messages.safeDM(seer.user, "⚠ **黒発見のため潜伏解除しました。**"); 
                        }
                        else { 
                            shouldReveal = false;
                            Messages.safeDM(seer.user, "🕶️ **潜伏中... 結果は公開されません。**"); 
                        }
                    }
                }

                const existingEv = game.evidence.find((e: any) => e.day === game.dayCount && e.from === seer.id);
                if (!existingEv) game.evidence.push({ type: 'divine', day: game.dayCount, from: act.from, target: act.target, result: act.result, visible: shouldReveal });

                if (shouldReveal) {
                    const hiddenLogs = game.evidence.filter((e: any) => e.from === seer.id && !e.visible);
                    hiddenLogs.forEach((e: any) => e.visible = true);
                    
                    let revealText = "";
                    if (hiddenLogs.length > 0) {
                        revealText = `🔮 **${seer.name} (占い師CO)**: 「私は占い師だ。`;
                        hiddenLogs.forEach((e: any) => { 
                            const tName = game.players.find((p: Player) => p.id === e.target)?.name || '不明';
                            revealText += `${e.day}日目の夜は **${tName}** を占い、結果は **【${e.result ? '人狼🐺' : '人間👤'}】**。`; 
                        });
                        const currentTargetName = game.players.find((p: Player) => p.id === act.target)?.name || '不明';
                        revealText += `そして昨夜 **${currentTargetName}** を占った。結果は… **【${act.result ? '人狼🐺' : '人間👤'}】** だ」`;
                    } else {
                        const resStr = act.result ? '人狼🐺' : '人間👤';
                        const currentTargetName = game.players.find((p: Player) => p.id === act.target)?.name || '不明';
                        revealText = `🔮 **${seer.name} (占い師CO)**: 「昨夜 **${currentTargetName}** を占った。結果は… **【${resStr}】** だ」`;
                    }
                    await Messages.safeSend(game.channel, { content: revealText });

                    if (!game.chatLog) game.chatLog = [];
                    if (!game.timeline) game.timeline = []; 

                    const currentTargetName = game.players.find((p: Player) => p.id === act.target)?.name || '不明';
                    
                    game.chatLog.push({ id: seer.id, name: seer.name, content: `占い結果: ${currentTargetName} は ${act.result ? '黒' : '白'}`, day: game.dayCount });
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: seer.id, name: seer.name, content: `占い結果: ${currentTargetName} は ${act.result ? '黒' : '白'}` });
                }
            } catch(e) { console.error("Seer Announce Error:", e); }
        }
    }, 1500);
}

export async function startVotingPhase(game: GameState) {
    const alivePlayers = game.players.filter((p: Player) => p.alive);
    
    let voteTargets = alivePlayers;
    if (game.isRevote && game.revoteCandidates && game.revoteCandidates.length > 0) {
        voteTargets = alivePlayers.filter((p: Player) => game.revoteCandidates.includes(p.id));
    }

    const rows = Messages.createButtonRows(voteTargets, 'vote');
    if (!game.isRevote) {
        const passRow = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('vote_skip').setLabel('パス (投票しない)').setStyle(ButtonStyle.Secondary));
        
        const dictator = alivePlayers.find((p: Player) => p.role === '独裁者');
        if (dictator && !game.hasDictatorUsedPower) {
            passRow.addComponents(new ButtonBuilder().setCustomId('dictator_co').setLabel('✊ 独裁スイッチ').setStyle(ButtonStyle.Danger));
        }
        rows.push(passRow);
    }
    
    const voteTimeLimit = game.isRevote ? 30000 : 45000;
    
    const textMsg = game.isRevote 
        ? `🗳️ **決選投票してください (${voteTimeLimit/1000}秒)**` 
        : `🗳️ **投票してください (${voteTimeLimit/1000}秒)**`;
    
    const voteMsg = await game.channel.send({ content: textMsg, components: rows });
    const votes: Record<string, string> = {};
    let votingFinished = false;

    game.players.filter((p: Player) => p.isNpc && p.alive).forEach((npc: any) => {
        if (!game.isRevote && game.dayCount === 1 && Math.random() > 0.1) { votes[npc.id] = 'skip'; return; }
        
        if (game.isRevote && game.revoteCandidates) {
            votes[npc.id] = game.revoteCandidates[Math.floor(Math.random() * game.revoteCandidates.length)];
            return;
        }

        const voteInfo = NPC.getNpcVoteTarget(npc, game);
        const targetId = typeof voteInfo === 'string' ? voteInfo : voteInfo.targetId;
        votes[npc.id] = targetId || 'skip';
    });

    const collector = voteMsg.createMessageComponentCollector({ time: voteTimeLimit });
    // リセット時に停止できるよう登録
    trackCollector(game, collector);

    const aliveHumans = alivePlayers.filter((p: Player) => !p.isNpc).length;
    if (aliveHumans === 0) {
        setTimeout(() => collector.stop(), 2000);
    }

    collector.on('collect', (i: any) => {
        if (i.replied || i.deferred) return; 

        if (i.customId === 'dictator_co') {
            const p = game.players.find((pl: Player) => pl.id === i.user.id);
            if (!p || p.role !== '独裁者') return i.reply({ content: '権限がありません。', ephemeral: true });
            if (game.hasDictatorUsedPower) return i.reply({ content: '既に権限を使用済みです。', ephemeral: true });
            
            const dTargets = alivePlayers.filter((pl: Player) => pl.id !== p.id);
            const btnRows = Messages.createButtonRows(dTargets, 'dictator_exec', ButtonStyle.Danger);
            return i.reply({ content: '✊ **独裁の執行**\n誰を処刑するか選んでください。(※選んだ瞬間に議論が強制終了します)', components: btnRows, ephemeral: true });
        }
        
        if (i.customId.startsWith('dictator_exec_')) {
            const p = game.players.find((pl: Player) => pl.id === i.user.id);
            if (!p || p.role !== '独裁者' || game.hasDictatorUsedPower) return;
            
            game.hasDictatorUsedPower = true;
            game.dictatorTarget = i.customId.replace('dictator_exec_', '');
            
            alivePlayers.forEach((pl: Player) => { votes[pl.id] = game.dictatorTarget as string; }); 
            
            votingFinished = true;
            collector.stop('dictator');
            return i.reply({ content: '✊ 独裁権限を行使しました。', ephemeral: true });
        }

        if (!game.players.find((p: Player) => p.id === i.user.id && p.alive)) return i.reply({content:'あなたは死んでいます。', ephemeral:true});
        if (votes[i.user.id]) return i.reply({content:'投票済みです。', ephemeral:true});
        
        const targetId = i.customId.replace('vote_', '');
        votes[i.user.id] = targetId;
        
        const targetName = targetId === 'skip' ? 'パス' : game.players.find((p: Player) => p.id === targetId)?.name || '不明';
        i.reply({ content: `${targetName} に投票しました。`, ephemeral: true });
        
        if (game.settings.autoFinishVoting) {
            const votedHumans = Object.keys(votes).filter(id => !game.players.find((p: Player) => p.id === id).isNpc).length;
            if (votedHumans >= aliveHumans) collector.stop();
        }
    });

    collector.on('end', () => { 
        if (votingFinished) return; 
        votingFinished = true; 
        voteMsg.edit({ components: [] }).catch(e => console.error('Silent Error:', e.message));
        tallyVotes(game, votes); 
    });
}

async function tallyVotes(game: GameState, votes: Record<string, string>) {
    let tally: Record<string, number> = {};
    if (!game.voteLog) game.voteLog = [];
    if (!game.timeline) game.timeline = []; 

    game.voteLog.push({ day: game.dayCount, votes: { ...votes } });
    game.timeline.push({ type: 'vote', day: game.dayCount, data: { ...votes } });

    Object.entries(votes).forEach(([voterId, targetId]) => {
        const voter = game.players.find((p: Player) => p.id === voterId);
        const voteWeight = (voter && voter.role === '市長') ? 2 : 1;
        tally[targetId] = (tally[targetId] || 0) + voteWeight;
    });

    let tallyMsg = '';
    const sorted = Object.entries(tally).sort(([, a], [, b]) => b - a);

    if (game.dictatorTarget) {
        const dictator = game.players.find((p: Player) => p.role === '独裁者');
        const target = game.players.find((p: Player) => p.id === game.dictatorTarget);
        const dText = `🚨 **独裁者による強制執行** 🚨\n**${dictator?.name}** が【独裁者】として名乗り出ました！\n投票結果は無効化され、問答無用で **${target?.name}** が処刑されます！`;
        await Messages.safeSend(game.channel, { content: dText });
        game.history.push(`✊ 独裁者CO: ${dictator?.name} が ${target?.name} を処刑`);
        game.timeline.push({ type: 'system', content: `✊ 独裁者CO: ${dictator?.name} が ${target?.name} を処刑` });
    } else {
        if (game.settings.voteTransparency === 'anonymous') {
            sorted.forEach(([id, c]) => {
                const name = id === 'skip' ? 'パス' : game.players.find((p: Player) => p.id === id)?.name || '不明';
                tallyMsg += `・**${name}**: ${c}票\n`;
            });
        } else {
            sorted.forEach(([id, c]) => {
                const name = id === 'skip' ? 'パス' : game.players.find((p: Player) => p.id === id)?.name || '不明';
                const voters = Object.keys(votes).filter(vId => votes[vId] === id).map(vId => game.players.find((p: Player) => p.id === vId)?.name || '不明').join(', ');
                tallyMsg += `・**${name}**: ${c}票 (${voters})\n`;
            });
        }
        
        const resText = `📊 **投票結果**\n${tallyMsg.trim()}`;
        await Messages.safeSend(game.channel, { content: resText });
    }

    if (sorted.length === 0 || sorted[0][0] === 'skip') {
        game.isRevote = false;
        await Messages.safeSend(game.channel, { content: '処刑見送り。夜へ向かいます。' });
        game.history.push(`📅 ${game.dayCount}日目: 処刑なし`);
        game.timeline.push({ type: 'system', content: `📅 ${game.dayCount}日目: 処刑なし` });
        return startNightPhase(game);
    }
    
    const max = sorted[0][1];
    const candidates = sorted.filter(s => s[1] === max).map(s => s[0]);
    let executedId;

    if (candidates.length > 1) {
        if (game.settings.tieVoteHandling === 'revote' && !game.isRevote) {
            await Messages.safeSend(game.channel, { content: '⚖️ **最多得票者が複数います！決選投票を行います！**' });
            game.isRevote = true;
            game.revoteCandidates = candidates;
            return startVotingPhase(game);
        } 
        else if (game.settings.tieVoteHandling === 'random' || (game.settings.tieVoteHandling === 'revote' && game.isRevote)) {
            executedId = candidates[Math.floor(Math.random() * candidates.length)];
            await Messages.safeSend(game.channel, { content: `🎲 運命のダイスが振られ、**${game.players.find((p: Player)=>p.id===executedId)?.name}** が選ばれました…` });
        } 
        else {
            await Messages.safeSend(game.channel, { content: '処刑見送り。夜へ向かいます。' });
            game.history.push(`📅 ${game.dayCount}日目: 処刑なし (同票)`);
            game.timeline.push({ type: 'system', content: `📅 ${game.dayCount}日目: 処刑なし (同票)` });
            game.isRevote = false;
            return startNightPhase(game);
        }
    } else {
        executedId = candidates[0];
    }

    game.isRevote = false; 

    if (executedId === 'skip') { 
        await Messages.safeSend(game.channel, { content: '処刑見送り。夜へ向かいます。' });
        return startNightPhase(game); 
    }

    const executed = game.players.find((p: Player) => p.id === executedId);
    await Messages.safeSend(game.channel, { content: `💀 **${executed.name}** は処刑されました。` });
    
    let execText = `------------------------\n💀 処刑実行: ${executed.name}`;

    if (game.settings.willMode) {
        if (!executed.isNpc) {
            await Messages.safeSend(game.channel, `**${executed.name}**、最期の言葉をどうぞ。(20秒以内)`);
            try { 
                const collected = await game.channel.awaitMessages({ filter: (m: any) => m.author.id === executed.id, max: 1, time: 20000, errors: ['time'] });
                const willText = collected.first().content;
                execText += `\n> 「${willText}」`; 
                if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: executed.id, name: executed.name, content: `(遺言) ${willText}`, day: game.dayCount });
                game.timeline.push({ type: 'chat', day: game.dayCount, id: executed.id, name: executed.name, content: willText, isWill: true });
            } catch (e) { execText += '\n...(無言のまま処刑台へ)'; }
        } else { 
            const wills = [
                "無念だ…", "なぜ私を吊るんだ…愚かな…", "私が死んでも、村は救われないぞ…",
                "クソッ！ 騙されやがって！", "みんな、あとは頼んだ…", "これが…運命か…",
                "私を吊ったことを後悔するがいい！", "こんなところで終わるなんて…"
            ];
            const npcWill = wills[Math.floor(Math.random() * wills.length)];
            execText += `\n> 「${npcWill}」`; 
            if (!game.chatLog) game.chatLog = [];
            game.chatLog.push({ id: executed.id, name: executed.name, content: `(遺言) ${npcWill}`, day: game.dayCount });
            game.timeline.push({ type: 'chat', day: game.dayCount, id: executed.id, name: executed.name, content: npcWill, isWill: true });
        }
    }

    await Messages.safeSend(game.channel, { content: execText });
    executed.alive = false;
    executed.deathDay = game.dayCount;
    executed.deathReason = 'execution';

    offerGhostBet(game, executed);

    if (executed.role === '猫又') {
        const targets = game.players.filter((p: Player) => p.alive && p.id !== executed.id);
        if (targets.length > 0) {
            const catVictim = targets[Math.floor(Math.random() * targets.length)];
            catVictim.alive = false;
            catVictim.deathDay = game.dayCount;
            catVictim.deathReason = 'kill';

            await Messages.safeSend(game.channel, { content: `🐈 **猫又の呪い**\n**${executed.name}** は死に際に **${catVictim.name}** を道連れにしました！` });
            game.history.push(`🐈 道連れ(処刑): ${catVictim.name}`);
            game.timeline.push({ type: 'system', content: `🐈 道連れ(処刑): ${catVictim.name}` });
            offerGhostBet(game, catVictim);
            await checkLoversBond(game, catVictim);
        }
    }

    setSafeTimeout(game, async () => {
        if (executed.role === 'テルテル') { 
            const hCount = game.players.filter((p: Player) => !p.isNpc).length;
            const isRanked = game.settings.matchType === 'ranked' && hCount >= 2;
            const options = { isRanked, humanCount: hCount, npcCount: game.npcCount, mvpName: executed.name };
            
            game.winnerTeam = 'teruteru';
            finalizeTimeline(game, 'teruteru'); 
            
            game.resultSummary = buildResultSummary(game, 'teruteru');

            let deltas: Record<string, number> = {};
            try {
                const res = await DB.saveGameResults(game, 'teruteru', executed.name);
                if (res && res.deltas) deltas = res.deltas;
            } catch (e) {
                console.error("DB Save Error:", e);
            }
            
            const mvpData = calculateMVP(game, game.players, 'teruteru');
            const aiComment = AI.generateMvpComment(mvpData);
            
            let matchType = isRanked ? '🏆【ランクマッチ】' : '🔰【練習試合】';

            if (isRanked && Object.keys(deltas).length > 0) {
                matchType += '\n**📈 レート変動**\n';
                for (const [uid, delta] of Object.entries(deltas)) {
                    const p = game.players.find((pl: any) => pl.id === uid);
                    const d = delta as number; 
                    if (p) matchType += `▪ ${d > 0 ? '+' : ''}${d} pt : **${p.name}**\n`;
                }
            }
            // ここから「結果を表示します…」を消去！
            matchType += `\n\n🏅 **MVP**: ${mvpData.name} **[${mvpData.role}]**\n「${aiComment}」`;
            return endGame(game, `🃏 **テルテルの単独勝利！**\n${matchType}`); 
        }

        await checkLoversBond(game, executed);

        const mediums = game.players.filter((p: Player) => p.alive && (p.role === '霊能者' || p.isFakeMedium));
        const isFullInfo = game.settings.mediumInfo === 'full';
        
        const realExecutedRole = isFullInfo ? executed.role : (Roles.isActualWolf(executed.role as string) ? '人狼' : '人間');
        game.lastExecutionResult = { id: executed.id, isWolf: Roles.isActualWolf(executed.role as string) };

        if (mediums.length > 0) {
            for (const med of mediums) {
                let reportedRole = realExecutedRole;

                if (med.isFakeMedium) {
                    let isBlack = Math.random() < 0.5;
                    if (med.role === '狂信者' || Roles.isActualWolf(med.role as string)) {
                         isBlack = !Roles.isActualWolf(executed.role as string);
                    }
                    reportedRole = isBlack ? '人狼' : '人間';
                }

                if (med.isNpc) {
                    setTimeout(async () => {
                        await Messages.safeSend(game.channel, { content: `👻 **霊能結果**\n**${med.name}**: 「${executed.name} は **【${reportedRole}】** だ…」` });
                        
                        if (!game.chatLog) game.chatLog = [];
                        if (!game.timeline) game.timeline = []; 

                        game.chatLog.push({ id: med.id, name: med.name, content: `霊媒結果: ${executed.name} は ${reportedRole}`, day: game.dayCount });
                        game.timeline.push({ type: 'chat', day: game.dayCount, id: med.id, name: med.name, content: `霊媒結果: ${executed.name} は ${reportedRole}` });

                        if (!game.evidence) game.evidence = [];
                        game.evidence.push({ type: 'medium_co', day: game.dayCount, from: med.id, target: executed.id, result: reportedRole === '人狼', visible: true });
                    }, 1000 + Math.random() * 2000); 
                } else {
                    if (med.role === '霊能者') {
                        Messages.safeDM(med.user, { content: `👻 **霊能結果**: ${executed.name} は **【${reportedRole}】** でした。\n下のボタンを押すと公表できます。`, components: Messages.createMediumPublishRow(executed.id, executed.name, reportedRole) });
                    }
                }
            }
        }
        
        const isMediumInSettings = game.settings.roles.includes('medium');
        const fakers = game.players.filter((p: Player) => {
            if (!isMediumInSettings) return false; 
            if (!['狂人', '狂信者', '妖狐', 'テルテル', '妖術師'].includes(p.role as string) && !Roles.isActualWolf(p.role as string)) return false;
            if (!p.alive || p.isNpc) return false;
            const alreadyDivining = game.actions?.some((a: any) => a.from === p.id && a.type === 'divine') || 
                                    game.evidence?.some((e: any) => e.from === p.id && e.type === 'divine');
            const alreadyCoroner = game.evidence?.some((e: any) => e.from === p.id && e.type === 'coroner_co');
            return !(alreadyDivining || alreadyCoroner);
        });

        if (fakers.length > 0) {
            for (const faker of fakers) {
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`fakemedium_white_${executed.id}`).setLabel(`📢 【人間(白)】として公表`).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`fakemedium_black_${executed.id}`).setLabel(`📢 【人狼(黒)】として公表`).setStyle(ButtonStyle.Danger)
                );
                Messages.safeDM(faker.user, { content: `👻 **偽霊媒アクション**\n「${executed.name}」が処刑されました。霊能者を騙って結果を捏造しますか？\n（※本物の霊能者や他の騙りより先に押すと信憑性が上がります）`, components: [row] });
            }
        }

        game.history.push(`📅 ${game.dayCount}日目処刑: ${executed.name} (${executed.role})`);
        game.timeline.push({ type: 'execution', content: `📅 ${game.dayCount}日目処刑: ${executed.name} (${executed.role})` });

        if (await checkWin(game)) return;
        (game.timers = game.timers || []).push(setTimeout(() => startNightPhase(game), 2000));
    }, 1000);
}

export function offerGhostBet(game: GameState, player: Player) {
    if (game.settings.matchType !== 'ranked') return;

    if (player.isNpc || !player.user) return;
    player.betDeadline = Date.now() + 90 * 1000;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('bet_villager').setLabel('村人陣営に賭ける').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bet_wolf').setLabel('人狼陣営に賭ける').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('bet_other').setLabel('第三陣営に賭ける').setStyle(ButtonStyle.Secondary)
    );

    Messages.safeDM(player.user, { 
        content: `👻 **死んでも終わりではありません！**\nどちらの陣営が勝つか「賭け」をしませんか？\n予想が当たれば、**敗北時のレート減少がほんの少しだけ免除** されます！\n\n**⚠️ 締め切り: 90秒以内**`,
        components: [row]
    }).then(success => {
        if (!success && game.channel) Messages.safeSend(game.channel, `⚠ ${player.name} さん、DMが送れませんでした。`);
    });
}

export async function startNightPhase(game: GameState) {
    game.actions = []; game.cursedTarget = null; const nightTime = 30000;
    const isFirstNightPeace = game.dayCount === 1 && game.settings.firstNightPeace;

    if (!game.timeline) game.timeline = [];
    game.timeline.push({ type: 'phase', content: `🌙 NIGHT ${game.dayCount}`, detail: '夜のフェーズ' });

    if (game.dayCount === 1) {
        const freemasons = game.players.filter((p: Player) => p.role === '共有者');
        if (freemasons.length >= 2) {
            const names = freemasons.map((p: Player) => p.name).join(' と ');
            freemasons.forEach((fm: any) => {
                if (!fm.isNpc) Messages.safeDM(fm.user, `👥 **共有者の顔合わせ**\n今回の共有者（絶対に村人陣営の仲間）は、**${names}** です！\n協力して村を導きましょう。`);
            });
        }
    }

    const textMsg = `🌑 **夜が訪れました。** (${nightTime/1000}秒)`;
    await Messages.safeSend(game.channel, { content: textMsg });

    let fugitiveTargetId: string | null = null;
    let protectionTargetId: string | null = null;
    let wolfVictimId: string | null = null;

    const aliveHumans = game.players.filter((p: Player) => !p.isNpc && p.alive);
    const dmCollectors: any[] = [];

    // 各プレイヤーにDMを送信して個別のコレクターを設定
    for (const p of aliveHumans) {
        let mainContent = '🌙 今夜は特に行動はありません。夜が明けるのをお待ちください。';
        let mainComponents: any[] = [];
        let fakeContent: string | null = null;
        let fakeComponents: any[] = [];

        const hasActed = (type: string) => game.actions.some((a: any) => a.type === type && a.from === p.id);

        if (p.role === '怪盗' && game.dayCount === 1) {
            if (hasActed('steal')) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.id !== p.id);
                mainContent = '🕵️ **怪盗アクション**: 役職を盗む相手を選んでください。';
                mainComponents = Messages.createButtonRows(targets, 'thief', ButtonStyle.Primary);
            }
        }
        else if (p.role === 'キューピッド' && game.dayCount === 1) {
            if (game.lovers.length > 0) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => true);
                mainContent = '💘 **恋人の指名**: 2人のプレイヤーを選んでください。';
                mainComponents = Messages.getCupidSelection(targets);
            }
        }
        else if (p.role === '神' && !game.hasGodUsedPower) {
            const deadPlayers = game.players.filter((pl: Player) => !pl.alive);
            if (deadPlayers.length > 0) {
                mainContent = '✨ **神の奇跡**\n今夜、死者の中から1人を蘇生させることができます。(1回使い切り)';
                mainComponents = Messages.createButtonRows(deadPlayers, 'god_revive', ButtonStyle.Success);
                mainComponents.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('god_skip').setLabel('今夜は蘇生しない').setStyle(ButtonStyle.Secondary)));
            } else {
                mainContent = '✨ 蘇生できる死者がいません。';
            }
        }
        else if (p.role === '純愛者' && game.dayCount === 1) {
            if (game.devoteeTarget) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.id !== p.id);
                mainContent = '❤️‍🔥 **純愛者の指名**\n愛するプレイヤーを1人選んでください。';
                mainComponents = Messages.createButtonRows(targets, 'devotee', ButtonStyle.Danger);
            }
        }
        else if (p.role === '逃亡者') {
            if (fugitiveTargetId) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                mainContent = '🏃‍♂️ **逃亡アクション**\n今夜、誰の家に泊まりに行きますか？';
                mainComponents = Messages.createButtonRows(targets, 'fugitive', ButtonStyle.Success);
            }
        }
        else if (Roles.isActualWolf(p.role as string)) {
            if (isFirstNightPeace) {
                mainContent = '🐺 初日は襲撃できません。(平和村設定)';
            } else {
                if (wolfVictimId) {
                    mainContent = '✅ 今夜の襲撃先は既に決定しています。(仲間の人狼が選択済み)';
                } else {
                    const targets = game.players.filter((pl: Player) => !Roles.isActualWolf(pl.role as string) && pl.alive);
                    mainContent = '🐺 **襲撃先を選択:**';
                    mainComponents = Messages.createButtonRows(targets, 'kill', ButtonStyle.Secondary);
                }
            }
            
            const isSeerInSettings = game.settings.roles.includes('seer');
            const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
            if (isSeerInSettings && !alreadyFakingMedium) {
                if (hasActed('divine')) {
                    fakeContent = '✅ 偽占いアクションは完了しています。';
                } else {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    fakeContent = '🃏 **偽占いアクション**\n占い師を騙る場合、ターゲットを選んでください。';
                    fakeComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
            }
        }
        else if (p.role === '占い師') {
            if (hasActed('divine')) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                mainContent = '🔮 **占い行動**\n対象を選択してください。';
                mainComponents = Messages.createNightActionRows(targets, 'divine', '占い師');
            }
        }
        else if (p.role === '妖術師') {
            if (hasActed('sorcery')) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                mainContent = '🔮 **妖術アクション**\n正体を見抜く相手を選んでください。';
                mainComponents = Messages.createButtonRows(targets, 'sorcery', ButtonStyle.Secondary);
            }

            const isSeerInSettings = game.settings.roles.includes('seer');
            const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
            if (isSeerInSettings && !alreadyFakingMedium) {
                if (hasActed('divine')) {
                    fakeContent = '✅ 偽占いアクションは完了しています。';
                } else {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    fakeContent = '🃏 **偽占いアクション**\n占い師を騙る場合、ターゲットを選んでください。';
                    fakeComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
            }
        }
        else if (p.role === '騎士') {
            if (protectionTargetId) { mainContent = '✅ 行動済みです。'; }
            else {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id && (!game.settings.continuousGuard ? pl.id !== p.lastGuarded : true));
                if (targets.length > 0) {
                    mainContent = '🛡️ **護衛先を選択:**';
                    mainComponents = Messages.createButtonRows(targets, 'guard', ButtonStyle.Success);
                } else {
                    mainContent = '🛡️ 連続で守れる相手がいません…今夜は誰も守れません。';
                }
            }
        }
        else {
            const isSeerInSettings = game.settings.roles.includes('seer');
            const canFake = isSeerInSettings && ['狂人', '狂信者', '妖狐', 'テルテル', '猫又'].includes(p.role as string);
            const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
            
            if (canFake && !alreadyFakingMedium) {
                if (hasActed('divine')) {
                    mainContent = '✅ 偽占いアクションは完了しています。';
                } else {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    mainContent = '🃏 **偽占いアクション**\n占い師を騙る場合、ターゲットを選んでください。';
                    mainComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
            }
        }

        try {
            if (!p.user) continue;
            
            // DMチャンネル自体にコレクターを張ることで、複数メッセージのボタンに対応
            const dmChannel = await p.user.createDM();
            const dmCollector = dmChannel.createMessageComponentCollector({ time: nightTime });
            dmCollectors.push(dmCollector);

            // ① メインアクションの送信
            await dmChannel.send({ content: mainContent, components: mainComponents });

            // ② サブアクション（騙り等）があれば別メッセージで送信
            if (fakeContent) {
                await dmChannel.send({ content: fakeContent, components: fakeComponents });
            }

            dmCollector.on('collect', async (i: any) => {
                if (i.customId === 'strategy_hide') { p.hideStrategy = true; return i.update({ content: '🕶️ 潜伏モードに変更しました。', components: [] }).catch(()=>{}); }
                if (i.customId === 'strategy_co') { p.hideStrategy = false; return i.update({ content: '📢 即COモードに変更しました。', components: [] }).catch(()=>{}); }
                if (i.customId === 'god_skip') { game.hasGodUsedPower = true; return i.update({ content: '✨ 今夜は奇跡を見送りました。', components: [] }).catch(()=>{}); }
                
                if (i.customId.startsWith('fakeresult_')) {
                    const isBlack = i.customId.includes('black');
                    // 修正: NPCのIDが途切れないように replace を使用
                    const targetId = i.customId.replace('fakeresult_white_', '').replace('fakeresult_black_', '');
                    const t = game.players.find((pl: Player) => pl.id === targetId);
                    
                    if (t) {
                        game.actions.push({ type: 'divine', from: p.id, target: targetId, result: isBlack });
                        return i.update({ content: `🃏 **偽結果**: ${t.name} を **${isBlack ? '人狼🐺' : '人間👤'}** としました。`, components: [] }).catch(()=>{});
                    } else {
                        // 万が一見つからなかった場合でもボタンが固まらないようにエラーを返す
                        return i.reply({ content: '⚠️ エラー：対象プレイヤーが見つかりませんでした。', ephemeral: true }).catch(()=>{});
                    }
                }


                const getTarget = (i: any) => {
                    const val = i.isStringSelectMenu?.() ? i.values[0] : i.customId;
                    return game.players.find((pl: Player) => val.includes(pl.id));
                };
                const target = getTarget(i);
                if (!target && !i.customId.startsWith('fakeresult_')) return;

                if (i.customId.startsWith('thief_')) {
                    const stolenRole = target.role; target.role = '村人'; p.role = stolenRole;
                    game.actions.push({ type: 'steal', from: p.id, target: target.id, result: stolenRole });
                    await i.update({ content: `🕵️ 成功: **${target.name}** から **【${stolenRole}】** を盗みました！\nあなたは今から **${stolenRole}** です。`, components: [] }).catch(()=>{});
                    if (!target.isNpc) Messages.safeDM(target.user, `⚠ **怪盗被害**: あなたの役職は何者かに盗まれました。\nあなたは今から **【村人】** です。`);
                }
                else if (i.customId.startsWith('god_revive_')) {
                    game.hasGodUsedPower = true;
                    game.actions.push({ type: 'revive', from: p.id, target: target.id, result: true });
                    return i.update({ content: `✨ **${target.name}** に生命を吹き込みます。`, components: [] }).catch(()=>{});
                }
                else if (i.customId.startsWith('devotee_')) {
                    game.devoteeTarget = target.id;
                    return i.update({ content: `❤️‍🔥 **${target.name}** を愛する人に選びました。\n彼らの勝利のため、影からサポートしましょう。`, components: [] }).catch(()=>{});
                }
                else if (i.customId.startsWith('fugitive_')) {
                    fugitiveTargetId = target.id;
                    return i.update({ content: `🏃‍♂️ 今夜は **${target.name}** の家に逃げ込みます。`, components: [] }).catch(()=>{});
                }
                else if (i.customId.startsWith('kill_')) {
                    wolfVictimId = target.id;
                    return i.update({ content: `🩸 **${target.name}** をターゲットにしました。`, components: [] }).catch(()=>{});
                }
                else if (i.customId.startsWith('divine_')) {
                    if (p.role === '占い師') {
                        if (target.role === '妖狐') game.cursedTarget = target.id;
                        const isWolfResult = Roles.isActualWolf(target.role as string);
                        game.actions.push({ type: 'divine', from: p.id, target: target.id, result: isWolfResult });
                        return i.update({ content: `🔮 結果: ${target.name} は **${isWolfResult ? '人狼🐺' : '人間👤'}** です。`, components: [] }).catch(()=>{});
                    } else {
                        // 偽占いアクションの場合は、結果選択メニューに更新
                        return i.update({ content: `🎯 **${target.name}** に出す結果を選択:`, components: Messages.createFakeResultRows(target.id, target.name) }).catch(()=>{});
                    }
                }
                else if (i.customId.startsWith('sorcery_')) {
                    game.actions.push({ type: 'sorcery', from: p.id, target: target.id, result: target.role });
                    return i.update({ content: `🔮 結果: ${target.name} の正体は **【${target.role}】** です。`, components: [] }).catch(()=>{});
                }
                else if (i.customId.startsWith('guard_')) {
                    protectionTargetId = target.id;
                    return i.update({ content: `🛡️ **${target.name}** を護衛します。`, components: [] }).catch(()=>{});
                }
            });
        } catch (e) {
            console.error("Night DM Error for", p.name, e);
            Messages.safeSend(game.channel, `⚠ **${p.name}** さんにDMが送信できませんでした。サーバーのプライバシー設定を確認してください。`);
        }
    }

    (game.timers = game.timers || []).push(setTimeout(() => {
        dmCollectors.forEach(c => c.stop());

        let extraVictims: string[] = [];

        const thief = game.players.find((p: Player) => p.role === '怪盗' && p.alive);
        const cupid = game.players.find((p: Player) => p.role === 'キューピッド' && p.alive);
        const devotee = game.players.find((p: Player) => p.role === '純愛者' && p.alive);
        const fugitive = game.players.find((p: Player) => p.role === '逃亡者' && p.alive);
        const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive);
        const seer = game.players.find((p: Player) => p.role === '占い師' && p.alive);
        const sorcerer = game.players.find((p: Player) => p.role === '妖術師' && p.alive);
        const guard = game.players.find((p: Player) => p.role === '騎士' && p.alive);
        const targets = game.players.filter((p: Player) => !Roles.isActualWolf(p.role as string) && p.alive);

        if (game.dayCount === 1) {
            if (thief) {
                const acted = game.actions.some((a: any) => a.type === 'steal' && a.from === thief.id);
                if (!acted) {
                    const sTargets = game.players.filter((p: Player) => p.alive && p.id !== thief.id);
                    if (sTargets.length > 0) {
                        const t = sTargets[Math.floor(Math.random() * sTargets.length)];
                        const stolenRole = t.role; t.role = '村人'; thief.role = stolenRole;
                        game.actions.push({ type: 'steal', from: thief.id, target: t.id, result: stolenRole });
                        if (!thief.isNpc) Messages.safeDM(thief.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${t.name}** から役職を盗みました。\n今からあなたは **${stolenRole}** です。`);
                        if (!t.isNpc) Messages.safeDM(t.user, `⚠ **怪盗被害**: あなたの役職は盗まれました。\nあなたは今から **【村人】** です。`);
                    }
                }
            }
            if (cupid && game.lovers.length === 0) {
                const idx = [...Array(game.players.length).keys()];
                const l1 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
                const l2 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
                game.lovers = [l1.id, l2.id];
                if (!cupid.isNpc) Messages.safeDM(cupid.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${l1.name}** と **${l2.name}** を恋人にしました。`);
                if (!l1.isNpc) Messages.safeDM(l1.user, `💘 恋人に選ばれました！相手: ${l2.name}`);
                if (!l2.isNpc) Messages.safeDM(l2.user, `💘 恋人に選ばれました！相手: ${l1.name}`);
            }
            if (devotee && !game.devoteeTarget) {
                const dTargets = game.players.filter((p: Player) => p.id !== devotee.id);
                if (dTargets.length > 0) {
                    game.devoteeTarget = dTargets[Math.floor(Math.random() * dTargets.length)].id;
                    const selectedName = game.players.find((p: Player) => p.id === game.devoteeTarget)?.name;
                    if (!devotee.isNpc) Messages.safeDM(devotee.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${selectedName}** を愛する人に選びました。`);
                }
            }
        }

        if (fugitive && fugitive.alive && !fugitiveTargetId) {
            const fTargets = game.players.filter((p: Player) => p.alive && p.id !== fugitive.id);
            if (fTargets.length > 0) {
                fugitiveTargetId = fTargets[Math.floor(Math.random() * fTargets.length)].id;
                if (!fugitive.isNpc) Messages.safeDM(fugitive.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${game.players.find((p:any)=>p.id===fugitiveTargetId)?.name}** の家に逃亡しました。`);
            }
        }

        if (seer && seer.alive) {
            const acted = game.actions.some((a: any) => a.type === 'divine' && a.from === seer.id);
            if (!acted) {
                const sTargets = game.players.filter((p: Player) => p.alive && p.id !== seer.id);
                if (sTargets.length > 0) {
                    const t = sTargets[Math.floor(Math.random() * sTargets.length)];
                    if (t.role === '妖狐') game.cursedTarget = t.id;
                    const isWolfResult = Roles.isActualWolf(t.role as string);
                    game.actions.push({ type: 'divine', from: seer.id, target: t.id, result: isWolfResult });
                    if (!seer.isNpc) Messages.safeDM(seer.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${t.name}** を占いました。\n結果: **${isWolfResult ? '人狼🐺' : '人間👤'}**`);
                }
            }
        }

        if (sorcerer && sorcerer.alive) {
            const acted = game.actions.some((a: any) => a.type === 'sorcery' && a.from === sorcerer.id);
            if (!acted) {
                const sTargets = game.players.filter((p: Player) => p.alive && p.id !== sorcerer.id);
                if (sTargets.length > 0) {
                    const t = sTargets[Math.floor(Math.random() * sTargets.length)];
                    game.actions.push({ type: 'sorcery', from: sorcerer.id, target: t.id, result: t.role });
                    if (!sorcerer.isNpc) Messages.safeDM(sorcerer.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${t.name}** の正体を見抜きました。\n正体: **${t.role}**`);
                }
            }
        }

        if (guard && guard.alive) {
            if (!protectionTargetId) {
                const gTargets = game.players.filter((p: Player) => p.alive && p.id !== guard.id && (!game.settings.continuousGuard ? p.id !== guard.lastGuarded : true));
                if (gTargets.length > 0) {
                    protectionTargetId = gTargets[Math.floor(Math.random() * gTargets.length)].id;
                    if (!guard.isNpc) Messages.safeDM(guard.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${game.players.find((p: Player)=>p.id===protectionTargetId)?.name}** を護衛しました。`);
                }
            }
            guard.lastGuarded = protectionTargetId;
        }

        const humanWolves = wolves.filter((w: any) => !w.isNpc);
        if (!wolfVictimId && wolves.length > 0 && !isFirstNightPeace) {
            if (targets.length > 0) {
                wolfVictimId = targets[Math.floor(Math.random() * targets.length)].id;
                const v = game.players.find((p: Player) => p.id === wolfVictimId);
                humanWolves.forEach((w: any) => { Messages.safeDM(w.user, `⏳ **時間切れ！** (強制アクション)\nランダムに **${v?.name}** を襲撃します。`); });
            }
        }

        let guardSuccess = (protectionTargetId !== null && protectionTargetId === wolfVictimId);
        if (wolfVictimId) {
            const v = game.players.find((p: Player) => p.id === wolfVictimId);
            if (v && v.role === '妖狐') wolfVictimId = null;
        }
        if (guardSuccess) wolfVictimId = null;

        if (fugitive && fugitive.alive && fugitiveTargetId) {
            const target = game.players.find((p: Player) => p.id === fugitiveTargetId);
            if (target && Roles.isActualWolf(target.role as string)) extraVictims.push(fugitive.id);
            else if (wolfVictimId === fugitiveTargetId) extraVictims.push(fugitive.id);
            if (wolfVictimId === fugitive.id) wolfVictimId = fugitiveTargetId;
        }

        game.players.forEach((p: Player) => {
            if (p.role === 'タフガイ' && p.alive) {
                if (p.fatalWound) extraVictims.push(p.id);
                else if (wolfVictimId === p.id) { p.fatalWound = true; wolfVictimId = null; }
            }
        });

        game.actions.forEach(act => { game.timeline.push({ type: 'action', detail: act.type, day: game.dayCount, from: act.from, target: act.target, result: act.result }); });
        
        if (guard && guard.alive && protectionTargetId) game.timeline.push({ type: 'action', detail: 'guard', day: game.dayCount, from: guard.id, target: protectionTargetId, result: protectionTargetId === wolfVictimId });
        
        if (wolfVictimId) {
            const wFrom = humanWolves.length > 0 ? humanWolves[0].id : (wolves.length > 0 ? wolves[0].id : 'Unknown');
            game.timeline.push({ type: 'action', detail: 'kill', day: game.dayCount, from: wFrom, target: wolfVictimId, result: !guardSuccess });
        }

        if (fugitive && fugitive.alive && fugitiveTargetId) game.timeline.push({ type: 'action', detail: 'fugitive', day: game.dayCount, from: fugitive.id, target: fugitiveTargetId, result: true });
        
        if (game.dayCount === 1 && game.lovers && game.lovers.length === 2) {
            const cFrom = cupid ? cupid.id : 'GM';
            game.timeline.push({ type: 'action', detail: 'cupid', day: game.dayCount, from: cFrom, target: game.lovers[0], result: game.lovers[1] });
        }
        
        if (game.dayCount === 1 && game.devoteeTarget) {
            const dFrom = devotee ? devotee.id : 'GM';
            game.timeline.push({ type: 'action', detail: 'devotee', day: game.dayCount, from: dFrom, target: game.devoteeTarget, result: true });
        }

        startMorningPhase(game, wolfVictimId, guardSuccess, extraVictims);
    }, nightTime));
}

async function startMorningPhase(game: GameState, victimId: string | null, guardSuccess: boolean, extraVictims: string[] = []) { 
    let deadNames: string[] = [];
    let allVictimIds = new Set<string>();
    if (!game.timeline) game.timeline = []; 
    
    if (victimId) allVictimIds.add(victimId);
    extraVictims.forEach(id => allVictimIds.add(id));

    for (const vId of allVictimIds) {
        const v = game.players.find((p: Player) => p.id === vId);
        if (v && v.alive) { 
            v.alive = false;
            v.deathDay = game.dayCount;
            v.deathReason = 'kill';

            deadNames.push(v.name);
            game.history.push(`🌑 死亡: ${v.name}`); 
            game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 死亡: ${v.name}` });
            offerGhostBet(game, v); 
            await checkLoversBond(game, v);

            if (v.role === '猫又' && vId === victimId) {
                const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive);
                if (wolves.length > 0) {
                    const wolfVictim = wolves[Math.floor(Math.random() * wolves.length)];
                    wolfVictim.alive = false;
                    wolfVictim.deathDay = game.dayCount;
                    wolfVictim.deathReason = 'kill';

                    deadNames.push(wolfVictim.name);
                    game.history.push(`🐈 道連れ(襲撃): ${wolfVictim.name}`);
                    game.timeline.push({ type: 'death', day: game.dayCount, content: `🐈 道連れ(襲撃): ${wolfVictim.name}` });
                    offerGhostBet(game, wolfVictim);
                    await checkLoversBond(game, wolfVictim);
                    
                    if (!game.chatLog) game.chatLog = [];
                    game.chatLog.push({ id: 'GM', name: 'GM', content: `猫又の反撃: 人狼 ${wolfVictim.name} を道連れ。`, day: game.dayCount });
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: 'GM', name: 'GM', content: `猫又の反撃: 人狼 ${wolfVictim.name} を道連れ。` });
                }
            }
        } 
    }

    if (game.cursedTarget) { 
        const c = game.players.find((p: Player) => p.id === game.cursedTarget);
        if (c && c.alive) { 
            c.alive = false;
            c.deathDay = game.dayCount;
            c.deathReason = 'sudden_death';

            deadNames.push(c.name); 
            game.history.push(`🌑 呪殺: ${c.name}`); 
            game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 呪殺: ${c.name}` });
            offerGhostBet(game, c); await checkLoversBond(game, c);
        } 
    } 
    
    const coroner = game.players.find((p: Player) => p.role === '検死官' && p.alive);
    if (coroner && deadNames.length > 0) {
        let coronerReport = "🔍 **検死レポート**\n昨晩の死者の正体は以下の通りです：\n";
        deadNames.forEach(dName => {
            const deadPlayer = game.players.find((p: Player) => p.name === dName);
            if (deadPlayer) coronerReport += `▪ ${dName} ➔ **【${deadPlayer.role}】**\n`;
        });
        game.coronerReport = coronerReport; 
        
        if (coroner.isNpc) {
            setSafeTimeout(game, async () => {
                await Messages.safeSend(game.channel, { content: `------------------------\n🔍 **検死官の報告**\n**${coroner.name}**: 「死者たちの本当の役職が判明した…！」\n\n${coronerReport}` });
                if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: coroner.id, name: coroner.name, content: `検死結果公表\n\n${coronerReport}`, day: game.dayCount });
               
                game.timeline.push({ type: 'chat', day: game.dayCount, id: coroner.id, name: coroner.name, content: `検死結果公表\n\n${coronerReport}` });

                if (!game.evidence) game.evidence = [];
                game.evidence.push({ type: 'coroner_co', day: game.dayCount, from: coroner.id, target: 'all', result: true, visible: true });
            }, 2000 + Math.random() * 3000);
        } else {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('coroner_publish').setLabel('📢 検死結果を公表する').setStyle(ButtonStyle.Success)
            );
            Messages.safeDM(coroner.user, { content: coronerReport, components: [row] });
        }
    }

    const isCoronerInSettings = game.settings.roles.includes('coroner');
    const fakers = game.players.filter((p: Player) => {
        if (!isCoronerInSettings) return false; 
        if (!['狂人', '狂信者', '妖狐', 'テルテル', '妖術師'].includes(p.role as string) && !Roles.isActualWolf(p.role as string)) return false;
        if (!p.alive || p.isNpc) return false;
        const alreadyDivining = game.actions?.some((a: any) => a.from === p.id && a.type === 'divine') || 
                                game.evidence?.some((e: any) => e.from === p.id && e.type === 'divine');
        const alreadyMedium = game.evidence?.some((e: any) => e.from === p.id && e.type === 'medium_co');
        return !(alreadyDivining || alreadyMedium);
    });

    if (fakers.length > 0 && deadNames.length > 0) {
        for (const faker of fakers) {
            const fakeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('fakecoroner_open_modal').setLabel('📢 【偽】検死結果をでっちあげる').setStyle(ButtonStyle.Danger)
            );
            Messages.safeDM(faker.user, { content: `🔍 **偽検死官アクション**\n昨晩の死者の正体をでっちあげて、村を混乱させますか？\n(死者ごとに役職を指定できます。フォーマットは自動で完璧に整えられます)`, components: [fakeRow] });
        }
    }

    let morningText = `------------------------\n`;
    if (deadNames.length > 0) {
        morningText += `昨晩、**${deadNames.join('** と **')}** が無残な姿で発見されました…`;
    } else {
        morningText += guardSuccess ? `🛡️ 騎士の活躍により、昨晩は犠牲者が出ませんでした！` : `🕊️ 昨晩は誰も襲われませんでした。`;
        game.timeline.push({ type: 'death', day: game.dayCount, content: guardSuccess ? '🛡️ 誰も死ななかった (騎士の護衛成功)' : '🕊️ 誰も死ななかった (平和な朝)' });
    }
    await Messages.safeSend(game.channel, { content: morningText }); 

    const reviveAct = game.actions.find((a: any) => a.type === 'revive');
    if (reviveAct) {
        const revivedPlayer = game.players.find((p: Player) => p.id === reviveAct.target);
        if (revivedPlayer) {
            revivedPlayer.alive = true;
            revivedPlayer.deathDay = undefined;
            revivedPlayer.deathReason = undefined;
            
            await Messages.safeSend(game.channel, { content: `------------------------\n✨ **神の奇跡**\nなんと…！天からの光が差し込み、死の淵から **${revivedPlayer.name}** が蘇りました！` });
            
            game.history.push(`✨ 蘇生: ${revivedPlayer.name} (神の奇跡)`);
            game.timeline.push({ type: 'system', content: `✨ 蘇生: ${revivedPlayer.name} (神の奇跡)` });
        }
    }
    
    (game.timers = game.timers || []).push(setTimeout(async () => { if (await checkWin(game)) return; startDayPhase(game); }, 2000));
}

async function checkLoversBond(game: GameState, deadPlayer: any) { 
    if (game.lovers && game.lovers.includes(deadPlayer.id)) { 
        const pId = game.lovers.find((id: string) => id !== deadPlayer.id);
        const p = game.players.find((pl: any) => pl.id === pId); 
        if (p && p.alive) { 
            p.alive = false;
            p.deathDay = game.dayCount;
            p.deathReason = 'sudden_death';

            await Messages.safeSend(game.channel, { content: `------------------------\n💔 **後追い自殺**\n恋人を失った **${p.name}** も命を絶ちました。` }); 
            game.history.push(`💔 後追い: ${p.name}`);
            if (!game.timeline) game.timeline = [];
            game.timeline.push({ type: 'death', day: game.dayCount, content: `💔 後追い: ${p.name}` }); 

            offerGhostBet(game, p);
        } 
    } 
}

function buildResultSummary(game: GameState, winner: string) {
    const getTeam = (role: string = '') => {
        if (role === "妖狐") return "fox";
        if (role === "テルテル") return "teruteru";
        const team = Roles.ROLE_CATALOG[role]?.team;
        if (team === 'wolf') return 'wolf';
        return "village";
    };

    const summary = {
        total_days: game.dayCount,
        winner_team: winner,
        players: {} as Record<string, any>
    };

    game.players.forEach((p: Player) => {
        let team = getTeam(p.role);
        if (game.lovers && game.lovers.includes(p.id)) team = "lovers"; 

        summary.players[p.id] = {
            name: p.name,
            role: p.role || '不明',
            team: team,
            is_alive: !!p.alive,
            death_day: p.alive ? null : (p.deathDay || null),
            death_reason: p.alive ? null : (p.deathReason || null)
        };
    });
    return summary;
}

async function checkWin(game: GameState) {
    const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive).length;
    const humans = game.players.filter((p: Player) => !Roles.isActualWolf(p.role as string) && p.alive).length;
    
    const fox = game.players.find((p: Player) => p.role === '妖狐' && p.alive);
    const loversAlive = game.players.filter((p: Player) => p.alive && game.lovers && game.lovers.includes(p.id)).length === 2;
    
    let winner: string | null = null, message = '';
    
    if (wolves === 0) {
        if (fox) { winner = 'fox'; message = '🦊 **妖狐の独り勝ち！**'; }
        else if (loversAlive) { winner = 'lovers'; message = '💘 **恋人の勝利！**\n(村の平和よりも愛を選びました)'; }
        else { winner = 'villager'; message = '🎉 **村人チームの勝利！**'; }
    } else if (wolves >= humans) {
        if (fox) { winner = 'fox'; message = '🦊 **妖狐の独り勝ち！**'; }
        else if (loversAlive) { winner = 'lovers'; message = '💘 **恋人の勝利！**\n(混乱に乗じて駆け落ちしました)'; }
        else { winner = 'wolf'; message = '🐺 **人狼チームの勝利！**'; }
    }
    
    if (winner) { 
        game.winnerTeam = winner;
        const humanCount = game.players.filter((p: Player) => !p.isNpc).length;
        const isRanked = game.settings.matchType === 'ranked' && humanCount >= 2;
        const mvpData = calculateMVP(game, game.players, winner);
        const options = { isRanked, humanCount, npcCount: game.npcCount, mvpName: mvpData.name };
        const logForAi = game.chatLog || [];

        finalizeTimeline(game, winner);

        game.resultSummary = buildResultSummary(game, winner);

        let deltas: Record<string, number> = {};
        try {
            const res = await DB.saveGameResults(game, winner, mvpData.name);
            if (res && res.deltas) deltas = res.deltas;
        } catch (e) {
            console.error("DB Save Error:", e);
        }
        
        const aiComment = AI.generateMvpComment(mvpData);
        let matchType = isRanked ? '🏆【ランクマッチ】' : '🔰【練習試合】';
        if (isRanked && Object.keys(deltas).length > 0) {
            matchType += '\n**📈 レート変動**\n';
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
                    matchType += `▪ ${d > 0 ? '+' : ''}${d} pt : **${p.name}**${infoStr}\n`;
                }
            }
        }
        // ここから「結果を表示します…」を消去！
        matchType += `\n\n🏅 **MVP**: ${mvpData.name} **[${mvpData.role}]**\n「${aiComment}」`;
        endGame(game, `${message}\n${matchType}`); 
        return true; 
    }
    return false;
}

function calculateMVP(game: GameState, players: any[], winningTeam: string) {
    if (!players || players.length === 0) {
        return { name: 'Unknown', role: 'Unknown', reason: 'データなし' };
    }

    let scores = players.map(p => ({ id: p.id, name: p.name, role: p.role, score: 0, reasons: [] as string[] }));
    players.forEach((p, i) => {
        let isWin = false;
        
        const checkWinCondition = (role: string, id: string) => {
            if (winningTeam === 'lovers') return game.lovers && game.lovers.includes(id);
            if (winningTeam === 'fox') return role === '妖狐';
            if (winningTeam === 'teruteru') return role === 'テルテル';
            return Roles.ROLE_CATALOG && Roles.ROLE_CATALOG[role]?.team === winningTeam;
        };

        if (game.lovers && game.lovers.includes(p.id)) {
            isWin = (winningTeam === 'lovers');
        } else if (p.role === '純愛者' && game.devoteeTarget) {
            const target = players.find(pl => pl.id === game.devoteeTarget);
            if (target) isWin = checkWinCondition(target.role, target.id);
        } else {
            isWin = checkWinCondition(p.role as string, p.id);
        }
        
        if (p.role === 'キューピッド' && winningTeam === 'lovers') isWin = true;
        
        if (isWin) { 
            scores[i].score += 100; 
            if (p.alive) scores[i].score += 50; 
            if (p.role === '純愛者') scores[i].reasons.push('愛する人が勝利');
        }
    });
    
    if (game.actions) {
        game.actions.forEach((a: any) => {
            const idx = scores.findIndex(s => s.id === a.from);
            if (idx !== -1 && a.type === 'divine' && a.result === true) {
                scores[idx].score += 30; scores[idx].reasons.push('人狼発見');
            }
        });
    }

    const guard = players.find(p => p.role === '騎士');
    if (guard) {
        const idx = scores.findIndex(s => s.id === guard.id);
        const safeNights = game.history.filter((h: string) => h.includes('昨晩は誰も襲われませんでした')).length;
        if (safeNights > 0) { scores[idx].score += 40 * safeNights; scores[idx].reasons.push(`護衛成功x${safeNights}`);
        }
    }

    if (winningTeam === 'wolf') {
        players.filter(p => Roles.isActualWolf(p.role as string) && p.alive).forEach(w => {
            const idx = scores.findIndex(s => s.id === w.id);
            if(idx !== -1) { scores[idx].score += 30; }
        });
    }

    scores.sort((a, b) => b.score - a.score);
    const mvp = scores[0];
    const reasonText = mvp.reasons.length > 0 ? mvp.reasons.join(', ') : '勝利への貢献';
    return { name: mvp.name, role: mvp.role, reason: reasonText };
}

function finalizeTimeline(game: any, winner: string) {
    if (game.timelineFinalized) return; 
    game.timelineFinalized = true;
    if (!game.timeline) game.timeline = [];

    let winName = winner === 'villager' ? '村人チーム' : 
                  winner === 'wolf' ? '人狼チーム' : 
                  winner === 'fox' ? '妖狐' : 
                  winner === 'lovers' ? '恋人' : 
                  winner === 'teruteru' ? 'テルテル' : '引き分け';

    game.history.push(`🏆 勝敗: ${winName}の勝利！`);
    game.timeline.push({ type: 'winner', content: `${winName}の勝利！` });
    game.players.forEach((p: Player) => {
        game.history.push(`🎭 役職公開: ${p.name} <${p.id}> (${p.role})`);
        game.timeline.push({ type: 'system', content: `🎭 役職公開: ${p.name} <${p.id}> (${p.role})` });
    });
    game.timeline.push({ type: 'system', content: 'MATCH END: リプレイ終了' });
}

async function endGame(game: GameState, text: string) { 
    if (game.gayaInterval) {
        clearInterval(game.gayaInterval);
        game.gayaInterval = null;
    }
    if (game.timers && game.timers.length > 0) {
        game.timers.forEach(t => clearTimeout(t));
        game.timers = [];
    }

    if (!game.timeline) game.timeline = []; 

    let winName = game.winnerTeam === 'villager' ? '村人チーム' : 
                  game.winnerTeam === 'wolf' ? '人狼チーム' : 
                  game.winnerTeam === 'fox' ? '妖狐' : 
                  game.winnerTeam === 'lovers' ? '恋人' : 
                  game.winnerTeam === 'teruteru' ? 'テルテル' : '引き分け';
                  
    // タイムラインが未完了の場合はここで書き込む
    if (!game.timelineFinalized) {
        game.history.push(`🏆 勝敗: ${winName}の勝利！`);
        game.timeline.push({ type: 'winner', content: `${winName}の勝利！` });
        
        game.players.forEach(p => {
            game.history.push(`🎭 役職公開: ${p.name} <${p.id}> (${p.role})`);
            game.timeline.push({ type: 'system', content: `🎭 役職公開: ${p.name} <${p.id}> (${p.role})` });
        });

        game.timeline.push({ type: 'system', content: 'MATCH END: リプレイ終了' });
        game.timelineFinalized = true;
    }

    // 1段目：「結果を表示します…」のアナウンスだけを送信
    try {
        await Messages.safeSend(game.channel, { content: "結果を表示します…" });
    } catch (e) {
        console.error("EndGame MVP Send Error:", e);
    }

    // 2段目：詳細な結果と履歴を合体させて送信（少しだけ間をあける）
    (game.timers = game.timers || []).push(setTimeout(() => { 
        let historyStr = game.history.filter((h: string) => !h.startsWith('🏆') && !h.startsWith('🎭')).join('\n') || "(記録なし)";
        if (historyStr.length > 1900) {
            historyStr = "(ログが長すぎるため省略します)";
        }

        let playersList = "";
        game.players.forEach((p: Player) => {
            const status = p.alive ? '生存' : '死亡';
            playersList += `**${p.name}** : ${p.role} (${status})\n`;
        });

        // ここで勝敗(text)とリストをガッチャンコ！
        const resultText = `------------------------\n${text}\n\n📘 **【最終結果】**\n${playersList}\n📜 **【記録】**\n${historyStr}`;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents( 
            new ButtonBuilder().setCustomId('game_rematch').setLabel('🔁 再戦').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('game_force_reset').setLabel('リセット').setStyle(ButtonStyle.Secondary)
        );

        try {
            game.channel.send({ content: resultText, components: [row] });

            const currentChannel = game.channel as any;
            if (currentChannel && currentChannel.name && currentChannel.name.startsWith('🐺人狼村')) {
                currentChannel.send('☕ **【試合終了 / 感想戦】**\nお疲れ様でした！この専用チャンネルは、感想戦のために**「5分後」に自動的にクローズ（削除）**されます。\n(※誰かが「再戦」を押した場合は削除がキャンセルされ、この部屋をそのまま使って次の村が始まります！)');

                setTimeout(async () => {
                    try {
                        const { getGame } = require('./state');
                        const checkGame = getGame(currentChannel.id);
                        
                        if (checkGame && checkGame.state !== 'idle') {
                            console.log('🔄 再戦が開始されたため、チャンネル削除をキャンセルしました！');
                            return; 
                        }

                        await currentChannel.delete('人狼ゲーム終了による自動削除');
                    } catch (err) {
                        console.error('チャンネルの削除に失敗しました:', err);
                    }
                }, 5 * 60 * 1000); 
            }

        } catch (e) {
            console.error("EndGame Send Error:", e);
            Messages.safeSend(game.channel, "結果表示中にエラーが発生しましたが、ゲームは終了しました。");
        }
        
        game.state = 'idle';
        setTimeout(() => {
            try {
                const { resetGame } = require('./state');
                const g = require('./state').getGame(game.channel.id);
                if (g && g.state === 'idle') {
                    resetGame(game.channel.id, true);
                    console.log(`[🧹お掃除] 放置されたロッカー(${game.channel.id})を消去しました`);
                }
            } catch(e) { console.error(e); }
        }, 60 * 60 * 1000);
    }, 2000)); 
}