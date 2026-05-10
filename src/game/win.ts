// src/game/win.ts
// 🏁 勝利判定・ゲーム終了処理を一元管理するファイル
//
// 【このファイルの責務】
//   - offerGhostBet      : 死者への幽霊賭けDM送信
//   - checkLoversBond    : 恋人の後追い死チェック
//   - checkNecromancerBond : 死霊術師の連鎖死チェック
//   - checkWin           : 勝利条件の判定（メインロジック）
//   - calculateMVP       : MVP計算
//   - finalizeTimeline   : タイムライン確定
//   - endGame            : ゲーム終了・結果送信
//
// 【phase.ts 側でやること】
//   以下の関数定義をすべて削除し、このファイルからimportする:
//
//   import {
//       offerGhostBet,
//       checkWin,
//       endGame,
//       checkLoversBond,
//       checkNecromancerBond,
//   } from './game/win';

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as Messages from '../messages';
import * as DB from '../db';
import * as AI from '../aiUtils';
import * as Roles from '../roles';
import { GameState, Player } from '../types';
import { TIMING, MSG, UI, fill } from '../gameConfig';
import { getGame, resetGame } from '../state';

// ============================================================
// 幽霊賭け（ランクマッチ限定）
// ============================================================

/**
 * 死亡したプレイヤーに「どの陣営が勝つか」賭けのDMを送る。
 * 元は phase.ts にあったが、連鎖死処理 (checkLoversBond等) と
 * 同じファイルに置くことで循環依存を解消。
 */
export function offerGhostBet(game: GameState, player: Player) {
    if (game.settings.matchType !== 'ranked' || player.isNpc || !player.user) return;

    player.betDeadline = Date.now() + TIMING.ghostBetDeadline * 1000;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('bet_villager').setLabel(UI.vote.villagerBetButton).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bet_wolf').setLabel(UI.vote.wolfBetButton).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('bet_other').setLabel(UI.vote.otherBetButton).setStyle(ButtonStyle.Secondary)
    );

    Messages.safeDM(player.user, {
        content: fill(MSG.ghostBet.prompt, { seconds: TIMING.ghostBetDeadline }),
        components: [row]
    }).then(success => {
        if (!success && game.channel) {
            Messages.safeSend(game.channel, fill(MSG.ghostBet.dmFailed, { name: player.name }));
        }
    });
}

// ============================================================
// 連鎖死チェック
// ============================================================

/** 恋人の一方が死んだとき、もう一方も後追い死させる */
export async function checkLoversBond(game: GameState, deadPlayer: any) {
    if (!game.lovers || !game.lovers.includes(deadPlayer.id)) return;

    const partnerId = game.lovers.find((id: string) => id !== deadPlayer.id);
    const partner = game.players.find((p: any) => p.id === partnerId);

    if (partner && partner.alive) {
        partner.alive = false;
        partner.deathDay = game.dayCount;
        partner.deathReason = 'sudden_death';

        await Messages.safeSend(game.channel, {
            content: `------------------------\n💔 **後追い自殺**\n恋人を失った **${partner.name}** も命を絶ちました。`
        });

        if (!game.timeline) game.timeline = [];
        game.history.push(`💔 後追い: ${partner.name}`);
        game.timeline.push({ type: 'death', day: game.dayCount, content: `💔 後追い: ${partner.name}` });

        offerGhostBet(game, partner);
    }
}

/** 死霊術師が死んだとき、蘇生していた相手を道連れにする */
export async function checkNecromancerBond(game: GameState, deadPlayer: any) {
    if (deadPlayer.role !== '死霊術師' || !game.necromancerTarget) return;

    const revived = game.players.find((p: any) => p.id === game.necromancerTarget);

    if (revived && revived.alive) {
        revived.alive = false;
        revived.deathDay = game.dayCount;
        revived.deathReason = 'sudden_death';

        await Messages.safeSend(game.channel, {
            content: `------------------------\n💀 **死者の道連れ**\n死霊術師が死亡したため、魔力で生かされていた **${revived.name}** も土へと還りました。`
        });

        if (!game.timeline) game.timeline = [];
        game.history.push(`💀 道連れ: ${revived.name} (死霊術師の死)`);
        game.timeline.push({ type: 'death', day: game.dayCount, content: `💀 道連れ: ${revived.name}` });

        offerGhostBet(game, revived);
        await checkLoversBond(game, revived); // 蘇生相手が恋人だった場合の連鎖チェック
    }
}

