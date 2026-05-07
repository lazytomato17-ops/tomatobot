// src/npcLogic.ts
import { GameState, Player } from "./types";
import { isActualWolf, isWolfTeam } from "./roles";

export function getNpcVoteTarget(npc: Player, game: GameState): { targetId: string, reasonType: string } | string {
    const alivePlayers = game.players.filter(p => p.alive);

    // ==========================================
    // 1. 投票候補のベース作成（絶対に投票しない相手の除外）
    // ==========================================
    const voteCandidates = alivePlayers.filter(p => {
        if (p.id === npc.id) return false;
        if (isActualWolf(npc.role || '') && isActualWolf(p.role || '')) return false;
        if (npc.role === '狂信者' && isActualWolf(p.role || '')) return false;
        if (npc.role === '共有者' && p.role === '共有者') return false;
        if (game.lovers && game.lovers.includes(npc.id) && game.lovers.includes(p.id)) return false;
        return true;
    });

    if (voteCandidates.length === 0) return "skip";

    // ==========================================
    // 2. 盤面の全体共有情報の整理
    // ==========================================
    const aliveSeerIds = [...new Set(game.evidence.filter(e => e.visible && e.type === 'divine').map(e => e.from))]
        .filter(id => alivePlayers.some(p => p.id === id));

    const blackTargetCounts: Record<string, number> = {};
    game.evidence.filter(e => e.visible && e.type === 'divine' && e.result === true).forEach(e => {
        blackTargetCounts[e.target] = (blackTargetCounts[e.target] || 0) + 1;
    });

    const blackCandidates = voteCandidates.filter(p => blackTargetCounts[p.id] > 0);
    blackCandidates.sort((a, b) => blackTargetCounts[b.id] - blackTargetCounts[a.id]);

    // ==========================================
    // 3. 役職固有の主観ロジック
    // ==========================================
    
    // 【占い師・霊能者（騙り含む）】自分で見つけた黒は優先して吊る
    const myBlackTargets = game.evidence
        .filter(e => e.from === npc.id && e.result === true)
        .map(e => e.target);
    const validMyBlackTargets = voteCandidates.filter(p => myBlackTargets.includes(p.id));
    
    if (validMyBlackTargets.length > 0) {
        // ③ 真役職は100%貫くが、人狼陣営の騙りは20%の確率で嘘を貫けず別の行動をとる（人間味）
        if (!isWolfTeam(npc.role || '') || Math.random() < 0.8) {
            return { targetId: validMyBlackTargets[validMyBlackTargets.length - 1].id, reasonType: "my_black_result" };
        }
    }

    // 【人狼】仲間に黒出ししてきた占い師への反撃（偽装あり）
    if (isActualWolf(npc.role || '')) {
        const wolfIds = alivePlayers.filter(p => isActualWolf(p.role || '')).map(p => p.id);
        const hostileSeers = game.evidence
            .filter(e => e.visible && e.type === 'divine' && e.result === true && wolfIds.includes(e.target))
            .map(e => e.from);
        
        const targetSeers = voteCandidates.filter(p => hostileSeers.includes(p.id));
        const counterChance = game.dayCount >= 3 ? 0.5 : 0.2; 
        
        if (targetSeers.length > 0 && Math.random() < counterChance) {
            // ② 複数の人狼が一斉に同じ占い師を狙わないよう、対象が複数いればランダムにする
            const randomIndex = Math.floor(Math.random() * targetSeers.length);
            return { targetId: targetSeers[randomIndex].id, reasonType: "gray" }; 
        }
    }

    // 【狂人】盤面を荒らすノイズ行動（偽装あり）
    if (npc.role === '狂人') {
        const r = Math.random();
        // 40%の確率で占い師（いなければグレー全員）をターゲットのプールにする
        if (r < 0.4) {
            const targetSeers = voteCandidates.filter(p => aliveSeerIds.includes(p.id));
            const pool = targetSeers.length > 0 ? targetSeers : voteCandidates; 
            const randomIndex = Math.floor(Math.random() * pool.length);
            return { targetId: pool[randomIndex].id, reasonType: "gray" }; 
        } 
        // 30%の確率で完全ランダム
        else if (r < 0.7) { 
            const randomIndex = Math.floor(Math.random() * voteCandidates.length);
            return { targetId: voteCandidates[randomIndex].id, reasonType: "gray" };
        }
        // 残り30%はそのまま下の村人セオリーへ流れる
    }

    // ==========================================
    // 4. 客観的な村人ロジック（セオリー）
    // ==========================================
    if (aliveSeerIds.length >= 2) {
        const rollerChance = game.dayCount >= 3 ? 0.7 : 0.2;
        if (Math.random() < rollerChance) {
            const rollerCandidates = voteCandidates.filter(p => aliveSeerIds.includes(p.id));
            if (rollerCandidates.length > 0) {
                const randomIndex = Math.floor(Math.random() * rollerCandidates.length);
                return { targetId: rollerCandidates[randomIndex].id, reasonType: "seer_co_suspect" }; 
            }
        } 
        else {
            if (blackCandidates.length > 0 && Math.random() < 0.3) { 
                return { targetId: blackCandidates[0].id, reasonType: "doubtful_black" };
            }
        }
    } 
    else {
        if (blackCandidates.length > 0 && Math.random() < 0.8) {
            return { targetId: blackCandidates[0].id, reasonType: "trusted_black" }; 
        }
    }

    // ==========================================
    // 5. 完全なグレーへのランダム投票
    // ==========================================
    const randomIndex = Math.floor(Math.random() * voteCandidates.length);
    return { targetId: voteCandidates[randomIndex].id, reasonType: "gray" };
}