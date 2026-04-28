// src/states/NightPhase.ts
import { Phase } from './Phase';
import { GameState, Player } from '../types';
import { TIMING, MSG, fill } from '../gameConfig';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import * as Messages from '../messages';
import * as Roles from '../roles';
import * as AI from '../aiUtils';

// 夜フェーズ内で共有・更新するための状態インターフェース
interface NightState {
    fugitiveTargetId: string | null;
    protectionTargetId: string | null;
    wolfVictimId: string | null;
    dmCollectors: any[];
    wolfMainMessages: Record<string, any>;
}

export class NightPhase implements Phase {
    readonly name = 'night';

    public async onEnter(game: GameState): Promise<string | void> {
        return new Promise(async (resolve) => {
            game.actions = []; 
            game.cursedTarget = null; 
            const nightTime = TIMING.nightTime;
            const isFirstNightPeace = game.dayCount === 1 && game.settings.firstNightPeace;

            if (!game.timeline) game.timeline = [];
            game.timeline.push({ type: 'phase', content: `🌙 NIGHT ${game.dayCount}`, detail: '夜のフェーズ' });

            if (game.dayCount === 1) {
                const freemasons = game.players.filter((p: Player) => p.role === '共有者');
                if (freemasons.length >= 2) {
                    const names = freemasons.map((p: Player) => p.name).join(' と ');
                    freemasons.forEach((fm: any) => {
                        if (!fm.isNpc) Messages.safeDM(fm.user, fill(MSG.roleActions.freemasonIntro, { names }));
                    });
                }
            }

            await Messages.safeSend(game.channel, { content: fill(MSG.night.nightStart, { seconds: nightTime / 1000 }) });

            // この夜フェーズの進行中だけ保持するステートオブジェクト
            const nightState: NightState = {
                fugitiveTargetId: null,
                protectionTargetId: null,
                wolfVictimId: null,
                dmCollectors: [],
                wolfMainMessages: {}
            };

            const npcWolves = game.players.filter((p: Player) => p.isNpc && (Roles.isActualWolf(p.role as string) || p.role === '分断者'));

            // 1. AI軍師のブリーフィング
            this.handleAIBriefing(game, npcWolves);

            // 2. NPC作戦指示盤の設置
            this.setupNpcStrategyPanel(game, npcWolves, nightTime);

            // 3. 人間プレイヤーへのアクションDM送信と受付
            await this.sendRoleActionDMs(game, nightState, isFirstNightPeace, nightTime);

            // 4. 夜明け（タイムアウト）の処理
            const timer = setTimeout(() => {
                nightState.dmCollectors.forEach(c => { try { c.stop(); } catch (e) {} });

                // 未行動者の強制アクション処理、犠牲者計算
                const { guardSuccess, extraVictims } = this.processEndOfNightActions(game, nightState, isFirstNightPeace);

                // 朝フェーズに引き継ぐためのデータを game に一時保存
                (game as any).nightResults = {
                    victimId: nightState.wolfVictimId,
                    guardSuccess: guardSuccess,
                    extraVictims: extraVictims
                };

                resolve('morning');
            }, nightTime);

            if (!game.timers) game.timers = [];
            game.timers.push(timer);
        });
    }

    public async onExit(game: GameState): Promise<void> {
        // GameMachine側でクリアされるため基本空でOK
    }

    // ==========================================
    // 内部メソッド群（ロジック完全移植）
    // ==========================================

    private handleAIBriefing(game: GameState, npcWolves: Player[]) {
        if (game.dayCount === 1 && game.wolfChannel) {
            (async () => {
                try {
                    let speakerName = "AI軍師";
                    let isNpc = false; let personality = "normal";
                    let speakerObj: Player | undefined;

                    if (npcWolves.length > 0) {
                        speakerObj = npcWolves[Math.floor(Math.random() * npcWolves.length)];
                        speakerName = speakerObj.name; isNpc = true; personality = speakerObj.personality || "normal";
                    }
                    
                    let briefing = await AI.generateWolfBriefing(game, speakerName, isNpc, personality);
                    
                    if (isNpc && speakerObj) {
                        speakerObj.isFakeSeer = false; speakerObj.isFakeMedium = false; speakerObj.isHiding = true;
                        if (briefing.includes('[SEER]')) { speakerObj.isFakeSeer = true; speakerObj.isHiding = false; }
                        else if (briefing.includes('[MEDIUM]')) { speakerObj.isFakeMedium = true; speakerObj.isHiding = false; }
                        else if (briefing.includes('[HIDE]')) { speakerObj.isHiding = true; }
                        briefing = briefing.replace(/\[SEER\]|\[MEDIUM\]|\[HIDE\]/g, '').trim();
                    }
                    
                    if (isNpc) {
                        await Messages.safeSend(game.wolfChannel, `**${speakerName}**\n「${briefing}」`);
                    } else {
                        await Messages.safeSend(game.wolfChannel, `🤖 **AI軍師の初夜ブリーフィング**\n${briefing}`);
                    }
                } catch (e) { console.error("AIブリーフィングエラー", e); }
            })();
        }
    }

