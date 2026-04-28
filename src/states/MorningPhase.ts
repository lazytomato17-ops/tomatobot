// src/states/MorningPhase.ts
import { Phase } from './Phase';
import { GameState, Player } from '../types';
import { TIMING, MSG, UI, fill } from '../gameConfig';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import * as Messages from '../messages';
import * as Roles from '../roles';

// phase.tsから切り出したヘルパー群（別ファイルにある想定）
import { 
    kickFromWolfChannel, 
    offerGhostBet, 
    checkLoversBond, 
    checkNecromancerBond, 
    checkWin 
} from '../phaseUtils'; 

export class MorningPhase implements Phase {
    readonly name = 'morning';

    public async onEnter(game: GameState): Promise<string | void> {
        return new Promise(async (resolve) => {
            // NightPhase から引き継いだ結果を取得
            const results = (game as any).nightResults || { victimId: null, guardSuccess: false, extraVictims: [] };
            const { victimId, guardSuccess, extraVictims } = results;

            // 1. 分断アクションの処理（セクターの作成）
            await this.handleDividerAction(game);

            let deadNames: string[] = [];
            let allVictimIds = new Set<string>();
            if (!game.timeline) game.timeline = []; 
            if (victimId) allVictimIds.add(victimId);
            extraVictims.forEach((id: string) => allVictimIds.add(id));

            // 2. 襲撃・暗殺・タフガイなどの死亡処理
            await this.processVictims(game, allVictimIds, victimId, deadNames);

            // 3. 妖狐の呪殺処理
            await this.processCursedFox(game, deadNames);

            // 4. 朝の犠牲者発見アナウンス
            await this.announceMorningResults(game, deadNames, guardSuccess);

            // 5. 検死官・偽検死官のアクション
            this.handleCoronerActions(game, deadNames);

            // 6. 蘇生アクションの処理
            await this.handleReviveAction(game);

            // 一時保存したデータをクリア
            delete (game as any).nightResults;

            // 7. 朝のディレイ後に昼フェーズへ移行（または決着）
            const timer = setTimeout(async () => {
                if (await checkWin(game)) {
                    resolve('end');
                } else {
                    resolve('day'); // ループして再び昼へ！
                }
            }, TIMING.morningToDayDelay);

            if (!game.timers) game.timers = [];
            game.timers.push(timer);
        });
    }

    public async onExit(game: GameState): Promise<void> {
        // GameMachine 側で処理されるため基本空でOK
    }

    // ==========================================
    // 内部メソッド群
    // ==========================================

