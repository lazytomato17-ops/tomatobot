// src/npcLogic.ts
import { GameState, Player } from "./types";
import { isActualWolf, isWolfTeam } from "./roles";

export function getNpcVoteTarget(npc: Player, game: GameState): { targetId: string, reasonType: string } | string {
    const alivePlayers = game.players.filter(p => p.alive);

    // ==========================================
    // 1. 投票候補のベース作成
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
    // 2. 盤面の全体共有情報の整理 と 🚨【破綻（嘘つき）の検出】
    // ==========================================
    const aliveSeerIds = [...new Set(game.evidence.filter(e => e.visible && e.type === 'divine').map(e => e.from))]
        .filter(id => alivePlayers.some(p => p.id === id));

    const liars = new Set<string>(); // 破綻した嘘つきのリスト
    const provenColors: Record<string, boolean> = {}; // 確定した白黒（霊能結果など）

    // 霊能者が1人だけなら、その結果を「村の確定情報」として扱う
    const mediumEvidences = game.evidence.filter(e => e.visible && e.type === 'medium_co' && e.target !== 'none');
    const activeMediumIds = [...new Set(mediumEvidences.map(e => e.from))];
    if (activeMediumIds.length === 1) {
        mediumEvidences.forEach(e => { provenColors[e.target] = e.result as boolean; });
    }

    // 確定情報と矛盾する結果を出した占い師を「破綻者」として記録
    game.evidence.filter(e => e.visible && e.type === 'divine').forEach(e => {
        if (provenColors[e.target] !== undefined && provenColors[e.target] !== e.result) {
            liars.add(e.from);
        }
    });

    // 黒出しカウント（ただし、破綻者からの黒出しはノーカウントにする！）
    const blackTargetCounts: Record<string, number> = {};
    game.evidence.filter(e => e.visible && e.type === 'divine' && e.result === true && !liars.has(e.from)).forEach(e => {
        blackTargetCounts[e.target] = (blackTargetCounts[e.target] || 0) + 1;
    });

    const blackCandidates = voteCandidates.filter(p => blackTargetCounts[p.id] > 0);
    blackCandidates.sort((a, b) => blackTargetCounts[b.id] - blackTargetCounts[a.id]);

    // ==========================================
    // 3. 役職固有の主観ロジック（ブチギレ反撃を含む）
    // ==========================================
    
    // 【自分の確定白リスト】（自分自身、または相方など絶対に白だと知っている相手）
    const myKnownWhites = new Set<string>();
    if (!isActualWolf(npc.role || '')) myKnownWhites.add(npc.id); // 人狼以外は自分が白だと知っている
    if (npc.role === '共有者') {
        const partner = alivePlayers.find(p => p.role === '共有者' && p.id !== npc.id);
        if (partner) myKnownWhites.add(partner.id);
    }
    if (game.lovers && game.lovers.includes(npc.id)) {
        const partnerId = game.lovers.find(id => id !== npc.id);
        if (partnerId) myKnownWhites.add(partnerId);
    }

    // 🚨【村人陣営のブチギレ反撃】
    const fakeSeersToMe = game.evidence
        .filter(e => e.visible && e.type === 'divine' && e.result === true && myKnownWhites.has(e.target))
        .map(e => e.from);
    
    const targetFakeSeers = voteCandidates.filter(p => fakeSeersToMe.includes(p.id));
    
    // 🌟 修正：100%反撃するのではなく、30%の確率でパニックになって別の行動をとる
    if (targetFakeSeers.length > 0 && Math.random() < 0.7) {
        return { targetId: targetFakeSeers[0].id, reasonType: "liar" }; 
    }

    // 【占い師・霊能者・狂人（騙り）】自分の「黒出し」結果への対応
    const myBlackTargets = game.evidence
        .filter(e => e.from === npc.id && e.result === true)
        .map(e => e.target);
    const validMyBlackTargets = voteCandidates.filter(p => myBlackTargets.includes(p.id));
    
    if (validMyBlackTargets.length > 0) {
        const isFirmBeliever = !isWolfTeam(npc.role || '') || npc.role === '狂人';
        // ただし、もし自分の黒出し先が「霊能結果で白」と判明して破綻してしまった場合、
        // 狂人は「やべっ」となって適当なところへ投票先をずらす（ポンコツムーブ）
        const targetId = validMyBlackTargets[validMyBlackTargets.length - 1].id;
        if (!liars.has(npc.id) || Math.random() < 0.3) {
            if (isFirmBeliever || Math.random() < 0.8) {
                return { targetId: targetId, reasonType: "my_black_result" };
            }
        }
    }

    // 【妖術師】能力で「人間」だと判明した相手を積極的に攻撃する
    if (npc.role === '妖術師') {
        const knownHumans = game.evidence
            .filter(e => e.from === npc.id && (e.type === 'divine' || e.type === 'sorcery') && e.result === false)
            .map(e => e.target);
        
        const validHumanTargets = voteCandidates.filter(p => knownHumans.includes(p.id));
        if (validHumanTargets.length > 0 && Math.random() < 0.7) {
            return { targetId: validHumanTargets[validHumanTargets.length - 1].id, reasonType: "gray" };
        }
    }

    // 【人狼】仲間に黒出ししてきた占い師への反撃（偽装あり）
    if (isActualWolf(npc.role || '')) {
        const wolfIds = alivePlayers.filter(p => isActualWolf(p.role || '')).map(p => p.id);
        const hostileSeers = game.evidence
            .filter(e => e.visible && e.type === 'divine' && e.result === true && wolfIds.includes(e.target))
            .map(e => e.from);
        
        const tSeers = voteCandidates.filter(p => hostileSeers.includes(p.id));
        const counterChance = game.dayCount >= 3 ? 0.5 : 0.2; 
        
        if (tSeers.length > 0 && Math.random() < counterChance) {
            const randomIndex = Math.floor(Math.random() * tSeers.length);
            return { targetId: tSeers[randomIndex].id, reasonType: "gray" }; 
        }
    }

    // 【狂人】盤面を荒らすノイズ行動（偽装あり）
    if (npc.role === '狂人') {
        const r = Math.random();
        if (r < 0.4) {
            const tSeers = voteCandidates.filter(p => aliveSeerIds.includes(p.id));
            const pool = tSeers.length > 0 ? tSeers : voteCandidates; 
            const randomIndex = Math.floor(Math.random() * pool.length);
            return { targetId: pool[randomIndex].id, reasonType: "gray" }; 
        } 
        else if (r < 0.7) { 
            const randomIndex = Math.floor(Math.random() * voteCandidates.length);
            return { targetId: voteCandidates[randomIndex].id, reasonType: "gray" };
        }
    }

    // ==========================================
    // 4. 客観的な村人ロジック（セオリー）
    // ==========================================

    // 🚨【破綻者の処刑】
    const knownLiars = voteCandidates.filter(p => liars.has(p.id));
    if (knownLiars.length > 0) {
        // 🌟 修正：90%だと盤面が固定化しすぎるため、50%に落とす
        // 残りの50%のNPCは「破綻に気づかず、占いローラーやグレー吊りなどの通常思考に流れる」
        if (Math.random() < 0.5) {
            const randomIndex = Math.floor(Math.random() * knownLiars.length);
            return { targetId: knownLiars[randomIndex].id, reasonType: "liar" }; 
        }
    }

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
    // 5. グレーへのランダム投票
    // ==========================================
    const randomIndex = Math.floor(Math.random() * voteCandidates.length);
    return { targetId: voteCandidates[randomIndex].id, reasonType: "gray" };
}