// ============================================================
// 結果サマリー生成（内部用）
// ============================================================

/**
 * DB保存・タイムライン表示に使う構造化された試合結果オブジェクトを生成する。
 * 純愛者の陣営は「愛する人の陣営を継承する」という特殊ルールを再帰的に処理。
 */
function buildResultSummary(game: GameState, winner: string) {
    const getTeam = (role: string = '', id: string = ''): string => {
        if (game.lovers && game.lovers.includes(id)) return 'lovers';
        if (role === 'キューピッド' && winner === 'lovers') return 'lovers';
        if (role === '妖狐') return 'fox';
        if (role === 'テルテル') return 'teruteru';

        if (role === '純愛者' && game.devoteeTarget) {
            const target = game.players.find((p: Player) => p.id === game.devoteeTarget);
            if (target && target.id !== id) return getTeam(target.role ?? '', target.id);
        }

        const team = Roles.ROLE_CATALOG[role]?.team as string | undefined;
        if (team === 'wolf') return 'wolf';
        return 'villager';
    };

    const summary = {
        total_days: game.dayCount,
        winner_team: winner,
        players: {} as Record<string, any>
    };

    game.players.forEach((p: Player) => {
        let team = getTeam(p.role ?? '', p.id);

        // 恋人本人、または「恋人陣営が勝った時のキューピッド」を恋人陣営として表示
        if (game.lovers && game.lovers.includes(p.id)) {
            team = 'lovers';
        } else if (p.role === 'キューピッド' && winner === 'lovers') {
            team = 'lovers';
        }

        summary.players[p.id] = {
            name: p.name,
            role: p.role || '不明',
            team,
            is_alive: !!p.alive,
            death_day: p.alive ? null : (p.deathDay ?? null),
            death_reason: p.alive ? null : (p.deathReason ?? null)
        };
    });

    return summary;
}

// ============================================================
// MVP計算（内部用）
// ============================================================

/**
 * 占い・護衛成功・生存・勝利などのポイントを集計してMVPを決める。
 * NPCを含む全プレイヤーを対象にスコアリングする。
 */
function calculateMVP(game: GameState, players: any[], winningTeam: string) {
    if (!players || players.length === 0) {
        return { name: 'Unknown', role: 'Unknown', reason: 'データなし' };
    }

    let scores = players.map(p => ({
        id: p.id, name: p.name, role: p.role, score: 0, reasons: [] as string[]
    }));

    // 純愛者の「判定陣営」を再帰的に解決するヘルパー
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

    // 1. 勝利・生存ポイント
    players.forEach((p, i) => {
        const playerTeam = getEffectiveTeam(p);
        const isWin = playerTeam === winningTeam;

        if (isWin) {
            scores[i].score += 100;
            if (p.alive) scores[i].score += 50;
            if (p.role === '純愛者') scores[i].reasons.push('愛する人の勝利に貢献');
        }
    });

    // 2. 占い師の人狼発見ポイント
    if (game.actions) {
        game.actions.forEach((a: any) => {
            const idx = scores.findIndex(s => s.id === a.from);
            if (idx !== -1 && a.type === 'divine' && a.result === true) {
                scores[idx].score += 30;
                scores[idx].reasons.push('人狼発見');
            }
        });
    }

    // 3. 騎士の護衛成功ポイント（タイムライン参照）
    players.filter(p => p.role === '騎士').forEach(guard => {
        const idx = scores.findIndex(s => s.id === guard.id);
        if (idx !== -1 && game.timeline) {
            const successCount = game.timeline.filter((t: any) =>
                t.type === 'action' && t.detail === 'guard' && t.from === guard.id && t.result === true
            ).length;

            if (successCount > 0) {
                scores[idx].score += 40 * successCount;
                scores[idx].reasons.push(`護衛成功x${successCount}`);
            }
        }
    });

    // 4. 生き残った人狼への追加ポイント（人狼勝利時）
    if (winningTeam === 'wolf') {
        players.filter(p => Roles.isActualWolf(p.role as string) && p.alive).forEach(w => {
            const idx = scores.findIndex(s => s.id === w.id);
            if (idx !== -1) scores[idx].score += 30;
        });
    }

    scores.sort((a, b) => b.score - a.score);
    const mvp = scores[0];
    return {
        name: mvp.name,
        role: mvp.role,
        reason: mvp.reasons.length > 0 ? mvp.reasons.join(', ') : '勝利への貢献'
    };
}

