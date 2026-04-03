#![deny(clippy::all)]

use napi_derive::napi;
use std::collections::{HashMap, HashSet};

// ==========================================
// 前半：BotのDiscord本番用NPCロジック（絶対に消しちゃダメな部分）
// ==========================================

#[napi(object)]
pub struct RustPlayer {
    pub id: String,
    pub alive: bool,
    pub role: String,
    pub personality: String,
}

#[napi(object)]
pub struct RustEvidence {
    #[napi(js_name = "type")]
    pub evidence_type: String,
    pub from: String,
    pub target: String,
    pub result: bool,
    pub visible: bool,
}

#[napi(object)]
pub struct RustVoteLog {
    pub votes: HashMap<String, String>,
}

#[napi(object)]
pub struct RustGameState {
    pub players: Vec<RustPlayer>,
    pub evidence: Vec<RustEvidence>,
    pub lovers: Vec<String>,
    pub day_count: u32,
    pub is_public_vote: bool,
    pub chat_counts: HashMap<String, u32>,
    pub vote_logs: Vec<RustVoteLog>,
}

#[napi(object)]
pub struct VoteResult {
    pub target_id: String,
    pub reason_type: String,
}

struct Traits { silence: f64, gray: f64, liar: f64, roller: f64, protect: f64, logical: f64, random: f64, aggressive: f64 }

fn get_traits(p: &str) -> Traits {
    match p {
        "aggressive" => Traits { silence: 3.0, gray: 1.5, liar: 1.0, roller: 1.0, protect: 0.5, logical: 0.5, random: 10.0, aggressive: 2.0 },
        "cautious"   => Traits { silence: 0.5, gray: 0.5, liar: 1.0, roller: 0.2, protect: 2.0, logical: 1.0, random: 5.0,  aggressive: 0.5 },
        "logical"    => Traits { silence: 1.0, gray: 1.0, liar: 2.0, roller: 2.0, protect: 1.0, logical: 2.0, random: 0.0,  aggressive: 1.0 },
        "joker"      => Traits { silence: 0.0, gray: 0.5, liar: 0.5, roller: 0.0, protect: 0.0, logical: 0.0, random: 40.0, aggressive: 1.5 },
        "gal"        => Traits { silence: 1.5, gray: 1.0, liar: 0.8, roller: 0.5, protect: 0.8, logical: 0.5, random: 15.0, aggressive: 1.2 },
        "serious"    => Traits { silence: 1.2, gray: 1.2, liar: 1.5, roller: 1.2, protect: 1.5, logical: 1.5, random: 5.0,  aggressive: 1.0 },
        "witty"      => Traits { silence: 0.8, gray: 1.0, liar: 1.2, roller: 1.0, protect: 1.0, logical: 1.5, random: 10.0, aggressive: 1.0 },
        _            => Traits { silence: 1.0, gray: 1.0, liar: 1.0, roller: 1.0, protect: 1.0, logical: 1.0, random: 10.0, aggressive: 1.0 },
    }
}

