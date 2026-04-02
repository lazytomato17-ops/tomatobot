// src/db.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EmbedBuilder } from 'discord.js';
import { Player } from './types';
import { CONFIG } from './config';
import * as Messages from './messages';
import * as Roles from './roles';


const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase: SupabaseClient | null =
    supabaseUrl && supabaseKey && !supabaseUrl.startsWith('ここに')
        ? createClient(supabaseUrl, supabaseKey)
        : null;

// テーブル構造:
// users        : id, name, rate, streak, is_premium, created_at, updated_at
// matches      : id, winner_team, match_type, player_count, created_at
// match_players: match_id, user_id, role, is_win, is_alive, rate_delta
// presets      : user_id, name, settings

function getRankInfo(rate: number) {
    if (rate >= 2400) return { name: 'レジェンド',      icon: '⚜️', color: 0xFFD700 };
    if (rate >= 2000) return { name: 'グランドマスター', icon: '👑', color: 0xFF0000 };
    if (rate >= 1800) return { name: 'ダイヤモンド',    icon: '💎', color: 0x00BFFF };
    if (rate >= 1700) return { name: 'プラチナ',        icon: '💿', color: 0xE5E4E2 };
    if (rate >= 1600) return { name: 'ゴールド',        icon: '🥇', color: 0xFFD700 };
    if (rate >= CONFIG.DEFAULT_RATE) return { name: 'シルバー', icon: '🥈', color: 0xC0C0C0 };
    if (rate >= 1400) return { name: 'ブロンズ',        icon: '🥉', color: 0xCD7F32 };
    return { name: 'ルーキー', icon: '🔰', color: 0x808080 };
}

function getKFactor(winningTeam: string, totalPlayers: number, avgRate: number): number {
    let baseK = 32;
    if (['fox', 'teruteru', 'lovers'].includes(winningTeam)) baseK = 50;
    else if (winningTeam === 'wolf') baseK = 36;
    if (totalPlayers >= 8) baseK += 4;
    if (avgRate > 2200) baseK = Math.max(16, baseK * 0.8);
    return baseK;
}

function calculateEloDelta(myTeamAvg: number, oppTeamAvg: number, kFactor: number, isWin: boolean): number {
    const expected = 1 / (1 + Math.pow(10, (oppTeamAvg - myTeamAvg) / 400));
    return Math.round(kFactor * ((isWin ? 1 : 0) - expected));
}

export function isPlayerWinning(p: Player, winnerTeam: string, lovers: string[]): boolean {
    if (winnerTeam === 'lovers' && lovers.includes(p.id)) return true;
    if (winnerTeam === 'fox'      && p.role === '妖狐')     return true;
    if (winnerTeam === 'teruteru' && p.role === 'テルテル') return true;
    
    if (Roles.ROLE_CATALOG[p.role as string]?.team === winnerTeam) return true;
    
    if (p.role === 'キューピッド' && winnerTeam === 'lovers') return true;
    return false;
}

export async function getPlayersStats(
    userIds: string[]
): Promise<Record<string, { rate: number; streak: number }>> {
    const stats: Record<string, { rate: number; streak: number }> = {};
    if (!supabase || !userIds || userIds.length === 0) return stats;
    userIds.forEach(uid => { stats[uid] = { rate: CONFIG.DEFAULT_RATE, streak: 0 }; });

    const { data, error } = await supabase.from('users').select('id, rate, streak').in('id', userIds);
    if (error) { console.error('[getPlayersStats]', error); return stats; }
    (data ?? []).forEach((row: any) => {
        stats[row.id] = { rate: row.rate ?? CONFIG.DEFAULT_RATE, streak: row.streak ?? 0 };
    });
    return stats;
}

