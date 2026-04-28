// src/GameMachine.ts
import { GameState } from './types';
import { Phase } from './states/Phase';
import { DayPhase } from './states/DayPhase';
// import { VotePhase } from './states/VotePhase';
// import { NightPhase } from './states/NightPhase';
// import { MorningPhase } from './states/MorningPhase';
// import { EndPhase } from './states/EndPhase';

export class GameMachine {
    private game: GameState;
    private currentPhase: Phase | null = null;
    
    // 登録されている全フェーズ
    private phases: Record<string, Phase> = {
        'day': new DayPhase(),
        // 'vote': new VotePhase(),
        // 'night': new NightPhase(),
        // 'morning': new MorningPhase(),
        // 'end': new EndPhase()
    };

    constructor(game: GameState) {
        this.game = game;
    }

    /**
     * ゲームループを開始する
     * @param initialPhase 最初に開始するフェーズ名（基本は 'day' や 'night'）
     */
    public async start(initialPhase: string) {
        let nextPhaseName: string | void = initialPhase;

        // 次のフェーズが指定されている、かつゲームが終了していない限り回り続ける
        while (nextPhaseName && this.game.state !== 'idle') {
            nextPhaseName = await this.transitionTo(nextPhaseName);
        }

        console.log("🐺 ゲームループが完全に終了しました。");
    }

    /**
     * 指定されたフェーズへ移行し、そのフェーズが終わるまで待つ（内部用）
     */
    private async transitionTo(phaseName: string): Promise<string | void> {
        console.log(`[GameMachine] 🔄 フェーズ移行: ${this.currentPhase?.name || 'None'} -> ${phaseName}`);

        // 1. 現在のフェーズの終了処理 (クリーンアップ)
        if (this.currentPhase) {
            await this.currentPhase.onExit(this.game);
        }

        // 2. ★重要★ 前のフェーズが残したタイマーやコレクターを「強制的に」全消去
        this.clearAllTimersAndCollectors();

        // 3. 次のフェーズを取得して実行
        this.currentPhase = this.phases[phaseName];
        if (!this.currentPhase) {
            console.error(`[GameMachine] ⚠️ 未知のフェーズ: ${phaseName}`);
            return; // 存在しないフェーズならループを抜ける
        }

        // onEnterが resolve されるまでここで待機し、次のフェーズ名を受け取る
        const nextPhase = await this.currentPhase.onEnter(this.game);
        return nextPhase;
    }

    /**
     * すべてのタイマーとイベントリスナーを安全に破棄する
     */
    private clearAllTimersAndCollectors() {
        if (this.game.timers && this.game.timers.length > 0) {
            this.game.timers.forEach(t => clearTimeout(t));
            this.game.timers = [];
        }
        
        if (this.game.collectors && this.game.collectors.length > 0) {
            this.game.collectors.forEach(c => {
                try { c.stop(); } catch (e) { /* 無視 */ }
            });
            this.game.collectors = [];
        }
        
        if (this.game.gayaInterval) {
            clearInterval(this.game.gayaInterval);
            this.game.gayaInterval = null;
        }
    }
}