// ============================================================
// タイムライン確定（内部用）
// ============================================================

/** ゲーム終了時にタイムラインへ勝者・全役職公開を追記して封印する */
function finalizeTimeline(game: GameState, winner: string) {
    if (game.timelineFinalized) return;
    game.timelineFinalized = true;
    if (!game.timeline) game.timeline = [];

    const winName =
        MSG.endGame.winnerNames[winner as keyof typeof MSG.endGame.winnerNames] ||
        MSG.endGame.winnerNames.draw;

    game.history.push(`🏆 勝敗: ${winName}の勝利！`);
    game.timeline.push({ type: 'winner', content: `${winName}の勝利！` });

    game.players.forEach((p: Player) => {
        game.history.push(`🎭 役職公開: ${p.name} <${p.id}> (${p.role})`);
        game.timeline.push({ type: 'system', content: `🎭 役職公開: ${p.name} <${p.id}> (${p.role})` });
    });

    game.timeline.push({ type: 'system', content: 'MATCH END: リプレイ終了' });
}

// ============================================================
// 勝利判定メイン
// ============================================================

/**
 * 生存人数を元に勝利条件を確認し、決着がついていれば endGame() を呼ぶ。
 * @returns 決着がついた場合 true、続行の場合 false
 */
export async function checkWin(game: GameState): Promise<boolean> {
    const wolves  = game.players.filter((p: Player) => Roles.isActualWolf(p.role as string) && p.alive).length;
    const humans  = game.players.filter((p: Player) => !Roles.isActualWolf(p.role as string) && p.alive).length;
    const fox     = game.players.find((p: Player) => p.role === '妖狐' && p.alive);
    const loversAlive =
        game.players.filter((p: Player) => p.alive && game.lovers && game.lovers.includes(p.id)).length === 2;

    // 勝者と勝利メッセージを決定する辞書 (if文の連鎖をやめてデータで管理)
    const WIN_CONDITIONS: Array<{
        condition: boolean;
        winner: string;
        message: string;
    }> = [
        // 人狼全滅時
        { condition: wolves === 0 && !!fox,         winner: 'fox',      message: MSG.endGame.winText.fox },
        { condition: wolves === 0 && loversAlive,   winner: 'lovers',   message: MSG.endGame.winText.lovers },
        { condition: wolves === 0,                  winner: 'villager', message: MSG.endGame.winText.villager },
        // 人狼が村人と同数以上になった時
        { condition: wolves >= humans && !!fox,     winner: 'fox',      message: MSG.endGame.winText.fox },
        { condition: wolves >= humans && loversAlive, winner: 'lovers', message: MSG.endGame.winText.lovers },
        { condition: wolves >= humans,              winner: 'wolf',     message: MSG.endGame.winText.wolf },
    ];

    const matched = WIN_CONDITIONS.find(c => c.condition);
    if (!matched) return false; // まだ決着なし

    let { winner, message } = matched;

    // ▼ 神の勝利書き換えロジック
    const god        = game.players.find((p: Player) => p.role === '神' && p.alive);
    const aliveCount = game.players.filter((p: Player) => p.alive).length;

    if (god) {
        if (['fox', 'lovers', 'teruteru'].includes(winner)) {
            winner  = 'god';
            message = '✨ **神の単独勝利**\n第三陣営の勝利を退け、最後まで生き残った【神】が世界を掌握しました！';
        } else if (aliveCount <= 3) {
            message += '\n\n✨ **神の共存勝利**\n生存者が3人以下となったため、生き残った【神】も共に勝利を分かち合います！';
            game.godCoWin = true;
        }
    }
    // ▲ ここまで

    game.winnerTeam = winner;

    const humanCount = game.players.filter((p: Player) => !p.isNpc).length;
    const isRanked   = game.settings.matchType === 'ranked' && humanCount >= 2;
    const mvpData    = calculateMVP(game, game.players, winner);

    finalizeTimeline(game, winner);
    game.resultSummary = buildResultSummary(game, winner);

    // DB保存
    let deltas: Record<string, number> = {};
    try {
        const res = await DB.saveGameResults(game, winner, mvpData.name);
        if (res && res.deltas) deltas = res.deltas;
    } catch (e) {
        console.error('DB Save Error:', e);
    }

    // MVPコメント生成
    const aiComment = await AI.generateMvpComment(mvpData, game.history);

    // レート変動テキストの組み立て
    let matchType = isRanked ? '🏆【ランクマッチ】' : '🔰【練習試合】';
    if (isRanked && Object.keys(deltas).length > 0) {
        matchType += '\n**📈 レート変動**\n';
        for (const [uid, delta] of Object.entries(deltas)) {
            const p = game.players.find((pl: any) => pl.id === uid);
            const d = delta as number;
            if (!p) continue;

            const extras: string[] = [];
            if (p.name === mvpData.name) extras.push('MVP');
            if (p.alive) extras.push('生存');

            // 幽霊賭け的中チェック
            if (!p.alive && p.ghostBet) {
                const betHit =
                    (p.ghostBet === 'villager' && winner === 'villager') ||
                    (p.ghostBet === 'wolf'     && winner === 'wolf')     ||
                    (p.ghostBet === 'other'    && ['fox', 'lovers', 'teruteru'].includes(winner));
                if (betHit) extras.push('賭的中');
            }

            const infoStr = extras.length > 0 ? ` (${extras.join('/')})` : '';
            matchType += `▪ ${d > 0 ? '+' : ''}${d} pt : **${p.name}**${infoStr}\n`;
        }
    }
    matchType += `\n\n🏅 **MVP**: ${mvpData.name} **[${mvpData.role}]**\n「${aiComment}」`;

    // 人狼チャット部屋の自動削除
    const wolfCh = game.wolfChannel;
    if (wolfCh) {
        game.wolfChannel = undefined; // 先にBotの記憶から切り離してから物理削除
        wolfCh.send('🚪 **この隠れ家はまもなく閉鎖されます。さらばだ。**').catch(() => {});
        setTimeout(() => {
            wolfCh.delete().catch((e: any) => console.error('隠れ家削除失敗', e));
        }, 5000);
    }

    endGame(game, `${message}\n${matchType}`);
    return true;
}