export async function predictRatingChange(
    winnerTeam: string,
    players: Player[],
    lovers: string[],
    options: any,
    mvpName: string | null,
    currentStats: Record<string, { rate: number; streak: number }>
): Promise<Record<string, number>> {
    if (!options.isRanked) return {};
    const LOSE_FACTOR = 0.6;
    const humans = players.filter(p => !p.isNpc);
    if (humans.length === 0) return {};

    const allHumansAvg = humans.reduce((s, p) => s + (currentStats[p.id]?.rate ?? CONFIG.DEFAULT_RATE), 0) / humans.length;
    const winners = humans.filter(p =>  isPlayerWinning(p, winnerTeam, lovers));
    const losers  = humans.filter(p => !isPlayerWinning(p, winnerTeam, lovers));

    const winnerAvg = winners.length > 0 ? winners.reduce((s, p) => s + (currentStats[p.id]?.rate ?? CONFIG.DEFAULT_RATE), 0) / winners.length : allHumansAvg;
    const loserAvg  = losers.length  > 0 ? losers.reduce((s, p)  => s + (currentStats[p.id]?.rate ?? CONFIG.DEFAULT_RATE), 0) / losers.length  : allHumansAvg;

    const K = getKFactor(winnerTeam, players.length, winnerAvg);
    const result: Record<string, number> = {};

    winners.forEach(p => {
        const streak = currentStats[p.id]?.streak ?? 0;
        let delta = calculateEloDelta(winnerAvg, loserAvg, K, true);
        if (delta < 10) delta = 10;
        if (streak >= 5) delta += 10; else if (streak >= 3) delta += 5;
        if (p.alive) delta += 3;
        if (p.name === mvpName) delta += 15;
        result[p.id] = delta;
    });

    losers.forEach(p => {
        let delta = calculateEloDelta(loserAvg, winnerAvg, K, false);
        delta = Math.round(delta * LOSE_FACTOR);
        const currentRate = currentStats[p.id]?.rate ?? CONFIG.DEFAULT_RATE;
        if (currentRate < 1400) delta = 0;
        else if (currentRate < 1600) delta = Math.max(-8, delta);
        if (p.name === mvpName) { delta += 10; if (delta > 0) delta = 0; }
        result[p.id] = delta;
    });

    return result;
}

export async function saveGameResults(
    game: any,
    winningSide: string,
    mvpName: string | null
): Promise<{ deltas: Record<string, number> }> {
    if (!supabase) return { deltas: {} };

    // 引数を game オブジェクトから展開
    const players = game.players;
    const lovers = game.lovers || [];
    const isRanked = game.settings.matchType === 'ranked';
    const options = { isRanked, mvpName };

    const humanPlayers = players.filter((p: any) => !p.isNpc);
    const humanIds = humanPlayers.map((p: any) => p.id);
    const currentStats = await getPlayersStats(humanIds);
    const deltas = await predictRatingChange(winningSide, players, lovers, options, mvpName, currentStats);

    // ==========================================
    // シーズン番号の取得
    // ==========================================
    let currentSeason = 1;
    const { data: seasonData } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'current_season')
        .single();
    if (seasonData) currentSeason = seasonData.value;

    // 1. matches テーブルに INSERT
    const { data: matchData, error: matchError } = await supabase
        .from('matches')
        .insert({ 
            winner_team: winningSide, 
            match_type: isRanked ? 'ranked' : 'casual', 
            player_count: players.length,
            season_id: currentSeason 
        })
        .select('id').single();

    if (matchError || !matchData) {
        console.error('[saveGameResults] matches insert error:', matchError);
        return { deltas };
    }
    const matchId = matchData.id;

    // 2. match_players に INSERT
    const matchPlayerRows = humanPlayers.map((p: any) => ({
        match_id:   matchId,
        user_id:    p.id,
        role:       p.role ?? '不明',
        is_win:     isPlayerWinning(p, winningSide, lovers),
        is_alive:   p.alive,
        rate_delta: isRanked ? (deltas[p.id] ?? 0) : 0,
    }));
    if (matchPlayerRows.length > 0) {
        const { error: mpError } = await supabase.from('match_players').insert(matchPlayerRows);
        if (mpError) console.error('[saveGameResults] match_players error:', mpError);
    }

    // 3. users テーブルを UPSERT
    const now = new Date().toISOString();
    const userUpsertRows = humanPlayers.map((p: any) => {
        const isWin    = isPlayerWinning(p, winningSide, lovers);
        const oldRate  = currentStats[p.id]?.rate   ?? CONFIG.DEFAULT_RATE;
        const oldStreak = currentStats[p.id]?.streak ?? 0;
        
        const avatarUrl = p.user ? p.user.displayAvatarURL({ extension: 'png', size: 256 }) : null;

        return {
            id:         p.id,
            name:       p.name,
            rate:       isRanked ? oldRate + (deltas[p.id] ?? 0) : oldRate,
            streak:     isWin ? oldStreak + 1 : 0,
            avatar_url: avatarUrl,
            updated_at: now,
        };
    });
    if (userUpsertRows.length > 0) {
        const { error: upsertError } = await supabase.from('users').upsert(userUpsertRows, { onConflict: 'id' });
        if (upsertError) console.error('[saveGameResults] users upsert error:', upsertError);
    }

    // ==========================================
    // 4. ★ 新機能：action_logs に完全な試合記録を保存！
    // ==========================================
    const logData = {
        history: game.history || [],
        chatLog: game.chatLog || [],
        voteLog: game.voteLog || [],
        actions: game.actions || [],
        timeline: game.timeline || [],
        // ★ これを追加！(phase.tsで作った集計データ)
        result_summary: game.resultSummary || null 
    };
    
    const { error: logError } = await supabase.from('action_logs').insert({
        match_id: matchId,
        logs: logData
    });
    
    if (logError) {
        console.error('[saveGameResults] action_logs insert error:', logError);
    } else {
        console.log(`[DB] 試合 ${matchId} の完全なアクションログ(集計データ付き)を保存しました！`);
    }

    return { deltas };
}

