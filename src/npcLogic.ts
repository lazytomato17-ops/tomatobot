// src/npcLogic.ts

import { GameState, Player } from "./types";
// ❌ Rustのインポートを削除
// import { calculateNpcVote } from "../tomatobot-core";

// ⭕️ TypeScriptだけのシンプルなロジックに変更
export function getNpcVoteTarget(npc: any, game: GameState): { targetId: string, reasonType: string } | string {
    
    // 生きているプレイヤーの中から、自分と仲間（人狼なら他の人狼など）を除外
    // ※ allies（仲間）の判定はゲームの仕様に合わせて調整してください
    const voteCandidates = game.players.filter(p => 
        p.alive && 
        p.id !== npc.id && 
        p.role !== npc.role // 例：自分と同じ役職には投票しない
    );

    // 候補がいない場合はスキップ
    if (voteCandidates.length === 0) return "skip"; 
    
    // 候補の中からランダムに選択
    const randomIndex = Math.floor(Math.random() * voteCandidates.length);
    const target = voteCandidates[randomIndex];

    return { targetId: target.id, reasonType: "random" };
}