    private async handleDividerAction(game: GameState) {
        const divideAct = game.actions.find((a: any) => a.type === 'divide');
        if (divideAct && !game.dividedGroups) {
            const alivePlayers = game.players.filter((p: Player) => p.alive);
            const roomA = new Set<string>([divideAct.from, divideAct.target]);
            const others = alivePlayers.filter((p: Player) => !roomA.has(p.id)).sort(() => Math.random() - 0.5);
            
            const half = Math.floor(alivePlayers.length / 2);
            while (roomA.size < half && others.length > 0) roomA.add(others.pop()!.id);
            game.dividedGroups = { roomA: Array.from(roomA), roomB: others.map(p => p.id) };

            try {
                await game.channel.permissionOverwrites.edit(game.channel.guild.roles.everyone, { ViewChannel: false });
                
                const createSector = async (name: string, members: string[]) => {
                    return await game.channel.guild.channels.create({
                        name: name, type: ChannelType.GuildText, parent: game.channel.parentId,
                        permissionOverwrites: [
                            { id: game.channel.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: game.channel.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                            ...members.filter(id => !id.startsWith('npc_')).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }))
                        ]
                    });
                };

                game.sectorAChannel = await createSector('🌀セクターα', game.dividedGroups.roomA);
                game.sectorBChannel = await createSector('🌀セクターβ', game.dividedGroups.roomB);

                const getSectorMemberNames = (ids: string[]) => ids.map(id => {
                    const p = game.players.find(pl => pl.id === id);
                    return p ? (p.isNpc ? `${p.name}` : p.name) : '不明';
                }).join(', ');

                const namesA = getSectorMemberNames(game.dividedGroups.roomA);
                const namesB = getSectorMemberNames(game.dividedGroups.roomB);

                const mentionsA = game.dividedGroups.roomA.filter(id => !id.startsWith('npc_')).map(id => `<@${id}>`).join(' ');
                const mentionsB = game.dividedGroups.roomB.filter(id => !id.startsWith('npc_')).map(id => `<@${id}>`).join(' ');

                await Messages.safeSend(game.sectorAChannel, { content: fill(MSG.morning.sectorSplit, { mentions: mentionsA, names: namesA }) });
                await Messages.safeSend(game.sectorBChannel, { content: fill(MSG.morning.sectorSplit, { mentions: mentionsB, names: namesB }) });
                game.history.push(`🌀 分断発動: 村が2つのセクターに隔離された！`);
            } catch (e) { 
                console.error("チャンネル分断エラー:", e); 
                game.dividedGroups = null; 
            }
        }
    }

    private async processVictims(game: GameState, allVictimIds: Set<string>, victimId: string | null, deadNames: string[]) {
        for (const vId of allVictimIds) {
            const v = game.players.find((p: Player) => p.id === vId);
            if (v && v.alive) { 
                v.alive = false; 
                kickFromWolfChannel(game, v.id);
                v.deathDay = game.dayCount; 
                v.deathReason = 'kill';
                deadNames.push(v.name);
                
                game.history.push(`🌑 死亡: ${v.name}`); 
                game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 死亡: ${v.name}` });
                
                offerGhostBet(game, v); 
                await checkLoversBond(game, v);
                await checkNecromancerBond(game, v);

                // 猫又が人狼に襲撃された場合の道連れ処理
                if (v.role === '猫又' && vId === victimId) {
                    const wolves = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive);
                    if (wolves.length > 0) {
                        const wolfVictim = wolves[Math.floor(Math.random() * wolves.length)];
                        wolfVictim.alive = false; 
                        wolfVictim.deathDay = game.dayCount; 
                        wolfVictim.deathReason = 'kill';
                        deadNames.push(wolfVictim.name);
                        
                        game.history.push(`🐈‍⬛ 道連れ(襲撃): ${wolfVictim.name}`);
                        game.timeline.push({ type: 'death', day: game.dayCount, content: `🐈‍⬛ 道連れ(襲撃): ${wolfVictim.name}` });
                        
                        offerGhostBet(game, wolfVictim); 
                        await checkLoversBond(game, wolfVictim);
                    }
                }
            } 
        }
    }

    private async processCursedFox(game: GameState, deadNames: string[]) {
        if (game.cursedTarget) { 
            const c = game.players.find((p: Player) => p.id === game.cursedTarget);
            if (c && c.alive) { 
                c.alive = false; 
                c.deathDay = game.dayCount; 
                c.deathReason = 'sudden_death';
                deadNames.push(c.name); 
                
                game.history.push(`🌑 呪殺: ${c.name}`); 
                game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 呪殺: ${c.name}` });
                
                offerGhostBet(game, c); 
                await checkLoversBond(game, c);
                await checkNecromancerBond(game, c);
            } 
        }
    }

    private async announceMorningResults(game: GameState, deadNames: string[], guardSuccess: boolean) {
        let morningTextA = `------------------------\n`;
        let morningTextB = `------------------------\n`;
        let victimsInA: string[] = []; let victimsInB: string[] = [];

        deadNames.forEach(dName => {
            const deadPlayer = game.players.find((p: Player) => p.name === dName);
            if (deadPlayer) {
                if (game.dividedGroups?.roomA.includes(deadPlayer.id)) victimsInA.push(dName);
                else if (game.dividedGroups?.roomB.includes(deadPlayer.id)) victimsInB.push(dName);
                else victimsInA.push(dName);
            }
        });

        if (game.dividedGroups) {
            morningTextA += victimsInA.length > 0 ? fill(MSG.morning.sectorVictimFound, { names: victimsInA.join('** と **') }) : MSG.morning.sectorNoVictim;
            morningTextB += victimsInB.length > 0 ? fill(MSG.morning.sectorVictimFound, { names: victimsInB.join('** と **') }) : MSG.morning.sectorNoVictim;
            await Messages.safeSend(game.sectorAChannel, { content: morningTextA });
            await Messages.safeSend(game.sectorBChannel, { content: morningTextB });
        } else {
            if (deadNames.length > 0) {
                await Messages.safeSend(game.channel, { content: fill(MSG.morning.victimFound, { names: deadNames.join('** と **') }) });
            } else {
                await Messages.safeSend(game.channel, { content: guardSuccess ? MSG.morning.guardSuccess : MSG.morning.noVictim }); 
            }
        }
    }

    private handleCoronerActions(game: GameState, deadNames: string[]) {
        const coroner = game.players.find((p: Player) => p.role === '検死官' && p.alive);
        if (coroner && deadNames.length > 0) {
            let coronerReport = MSG.morning.coronerReportHeader;
            deadNames.forEach(dName => {
                const deadPlayer = game.players.find((p: Player) => p.name === dName);
                if (deadPlayer) coronerReport += fill(MSG.morning.coronerReportLine, { name: dName, role: deadPlayer.role || '' });
            });
            game.coronerReport = coronerReport; 
            
            if (coroner.isNpc) {
                const delay = TIMING.coronerDelayBase + Math.random() * TIMING.coronerDelayRandom;
                const timer = setTimeout(async () => {
                    let targetCh = game.channel;
                    if (game.dividedGroups) targetCh = game.dividedGroups.roomA.includes(coroner.id) ? game.sectorAChannel : game.sectorBChannel;
                    await Messages.safeSend(targetCh, { content: fill(MSG.morning.coronerAnnounce, { name: coroner.name, report: coronerReport }) });
                    
                    if (!game.chatLog) game.chatLog = [];
                    game.chatLog.push({ id: coroner.id, name: coroner.name, content: `検死結果公表\n\n${coronerReport}`, day: game.dayCount });
                    game.timeline.push({ type: 'chat', day: game.dayCount, id: coroner.id, name: coroner.name, content: `検死結果公表\n\n${coronerReport}` });
                    
                    if (!game.evidence) game.evidence = [];
                    game.evidence.push({ type: 'coroner_co', day: game.dayCount, from: coroner.id, target: 'all', result: true, visible: true });
                }, delay);
                
                if (!game.timers) game.timers = [];
                game.timers.push(timer);
            } else {
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('coroner_publish').setLabel(UI.night.coronerPublishBtn).setStyle(ButtonStyle.Success)
                );
                Messages.safeDM(coroner.user, { content: coronerReport, components: [row] });
            }
        }

        const isCoronerInSettings = game.settings.roles.includes('coroner');
        const fakers = game.players.filter((p: Player) => {
            if (!isCoronerInSettings) return false; 
            if (!['狂人', '狂信者', '妖狐', 'テルテル', '妖術師'].includes(p.role as string) && !Roles.isActualWolf(p.role as string)) return false;
            if (!p.alive || p.isNpc) return false;
            const alreadyDivining = game.actions?.some((a: any) => a.from === p.id && a.type === 'divine') || game.evidence?.some((e: any) => e.from === p.id && e.type === 'divine');
            const alreadyMedium = game.evidence?.some((e: any) => e.from === p.id && e.type === 'medium_co');
            return !(alreadyDivining || alreadyMedium);
        });

        if (fakers.length > 0 && deadNames.length > 0) {
            for (const faker of fakers) {
                const fakeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('fakecoroner_open_modal').setLabel(UI.night.fakeCoronerBtn).setStyle(ButtonStyle.Danger)
                );
                Messages.safeDM(faker.user, { content: MSG.morning.fakeCoronerDm, components: [fakeRow] });
            }
        }
    }

    private async handleReviveAction(game: GameState) {
        const reviveAct = game.actions.find((a: any) => a.type === 'revive');
        if (reviveAct) {
            const revivedPlayer = game.players.find((p: Player) => p.id === reviveAct.target);
            if (revivedPlayer) {
                revivedPlayer.alive = true; 
                revivedPlayer.deathDay = undefined; 
                revivedPlayer.deathReason = undefined;
                
                const reviveMsg = `🧟 **死霊術師の秘術**\n死者の魂が呼び戻されました。**${revivedPlayer.name}** が蘇生し、今日から再び議論に参加します！`;
                if (game.dividedGroups) {
                    await Messages.safeSend(game.sectorAChannel, { content: reviveMsg });
                    await Messages.safeSend(game.sectorBChannel, { content: reviveMsg });
                } else { 
                    await Messages.safeSend(game.channel, { content: reviveMsg }); 
                }
                
                game.history.push(`💀 蘇生: ${revivedPlayer.name} (死霊術師の秘術)`);
                game.timeline.push({ type: 'system', content: `💀 蘇生: ${revivedPlayer.name} (死霊術師の秘術)` });
            }
        }
    }
}