export async function isPremiumUser(userId: string): Promise<boolean> {
    const plan = await getUserPlan(userId);
    return plan !== 'free';
}

export async function showStats(userId: string, interaction: any) {
    if (!supabase) return interaction.editReply('データベース未接続です。');

    const { data: userData } = await supabase.from('users').select('rate, streak').eq('id', userId).single();
    const myRate    = userData?.rate       ?? CONFIG.DEFAULT_RATE;
    const streak    = userData?.streak     ?? 0;

    const { data: allUsers } = await supabase.from('users').select('id, rate');
    const totalPlayers = allUsers?.length || 1;
    const myRank = allUsers ? allUsers.filter(u => (u.rate || CONFIG.DEFAULT_RATE) > myRate).length + 1 : 1;
    
    const userPlan = await getUserPlan(userId);
    let premiumBadge = '';
    if (userPlan === 'founder') premiumBadge = ' [FOUNDER]';
    else if (userPlan === 'pro') premiumBadge = ' [PRO]';
    else if (userPlan === 'host') premiumBadge = ' [HOST]';
    else if (userPlan === 'supporter') premiumBadge = ' [SUPPORTER]'; // サポーターバッジも追加しておきました
    
    const rankInfo  = getRankInfo(myRate);
    const avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 256 });

    const { data: mpData } = await supabase.from('match_players').select('role, is_win, is_alive, rate_delta').eq('user_id', userId);
    const records = mpData ?? [];
    const total   = records.length;
    const wins    = records.filter((r: any) => r.is_win).length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

    if (total === 0) {
        const descZero = `**現在のレート**: 🏆 **${myRate}** (${myRank}位 / ${totalPlayers}人)\n\n` +
                         `まだ試合記録がありません。\nランクマッチに参加して最初の記録を刻みましょう！`;

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${rankInfo.name} ${rankInfo.icon}${premiumBadge}`)
            .setDescription(descZero)
            .setThumbnail(avatarUrl)
            .setColor(rankInfo.color);
        return interaction.editReply({ embeds: [embed] });
    }

    const roleStats: Record<string, { played: number; won: number }> = {};
    records.forEach((r: any) => {
        if (!r.role) return;
        if (!roleStats[r.role]) roleStats[r.role] = { played: 0, won: 0 };
        roleStats[r.role].played++;
        if (r.is_win) roleStats[r.role].won++;
    });

    const desc = `**現在のレート**: 🏆 **${myRate}** (${myRank}位 / ${totalPlayers}人)\n` +
                 `**現在の連勝**: 🔥 **${streak}**\n\n` +
                 `**通算成績**\n` +
                 `試合: **${total}** 勝利: **${wins}**\n` +
                 `勝率: **${winRate}%**`;

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${rankInfo.name} ${rankInfo.icon}${premiumBadge}`)
        .setDescription(desc)
        .setThumbnail(avatarUrl)
        .setColor(rankInfo.color);

    await interaction.editReply({ embeds: [embed] });
}

export async function getCurrentStreak(userId: string): Promise<number> {
    if (!supabase) return 0;
    const { data } = await supabase.from('users').select('streak').eq('id', userId).single();
    return data?.streak ?? 0;
}

export async function getPresets(userId: string) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('presets').select('*').eq('user_id', userId).order('created_at', { ascending: true });
    if (error) { console.error(error); return []; }
    return data || [];
}

export async function savePreset(userId: string, name: string, settings: any, userName: string = 'Player') {
    if (!supabase) return { success: false, message: 'DB未接続です。' };

    await supabase.from('users').upsert(
        { id: userId, name: userName, rate: CONFIG.DEFAULT_RATE, streak: 0, updated_at: new Date().toISOString() }, 
        { onConflict: 'id', ignoreDuplicates: true }
    );

    const isPremium = await isPremiumUser(userId);
    if (!isPremium) return { success: false, message: '⚠️ **機能ロック中**\nオリジナルプリセットの保存はサポーター（VIP）以上向けに限定解放されています。' };
    
    const presets = await getPresets(userId);
    const existing = presets.find((p: any) => p.name === name);
    
    const maxPresets = 20;
    if (!existing && presets.length >= maxPresets) return { success: false, message: `⚠️ 保存枠の上限（最大${maxPresets}枠）に達しています。` };
    
    const { error } = await supabase.from('presets').upsert({ user_id: userId, name, settings }, { onConflict: 'user_id, name' });
    if (error) {
        console.error('[savePreset Error]', error);
        return { success: false, message: '保存時にエラーが発生しました。' };
    }
    return { success: true, message: `✅ プリセット「**${name}**」として保存しました！` };
}

