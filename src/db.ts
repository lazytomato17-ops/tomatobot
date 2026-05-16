// src/db.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { EmbedBuilder } from 'discord.js';
import { Player } from './types';
import * as Messages from './messages';
import * as Roles from './roles';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase: SupabaseClient | null =
    supabaseUrl && supabaseKey && !supabaseUrl.startsWith('ここに')
        ? createClient(supabaseUrl, supabaseKey)
        : null;

// テーブル構造:
// users            : id, name, rate, streak, plan, avatar_url, created_at, updated_at
// matches          : id, winner_team, match_type, player_count, season_id, created_at
// match_players    : match_id, user_id, role, is_win, is_alive, rate_delta
// match_participants: id, match_id, player_id, is_human, role, team, is_winner, death_reason, created_at
// game_results     : user_id, user_name, role, is_win, is_alive, is_mvp, is_ranked, bet_correct, human_count, npc_count, season_id, match_id, avatar_url, created_at
// presets          : user_id, name, settings, created_at
// system_settings  : key, value

function getRankInfo(rate: number) {
    if (rate >= 2400) return { name: 'レジェンド',       icon: '⚜️', color: 0xFFD700 };
    if (rate >= 2000) return { name: 'グランドマスター', icon: '👑', color: 0xFF0000 };
    if (rate >= 1800) return { name: 'ダイヤモンド',     icon: '💎', color: 0x00BFFF };
    if (rate >= 1700) return { name: 'プラチナ',         icon: '💿', color: 0xE5E4E2 };
    if (rate >= 1600) return { name: 'ゴールド',         icon: '🥇', color: 0xFFD700 };
    if (rate >= 1500) return { name: 'シルバー',         icon: '🥈', color: 0xC0C0C0 };
    if (rate >= 1400) return { name: 'ブロンズ',         icon: '🥉', color: 0xCD7F32 };
    return { name: 'ルーキー', icon: '🔰', color: 0x808080 };
}

// =============================================
// レート変動計算（MM2スタイル）
// 方針：
//   勝ち → レートに応じたベース値 + 各種ボーナスで気持ちよく上昇
//   負け → シンプルに下がる。ただしレート帯・状況で軽重あり
// =============================================

/**
 * レート帯に応じた勝利時のベースポイントを返す
 * 低レート帯は上がりやすく、高レートは渋くなる（MM2的感覚）
 */
function getBaseWinPoints(rate: number): number {
    if (rate < 1500) return 40;  // ルーキー：ガンガン上がる
    if (rate < 1700) return 32;  // ブロンズ〜シルバー
    if (rate < 1900) return 26;  // ゴールド
    if (rate < 2100) return 20;  // プラチナ〜ダイヤ
    if (rate < 2400) return 15;  // マスター
    return 10;                   // レジェンド：1勝が重い
}

/**
 * レート帯に応じた敗北時のペナルティを返す（正の値、あとでマイナスにする）
 */
function getBaseLossPoints(rate: number): number {
    if (rate < 1500) return 12;  // ルーキー：下がりにくい（萎えない）
    if (rate < 1700) return 18;  // ブロンズ〜シルバー
    if (rate < 1900) return 22;  // ゴールド
    if (rate < 2100) return 26;  // プラチナ〜ダイヤ
    if (rate < 2400) return 28;  // マスター
    return 32;                   // レジェンド：負けると痛い
}

// db.ts の isPlayerWinning 関数を以下のように修正

export function isPlayerWinning(p: Player, winnerTeam: string, lovers: string[], allPlayers: Player[] = [], devoteeTarget?: string): boolean {
    const isLover = lovers.includes(p.id);

    // 1. 恋人・キューピッドの勝利判定（恋人陣営勝利時のみ）
    if (winnerTeam === 'lovers') {
        // 恋人本人、またはキューピッドであれば勝利
        if (isLover || p.role === 'キューピッド') return true;
    }

    // ★ 修正ポイント: 恋人本人は、恋人陣営が勝たない限り「負け」確定にする
    // これにより、死んだ後に元のチームが勝っても便乗勝利できなくなります
    if (isLover) return false;
    
    // キューピッドも恋人が全滅した時点で負けとする
    if (p.role === 'キューピッド') return false;

    // 2. 第三陣営（狐・テルテル）の判定
    if (winnerTeam === 'fox'      && p.role === '妖狐')     return true;
    if (winnerTeam === 'teruteru' && p.role === 'テルテル') return true;

    // 3. 純愛者の勝利判定
    if (p.role === '純愛者' && devoteeTarget) {
        const target = allPlayers.find(pl => pl.id === devoteeTarget);
        if (target && target.id !== p.id) {
            return isPlayerWinning(target, winnerTeam, lovers, allPlayers, devoteeTarget);
        }
    }

    // 4. 通常陣営（村人・人狼）の判定
    const team = Roles.ROLE_CATALOG[p.role as string]?.team as string | undefined;
    if (team === winnerTeam) return true;
    if ((team === 'villager' || team === 'village') && (winnerTeam === 'villager' || winnerTeam === 'village')) return true;

    return false;
}