#[napi]
pub fn calculate_npc_vote(npc: RustPlayer, game: RustGameState, rand_values: Vec<f64>) -> VoteResult {
    let mut trait_vals = get_traits(&npc.personality);
    if npc.role == "テルテル" { trait_vals.random = 100.0; }

    let alive_players: Vec<&RustPlayer> = game.players.iter().filter(|p| p.alive).collect();
    let others: Vec<&RustPlayer> = alive_players.iter().filter(|p| p.id != npc.id).copied().collect();

    for e in &game.evidence {
        if e.from == npc.id && (e.evidence_type == "divine" || e.evidence_type == "medium_co") && e.result {
            if others.iter().any(|p| p.id == e.target) {
                return VoteResult { target_id: e.target.clone(), reason_type: "black".to_string() };
            }
        }
    }

    let mut scores: HashMap<String, f64> = HashMap::new();
    let mut reasons: HashMap<String, String> = HashMap::new();
    for p in &others {
        scores.insert(p.id.clone(), 0.0);
        reasons.insert(p.id.clone(), "gray".to_string());
    }

    let mut liars = HashSet::new();
    if npc.role == "検死官" {
        let dead_players: Vec<&RustPlayer> = game.players.iter().filter(|p| !p.alive).collect();
        for dead in dead_players {
            let is_wolf = dead.role == "人狼";
            for e in &game.evidence {
                if e.visible && e.evidence_type == "divine" && e.target == dead.id && e.result != is_wolf {
                    liars.insert(e.from.clone());
                }
            }
        }
    }
    if !["人狼", "狂人", "狂信者", "妖術師"].contains(&npc.role.as_str()) {
        for e in &game.evidence {
            if e.visible && e.evidence_type == "divine" && e.target == npc.id && e.result {
                liars.insert(e.from.clone());
            }
        }
    }
    for med in &game.evidence {
        if med.visible && med.evidence_type == "medium_co" {
            for seer in &game.evidence {
                if seer.visible && seer.evidence_type == "divine" && seer.target == med.target {
                    if seer.result != med.result {
                        liars.insert(seer.from.clone());
                        liars.insert(med.from.clone());
                    }
                }
            }
        }
    }

    for liar_id in &liars {
        if let Some(s) = scores.get_mut(liar_id) {
            *s += 500.0 * trait_vals.liar;
            let is_self_破綻 = game.evidence.iter().any(|e| e.from == *liar_id && e.target == npc.id && e.result);
            if npc.role == "検死官" { reasons.insert(liar_id.clone(), "coroner_truth".to_string()); }
            else if is_self_破綻 { reasons.insert(liar_id.clone(), "self_破綻".to_string()); }
            else { reasons.insert(liar_id.clone(), "liar".to_string()); }
        }
    }

    let mut valid_seers = HashSet::new();
    let mut confirmed_whites = HashSet::new();
    let mut confirmed_blacks = HashSet::new();
    for e in &game.evidence {
        if e.visible && e.evidence_type == "divine" && !liars.contains(&e.from) {
            if let Some(seer) = game.players.iter().find(|p| p.id == e.from) {
                if seer.alive { valid_seers.insert(e.from.clone()); }
            }
            if e.result { confirmed_blacks.insert(e.target.clone()); }
            else { confirmed_whites.insert(e.target.clone()); }
        }
    }

    for id in &confirmed_blacks {
        if let Some(s) = scores.get_mut(id) {
            *s += 80.0;
            if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "black".to_string()); }
        }
    }
    for id in &confirmed_whites {
        if let Some(s) = scores.get_mut(id) { *s -= 80.0; }
    }

    let mut claimed_mediums = HashSet::new();
    let mut claimed_coroners = HashSet::new();
    for e in &game.evidence {
        if let Some(p) = game.players.iter().find(|pl| pl.id == e.from) {
            if p.alive {
                if e.evidence_type == "medium_co" { claimed_mediums.insert(e.from.clone()); }
                if e.evidence_type == "coroner_co" { claimed_coroners.insert(e.from.clone()); }
            }
        }
    }

    for p in &others {
        let id = &p.id;
        let is_co = game.evidence.iter().any(|e| e.from == *id);
        let chat_count = game.chat_counts.get(id).copied().unwrap_or(0);
        
        let mut has_good_vote = false;
        for log in &game.vote_logs {
            if let Some(my_vote) = log.votes.get(id) {
                if liars.contains(my_vote) || confirmed_blacks.contains(my_vote) { has_good_vote = true; }
            }
        }

        let mut is_protecting_liar = false;
        for e in &game.evidence {
            if e.from == *id && !e.result && liars.contains(&e.target) { is_protecting_liar = true; }
        }

        if is_co && !liars.contains(id) && valid_seers.contains(id) {
            if valid_seers.len() < 2 {
                if let Some(s) = scores.get_mut(id) { *s -= 60.0 * trait_vals.protect; }
            } else {
                if let Some(s) = scores.get_mut(id) {
                    *s += 80.0 * trait_vals.roller;
                    if chat_count <= game.day_count { *s += 40.0; }
                    if has_good_vote { *s -= 30.0; } else if game.day_count >= 3 { *s += 30.0; }
                    if is_protecting_liar { *s += 80.0; reasons.insert(id.clone(), "line_defense".to_string()); }
                }
                if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "roller".to_string()); }
            }
        }

        if claimed_mediums.contains(id) && !liars.contains(id) {
            if claimed_mediums.len() < 2 {
                if let Some(s) = scores.get_mut(id) { *s -= 60.0 * trait_vals.protect; }
            } else {
                if let Some(s) = scores.get_mut(id) {
                    *s += 80.0 * trait_vals.roller;
                    if chat_count <= game.day_count { *s += 40.0; }
                    if has_good_vote { *s -= 30.0; } else if game.day_count >= 3 { *s += 30.0; }
                    if is_protecting_liar { *s += 80.0; reasons.insert(id.clone(), "line_defense".to_string()); }
                }
                if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "roller".to_string()); }
            }
        }

        if claimed_coroners.contains(id) && !liars.contains(id) {
            if claimed_coroners.len() < 2 {
                if let Some(s) = scores.get_mut(id) { *s -= 60.0 * trait_vals.protect; }
            } else {
                if let Some(s) = scores.get_mut(id) {
                    *s += 80.0 * trait_vals.roller;
                    if chat_count <= game.day_count { *s += 40.0; }
                    if has_good_vote { *s -= 30.0; } else if game.day_count >= 3 { *s += 30.0; }
                    if is_protecting_liar { *s += 80.0; reasons.insert(id.clone(), "line_defense".to_string()); }
                }
                if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "roller".to_string()); }
            }
        }
    }

    if game.is_public_vote {
        let mut suspects = liars.clone();
        for b in &confirmed_blacks { suspects.insert(b.clone()); }

        if let Some(last_log) = game.vote_logs.last() {
            for p in &others {
                let id = &p.id;
                if !suspects.is_empty() {
                    if let Some(voted_for) = last_log.votes.get(id) {
                        if !suspects.contains(voted_for) {
                            if let Some(s) = scores.get_mut(id) {
                                if *s < 1000.0 {
                                    *s += 40.0 * trait_vals.logical;
                                    if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "line_defense".to_string()); }
                                }
                            }
                        }
                    }
                }
                if let Some(voted_for) = last_log.votes.get(id) {
                    if voted_for == &npc.id {
                        if let Some(s) = scores.get_mut(id) {
                            *s += 40.0 * trait_vals.aggressive;
                            if reasons.get(id).map(|r| r.as_str()) == Some("gray") { reasons.insert(id.clone(), "revenge".to_string()); }
                        }
                    }
                }
            }
        }
    }

    for p in &others {
        let id = &p.id;
        let s_val = scores.get(id).copied().unwrap_or(0.0);
        if s_val >= 100.0 || s_val <= -100.0 { continue; }

        let is_co = game.evidence.iter().any(|e| e.from == *id);
        let is_white = confirmed_whites.contains(id);
        if !is_co && !is_white {
            if let Some(s) = scores.get_mut(id) {
                *s += 20.0 * trait_vals.gray;
                if game.day_count >= 3 { *s += 30.0; }
                
                let chat_count = game.chat_counts.get(id).copied().unwrap_or(0);
                if (chat_count as f64) < (game.day_count as f64) * 0.5 {
                    *s += 10.0 * trait_vals.silence;
                    reasons.insert(id.clone(), "silence".to_string());
                }
            }
        }
    }

    if ["人狼", "狂信者"].contains(&npc.role.as_str()) {
        let wolf_ids: HashSet<String> = alive_players.iter().filter(|p| p.role == "人狼").map(|p| p.id.clone()).collect();
        if wolf_ids.len() >= alive_players.len() - wolf_ids.len() {
            if let Some(target) = others.iter().find(|p| !wolf_ids.contains(&p.id)) {
                return VoteResult { target_id: target.id.clone(), reason_type: "wolf_pp".to_string() };
            }
        }
        for w_id in &wolf_ids {
            if let Some(s) = scores.get_mut(w_id) { if *s < 400.0 { *s = -9999.0; } }
        }
    }
    if npc.role == "共有者" {
        if let Some(partner) = alive_players.iter().find(|p| p.role == "共有者" && p.id != npc.id) {
            if let Some(s) = scores.get_mut(&partner.id) { *s = -9999.0; }
        }
    }
    if game.lovers.contains(&npc.id) {
        if let Some(partner_id) = game.lovers.iter().find(|id| *id != &npc.id) {
            if let Some(s) = scores.get_mut(partner_id) { *s = -9999.0; }
        }
    }

    let mut rand_idx = 0;
    for (_id, s) in scores.iter_mut() {
        if *s > -5000.0 {
            let r = rand_values.get(rand_idx).copied().unwrap_or(0.5);
            *s += r * trait_vals.random;
            rand_idx += 1;
        }
    }

    let mut sorted_candidates: Vec<(&String, &f64)> = scores.iter().filter(|(_, s)| **s > -9000.0).collect();
    sorted_candidates.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));

    if sorted_candidates.is_empty() {
        return VoteResult { target_id: "skip".to_string(), reason_type: "skip".to_string() };
    }

    let top_id = sorted_candidates[0].0;
    VoteResult {
        target_id: top_id.clone(),
        reason_type: reasons.get(top_id).cloned().unwrap_or_else(|| "gray".to_string())
    }
}

