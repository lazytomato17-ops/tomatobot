// src/npcLogic.ts
import { GameState, Player } from "./types";
import { isActualWolf, isWolfTeam } from "./roles";

export function getNpcVoteTarget(npc: Player, game: GameState): { targetId: string, reasonType: string } | string {
    const alivePlayers = game.players.filter(p => p.alive);

    // ==========================================
    // 1. 投票候補のベース作成 (絶対に投票しない相手を除外)
    // ==========================================
    const voteCandidates = alivePlayers.filter(p => {
        if (p.id === npc.id) return false;
        if (isActualWolf(npc.role || '') && isActualWolf(p.role || '')) return false;
        if (npc.role === '狂信者' && isActualWolf(p.role || '')) return false;
        if (npc.role === '共有者' && p.role === '共有者') return false;
        if (game.lovers && game.lovers.includes(npc.id) && game.lovers.includes(p.id)) return false;
        
        // 妖術師が白と知っている相手は弾く
        if (npc.role === '妖術師') {
            const knownHuman = game.evidence.some(e => e.from === npc.id && (e.type === 'divine' || e.type === 'sorcery') && e.result === false && e.target === p.id);
            if (knownHuman) return false;
        }
        return true;
    });

    if (voteCandidates.length === 0) return "skip";

    // ==========================================
    // 2. 盤面情報の整理（論理のベース）
    // ==========================================
    const liars = new Set<string>();
    const provenColors: Record<string, boolean> = {};

    // 霊能結果の確定 (霊能者が複数出ている＝破綻している場合は確定させない)
    const mediumEvidences = game.evidence.filter(e => e.visible && e.type === 'medium_co' && e.target !== 'none');
    const activeMediumIds = [...new Set(mediumEvidences.map(e => e.from))];
    if (activeMediumIds.length === 1) {
        mediumEvidences.forEach(e => { provenColors[e.target] = e.result as boolean; });
    }

    // 破綻者（嘘つき）の検出
    game.evidence.filter(e => e.visible && e.type === 'divine').forEach(e => {
        if (provenColors[e.target] !== undefined && provenColors[e.target] !== e.result) liars.add(e.from);
    });

    // 黒出し・白出しカウント (嘘つきと判明した奴からの情報は無視する)
    const blackTargetCounts: Record<string, number> = {};
    const whiteTargetCounts: Record<string, number> = {};
    game.evidence.filter(e => e.visible && e.type === 'divine' && !liars.has(e.from)).forEach(e => {
        if (e.result === true) {
            blackTargetCounts[e.target] = (blackTargetCounts[e.target] || 0) + 1;
        } else {
            whiteTargetCounts[e.target] = (whiteTargetCounts[e.target] || 0) + 1;
        }
    });

    // 自分が黒を出した相手
    const myBlackTargets = game.evidence.filter(e => e.from === npc.id && e.result === true).map(e => e.target);

    // ==========================================
    // 3. 【新実装】性格（Personality）による独自のスコア評価
    // ==========================================
    let maxScore = -9999;
    let bestTargetId = 'skip';
    let bestReason = 'gray';

    const yesterdayLog = game.voteLog?.find(v => v.day === game.dayCount - 1);
    const isEnemyTeam = isWolfTeam(npc.role || '');
    const pTone = npc.personality || 'normal';

    voteCandidates.forEach(p => {
        let score = 0;
        let reason = "gray";

        // 基礎データの取得
        const chatMentions = game.chatLog?.filter(l => l.day === game.dayCount && l.id !== npc.id && l.content.includes(p.name)).length || 0;
        const isRevenge = yesterdayLog && yesterdayLog.votes[p.id] === npc.id;
        const isLiar = liars.has(p.id);
        const blackCount = blackTargetCounts[p.id] || 0;
        const whiteCount = whiteTargetCounts[p.id] || 0;

        // 🧠【性格別の思考回路（スコアの重み付け）】
        if (pTone === 'logical' || pTone === 'serious') {
            // 👓 学級委員長タイプ（論理至上主義）
            // 恨みや空気は無視。占い結果や破綻などの「事実」だけで動く。
            score += isLiar ? 80 : 0;
            score += blackCount * 50;
            if (!isEnemyTeam) score -= whiteCount * 40; // 白確は絶対に守る
            else score += whiteCount * 10; // 人外なら白確を少し狙う
            score += Math.random() * 5; // 迷い（揺らぎ）が少ない
            
            if (isLiar) reason = "liar";
            else if (blackCount > 0 && whiteCount > 0) reason = "roller"; // パンダは処刑
            else if (blackCount > 0) reason = "trusted_black";
        }
        else if (pTone === 'aggressive' || pTone === 'jax') {
            // 💥 ヤンキータイプ（感情と暴力）
            // 占い結果より「自分に噛み付いてきた奴」や「チャットで炎上してる奴」を殴る。
            score += isRevenge ? 80 : 0; 
            score += chatMentions * 30;  
            score += blackCount * 20;
            // 白確保護なし。むかついたら白確でも殴る
            score += Math.random() * 30; // 気分で暴走する
            
            if (isRevenge) reason = "revenge";
            else if (chatMentions > 0) reason = "line_defense";
            else if (blackCount > 0) reason = "doubtful_black";
        }
        else if (pTone === 'cautious') {
            // 😨 ビビリタイプ（同調圧力）
            // 自分で推理せず、チャットの空気に流される。
            if (!isEnemyTeam) score -= whiteCount * 50; // 白確を殴る勇気はない
            score += chatMentions * 40; // とにかくみんなが疑ってる奴に入れる
            score += blackCount * 30;
            score += isRevenge ? -15 : 0; // 逆恨みされるのが怖くて自分からはやり返せない
            score += Math.random() * 10;
            
            if (reason === "gray" && chatMentions > 0) reason = "line_defense";
        }
        else if (pTone === 'sans' || pTone === 'witty') {
            // 🃏 トリックスター（気分屋）
            // セオリー完全無視。とんでもない勘や気分で投票する村のノイズ。
            score += isRevenge ? 40 : 0;
            score += Math.random() * 100; // 揺らぎが異常（完全に気分）
            if (isRevenge && Math.random() > 0.5) reason = "revenge";
        }
        else {
            // 👤 一般人（バランス型）
            score += isLiar ? 50 : 0;
            score += blackCount * 40;
            score += isRevenge ? 30 : 0;
            score += chatMentions * 15;
            if (!isEnemyTeam) score -= whiteCount * 20;
            else score += whiteCount * 10;
            score += Math.random() * 15;
            
            if (isLiar) reason = "liar";
            else if (blackCount > 0 && whiteCount > 0) reason = "roller";
            else if (blackCount > 0) reason = "trusted_black";
            else if (isRevenge) reason = "revenge";
            else if (chatMentions > 0) reason = "line_defense";
        }

        // 🎯 絶対の自信 (自分が黒出しした相手には必ず執着する)
        if (myBlackTargets.includes(p.id)) {
            score += 100;
            reason = "my_black_result";
        }

        // 最終決定
        if (score > maxScore) {
            maxScore = score;
            bestTargetId = p.id;
            bestReason = reason;
        }
    });

    return { targetId: bestTargetId, reasonType: bestReason };
}