export async function getPlayersStats(
    userIds: string[]
): Promise<Record<string, { rate: number; streak: number; tp: number }>> {
    const stats: Record<string, { rate: number; streak: number; tp: number }> = {};
    if (!supabase || !userIds || userIds.length === 0) return stats;
    userIds.forEach(uid => { stats[uid] = { rate: 1500, streak: 0, tp: 0 }; });

    const { data, error } = await supabase.from('users').select('id, rate, streak, tp').in('id', userIds);
    if (error) { console.error('[getPlayersStats]', error); return stats; }
    (data ?? []).forEach((row: any) => {
        stats[row.id] = { rate: row.rate ?? 1500, streak: row.streak ?? 0, tp: row.tp ?? 0 };
    });
    return stats;
}

export async function predictRatingChange(
    winnerTeam: string,
    players: Player[],
    lovers: string[],
    options: any,
    mvpName: string | null,
    currentStats: Record<string, { rate: number; streak: number; tp: number }>,
    devoteeTarget?: string
): Promise<{ rate: Record<string, number>; tp: Record<string, number> }> {
    if (!options.isRanked) return { rate: {}, tp: {} };
    const humans = players.filter(p => !p.isNpc);
    if (humans.length === 0) return { rate: {}, tp: {} };
    
    const winners = humans.filter(p =>  isPlayerWinning(p, winnerTeam, lovers, players, devoteeTarget));
    const losers  = humans.filter(p => !isPlayerWinning(p, winnerTeam, lovers, players, devoteeTarget));

    const allHumansAvg = humans.reduce((s, p) => s + (currentStats[p.id]?.rate ?? 1500), 0) / humans.length;
    const winnerAvg = winners.length > 0 ? winners.reduce((s, p) => s + (currentStats[p.id]?.rate ?? 1500), 0) / winners.length : allHumansAvg;
    const loserAvg  = losers.length  > 0 ? losers.reduce((s, p)  => s + (currentStats[p.id]?.rate ?? 1500), 0) / losers.length  : allHumansAvg;

    const result: Record<string, number> = {};

    // =============================================
    // 🏆 勝利チームの計算
    // ベースポイント + 陣営ボーナス + 各種ボーナス
    // =============================================
    winners.forEach(p => {
        const myRate = currentStats[p.id]?.rate ?? 1500;
        const streak = currentStats[p.id]?.streak ?? 0;
        const myTeam = Roles.ROLE_CATALOG[p.role as string]?.team || 'villager';

        // 1. レート帯に応じたベースポイント
        let delta = getBaseWinPoints(myRate);

        // 1.5. 格上・格下補正
        // 期待値（勝つ確率）が低いほど勝利ボーナスが大きい
        // 期待値0.5（同格）で補正なし、格上ほど最大1.5倍、格下なら最小0.6倍
        const expected = 1 / (1 + Math.pow(10, (loserAvg - myRate) / 400));
        const upsetMultiplier = 0.6 + (1 - expected); // 格上勝利：最大~1.5倍、格下勝利：最小~0.6倍
        delta = Math.round(delta * upsetMultiplier);

        // 2. 陣営難易度ボーナス（ハイリスク・ハイリターン）
        //    ※ 倍率ではなく加算にすることでインフレを抑制
        if (myTeam === 'lovers') delta += 18;               // 恋人：最難関なので最大ボーナス
        else if (['fox', 'teruteru'].includes(myTeam)) delta += 12; // 妖狐・テルテル：まあまあ難しい
        else if (myTeam === 'wolf') delta += 6;             // 人狼：村人よりやや旨い程度

        // 3. 人数ボーナス（大人数村ほど価値が高い）
        if (players.length >= 12) delta += 5;
        else if (players.length >= 8) delta += 2;

        // 4. 連勝ボーナス（MM2の連勝ストリーク感）
        if (streak >= 7) delta += 6;
        else if (streak >= 5) delta += 4;
        else if (streak >= 3) delta += 2;

        // 5. MVP ボーナス
        if (p.name === mvpName) delta += 5;

        // 7. ランダムボーナス（0〜8の上振れ、勝利の気持ちよさ）
        delta += Math.floor(Math.random() * 9);

        // 最低保証（勝ったのに1未満にはならない）
        if (delta < 1) delta = 1;

        result[p.id] = delta;
    });

    // =============================================
    // 💧 敗北チームの計算
    // シンプルに下がる。ただし状況で軽重あり
    // =============================================
    losers.forEach(p => {
        const myRate  = currentStats[p.id]?.rate ?? 1500;
        const myTeam  = Roles.ROLE_CATALOG[p.role as string]?.team || 'villager';

        // 1. レート帯に応じたベースペナルティ
        let penalty = getBaseLossPoints(myRate);

        // 1.5. 格上・格下補正
        // 格下に負けるほどペナルティが大きい（期待値が高かったのに負けた）
        // 期待値0.5（同格）で補正なし、格下負けで最大1.5倍、格上負けで最小0.6倍
        const expected = 1 / (1 + Math.pow(10, (winnerAvg - myRate) / 400));
        const upsetMultiplier = 0.6 + expected; // 格下負け：最大~1.5倍、格上負け：最小~0.6倍
        penalty = Math.round(penalty * upsetMultiplier);

        // 2. 陣営難易度による軽減（第三陣営は負けて当然なので痛みを減らす）
        if (myTeam === 'lovers') penalty = Math.round(penalty * 0.5);           // 恋人：最難関なので大幅軽減
        else if (['fox', 'teruteru'].includes(myTeam)) penalty = Math.round(penalty * 0.6); // 妖狐・テルテル：少し軽減
        // 村人・人狼は同じ（軽減なし）

        // 3. 生存ボーナス（生き残っていれば少し軽減。MM2のゴール補正的な立ち位置）
        if (p.alive) penalty = Math.round(penalty * 0.7);

        // 4. 敗北 MVP への救済（貢献したなら少し返す）
        if (p.name === mvpName) penalty -= 5;

        // ランダムブレ（-3〜+3、負けの重さに幅を持たせる）
        penalty += Math.floor(Math.random() * 7) - 3;

        // penalty は正の数で管理してここでマイナスに
        let delta = -Math.max(penalty, 0);

        // 負けたのにレートが上がる事態を防止
        if (delta > 0) delta = 0;

        // レートの底（1000未満にはならない）
        if (myRate + delta < 1000) delta = 1000 - myRate;

        result[p.id] = delta;
    });

    // =============================================
    // 🍅 Tomato Point (TP) 計算
    // Ghost Bet 的中者にTPを付与（レートとは完全に独立）
    // =============================================
    const tpDeltas: Record<string, number> = {};
    humans.forEach(p => {
        if (!p.ghostBet) return;
        const hit = (p.ghostBet === 'villager' && winnerTeam === 'villager') ||
                    (p.ghostBet === 'wolf'     && winnerTeam === 'wolf')     ||
                    (p.ghostBet === 'other'    && ['fox', 'lovers', 'teruteru'].includes(winnerTeam));
        if (hit) tpDeltas[p.id] = (p.ghostBet === 'other') ? 150 : 50;
    });

    return { rate: result, tp: tpDeltas };
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
    const devoteeTarget = game.devoteeTarget;
    const { rate: deltas, tp: tpDeltas } = await predictRatingChange(winningSide, players, lovers, options, mvpName, currentStats, devoteeTarget);

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
        is_win:     isPlayerWinning(p, winningSide, lovers, players, devoteeTarget), // ★修正
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
        const isWin     = isPlayerWinning(p, winningSide, lovers, players, devoteeTarget);
        const oldRate   = currentStats[p.id]?.rate   ?? 1500;
        const oldStreak = currentStats[p.id]?.streak ?? 0;
        const oldTp     = currentStats[p.id]?.tp     ?? 0;
        const avatarUrl = p.user ? p.user.displayAvatarURL({ extension: 'png', size: 256 }) : null;

        return {
            id:         p.id,
            name:       p.name,
            rate:       isRanked ? oldRate + (deltas[p.id] ?? 0) : oldRate,
            streak:     isWin ? oldStreak + 1 : 0,
            tp:         oldTp + (tpDeltas[p.id] ?? 0),
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

    // ==========================================
    // 5. ★ 分析用：全員（人間＋NPC）の詳細な勝敗と死因を保存！
    // ==========================================
    const participantRows = players.map((p: any) => {
        const isHuman = !p.isNpc;
        const isWinner = isPlayerWinning(p, winningSide, lovers, players, devoteeTarget);
        
        // Rolesから陣営情報を取得
        const team = Roles.ROLE_CATALOG[p.role as string]?.team || 'unknown';
        
        // resultSummaryがあればそこから正確な死因を取得、なければaliveから推測
        const summaryData = game.resultSummary?.players?.[p.id];
        const deathReason = summaryData?.death_reason || (p.alive ? null : 'unknown');

        return {
            match_id: matchId,
            player_id: p.id,
            is_human: isHuman,
            role: p.role ?? '不明',
            team: team,
            is_winner: isWinner,
            death_reason: deathReason
        };
    });

    if (participantRows.length > 0) {
        const { error: partError } = await supabase.from('match_participants').insert(participantRows);
        if (partError) {
            console.error('[saveGameResults] match_participants insert error:', partError);
        } else {
            console.log(`[DB] 試合 ${matchId} の分析用参加者データを保存しました！`);
        }
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
    const myRate = userData?.rate  ?? 1500;
    const streak = userData?.streak ?? 0;

    // 全ユーザーを取得する代わりにDBで集計（負荷・転送量を大幅削減）
    const [{ count: totalPlayers }, { count: higherCount }] = await Promise.all([
        supabase.from('users').select('*', { count: 'exact', head: true }),
        supabase.from('users').select('*', { count: 'exact', head: true }).gt('rate', myRate),
    ]);
    const myRank = (higherCount ?? 0) + 1;
    const totalPlayersCount = totalPlayers ?? 1;
    
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
        const descZero = `**現在のレート**: 🏆 **${myRate}** (${myRank}位 / ${totalPlayersCount}人)\n\n` +
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

    const desc = `**現在のレート**: 🏆 **${myRate}** (${myRank}位 / ${totalPlayersCount}人)\n` +
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

// 💡 キャッシュ用の変数をファイル上部に追加
const presetCache = new Map<string, { data: any[], expires: number }>();

export async function getPresets(userId: string) {
    if (!supabase) return [];

    // 1. キャッシュが有効なら、DB通信せずに爆速で返す
    const cached = presetCache.get(userId);
    if (cached && cached.expires > Date.now()) {
        return cached.data;
    }

    // 2. キャッシュがなければ通常通りDBから取得
    const { data, error } = await supabase.from('presets').select('*').eq('user_id', userId).order('created_at', { ascending: true });
    if (error) { console.error(error); return []; }

    // 3. 取得したデータを5分間キャッシュに保存
    presetCache.set(userId, { data: data || [], expires: Date.now() + 1000 * 60 * 5 });
    return data || [];
}

export async function savePreset(userId: string, name: string, settings: any, userName: string = 'Player') {
    if (!supabase) return { success: false, message: 'DB未接続です。' };

    await supabase.from('users').upsert(
        { id: userId, name: userName, rate: 1500, streak: 0, updated_at: new Date().toISOString() }, 
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

    // 🌟 追加：保存した瞬間にキャッシュを消して最新状態を反映！
    presetCache.delete(userId);

    return { success: true, message: `✅ プリセット「**${name}**」として保存しました！` };
}

export async function deletePreset(userId: string, name: string) {
    if (!supabase) return { success: false, message: 'DB未接続です。' };
    const { error } = await supabase.from('presets').delete().match({ user_id: userId, name });
    if (error) return { success: false, message: '削除に失敗しました。' };

    // 🌟 追加：削除した瞬間にキャッシュも消す！
    presetCache.delete(userId);

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
    const { error } = await supabase.from('users').upsert({ id: userId, name: userName, rate: 1500, streak: 0, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) return { success: false, message: 'DBエラーが発生しました。' };
    return { success: true, message: `レートを初期値(${1500})に強制リセットしました` };
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
        const resetRows = allUsers.map((u: any) => ({ id: u.id, rate: 1500, streak: 0, updated_at: now }));
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

// ランキング発表用に上位プレイヤーを取得する関数
export async function getTopRanking(limit: number = 10) {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('users')
        .select('id, name, rate')
        .order('rate', { ascending: false })
        .limit(limit);
    
    if (error) {
        console.error('[getTopRanking]', error);
        return [];
    }
    return data || [];
}