// ==========================================
// 後半：人間とNPC混在シミュレーター（バランス調整用）
// ==========================================

use rand::seq::SliceRandom;
use rand::thread_rng;
use rand::Rng; 

#[napi(object)]
pub struct SimulationResult {
  pub villager_wins: u32,
  pub wolf_wins: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Color { White, Black }

#[napi]
pub fn run_simulation(iterations: u32, roles: Vec<String>) -> SimulationResult {
    let mut villager_wins = 0;
    let mut wolf_wins = 0;
    let mut rng = thread_rng();

    for _ in 0..iterations {
        let num_players = roles.len();
        
        // 1. 忖度なしの役職配分（ただのシャッフル）
        let mut current_roles = roles.clone();
        current_roles.shuffle(&mut rng);

        let mut alive = vec![true; num_players];
        let mut is_co = vec![false; num_players];
        let mut fake_wolf_idx: Option<usize> = None;
        
        for i in 0..num_players {
            if current_roles[i] == "seer" || current_roles[i] == "madman" { 
                is_co[i] = true; 
            }
            
            if current_roles[i] == "wolf" && fake_wolf_idx.is_none() && rng.gen_bool(0.3) {
                is_co[i] = true;
                fake_wolf_idx = Some(i);
            }
        }

        let mut reports: Vec<Vec<Option<Color>>> = vec![vec![None; num_players]; num_players];
        let mut proven_fake = vec![false; num_players]; 
        let mut last_executed: Option<usize> = None; 
        let mut is_first_night = true;

        loop {
            // === 🌙 夜のフェーズ ===
            // 霊能者の発見
            let medium_alive = current_roles.iter().enumerate().any(|(i, r)| alive[i] && r == "medium");
            if medium_alive {
                if let Some(target) = last_executed {
                    let actual_color = if current_roles[target] == "wolf" { Color::Black } else { Color::White };
                    for seer_idx in 0..num_players {
                        if is_co[seer_idx] && !proven_fake[seer_idx] {
                            if let Some(reported_color) = reports[seer_idx][target] {
                                if reported_color != actual_color { proven_fake[seer_idx] = true; }
                            }
                        }
                    }
                }
            }

            // 占い師・狂人・人狼占い師の「占い報告」
            for i in 0..num_players {
                if alive[i] && is_co[i] && !proven_fake[i] {
                    let uninspected: Vec<usize> = (0..num_players)
                        .filter(|&j| alive[j] && i != j && reports[i][j].is_none())
                        .collect();
                    
                    if let Some(&target) = uninspected.choose(&mut rng) {
                        if current_roles[i] == "seer" {
                            // 真占い師：真実を報告
                            reports[i][target] = Some(if current_roles[target] == "wolf" { Color::Black } else { Color::White });
                        } else {
                            // 狂人、または騙っている人狼の嘘
                            if current_roles[target] == "wolf" {
                                // 相方の人狼を占ったなら、必ず「白」と言って守る（囲い）
                                reports[i][target] = Some(Color::White);
                            } else {
                                // 人間を占ったなら、20%で「黒（人狼）」と塗りつぶす。80%は潜伏のために白。
                                reports[i][target] = Some(if rng.gen_bool(0.15) { Color::Black } else { Color::White });
                            }
                        }              
                    }
                }
            }

            // 騎士の護衛（役職優先）
            let guard_alive = current_roles.iter().enumerate().any(|(i, r)| alive[i] && r == "guard");
            let mut protected = None;
            if guard_alive {
                let co_targets: Vec<usize> = (0..num_players).filter(|&j| alive[j] && is_co[j]).collect();
                protected = if !co_targets.is_empty() { co_targets.choose(&mut rng).copied() } 
                            else { (0..num_players).filter(|&j| alive[j]).collect::<Vec<_>>().choose(&mut rng).copied() };
            }

            // 人狼の襲撃
            let human_targets: Vec<usize> = (0..num_players).filter(|&j| alive[j] && current_roles[j] != "wolf").collect();
            let killed_tonight = human_targets.choose(&mut rng).copied();

            if !is_first_night {
                if let Some(target) = killed_tonight {
                    if protected != Some(target) { alive[target] = false; }
                }
            }
            is_first_night = false;

            // 勝敗判定（朝）
            let wolves = current_roles.iter().enumerate().filter(|(i, r)| alive[*i] && *r == "wolf").count();
            let humans = current_roles.iter().enumerate().filter(|(i, r)| alive[*i] && *r != "wolf").count();
            if wolves == 0 { villager_wins += 1; break; }
            if wolves >= humans { wolf_wins += 1; break; }

            // === ☀️ 昼のフェーズ (全員統一Bot投票) ===
            let valid_fakes: Vec<usize> = (0..num_players).filter(|&j| alive[j] && proven_fake[j]).collect();
            let active_co: Vec<usize> = (0..num_players).filter(|&j| alive[j] && is_co[j] && !proven_fake[j]).collect();
            let mut black_targets: Vec<usize> = Vec::new();
            for seer_idx in 0..num_players {
                if alive[seer_idx] && is_co[seer_idx] && !proven_fake[seer_idx] {
                    for target in 0..num_players {
                        if alive[target] && reports[seer_idx][target] == Some(Color::Black) { black_targets.push(target); }
                    }
                }
            }

            let mut votes = vec![0; num_players];
            for voter in 0..num_players {
                if !alive[voter] { continue; }
                let mut vote_target = None;

                if current_roles[voter] == "wolf" {
                    let mut targets = human_targets.clone();
                    targets.retain(|&t| alive[t]);
                    vote_target = targets.choose(&mut rng).copied();
                } else {
                    // ★ 全員が10%の確率でやらかす共通仕様
                    if rng.gen_bool(0.1) {
                        vote_target = (0..num_players).filter(|&j| alive[j]).collect::<Vec<_>>().choose(&mut rng).copied();
                    } else if !valid_fakes.is_empty() {
                        vote_target = valid_fakes.choose(&mut rng).copied();
                    } else if active_co.len() >= 2 {
                        vote_target = active_co.choose(&mut rng).copied();
                    } else if !black_targets.is_empty() {
                        vote_target = black_targets.choose(&mut rng).copied();
                    } else {
                        // 確定白除外のグレー吊り
                        let mut confirmed_whites = Vec::new();
                        for s_idx in 0..num_players {
                            if is_co[s_idx] && !proven_fake[s_idx] {
                                for t_idx in 0..num_players {
                                    if reports[s_idx][t_idx] == Some(Color::White) { confirmed_whites.push(t_idx); }
                                }
                            }
                        }
                        let grays: Vec<usize> = (0..num_players).filter(|&j| alive[j] && !is_co[j] && current_roles[j] != "medium" && !confirmed_whites.contains(&j)).collect();
                        vote_target = if !grays.is_empty() { grays.choose(&mut rng).copied() } 
                                      else { (0..num_players).filter(|&j| alive[j] && !is_co[j]).collect::<Vec<_>>().choose(&mut rng).copied() };
                    }
                }
                if let Some(t) = vote_target { votes[t] += 1; }
            }

            let max_votes = *votes.iter().max().unwrap();
            last_executed = (0..num_players).filter(|&j| votes[j] == max_votes).collect::<Vec<_>>().choose(&mut rng).copied();
            if let Some(target) = last_executed { alive[target] = false; }

            // 勝敗判定（夕方）
            let wolves = current_roles.iter().enumerate().filter(|(i, r)| alive[*i] && *r == "wolf").count();
            let humans = current_roles.iter().enumerate().filter(|(i, r)| alive[*i] && *r != "wolf").count();
            if wolves == 0 { villager_wins += 1; break; }
            if wolves >= humans { wolf_wins += 1; break; }
        }
    }
    SimulationResult { villager_wins, wolf_wins }
}