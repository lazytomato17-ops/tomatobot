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
    // 1. まず、ユーザーが poke_users テーブルに存在するか確認（なければ自動作成 = UPSERT）
    const { error: userError } = await supabase
        .from('poke_users')
        .upsert([{ discord_id: userId }], { onConflict: 'discord_id' });
    
    if (userError) {
        console.error('ユーザー保存エラー:', userError);
        throw userError;
    }

    // 2. 個体値（0〜31）をランダムに生成！これが厳選の醍醐味です
    const getRandomIV = () => Math.floor(Math.random() * 32);

    // 3. ポケモンを poke_caught_pokemons に保存
    const { error: pokeError } = await supabase
        .from('poke_caught_pokemons')
        .insert([{
            owner_id: userId,
            original_trainer_id: userId,
            pokedex_id: pokedexId,
            nickname: nickname,
            iv_hp: getRandomIV(),
            iv_attack: getRandomIV(),
            iv_defense: getRandomIV(),
            iv_sp_atk: getRandomIV(),
            iv_sp_def: getRandomIV(),
            iv_speed: getRandomIV()
        }]);

    if (pokeError) {
        console.error('ポケモン保存エラー:', pokeError);
        throw pokeError;
    }

    return true;
}