// src/pokeDb.ts
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

// 既存の.envにあるSupabaseのURLとキーをそのまま使い回せます！
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!; 
export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * 捕まえたポケモンをDBに保存する関数
 */
export async function saveCaughtPokemon(userId: string, pokedexId: number, nickname: string) {
    // 1. 捕まえた瞬間にPokeAPIから詳細データを取得（以降はDBのデータのみを使う）
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokedexId}`);
    const data = await res.json();
    
    // タイプの抽出
    const types = data.types.map((t: any) => t.type.name);

    // 個体値の生成
    const iv_hp = getRandomIV();
    const iv_attack = getRandomIV();
    const iv_defense = getRandomIV();
    const iv_sp_atk = getRandomIV();
    const iv_sp_def = getRandomIV();
    const iv_speed = getRandomIV();

    // 捕獲時の初期レベル(とりあえずLv5固定とする)
    const level = 5;

    // 最大HPを計算して、current_hpの初期値にする
    const baseHp = data.stats.find((s:any) => s.stat.name === 'hp').base_stat;
    const maxHp = Math.floor(((2 * baseHp + iv_hp) * level) / 100) + level + 10;

    // 現在のレベルで覚える技を最大4つ取得
    const moves = await getMovesForLevel(data, level);

    // 2. DBにすべての情報をまるごと保存
    const { data: inserted, error } = await supabase
        .from('poke_caught_pokemons')
        .insert([{
            owner_id: userId,
            original_trainer_id: userId,
            pokedex_id: pokedexId,
            nickname: nickname,
            level: level,
            exp: 0,
            nature: 'がんばりや', // とりあえず固定
            iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed,
            current_hp: maxHp, // 👈 最初は全回復状態
            types: types,      // 👈 JSONBとして保存
            moves: moves       // 👈 JSONBとして保存
        }])
        .select('id')
        .single();

    if (error) {
        console.error('ポケモン保存エラー:', error);
        throw error;
    }

    return inserted.id; // DBのUUIDを返す
}