// src/states/DayPhase.ts
import { Phase } from './Phase';
import { GameState, Player } from '../types';
import { TIMING, MSG, EASY_WORDS, fill } from '../gameConfig';
import * as Messages from '../messages';
import * as Roles from '../roles';

// ※ 元のphase.tsに残るヘルパー関数群（占い発表や勝利判定など）をインポートする想定
import { 
    announceSeerResults, 
    announceMediumResults, 
    startGaya, 
    kickFromWolfChannel, 
    checkLoversBond, 
    checkNecromancerBond, 
    checkWin 
} from '../phaseUtils'; 

export class DayPhase implements Phase {
    readonly name = 'day';

    public async onEnter(game: GameState): Promise<string | void> {
        return new Promise((resolve) => {
            game.dayCount++;
            if (!game.timeline) game.timeline = [];

            // 1日目の特殊なタイムライン記録
            if (game.dayCount === 1) {
                game.timeline = [];
                game.timeline.push({ type: 'system', content: 'LINK START: リプレイデータを展開します...' });
            }

            game.timeline.push({ type: 'phase', content: `☀️ DAY ${game.dayCount}`, detail: '昼のフェーズ' });

            // 議論時間の計算
            const aliveCount = game.players.filter((p: Player) => p.alive).length;
            let duration = game.settings.discussionTime;
            if (game.dayCount === 1) duration = Math.floor(duration / 2);

            // 朝の開始メッセージ送信
            let textMsg = fill(MSG.day.morningAnnounce, { day: game.dayCount, alive: aliveCount, duration });
            Messages.safeSend(game.channel, { content: textMsg });

            // 役職の結果発表とガヤの開始（非同期で流しっぱなしにする）
            announceSeerResults(game).catch(e => console.error(e));
            announceMediumResults(game).catch(e => console.error(e));
            if (game.settings.gayaMode && game.npcCount > 0) startGaya(game);

            // 饒舌な人狼のセットアップ
            const loquaciousWolves = game.dayCount > 1 
                ? game.players.filter((p: Player) => 
                    p.alive && (p.role === '饒舌な人狼' || (game.settings.loquaciousMode && Roles.isActualWolf(p.role as string)))
                )
                : [];

            // メッセージコレクターの作成
            const msgCollector = game.channel.createMessageCollector({ 
                filter: (m: any) => !m.author.bot, 
                time: duration * 1000 
            });
            if (!game.collectors) game.collectors = [];
            game.collectors.push(msgCollector);

            // 饒舌なお題の配布と判定
            if (loquaciousWolves.length > 0) {
                loquaciousWolves.forEach((w: any) => {
                    w.wordToSay = EASY_WORDS[Math.floor(Math.random() * EASY_WORDS.length)];
                    w.hasSaidWord = false;
                    
                    if (!w.isNpc) {
                        Messages.safeDM(w.user, fill(MSG.day.loquaciousMission, { word: w.wordToSay }));
                    } else {
                        w.hasSaidWord = true; // NPCは自動達成
                    }
                });

                msgCollector.on('collect', (m: any) => {
                    const player = game.players.find((p: Player) => p.id === m.author.id);
                    if (player && loquaciousWolves.some((w: any) => w.id === player.id) && !player.hasSaidWord) {
                        if (m.content.includes(player.wordToSay!)) {
                            player.hasSaidWord = true;
                            Messages.safeDM(player.user, fill(MSG.day.loquaciousSuccess, { word: player.wordToSay }));
                        }
                    }
                });
            }

            // 議論終了のタイマーセット
            const timer = setTimeout(async () => {
                try {
                    await Messages.safeSend(game.channel, { content: MSG.day.discussionEnd });

                    // ガヤとコレクターを停止
                    if (game.gayaInterval) clearInterval(game.gayaInterval);
                    msgCollector.stop();

                    // 饒舌なお題未達成者の突然死処理
                    let suddenDeaths: string[] = [];
                    loquaciousWolves.forEach((w: any) => {
                        if (!w.hasSaidWord && w.alive) {
                            w.alive = false;
                            w.deathDay = game.dayCount;
                            w.deathReason = 'sudden_death';
                            kickFromWolfChannel(game, w.id);

                            suddenDeaths.push(w.name);
                            game.history.push(`🌑 突然死: ${w.name} (饒舌なお題未達成)`);
                            game.timeline.push({ type: 'death', day: game.dayCount, content: `🌑 突然死: ${w.name}` });
                        }
                    });

                    // 突然死が起きた場合の後処理と勝利判定
                    if (suddenDeaths.length > 0) {
                        for (const w of loquaciousWolves) {
                            if (!w.alive && w.deathReason === 'sudden_death') {
                                await checkLoversBond(game, w);
                                await checkNecromancerBond(game, w);
                            }
                        }
                        await Messages.safeSend(game.channel, fill(MSG.day.suddenDeath, { names: suddenDeaths.join('**, **') }));
                        
                        // 誰かが勝っていたらゲーム終了
                        if (await checkWin(game)) {
                            resolve('end'); 
                            return;
                        }
                    }

                    // 何事もなければ投票フェーズへ進むよう合図を出す
                    resolve('vote');

                } catch (e) {
                    console.error("Day End Error:", e);
                    // エラーが起きても進行が止まらないよう、とりあえず投票へ進める
                    resolve('vote'); 
                }
            }, duration * 1000);

            if (!game.timers) game.timers = [];
            game.timers.push(timer);
        });
    }

    public async onExit(game: GameState): Promise<void> {
        // GameMachine側で全タイマーとコレクターを消去するので、基本的にここは空でOKです。
        // （もしこのフェーズ特有のクリーンアップが必要ならここに書きます）
    }
}
