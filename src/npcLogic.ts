// src/npcLogic.ts
import { GameState, Player } from "./types";
import { isActualWolf } from "./roles";

export function getNpcVoteTarget(npc: Player, game: GameState): { targetId: string, reasonType: string } | string {
    // 1. 生きている全プレイヤーを取得
    const alivePlayers = game.players.filter(p => p.alive);

    // 2. 投票先の候補を絞り込む
    const voteCandidates = alivePlayers.filter(p => {
        // ① 自分自身には投票しない
        if (p.id === npc.id) return false;

        // ② 仲間の判定（確白や味方には投票しない最低限の賢さ）
        
        // 人狼：他の人狼には投票しない
        if (isActualWolf(npc.role || '') && isActualWolf(p.role || '')) return false;

        // 狂信者：人狼が誰か知っているので、ご主人様(人狼)には投票しない
        if (npc.role === '狂信者' && isActualWolf(p.role || '')) return false;

        // 共有者：相方が誰か知っているので、相方には投票しない
        if (npc.role === '共有者' && p.role === '共有者') return false;

        // 恋人：愛する相手には投票しない
        if (game.lovers && game.lovers.includes(npc.id) && game.lovers.includes(p.id)) return false;

        // 上記の除外条件をすべてすり抜けたプレイヤーを候補にする
        return true;
    });

    // 3. 候補が誰もいない場合（通常はあり得ないがエラー防止）
    if (voteCandidates.length === 0) return "skip";

    // 4. 候補の中から完全にランダムで1人を選ぶ
    const randomIndex = Math.floor(Math.random() * voteCandidates.length);
    const target = voteCandidates[randomIndex];

    // ガヤ（昼の議論の発言）用の reasonType は一旦 'random' または 'gray' にしておく
    return { targetId: target.id, reasonType: "gray" };
}
