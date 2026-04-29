// src/pokeDb.ts
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

// 既存の.envにあるSupabaseのURLとキーをそのまま使い回せます！
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!; 
export const supabase = createClient(supabaseUrl, supabaseKey);

// 個体値(0〜31)をランダムに生成する関数
export function getRandomIV(): number {
    return Math.floor(Math.random() * 32);
}