// ============================================================
// ゲーム終了・結果送信
// ============================================================

/**
 * タイマー・インターバルを全停止し、試合ログと結果を送信する。
 * リュウNPCがいる場合は感想戦コメントも生成する。
 */
export async function endGame(game: GameState, text: string) {
    // タイマー類を全停止
    if (game.gayaInterval) { clearInterval(game.gayaInterval); game.gayaInterval = null; }
    if (game.timers?.length) { game.timers.forEach(t => clearTimeout(t)); game.timers = []; }

    // タイムラインがまだ確定していない場合は再度確定する（安全弁）
    if (!game.timelineFinalized) {
        const winName =
            MSG.endGame.winnerNames[game.winnerTeam as keyof typeof MSG.endGame.winnerNames] ||
            MSG.endGame.winnerNames.draw;
        game.history.push(`🏆 勝敗: ${winName}の勝利！`);
        game.timeline.push({ type: 'winner', content: `${winName}の勝利！` });
        game.players.forEach(p => {
            game.history.push(`🎭 役職公開: ${p.name} <${p.id}> (${p.role})`);
            game.timeline.push({ type: 'system', content: `🎭 役職公開: ${p.name} <${p.id}> (${p.role})` });
        });
        game.timeline.push({ type: 'system', content: 'MATCH END: リプレイ終了' });
        game.timelineFinalized = true;
    }

    try {
        await Messages.safeSend(game.channel, { content: '結果を表示します...' });
    } catch (e) {
        console.error('EndGame MVP Send Error:', e);
    }

    game.timers.push(setTimeout(async () => {
        // ── 試合ログの組み立て ──────────────────────────────────────────
        let historyStr = '';

        for (let d = 1; d <= game.dayCount; d++) {
            let dailyLog = '';

            // 1日目のみ：特殊な関係（恋人・純愛）を先頭に表示
            if (d === 1) {
                if (game.lovers?.length === 2) {
                    const l1 = game.players.find(p => p.id === game.lovers[0])?.name ?? '不明';
                    const l2 = game.players.find(p => p.id === game.lovers[1])?.name ?? '不明';
                    dailyLog += `💘 **恋人成立** : **${l1}** & **${l2}**\n`;
                }
                if (game.devoteeTarget) {
                    const devotee = game.players.find(p => p.role === '純愛者')?.name ?? '純愛者';
                    const target  = game.players.find(p => p.id === game.devoteeTarget)?.name ?? '不明';
                    dailyLog += `❤️‍🔥 **純愛の対象** : **${devotee}** ➔ **${target}**\n`;
                }
            }

            // 夜のアクションをタイムラインから抽出して整形
            const NIGHT_ACTION_LABELS: Record<string, (act: any, fromName: string, targetName: string, fromPlayer: Player | undefined) => string> = {
                divine: (act, fromName, targetName, fromPlayer) => {
                    const isFake = fromPlayer && fromPlayer.role !== '占い師';
                    return `🔮 **${fromName}** [${isFake ? '偽占い' : '占い'}] : **${targetName}** ➔【${act.result ? '人狼●' : '人間○'}】\n`;
                },
                guard:      (act, fromName, targetName) => `🛡️ **${fromName}** [護衛] : **${targetName}** ${act.result ? '(成功!)' : ''}\n`,
                kill:       (act, fromName, targetName) => `🐺 **${fromName}** [襲撃] : **${targetName}** ${act.result === false ? '(失敗)' : '(成功)'}\n`,
                sorcery:    (act, fromName, targetName) => `👁️ **${fromName}** [妖術] : **${targetName}** ➔【${act.result}】\n`,
                steal:      (act, fromName, targetName) => `🎩 **${fromName}** [怪盗] : **${targetName}**\n`,
                divide:     (act, fromName, targetName) => `🌀 **${fromName}** [隔離] : **${targetName}**\n`,
                revive:     (act, fromName, targetName) => `🧟 **${fromName}** [蘇生] : **${targetName}**\n`,
                fugitive:   (act, fromName, targetName) => `💨 **${fromName}** [逃亡] : **${targetName}**\n`,
                assassinate:(act, fromName, targetName) => `🌒 **${fromName}** [暗殺] : **${targetName}** ➔ ${act.result === 'suicide' ? '💀(誤射)' : '💀(成功)'}\n`,
            };

            game.timeline
                .filter((t: any) => t.day === d && t.type === 'action')
                .forEach((act: any) => {
                    const fromPlayer = game.players.find((p: Player) => p.id === act.from);
                    const fromName   = fromPlayer?.name ?? '不明';
                    const targetName = game.players.find((p: Player) => p.id === act.target)?.name ?? '不明';
                    const formatter  = NIGHT_ACTION_LABELS[act.detail];
                    if (formatter) dailyLog += formatter(act, fromName, targetName, fromPlayer);
                });

            // 死亡・処刑イベント
            game.timeline
                .filter(t => t.day === d && (t.type === 'death' || t.type === 'execution'))
                .forEach(evt => {
                    const clean = evt.content?.replace(/🌑 |📅 |🐈 |✨ |⚖️ /g, '') ?? '';
                    dailyLog += `💀 ${clean}\n`;
                });

            if (dailyLog) historyStr += `\n**━━━ ${d}日目 ━━━**\n${dailyLog}`;
        }

        if (historyStr.length > 1900) historyStr = '⚠️ 記録が長すぎるため、一部を省略しました。';

        // ── 最終テキストの組み立て ──────────────────────────────────────
        const playersList = game.players
            .map(p => `**${p.name}** : ${p.role} (${p.alive ? '生存' : '死亡'})`)
            .join('\n');

        const resultText =
            `------------------------\n${text}\n\n` +
            `📘 **【最終結果】**\n${playersList}\n\n` +
            `📜 **【試合ログ】**\n${historyStr}`;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('game_rematch').setLabel(UI.vote.rematchButton).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('game_force_reset').setLabel(UI.vote.resetButton).setStyle(ButtonStyle.Secondary)
        );

        try {
            game.channel.send({ content: resultText, components: [row] });

            // ── リュウNPCの感想戦コメント ────────────────────────────────
            const ryu = game.players.find(p => p.isNpc && p.personality === 'ryu');
            if (ryu) {
                setTimeout(async () => {
                    try {
                        await game.channel.sendTyping();

                        const myState  = ryu.alive ? '最後まで生きてた' : '途中で死んだ';
                        const teamMap: Record<string, string> = {
                            villager: '村人', wolf: '人狼', fox: '妖狐',
                            lovers: '恋人', teruteru: 'テルテル', god: '神'
                        };
                        const winTeam      = teamMap[game.winnerTeam ?? ''] ?? game.winnerTeam;
                        const recentEvents = game.history.slice(-8);

                        const ryuComment = await AI.generateNpcGaya(
                            ryu.name, 'ryu', 'game_end', null,
                            `試合終了。${winTeam}陣営の勝ち。\n` +
                            `自分は【${ryu.role}】で【${myState}】だった。\n` +
                            `ただの感想じゃなく、「あの時のあの発言で騙されたわｗ」とか「俺があそこで○○してれば勝てたかもな」といった、` +
                            `実際のゲーム展開（履歴：${recentEvents}）に基づいた、一人のプレイヤーとしてのガチの振り返りを1〜2文で言って。` +
                            `タメ口で、Discordの感想戦のノリで。`,
                            recentEvents, ryu.role ?? '村人', game.settings.roles.join(', ')
                        );

                        if (ryuComment && game.state !== 'playing') {
                            await game.channel.send(`**${ryu.name}**: 「${ryuComment}」`);
                        }
                    } catch (e) {
                        console.error('リュウ感想戦エラー:', e);
                    }
                }, 1000 + Math.random() * 2000);
            }

            // ── 人狼村チャンネルの自動削除 ──────────────────────────────
            const currentChannel = game.channel as any;
            if (currentChannel?.name?.startsWith('🐺人狼村')) {
                currentChannel.send(
                    fill(MSG.endGame.channelCloseNotice, { minutes: TIMING.channelAutoDeleteMinutes })
                );
                setTimeout(async () => {
                    try {
                        const checkGame = getGame(currentChannel.id);
                        if (checkGame && checkGame.state !== 'idle') return;
                        await currentChannel.delete('人狼ゲーム終了による自動削除');
                        if (game.wolfChannel) {
                            await game.wolfChannel.delete('人狼ゲーム終了による自動削除 (証拠隠滅)').catch(() => {});
                        }
                    } catch (err) {
                        console.error('チャンネルの削除に失敗しました:', err);
                    }
                }, TIMING.channelAutoDeleteMinutes * 60 * 1000);
            }

        } catch (e) {
            console.error('EndGame Send Error:', e);
            Messages.safeSend(game.channel, MSG.endGame.errorFallback);
        }

        // ゲームをidle状態に戻し、一定時間後にメモリから解放
        game.state = 'idle';
        setTimeout(() => {
            try {
                const g = getGame(game.channel.id);
                if (g && g.state === 'idle') resetGame(game.channel.id, true);
            } catch (e) {
                console.error(e);
            }
        }, TIMING.idleGameCleanupHours * 60 * 60 * 1000);

    }, TIMING.endGameResultDelay));
}