    private setupNpcStrategyPanel(game: GameState, npcWolves: Player[], nightTime: number) {
        if (npcWolves.length > 0 && game.wolfChannel) {
            const components: any[] = [];
            const aliveVillagers = game.players.filter((p: Player) => p.alive && !Roles.isActualWolf(p.role as string) && p.role !== '分断者');
            
            npcWolves.forEach(npc => {
                components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder().setCustomId(`npc_strat_${npc.id}`)
                        .setPlaceholder(`🎭 ${npc.name} の騙り方針を指示`)
                        .addOptions([
                            { label: '🔮 占い師を騙らせる', value: `claim_seer` },
                            { label: '👻 霊能者を騙らせる', value: `claim_medium` },
                            { label: '🥷 潜伏させる（騙らない）', value: `claim_hide` }
                        ])
                ));
                if (npc.role === '分断者' && aliveVillagers.length > 0 && !game.hasDividerUsedPower) {
                    const divOptions = aliveVillagers.map((p: Player) => ({ label: `🌀 ${p.name} を隔離する`, value: `divide_${p.id}` }));
                    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                        new StringSelectMenuBuilder().setCustomId(`npc_div_${npc.id}`)
                            .setPlaceholder(`🌀 ${npc.name}(分断者) のターゲットを指示`)
                            .addOptions(divOptions.slice(0, 25))
                    ));
                }
            });

            game.wolfChannel.send({ content: '⚙️ **【NPC作戦指示盤】**', components }).then((panelMsg: any) => {
                const collector = panelMsg.createMessageComponentCollector({ time: nightTime });
                if (!game.collectors) game.collectors = [];
                game.collectors.push(collector);
                
                collector.on('collect', async (i: any) => {
                    const val = i.values[0];
                    const targetNpcId = i.customId.replace('npc_strat_', '').replace('npc_div_', '');
                    const targetNpc = game.players.find((p: Player) => p.id === targetNpcId);
                    
                    if (!targetNpc) return i.reply({ content: 'NPCが見つかりません', ephemeral: true });
                    const pTone = targetNpc.personality || 'normal';

                    if (i.customId.startsWith('npc_div_')) {
                        const usedThisNight = game.actions.some((a: any) => a.type === 'divide' && a.from === targetNpcId);
                        if (game.hasDividerUsedPower && !usedThisNight) {
                            return i.reply({ content: '⚠️ 分断者の能力は既に別の夜に使用済みです（1ゲーム1回のみ）。', ephemeral: true });
                        }

                        const targetPlayerId = val.replace('divide_', '');
                        const targetPlayer = game.players.find((p: Player) => p.id === targetPlayerId);
                        
                        game.hasDividerUsedPower = true;
                        game.actions = game.actions.filter((a: any) => !(a.type === 'divide' && a.from === targetNpcId));
                        game.actions.push({ type: 'divide', from: targetNpcId, target: targetPlayerId, result: true });
                        
                        let divReply = `「了解だ。今夜は ${targetPlayer?.name || '不明'} を隔離するぜ。」`;
                        if (pTone === 'aggressive') divReply = `「${targetPlayer?.name}だな！？絶対逃がさねぇ、俺の部屋に引きずり込んでやる！」`;
                        if (pTone === 'gal') divReply = `「おけー！${targetPlayer?.name}をアタシの部屋に拉致るね！マジウケるｗ」`;
                        if (pTone === 'logical') divReply = `「承知しました。${targetPlayer?.name} の隔離が戦術的に有効と判断します。」`;
                        if (pTone === 'witty') divReply = `「ククッ…哀れな ${targetPlayer?.name}。今夜は俺と2人きりだ。」`;
                        
                        return i.reply({ content: `**${targetNpc.name}**\n${divReply}`, ephemeral: false });
                    }
                    
                    targetNpc.isFakeSeer = false; targetNpc.isFakeMedium = false; targetNpc.isHiding = false;
                    let roleName = '潜伏';
                    if (val === 'claim_seer') { targetNpc.isFakeSeer = true; roleName = '占い師'; }
                    else if (val === 'claim_medium') { targetNpc.isFakeMedium = true; roleName = '霊能者'; }
                    else if (val === 'claim_hide') { targetNpc.isHiding = true; }

                    let replyMsg = `「了解した。俺は${roleName}で行くぜ。」`;
                    if (pTone === 'aggressive') replyMsg = `「オラァ！俺が${roleName}として引っ掻き回してやんよ！」`;
                    if (pTone === 'gal') replyMsg = `「りょ！アタシが${roleName}やればいっしょ！まかせとけー！」`;
                    if (pTone === 'logical') replyMsg = `「了解しました。私が${roleName}として振る舞うのが最適解ですね。」`;
                    if (pTone === 'witty') replyMsg = `「ククッ、御意。俺様の${roleName}の演技で、愚かな村人どもを騙してやろう。」`;
                    if (pTone === 'joker') replyMsg = `「ヒャッハー！俺が${roleName}やっちゃうぜ〜！」`;
                    if (pTone === 'cautious') replyMsg = `「わかった…${roleName}だね。バレないように気をつけるよ。」`;
                    if (pTone === 'serious') replyMsg = `「承知した。我が${roleName}の任、全うしよう。」`;

                    return i.reply({ content: `**${targetNpc.name}**\n${replyMsg}`, ephemeral: false });
                });
            });
        }
    }

    private async sendRoleActionDMs(game: GameState, nightState: NightState, isFirstNightPeace: boolean, nightTime: number) {
        const aliveHumans = game.players.filter((p: Player) => !p.isNpc && p.alive);
        
        for (const p of aliveHumans) {
            let mainContent: string | null = null, fakeContent: string | null = null;
            let mainComponents: any[] = [], fakeComponents: any[] = [];
            const hasActed = (type: string) => game.actions.some((a: any) => a.type === type && a.from === p.id);

            if (p.role === '怪盗' && game.dayCount === 1) {
                if (!hasActed('steal')) {
                    const targets = game.players.filter((pl: Player) => pl.id !== p.id);
                    mainContent = MSG.night.roles.thief; mainComponents = Messages.createButtonRows(targets, 'thief', ButtonStyle.Primary);
                }
            }
            else if (p.role === 'キューピッド' && game.dayCount === 1) {
                if (game.lovers.length === 0) {
                    const targets = game.players.filter((pl: Player) => true);
                    mainContent = MSG.night.roles.cupid; mainComponents = Messages.getCupidSelection(targets);
                }
            }
            else if (p.role === '死霊術師' && !game.hasNecromancerUsedPower) {
                const deadPlayers = game.players.filter((pl: Player) => !pl.alive);
                if (deadPlayers.length > 0) {
                    mainContent = '🧟 **死霊術師の能力**\n今夜、死者の中から1人を選んで蘇生させることができます。（1ゲーム1回のみ）\n※あなたが死亡した場合、蘇生した者も道連れになります。';
                    mainComponents = Messages.createButtonRows(deadPlayers, 'necro_revive', ButtonStyle.Success);
                    mainComponents.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('necro_skip').setLabel('今は蘇生しない').setStyle(ButtonStyle.Secondary)));
                }
            }
            else if (p.role === '暗殺者') {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                if (targets.length > 0) {
                    mainContent = '🌒 **暗殺アクション**\n毎晩、誰かを暗殺できます。「村人陣営」を撃つとショックで自分も死ぬので注意。使わない場合は無視してください。';
                    mainComponents = Messages.createButtonRows(targets, 'assassinate', ButtonStyle.Danger);
                }
            }
            else if (p.role === '純愛者' && game.dayCount === 1) {
                if (!game.devoteeTarget) {
                    const targets = game.players.filter((pl: Player) => pl.id !== p.id);
                    mainContent = MSG.night.roles.devotee; mainComponents = Messages.createButtonRows(targets, 'devotee', ButtonStyle.Danger);
                }
            }
            else if (p.role === '逃亡者') {
                if (!nightState.fugitiveTargetId) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    mainContent = MSG.night.roles.fugitive; mainComponents = Messages.createButtonRows(targets, 'fugitive', ButtonStyle.Success);
                }
            }
            else if (Roles.isActualWolf(p.role as string)) {
                if (isFirstNightPeace) {
                    mainContent = MSG.night.roles.wolfFirstNight;
                } else {
                    if (nightState.wolfVictimId) {
                        mainContent = MSG.night.roles.wolfAlreadyChosen || '🐺 すでに他の人狼が襲撃対象を決定しました。';
                    } else {
                        const targets = game.players.filter((pl: Player) => !Roles.isActualWolf(pl.role as string) && pl.alive);
                        mainContent = MSG.night.roles.wolfKillPrompt || '🐺 今夜の襲撃対象を選んでください。（※先着順）'; 
                        mainComponents = Messages.createButtonRows(targets, 'kill', ButtonStyle.Danger);
                    }
                }

                const isSeerInSettings = game.settings.roles.includes('seer');
                const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
                
                if (isSeerInSettings && !alreadyFakingMedium && !hasActed('divine')) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    fakeContent = MSG.night.roles.fakeSeer; 
                    fakeComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
                
                const isMediumInSettings = game.settings.roles.includes('medium');
                if (isMediumInSettings && game.dayCount >= 1 && !alreadyFakingMedium && !hasActed('fake_medium')) {
                    if (!fakeContent) fakeContent = '👻 **偽の霊能結果（騙り）**';
                    const fakeMedRow = new ActionRowBuilder<ButtonBuilder>();
                
                    if (game.lastExecutionResult) {
                        const exId = game.lastExecutionResult.id;
                        const exP = game.players.find((pl: Player) => pl.id === exId);
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId(`fakemedium_white_${exId}`).setLabel(`${exP?.name}を白出し`).setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`fakemedium_black_${exId}`).setLabel(`${exP?.name}を黒出し`).setStyle(ButtonStyle.Danger)
                        );
                    } else {
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId('fakemedium_co_only').setLabel('霊能者としてCOする').setStyle(ButtonStyle.Primary)
                        );
                    }
                    fakeComponents.push(fakeMedRow);
                }
            }
            else if (p.role === '占い師') {
                if (!hasActed('divine')) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    mainContent = MSG.night.roles.seer; mainComponents = Messages.createNightActionRows(targets, 'divine', '占い師');
                }
            }
            else if (p.role === '妖術師') {
                if (!hasActed('sorcery')) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    mainContent = MSG.night.roles.sorcerer; mainComponents = Messages.createButtonRows(targets, 'sorcery', ButtonStyle.Secondary);
                }
                const isSeerInSettings = game.settings.roles.includes('seer');
                const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
                
                if (isSeerInSettings && !alreadyFakingMedium && !hasActed('divine')) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    fakeContent = MSG.night.roles.fakeSeer; 
                    fakeComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
                
                const isMediumInSettings = game.settings.roles.includes('medium');
                if (isMediumInSettings && game.dayCount >= 1 && !alreadyFakingMedium && !hasActed('fake_medium')) {
                    if (!fakeContent) fakeContent = '👻 **偽の霊能結果（騙り）**';
                    const fakeMedRow = new ActionRowBuilder<ButtonBuilder>();
                
                    if (game.lastExecutionResult) {
                        const exId = game.lastExecutionResult.id;
                        const exP = game.players.find((pl: Player) => pl.id === exId);
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId(`fakemedium_white_${exId}`).setLabel(`${exP?.name}を白出し`).setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`fakemedium_black_${exId}`).setLabel(`${exP?.name}を黒出し`).setStyle(ButtonStyle.Danger)
                        );
                    } else {
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId('fakemedium_co_only').setLabel('霊能者としてCOする').setStyle(ButtonStyle.Primary)
                        );
                    }
                    fakeComponents.push(fakeMedRow);
                }
            }
            else if (p.role === '騎士') {
                if (!nightState.protectionTargetId) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id && (!game.settings.continuousGuard ? pl.id !== p.lastGuarded : true));
                    if (targets.length > 0) {
                        mainContent = MSG.night.roles.guard; mainComponents = Messages.createButtonRows(targets, 'guard', ButtonStyle.Success);
                    } else {
                        mainContent = '🛡️ 連続で守れる相手がいません…今夜は誰も守れません。';
                    }
                }
            }
            else if (p.role === '分断者' && !game.hasDividerUsedPower && !hasActed('divide')) {
                const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                mainContent = '🌀 **分断アクション**\n今夜、自分と同じ部屋に引き込みたいメンバーを1人選んでください。（残りのメンバーはランダムに2部屋に分けられます。1ゲーム1回のみ）';
                mainComponents = Messages.createButtonRows(targets, 'divider', ButtonStyle.Danger);
            }
            else if (p.role === '霊能者') {
                if (game.dayCount >= 1) {
                    const hasResult = !!game.lastExecutionResult;
                    let resultText = "【昨晩、処刑は行われませんでした】";
                    if (hasResult) {
                        const exP = game.players.find(pl => pl.id === game.lastExecutionResult!.id);
                        const resStr = game.lastExecutionResult!.isWolf ? '人狼🐺' : '人間👤';
                        resultText = `昨晩処刑された **${exP?.name}** は **【${resStr}】** でした。`;
                    }
                    mainContent = `👻 **霊能結果**\n${resultText}\n\n明日の朝、霊能者としてCOしますか？（選択しなければ自動的にCO/公表されます）`;
                    mainComponents = [
                        new ActionRowBuilder<ButtonBuilder>().addComponents(
                            new ButtonBuilder().setCustomId('strategy_co').setLabel('朝に公表する').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId('strategy_hide').setLabel('潜伏する (公表しない)').setStyle(ButtonStyle.Secondary)
                        )
                    ];
                }
            }
            else {
                const isSeerInSettings = game.settings.roles.includes('seer');
                const canFake = isSeerInSettings && ['狂人', '狂信者', '妖狐', 'テルテル'].includes(p.role as string);
                const alreadyFakingMedium = game.evidence?.some((e: any) => e.from === p.id && ['medium_co', 'coroner_co'].includes(e.type));
                
                if (canFake && !alreadyFakingMedium && !hasActed('divine')) {
                    const targets = game.players.filter((pl: Player) => pl.alive && pl.id !== p.id);
                    mainContent = MSG.night.roles.fakeSeer; 
                    mainComponents = Messages.createNightActionRows(targets, 'divine', '偽占い');
                }
                
                const isMediumInSettings = game.settings.roles.includes('medium');
                if (isMediumInSettings && canFake && game.dayCount >= 1 && !alreadyFakingMedium && !hasActed('fake_medium')) {
                    if (!mainContent) mainContent = '👻 **偽の霊能結果（騙り）**\n明日の朝、霊能者として偽証しますか？';
                    else mainContent += '\n\n👻 **偽の霊能結果（騙り）**\n霊能者として騙ることも可能です。';
                
                    const fakeMedRow = new ActionRowBuilder<ButtonBuilder>();
                
                    if (game.lastExecutionResult) {
                        const executedId = game.lastExecutionResult.id;
                        const executedPlayer = game.players.find((pl: Player) => pl.id === executedId);
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId(`fakemedium_white_${executedId}`).setLabel(`${executedPlayer?.name} を白出し`).setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`fakemedium_black_${executedId}`).setLabel(`${executedPlayer?.name} を黒出し`).setStyle(ButtonStyle.Danger)
                        );
                    } else {
                        fakeMedRow.addComponents(
                            new ButtonBuilder().setCustomId('fakemedium_co_only').setLabel('霊能者としてCOする').setStyle(ButtonStyle.Primary)
                        );
                    }
                    mainComponents.push(fakeMedRow);
                }
            }

            if (game.dayCount === 2) {
                const stolenAct = game.timeline.find((t: any) => t.type === 'action' && t.detail === 'steal' && t.target === p.id);
                if (stolenAct) {
                    if (!mainContent) mainContent = MSG.system.thiefVictimNotice;
                    else mainContent += `\n\n------------------------\n${MSG.system.thiefVictimNotice}`;
                }
            }

            try {
                if (!p.user) continue;
                if (mainContent || fakeContent) {
                    const dmChannel = await p.user.createDM();
                    const dmCollector = dmChannel.createMessageComponentCollector({ time: nightTime });
                    nightState.dmCollectors.push(dmCollector);

                    let sentMainMsg: any = null;
                    if (mainContent) {
                        sentMainMsg = await dmChannel.send({ content: mainContent, components: mainComponents });
                        if (Roles.isActualWolf(p.role as string) && !isFirstNightPeace) {
                            nightState.wolfMainMessages[p.id] = sentMainMsg;
                        }
                    }
                    
                    if (fakeContent) await dmChannel.send({ content: fakeContent, components: fakeComponents });

                    dmCollector.on('collect', async (i: any) => {
                        if (i.customId === 'strategy_hide') { 
                            p.hideStrategy = true; 
                            if (p.role === '霊能者') {
                                return i.update({ content: MSG.night.results.hideModeOn, components: [] }).catch(()=>{}); 
                            } else {
                                return i.reply({ content: (MSG.night.results.hideModeOn || '🌙 潜伏モードをONにしました。') + '\n(続けて夜のアクションを行ってください)', ephemeral: true }).catch(()=>{}); 
                            }
                        }
                        if (i.customId === 'strategy_co') { 
                            p.hideStrategy = false; 
                            if (p.role === '霊能者') {
                                return i.update({ content: MSG.night.results.coModeOn, components: [] }).catch(()=>{}); 
                            } else {
                                return i.reply({ content: (MSG.night.results.coModeOn || '☀️ 朝に公表するモードをONにしました。') + '\n(続けて夜のアクションを行ってください)', ephemeral: true }).catch(()=>{}); 
                            }
                        }
                        if (i.customId === 'necro_skip') { return i.update({ content: '🌙 今夜は死者を眠らせておきます。', components: [] }).catch(()=>{}); }
                        
                        if (i.customId.startsWith('fakemedium_')) {
                            game.actions = game.actions.filter((a: any) => !(a.type === 'fake_medium' && a.from === p.id));
                            if (i.customId === 'fakemedium_co_only') {
                                game.actions.push({ type: 'fake_medium', from: p.id, target: 'none', result: false });
                                return i.update({ content: `🎭 偽の霊能者としてCOするように設定しました。（明日の朝、公表されます）`, components: [] }).catch(()=>{});
                            } else {
                                const isBlack = i.customId.includes('_black_');
                                const executedId = i.customId.replace('fakemedium_white_', '').replace('fakemedium_black_', '');
                                game.actions.push({ type: 'fake_medium', from: p.id, target: executedId, result: isBlack });
                                const reportedRole = isBlack ? '人狼🐺' : '人間👤';
                                return i.update({ content: `🎭 偽の霊能結果を **【${reportedRole}】** に設定しました。（明日の朝、公表されます）`, components: [] }).catch(()=>{});
                            }
                        }

                        if (i.customId.startsWith('fakeresult_')) {
                            const isBlack = i.customId.includes('black');
                            const targetId = i.customId.replace('fakeresult_white_', '').replace('fakeresult_black_', '');
                            const t = game.players.find((pl: Player) => pl.id === targetId);
                            if (t) {
                                game.actions.push({ type: 'divine', from: p.id, target: targetId, result: isBlack });
                                return i.update({ content: fill(MSG.night.results.fakeResult, { target: t.name, result: isBlack ? '人狼🐺' : '人間👤' }), components: [] }).catch(()=>{});
                            } else {
                                return i.reply({ content: MSG.night.results.errorTarget, ephemeral: true }).catch(()=>{});
                            }
                        }

                        const getTarget = (i: any) => {
                            const val = i.isStringSelectMenu?.() ? i.values[0] : i.customId;
                            const parts = val.split('_');
                            const targetId = parts[parts.length - 1]; 
                            return game.players.find((pl: Player) => pl.id === targetId || val.endsWith(pl.id));
                        };
                        const target = getTarget(i);
                        if (!target && !i.customId.startsWith('fakeresult_')) return;

                        if (i.customId.startsWith('thief_')) {
                            const stolenRole = target.role; target.role = '村人'; p.role = stolenRole;
                            game.actions.push({ type: 'steal', from: p.id, target: target.id, result: stolenRole });
                            await i.update({ content: fill(MSG.night.results.thiefSuccess, { target: target.name, role: stolenRole || '' }), components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('necro_revive_')) {
                            game.hasNecromancerUsedPower = true;
                            game.necromancerTarget = target.id;
                            game.actions.push({ type: 'revive', from: p.id, target: target.id, result: true });
                            return i.update({ content: `🧟 **${target.name}** に魂を吹き込みました。（明日の朝、蘇生します）`, components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('assassinate_')) {
                            game.hasAssassinUsedPower = true;
                            game.actions.push({ type: 'assassinate', from: p.id, target: target.id, result: true });
                            return i.update({ content: `🗡️ **${target.name}** を暗殺ターゲットに設定しました。明日の朝が楽しみですね…。`, components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('devotee_')) {
                            game.devoteeTarget = target.id;
                            return i.update({ content: fill(MSG.night.results.devoteeSet, { target: target.name }), components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('fugitive_')) {
                            nightState.fugitiveTargetId = target.id;
                            return i.update({ content: fill(MSG.night.results.fugitiveHide, { target: target.name }), components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('divine_')) {
                            if (p.role === '占い師') {
                                if (target.role === '妖狐') game.cursedTarget = target.id;
                                const isWolfResult = Roles.isActualWolf(target.role as string);
                                game.actions.push({ type: 'divine', from: p.id, target: target.id, result: isWolfResult });
                                return i.update({ content: fill(MSG.night.results.seerResult, { target: target.name, result: isWolfResult ? '人狼🐺' : '人間👤' }), components: [] }).catch(()=>{});
                            } else {
                                return i.update({ content: fill(MSG.night.results.fakeSeerChoose, { target: target.name }), components: Messages.createFakeResultRows(target.id, target.name) }).catch(()=>{});
                            }
                        }
                        else if (i.customId.startsWith('sorcery_')) {
                            game.actions.push({ type: 'sorcery', from: p.id, target: target.id, result: target.role });
                            return i.update({ content: fill(MSG.night.results.sorceryResult, { target: target.name, role: target.role || '' }), components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('guard_')) {
                            nightState.protectionTargetId = target.id;
                            return i.update({ content: fill(MSG.night.results.guardSet, { target: target.name }), components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('kill_')) {
                            if (nightState.wolfVictimId) return i.update({ content: '🐺 すでに他の人狼が対象を決定済みです。', components: [] }).catch(()=>{});
                            nightState.wolfVictimId = target.id;
                            
                            if (game.wolfChannel) {
                                Messages.safeSend(game.wolfChannel, `🐺 **${p.name}** が今夜の襲撃対象を **${target.name}** に決定した！`);
                            }

                            for (const [wId, wMsg] of Object.entries(nightState.wolfMainMessages)) {
                                if (wId !== p.id && wMsg && typeof (wMsg as any).edit === 'function') {
                                    (wMsg as any).edit({ 
                                        content: `🐺 仲間の **${p.name}** が **${target.name}** を襲撃対象に決定しました！`, 
                                        components: [] 
                                    }).catch(() => {});
                                }
                            }

                            return i.update({ content: `🐺 あなたが **${target.name}** を襲撃対象に設定しました。`, components: [] }).catch(()=>{});
                        }
                        else if (i.customId.startsWith('divider_')) {
                            game.hasDividerUsedPower = true;
                            game.actions.push({ type: 'divide', from: p.id, target: target.id, result: true });
                            if (game.wolfChannel) Messages.safeSend(game.wolfChannel, fill(MSG.wolfChat.dividerAlert, { divider: p.name, target: target.name }));
                            return i.update({ content: fill(MSG.night.results.dividerSet, { target: target.name }), components: [] }).catch(()=>{});
                        }
                    });
                }
            } catch (e) {
                console.error("Night DM Error for", p.name, e);
                Messages.safeSend(game.channel, fill(MSG.system.dmFailed, { name: p.name }));
            }
        }
    }

    private processEndOfNightActions(game: GameState, nightState: NightState, isFirstNightPeace: boolean) {
        let extraVictims: string[] = [];

        const thief = game.players.find((p: Player) => p.role === '怪盗' && p.alive);
        const cupid = game.players.find((p: Player) => p.role === 'キューピッド' && p.alive);
        const devotee = game.players.find((p: Player) => p.role === '純愛者' && p.alive);
        const fugitive = game.players.find((p: Player) => p.role === '逃亡者' && p.alive);
        const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive);
        const seer = game.players.find((p: Player) => p.role === '占い師' && p.alive);
        const sorcerer = game.players.find((p: Player) => p.role === '妖術師' && p.alive);
        const guard = game.players.find((p: Player) => p.role === '騎士' && p.alive);
        const necromancer = game.players.find((p: Player) => p.role === '死霊術師' && p.alive);
        const divider = game.players.find((p: Player) => p.role === '分断者' && p.alive);
        
        const targets = game.players.filter((p: Player) => !Roles.isActualWolf(p.role as string) && p.alive);

        const assassinateAct = game.actions.find((a: any) => a.type === 'assassinate');
        if (assassinateAct) {
            const assassinId = assassinateAct.from;
            const aTargetId = assassinateAct.target as string;
            const aTarget = game.players.find((p: Player) => p.id === aTargetId);
            
            if (aTarget && aTarget.alive) {
                extraVictims.push(aTarget.id);
                const targetTeam = Roles.ROLE_CATALOG[aTarget.role as string]?.team;
                
                if (targetTeam === 'villager') {
                    extraVictims.push(assassinId);
                    assassinateAct.result = 'suicide'; 
                } else {
                    assassinateAct.result = 'success'; 
                }
            }
        }

        if (game.dayCount === 1) {
            if (thief) {
                const acted = game.actions.some((a: any) => a.type === 'steal' && a.from === thief.id);
                if (!acted && targets.length > 0) {
                    const t = targets[Math.floor(Math.random() * targets.length)];
                    const stolenRole = t.role; t.role = '村人'; thief.role = stolenRole;
                    game.actions.push({ type: 'steal', from: thief.id, target: t.id, result: stolenRole });
                    if (!thief.isNpc) Messages.safeDM(thief.user, fill(MSG.night.forced.thief, { target: t.name, role: stolenRole || '' }));
                }
            }
            if (cupid && game.lovers.length === 0) {
                const idx = [...Array(game.players.length).keys()];
                const l1 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
                const l2 = game.players[idx.splice(Math.floor(Math.random() * idx.length), 1)[0]];
                game.lovers = [l1.id, l2.id];
                if (!cupid.isNpc) Messages.safeDM(cupid.user, fill(MSG.night.forced.cupid, { l1: l1.name, l2: l2.name }));
            }
            if (devotee && !game.devoteeTarget) {
                const dTargets = game.players.filter((p: Player) => p.id !== devotee.id);
                if (dTargets.length > 0) {
                    game.devoteeTarget = dTargets[Math.floor(Math.random() * dTargets.length)].id;
                }
            }
        }

        if (fugitive && fugitive.alive && !nightState.fugitiveTargetId) {
            let fTargets = game.players.filter((p: Player) => p.alive && p.id !== fugitive.id);
            if (fTargets.length > 0) {
                if (fugitive.isNpc) {
                    const knownWhites = game.evidence.filter((e: any) => e.type === 'divine' && e.result === false && e.visible).map((e: any) => e.target);
                    const safeTargets = fTargets.filter(p => knownWhites.includes(p.id));
                    if (safeTargets.length > 0) fTargets = safeTargets;
                }
                nightState.fugitiveTargetId = fTargets[Math.floor(Math.random() * fTargets.length)].id;
                if (!fugitive.isNpc) Messages.safeDM(fugitive.user, fill(MSG.night.forced.fugitive, { target: game.players.find((p:any)=>p.id===nightState.fugitiveTargetId)?.name || '' }));
            }
        }

        if (seer && seer.alive && !game.actions.some((a: any) => a.type === 'divine' && a.from === seer.id)) {
            let sTargets = game.players.filter((p: Player) => p.alive && p.id !== seer.id);
            if (sTargets.length > 0) {
                if (seer.isNpc) {
                    const myHistory = game.evidence.filter((e: any) => e.type === 'divine' && e.from === seer.id).map((e: any) => e.target);
                    const unsearched = sTargets.filter(p => !myHistory.includes(p.id));
                    if (unsearched.length > 0) sTargets = unsearched;
                }
                const t = sTargets[Math.floor(Math.random() * sTargets.length)];
                if (t.role === '妖狐') game.cursedTarget = t.id;
                const isWolfResult = Roles.isActualWolf(t.role as string);
                game.actions.push({ type: 'divine', from: seer.id, target: t.id, result: isWolfResult });
                if (!seer.isNpc) Messages.safeDM(seer.user, fill(MSG.night.forced.seer, { target: t.name, result: isWolfResult ? '人狼🐺' : '人間👤' }));
            }
        }

        if (sorcerer && sorcerer.alive && !game.actions.some((a: any) => a.type === 'sorcery' && a.from === sorcerer.id)) {
            const sTargets = game.players.filter((p: Player) => p.alive && p.id !== sorcerer.id);
            if (sTargets.length > 0) {
                const t = sTargets[Math.floor(Math.random() * sTargets.length)];
                game.actions.push({ type: 'sorcery', from: sorcerer.id, target: t.id, result: t.role });
                if (!sorcerer.isNpc) Messages.safeDM(sorcerer.user, fill(MSG.night.forced.sorcery, { target: t.name, role: t.role || '' }));
            }
        }

        if (guard && guard.alive) {
            if (!nightState.protectionTargetId) {
                let gTargets = game.players.filter((p: Player) => p.alive && p.id !== guard.id && (!game.settings.continuousGuard ? p.id !== guard.lastGuarded : true));
                if (gTargets.length > 0) {
                    if (guard.isNpc) {
                        const coPlayers = game.evidence.filter((e: any) => e.visible && ['divine', 'medium_co'].includes(e.type)).map((e: any) => e.from);
                        const vipTargets = gTargets.filter(p => coPlayers.includes(p.id));
                        if (vipTargets.length > 0) gTargets = vipTargets;
                    }
                    nightState.protectionTargetId = gTargets[Math.floor(Math.random() * gTargets.length)].id;
                    if (!guard.isNpc) Messages.safeDM(guard.user, fill(MSG.night.forced.guard, { target: game.players.find((p: Player)=>p.id===nightState.protectionTargetId)?.name || '' }));
                }
            }
            guard.lastGuarded = nightState.protectionTargetId;
        }

        if (necromancer && necromancer.alive && necromancer.isNpc && !game.hasNecromancerUsedPower) {
            const deadPlayers = game.players.filter((p: Player) => !p.alive);
            if (deadPlayers.length > 0 && game.dayCount >= 2 && Math.random() < 0.3) {
                game.hasNecromancerUsedPower = true;
                const target = deadPlayers[Math.floor(Math.random() * deadPlayers.length)];
                game.necromancerTarget = target.id;
                game.actions.push({ type: 'revive', from: necromancer.id, target: target.id, result: true });
            }
        }

        if (divider && divider.alive && divider.isNpc && !game.hasDividerUsedPower && !game.actions.some((a: any) => a.type === 'divide')) {
            const aliveVillagers = game.players.filter((p: Player) => p.alive && p.id !== divider.id && !Roles.isActualWolf(p.role as string));
            if (aliveVillagers.length > 0 && game.dayCount >= 2 && Math.random() < 0.3) {
                game.hasDividerUsedPower = true;
                const target = aliveVillagers[Math.floor(Math.random() * aliveVillagers.length)];
                game.actions.push({ type: 'divide', from: divider.id, target: target.id, result: true });
            }
        }

        const humanWolves = wolves.filter((w: any) => !w.isNpc);
        if (!nightState.wolfVictimId && wolves.length > 0 && !isFirstNightPeace && targets.length > 0) {
            nightState.wolfVictimId = targets[Math.floor(Math.random() * targets.length)].id;
            const v = game.players.find((p: Player) => p.id === nightState.wolfVictimId);
            humanWolves.forEach((w: any) => { Messages.safeDM(w.user, fill(MSG.night.forced.kill, { target: v?.name || '' })); });
        }

        let guardSuccess = (nightState.protectionTargetId !== null && nightState.protectionTargetId === nightState.wolfVictimId);
        const intendedWolfVictimId = nightState.wolfVictimId;

        if (nightState.wolfVictimId) {
            const v = game.players.find((p: Player) => p.id === nightState.wolfVictimId);
            if (v && v.role === '妖狐') nightState.wolfVictimId = null;
            if (v && v.role === '神') nightState.wolfVictimId = null; 
            if (v && Roles.isActualWolf(v.role as string)) nightState.wolfVictimId = null;
        }
        if (guardSuccess) nightState.wolfVictimId = null;

        if (fugitive && fugitive.alive && nightState.fugitiveTargetId) {
            const target = game.players.find((p: Player) => p.id === nightState.fugitiveTargetId);
            if (target && Roles.isActualWolf(target.role as string)) extraVictims.push(fugitive.id);
            else if (nightState.wolfVictimId === nightState.fugitiveTargetId) extraVictims.push(fugitive.id);
            if (nightState.wolfVictimId === fugitive.id) nightState.wolfVictimId = null; 
        }

        game.players.forEach((p: Player) => {
            if (p.role === 'タフガイ' && p.alive) {
                if (p.fatalWound) extraVictims.push(p.id);
                else if (nightState.wolfVictimId === p.id) { p.fatalWound = true; nightState.wolfVictimId = null; }
            }
        });

        game.actions.forEach(act => { game.timeline.push({ type: 'action', detail: act.type, day: game.dayCount, from: act.from, target: act.target, result: act.result }); });
        if (guard && guard.alive && nightState.protectionTargetId) game.timeline.push({ type: 'action', detail: 'guard', day: game.dayCount, from: guard.id, target: nightState.protectionTargetId, result: nightState.protectionTargetId === intendedWolfVictimId }); 
        if (intendedWolfVictimId) { 
            const wFrom = humanWolves.length > 0 ? humanWolves[0].id : (wolves.length > 0 ? wolves[0].id : 'Unknown');
            game.timeline.push({ type: 'action', detail: 'kill', day: game.dayCount, from: wFrom, target: intendedWolfVictimId, result: !guardSuccess }); 
        }
        if (fugitive && fugitive.alive && nightState.fugitiveTargetId) game.timeline.push({ type: 'action', detail: 'fugitive', day: game.dayCount, from: fugitive.id, target: nightState.fugitiveTargetId, result: true });
        
        return { guardSuccess, extraVictims };
    }
}
