// src/states/VotePhase.ts
import { Phase } from './Phase';
import { GameState, Player } from '../types';
import { TIMING, MSG, UI, fill } from '../gameConfig';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as Messages from '../messages';
import * as Roles from '../roles';
import * as NPC from '../npcLogic';

// phase.tsから切り出したヘルパー群（別ファイルにある想定）
import { 
    kickFromWolfChannel, 
    offerGhostBet, 
    checkLoversBond, 
    checkNecromancerBond, 
    checkWin 
} from '../phaseUtils'; 

export class VotePhase implements Phase {
    readonly name = 'vote';

    public async onEnter(game: GameState): Promise<string | void> {
        return new Promise(async (resolve) => {
            const alivePlayers = game.players.filter((p: Player) => p.alive);
            
            // 決選投票かどうかの判定
            let voteTargets = alivePlayers;
            if (game.isRevote && game.revoteCandidates && game.revoteCandidates.length > 0) {
                voteTargets = alivePlayers.filter((p: Player) => game.revoteCandidates!.includes(p.id));
            }

            // 投票ボタンの作成
            const rows = Messages.createButtonRows(voteTargets, 'vote');
            if (!game.isRevote) {
                const passRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('vote_skip').setLabel(UI.vote.skipButton).setStyle(ButtonStyle.Secondary)
                );
                // 独裁者のボタン追加
                const dictator = alivePlayers.find((p: Player) => p.role === '独裁者');
                if (dictator && !game.hasDictatorUsedPower) {
                    passRow.addComponents(
                        new ButtonBuilder().setCustomId('dictator_co').setLabel(UI.vote.dictatorButton).setStyle(ButtonStyle.Danger)
                    );
                }
                rows.push(passRow);
            }
            
            const voteTimeLimit = game.isRevote ? TIMING.revoteTimeLimit : TIMING.voteTimeLimit;
            const textMsg = fill(game.isRevote ? MSG.vote.revotePrompt : MSG.vote.prompt, { seconds: voteTimeLimit / 1000 });
            
            const votes: Record<string, string> = {};
            let votingFinished = false;

            // ★ NPCの投票ロジック（独裁者の突然CO含む）
            this.setupNpcVotes(game, alivePlayers, votes, votingFinished, resolve);

            // メッセージ送信（分断中かどうかで分岐）
            let voteMsg: any = null, voteMsgA: any = null, voteMsgB: any = null;
            if (!game.collectors) game.collectors = [];

            if (game.dividedGroups && game.sectorAChannel && game.sectorBChannel) {
                voteMsgA = await game.sectorAChannel.send({ content: textMsg, components: rows });
                voteMsgB = await game.sectorBChannel.send({ content: textMsg, components: rows });
                game.collectors.push(voteMsgA.createMessageComponentCollector({ time: voteTimeLimit }));
                game.collectors.push(voteMsgB.createMessageComponentCollector({ time: voteTimeLimit }));
            } else {
                voteMsg = await game.channel.send({ content: textMsg, components: rows });
                game.collectors.push(voteMsg.createMessageComponentCollector({ time: voteTimeLimit }));
            }

            const aliveHumans = alivePlayers.filter((p: Player) => !p.isNpc).length;
            if (aliveHumans === 0) {
                // 人間がいない場合はNPCの投票時間経過後に強制終了
                const timer = setTimeout(() => game.collectors?.forEach(c => { try{c.stop();}catch(e){} }), TIMING.npcVoteDelay);
                if (!game.timers) game.timers = [];
                game.timers.push(timer);
            }

            let endedCollectors = 0;

            // コレクターのイベントハンドリング（投票受付）
            game.collectors.forEach(collector => {
                collector.on('collect', async (i: any) => { 
                    if (i.replied || i.deferred) return; 

                    // --- 人間の独裁者CO処理 ---
                    if (i.customId === 'dictator_co') {
                        const p = game.players.find((pl: Player) => pl.id === i.user.id);
                        if (!p || p.role !== '独裁者') return i.reply({ content: MSG.vote.dictatorNoAuth, ephemeral: true });
                        if (game.hasDictatorUsedPower) return i.reply({ content: MSG.vote.dictatorAlreadyUsed, ephemeral: true });
                        
                        const dTargets = alivePlayers.filter((pl: Player) => pl.id !== p.id);
                        const btnRows = Messages.createButtonRows(dTargets, 'dictator_exec', ButtonStyle.Danger);
                        
                        const dictatorMsg = await i.reply({ 
                            content: MSG.vote.dictatorSelectPrompt, 
                            components: btnRows, ephemeral: true, fetchReply: true 
                        });
                        
                        try {
                            const execI = await dictatorMsg.awaitMessageComponent({ filter: (int: any) => int.user.id === i.user.id, time: voteTimeLimit });
                            if (execI.customId.startsWith('dictator_exec_')) {
                                game.hasDictatorUsedPower = true;
                                game.dictatorTarget = execI.customId.replace('dictator_exec_', '');
                                alivePlayers.forEach((pl: Player) => { votes[pl.id] = game.dictatorTarget as string; }); 
                                game.collectors?.forEach(c => { try{c.stop('dictator');}catch(e){} });
                                return execI.update({ content: MSG.vote.dictatorUsed, components: [] }).catch(()=>{});
                            }
                        } catch (err) {}
                        return;
                    }
                    
                    // --- 通常の投票処理 ---
                    if (!game.players.find((p: Player) => p.id === i.user.id && p.alive)) return i.reply({content: MSG.vote.deadVoteError, ephemeral:true});
                    if (votes[i.user.id]) return i.reply({content: MSG.vote.alreadyVoted, ephemeral:true});
                    
                    const targetId = i.customId.replace('vote_', '');
                    votes[i.user.id] = targetId;
                    const targetName = targetId === 'skip' ? 'パス' : game.players.find((p: Player) => p.id === targetId)?.name || '不明';
                    
                    i.reply({ content: fill(MSG.vote.voteConfirm, { target: targetName }), ephemeral: true });
                    
                    if (game.settings.autoFinishVoting) {
                        const votedHumans = Object.keys(votes).filter(id => !game.players.find((p: Player) => p.id === id)?.isNpc).length;
                        if (votedHumans >= aliveHumans) game.collectors?.forEach(c => { try{c.stop();}catch(e){} });
                    }
                });

                // コレクター終了時の処理（集計へ移行）
                collector.on('end', async () => { 
                    endedCollectors++;
                    if (endedCollectors >= game.collectors.length && !votingFinished) {
                        votingFinished = true; 
                        
                        if (voteMsg) voteMsg.edit({ components: [] }).catch(()=>{});
                        if (voteMsgA) voteMsgA.edit({ components: [] }).catch(()=>{});
                        if (voteMsgB) voteMsgB.edit({ components: [] }).catch(()=>{});

                        // 分断されていた場合は合流処理
                        if (game.dividedGroups && game.sectorAChannel && game.sectorBChannel) {
                            await this.mergeSectors(game);
                        }
                        
                        // ★ 集計メソッドへ移行 (終わったらresolveで次のフェーズ名が返る)
                        await this.tallyVotes(game, votes, resolve);
                    }
                });
            });
        });
    }

    public async onExit(game: GameState): Promise<void> {
        // GameMachine側で全タイマー・コレクターをクリアするので基本は空でOK
    }

    // ==========================================
    // 内部メソッド群（クラス化により綺麗に分離）
    // ==========================================

    private setupNpcVotes(game: GameState, alivePlayers: Player[], votes: Record<string, string>, votingFinished: boolean, resolve: (phase: string) => void) {
        game.players.filter((p: Player) => p.isNpc && p.alive).forEach((npc: any) => {
            if (!game.isRevote && game.dayCount === 1 && Math.random() > 0.1) { votes[npc.id] = 'skip'; return; }
            if (game.isRevote && game.revoteCandidates) {
                votes[npc.id] = game.revoteCandidates[Math.floor(Math.random() * game.revoteCandidates.length)];
                return;
            }
            
            const voteInfo = NPC.getNpcVoteTarget(npc, game);
            const targetId = typeof voteInfo === 'string' ? voteInfo : voteInfo.targetId;
            votes[npc.id] = targetId || 'skip';

            // NPC独裁者の能力発動ロジック
            if (npc.role === '独裁者' && !game.hasDictatorUsedPower && !game.isRevote && targetId !== 'skip') {
                const pTone = npc.personality || 'normal';
                let useChance = 0.2;
                if (pTone === 'aggressive' || pTone === 'joker') useChance = 0.6;
                if (pTone === 'gal') useChance = 0.5;
                if (pTone === 'cautious') useChance = 0.05;

                if (Math.random() < useChance) {
                    const timer = setTimeout(async () => {
                        if (votingFinished) return; 
                        
                        game.hasDictatorUsedPower = true;
                        game.dictatorTarget = targetId;
                        const targetName = game.players.find((p: Player) => p.id === targetId)?.name || '不明';

                        let coMsg = `「ごちゃごちゃウルセェ！俺がルールだ！ ${targetName} を処刑する！」`;
                        if (pTone === 'logical') coMsg = `「議論は不要です。私の権限により、${targetName} を処刑します。」`;
                        if (pTone === 'gal') coMsg = `「てかマジ長話ダルいんですけどー！アタシ独裁者だから ${targetName} 処刑でよろ！💅」`;
                        if (pTone === 'witty') coMsg = `「ククッ、哀れな羊どもめ。俺様が独裁者だ。${targetName}、お前が死ね。」`;
                        if (pTone === 'cautious') coMsg = `「もう耐えられない…！僕が独裁者だ！お願いだから ${targetName} を処刑してくれ！」`;
                        if (pTone === 'serious') coMsg = `「静粛に。私に一任してもらおう。独裁者の権限で ${targetName} を処刑する。」`;

                        const announce = `🗡️ **${npc.name} が【独裁者】をCO！**\n${coMsg}`;
                        
                        if (game.dividedGroups && game.sectorAChannel && game.sectorBChannel) {
                            await Messages.safeSend(game.sectorAChannel, { content: announce }).catch(()=>{});
                            await Messages.safeSend(game.sectorBChannel, { content: announce }).catch(()=>{});
                        } else {
                            await Messages.safeSend(game.channel, { content: announce }).catch(()=>{});
                        }

                        alivePlayers.forEach((pl: Player) => { votes[pl.id] = targetId; }); 
                        game.collectors?.forEach(c => { try{c.stop('dictator');}catch(e){} });
                    }, 2000 + Math.random() * 5000);
                    
                    if (!game.timers) game.timers = [];
                    game.timers.push(timer);
                }
            }
        });
    }

    private async mergeSectors(game: GameState) {
        try {
            await game.sectorAChannel.delete('分断解除').catch(()=>{});
            await game.sectorBChannel.delete('分断解除').catch(()=>{});
            await game.channel.permissionOverwrites.edit(game.channel.guild.roles.everyone, { ViewChannel: true });
            
            game.sectorAChannel = undefined; game.sectorBChannel = undefined; game.dividedGroups = null;

            let syncText = MSG.morning.sectorMerge;
            let syncInfos = [];
            const deadToday = game.players.filter(p => !p.alive && p.deathDay === (game.dayCount - 1) && p.deathReason === 'kill');
            if (deadToday.length > 0) {
                syncInfos.push(fill(MSG.morning.sectorDeadSync, { names: deadToday.map(p => p.name).join('** と **') }));
            } else {
                syncInfos.push(MSG.morning.sectorPeaceSync);
            }

            if (game.coronerReport) syncInfos.push(game.coronerReport);
            syncText += syncInfos.join('\n\n');
            
            await Messages.safeSend(game.channel, { content: syncText });
            await new Promise(resolve => setTimeout(resolve, TIMING.sectorMergeDelay));
        } catch (e) { console.error("合流エラー:", e); }
    }

    private async tallyVotes(game: GameState, votes: Record<string, string>, resolve: (phase: string) => void) {
        let tally: Record<string, number> = {};
        if (!game.voteLog) game.voteLog = [];
        if (!game.timeline) game.timeline = []; 

        game.voteLog.push({ day: game.dayCount, votes: { ...votes } });
        game.timeline.push({ type: 'vote', day: game.dayCount, data: { ...votes } });

        // 市長の2票計算
        Object.entries(votes).forEach(([voterId, targetId]) => {
            const voter = game.players.find((p: Player) => p.id === voterId);
            const voteWeight = (voter && voter.role === '市長') ? 2 : 1;
            tally[targetId] = (tally[targetId] || 0) + voteWeight;
        });

        let tallyMsg = '';
        const sorted = Object.entries(tally).sort(([, a], [, b]) => b - a);

        // 独裁者の処理
        if (game.dictatorTarget) {
            const dictator = game.players.find((p: Player) => p.role === '独裁者');
            const target = game.players.find((p: Player) => p.id === game.dictatorTarget);
            const dText = fill(MSG.vote.dictatorExec, { dictator: dictator?.name || '', target: target?.name || '' });
            await Messages.safeSend(game.channel, { content: dText });
            game.history.push(`​🗡️ 独裁者CO: ${dictator?.name} が ${target?.name} を処刑`);
            game.timeline.push({ type: 'system', content: `​🗡️ 独裁者CO: ${dictator?.name} が ${target?.name} を処刑` });
            game.dictatorTarget = undefined;
        } else {
            // 通常の集計表示
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
            await Messages.safeSend(game.channel, { content: `${MSG.vote.tallyTitle}\n${tallyMsg.trim()}` });
        }

        // 処刑見送り
        if (sorted.length === 0 || sorted[0][0] === 'skip') {
            game.isRevote = false;
            await Messages.safeSend(game.channel, { content: MSG.vote.noExecution });
            game.history.push(`📅 ${game.dayCount}日目: 処刑なし`);
            game.timeline.push({ type: 'system', content: `📅 ${game.dayCount}日目: 処刑なし` });
            return resolve('night'); // 夜へ
        }
        
        // ターゲットの決定と決選投票判定
        const max = sorted[0][1];
        const candidates = sorted.filter(s => s[1] === max).map(s => s[0]);
        let executedId;

        if (candidates.length > 1) {
            if (game.settings.tieVoteHandling === 'revote' && !game.isRevote) {
                await Messages.safeSend(game.channel, { content: MSG.vote.tieRevote });
                game.isRevote = true; game.revoteCandidates = candidates;
                return resolve('vote'); // もう一度投票フェーズへ！
            } 
            else if (game.settings.tieVoteHandling === 'random' || (game.settings.tieVoteHandling === 'revote' && game.isRevote)) {
                executedId = candidates[Math.floor(Math.random() * candidates.length)];
                await Messages.safeSend(game.channel, { content: fill(MSG.vote.randomExecution, { name: game.players.find((p: Player)=>p.id===executedId)?.name || '' }) });
            } 
            else {
                await Messages.safeSend(game.channel, { content: MSG.vote.tieNoExecution });
                game.history.push(`📅 ${game.dayCount}日目: 処刑なし (同票)`);
                game.timeline.push({ type: 'system', content: `📅 ${game.dayCount}日目: 処刑なし (同票)` });
                game.isRevote = false;
                return resolve('night'); // 夜へ
            }
        } else {
            executedId = candidates[0];
        }

        game.isRevote = false; 

        if (executedId === 'skip') { 
            await Messages.safeSend(game.channel, { content: MSG.vote.noExecution });
            return resolve('night'); // 夜へ
        }

        // 処刑実行！
        const executed = game.players.find((p: Player) => p.id === executedId)!;
        await Messages.safeSend(game.channel, { content: fill(MSG.vote.executedAnnounce, { name: executed.name }) });
        
        let execText = fill(MSG.vote.executedLog, { name: executed.name });

        // 遺言の収集
        if (game.settings.willMode) {
            if (!executed.isNpc) {
                await Messages.safeSend(game.channel, fill(MSG.vote.willRequest, { name: executed.name, seconds: TIMING.willTimeLimit / 1000 }));
                try { 
                    const collected = await game.channel.awaitMessages({ filter: (m: any) => m.author.id === executed.id, max: 1, time: TIMING.willTimeLimit, errors: ['time'] });
                    const willText = collected.first().content;
                    execText += `\n> 「${willText}」`; 
                    if (!game.chatLog) game.chatLog = [];
                    game.chatLog.push({ id: executed.id, name: executed.name, content: `(遺言) ${willText}`, day: game.dayCount });
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: executed.id, name: executed.name, content: willText, isWill: true });
                } catch (e) { execText += `\n${MSG.vote.willSilence}`; }
            } else { 
                const npcWill = MSG.npcWills[Math.floor(Math.random() * MSG.npcWills.length)];
                execText += `\n> 「${npcWill}」`; 
                if (!game.chatLog) game.chatLog = [];
                game.chatLog.push({ id: executed.id, name: executed.name, content: `(遺言) ${npcWill}`, day: game.dayCount });
                game.timeline.push({ type: 'chat', day: game.dayCount, id: executed.id, name: executed.name, content: npcWill, isWill: true });
            }
        }

        await Messages.safeSend(game.channel, { content: execText });
        executed.alive = false;
        kickFromWolfChannel(game, executed.id);
        executed.deathDay = game.dayCount;
        executed.deathReason = 'execution';

        offerGhostBet(game, executed);

        // 猫又の道連れ
        if (executed.role === '猫又') {
            const targets = game.players.filter((p: Player) => p.alive && p.id !== executed.id);
            if (targets.length > 0) {
                const catVictim = targets[Math.floor(Math.random() * targets.length)];
                catVictim.alive = false;
                kickFromWolfChannel(game, catVictim.id);
                catVictim.deathDay = game.dayCount;
                catVictim.deathReason = 'kill';

                await Messages.safeSend(game.channel, { content: fill(MSG.vote.catCurse, { executed: executed.name, victim: catVictim.name }) });
                game.history.push(`🐈‍⬛ 道連れ(処刑): ${catVictim.name}`);
                game.timeline.push({ type: 'system', content: `🐈‍⬛ 道連れ(処刑): ${catVictim.name}` });
                offerGhostBet(game, catVictim);
                await checkLoversBond(game, catVictim);
                await checkNecromancerBond(game, catVictim);
            }
        }

        // 処刑後ディレイと終了処理
        const timer = setTimeout(async () => {
            // テルテル勝利チェック
            if (executed.role === 'テルテル') { 
                // 勝敗が決まった場合は end フェーズへ移行
                if (await checkWin(game)) {
                    return resolve('end'); 
                }
            }

            await checkLoversBond(game, executed);
            await checkNecromancerBond(game, executed);

            game.lastExecutionResult = { id: executed.id, isWolf: Roles.isActualWolf(executed.role as string) };
            game.history.push(`📅 ${game.dayCount}日目処刑: ${executed.name} (${executed.role})`);
            game.timeline.push({ type: 'execution', content: `📅 ${game.dayCount}日目処刑: ${executed.name} (${executed.role})` });

            // 誰かの勝利条件を満たしたかチェック
            if (await checkWin(game)) return resolve('end'); 
            
            // 何もなければ夜フェーズへ
            resolve('night');

        }, TIMING.afterExecutionDelay);

        if (!game.timers) game.timers = [];
        game.timers.push(timer);
    }
}
