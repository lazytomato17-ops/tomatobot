// src/states/Phase.ts
import { GameState } from '../types';

export interface Phase {
    readonly name: string;
    
    // 処理が終わったら、次に移行すべきフェーズの名前（'vote', 'night'など）を返す
    onEnter(game: GameState): Promise<string | void>;
    
    // 強制終了やリセット時に呼ばれるお掃除用メソッド
    onExit(game: GameState): Promise<void>;
}