export async function deletePreset(userId: string, name: string) {
    if (!supabase) return { success: false, message: 'DB未接続です。' };
    const { error } = await supabase.from('presets').delete().match({ user_id: userId, name });
    if (error) return { success: false, message: '削除に失敗しました。' };
    return { success: true, message: `🗑️ プリセット「**${name}**」を削除しました。` };
}

export async function saveProfileSetting(userId: string, key: string, value: string | null) {
    if (!supabase) return false;
    const presets = await getPresets(userId);
    const profile = presets.find((p: any) => p.name === '__profile__');
    const currentSettings = profile?.settings ?? {};
    if (value === null) delete currentSettings[key]; else currentSettings[key] = value;
    const { error } = await supabase.from('presets').upsert({ user_id: userId, name: '__profile__', settings: currentSettings }, { onConflict: 'user_id, name' });
    return !error;
}

export async function applyPenalty(userId: string, userName: string, type: string, reason: string) {
    if (!supabase) return { success: false, message: 'DB未接続です。' };
    if (type !== 'reset_rate') return { success: false, message: '不明なペナルティタイプです。' };
    const { error } = await supabase.from('users').upsert({ id: userId, name: userName, rate: CONFIG.DEFAULT_RATE, streak: 0, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) return { success: false, message: 'DBエラーが発生しました。' };
    return { success: true, message: `レートを初期値(${CONFIG.DEFAULT_RATE})に強制リセットしました` };
}

export async function resetSeasonAllUsers() {
    if (!supabase) return { topRate: [], topUser: null };

    try {
        const { data: seasonData } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'current_season')
            .single();
        
        const nextSeason = (seasonData?.value || 1) + 1;
        
        const { error: seasonUpdateError } = await supabase
            .from('system_settings')
            .upsert({ key: 'current_season', value: nextSeason });
            
        if (seasonUpdateError) {
            console.error('[resetSeasonAllUsers] シーズン更新エラー:', seasonUpdateError);
        } else {
            console.log(`[Season Reset] シーズン設定を Season ${nextSeason} に更新しました！`);
        }
    } catch (e) {
        console.error('[resetSeasonAllUsers] シーズン処理中にエラーが発生しました:', e);
    }

    const { data: topRateData } = await supabase.from('users').select('id, name, rate').order('rate', { ascending: false }).limit(3);
    const { data: allUsers } = await supabase.from('users').select('id');
    
    if (allUsers && allUsers.length > 0) {
        const now = new Date().toISOString();
        const resetRows = allUsers.map((u: any) => ({ id: u.id, rate: CONFIG.DEFAULT_RATE, streak: 0, updated_at: now }));
        const { error } = await supabase.from('users').upsert(resetRows, { onConflict: 'id' });
        if (error) console.error('[resetSeasonAllUsers]', error);
        console.log(`[Season Reset] ${resetRows.length}人のレートをリセットしました。`);
    }
    
    return { topRate: topRateData ?? [], topUser: topRateData?.[0] ?? null };
}

const planCache = new Map<string, { plan: string, expires: number }>();
const CACHE_TTL = 1000 * 60 * 5;

export async function getUserPlan(userId: string): Promise<'free' | 'founder' | 'pro' | 'host' | 'supporter'> {
    const cached = planCache.get(userId);
    if (cached && cached.expires > Date.now()) {
        return cached.plan as 'free' | 'founder' | 'pro' | 'host' | 'supporter';
    }

    try {
        // @ts-ignore
        if (!supabase) return 'free';

        // @ts-ignore
        const { data, error } = await supabase
            .from('users')
            .select('plan')
            .eq('id', userId)
            .single();

        if (error || !data || !data.plan) {
            return 'free';
        }

        const plan = data.plan as 'free' | 'founder' | 'pro' | 'host' | 'supporter';
        planCache.set(userId, { plan, expires: Date.now() + CACHE_TTL });
        return plan;

    } catch (e) {
        console.error('DB Fetch Error (getUserPlan):', e);
        return 'free';
    }
}

export function clearUserPlanCache(userId: string) {
    planCache.delete(userId);
}
