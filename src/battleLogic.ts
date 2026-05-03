// src/battleLogic.ts (上から buildBattlePokemon までを上書き)
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageComponentInteraction, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './pokeDb';
import { getMovesForLevel, getRandomPokemonIdByArea } from './pokeApiUtils';

const activeBattles = new Map<string, BattleState>();
// 🌟 追加：回復や逃走でリセットされる隠し連戦カウンター
export const hiddenWildChains = new Map<string, number>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const NATURES = [
    'さみしがり', 'いじっぱり', 'やんちゃ', 'ゆうかん', 'ずぶとい', 'わんぱく', 'のうてんき', 'のんき', 'ひかえめ', 'おっとり', 'うっかりや', 'れいせい', 'おだやか', 'おとなしい', 'しんちょう', 'なまいき', 'おくびょう', 'せっかち', 'ようき', 'むじゃき', 'てれや', 'がんばりや', 'すなお', 'きまぐれ', 'まじめ'
];

const NATURE_EFFECTS: Record<string, [number, number] | null> = {
    'さみしがり': [1, 2], 'いじっぱり': [1, 3], 'やんちゃ': [1, 4], 'ゆうかん': [1, 5], 'ずぶとい': [2, 1], 'わんぱく': [2, 3], 'のうてんき': [2, 4], 'のんき': [2, 5], 'ひかえめ': [3, 1], 'おっとり': [3, 2], 'うっかりや': [3, 4], 'れいせい': [3, 5], 'おだやか': [4, 1], 'おとなしい': [4, 2], 'しんちょう': [4, 3], 'なまいき': [4, 5], 'おくびょう': [5, 1], 'せっかち': [5, 2], 'ようき': [5, 3], 'むじゃき': [5, 4], 'てれや': null, 'がんばりや': null, 'すなお': null, 'きまぐれ': null, 'まじめ': null
};

// 🌟 爆速化＆UI表示のためのタイプ相性表
const TYPE_CHART: Record<string, Record<string, number>> = {
    normal: { rock: 0.5, ghost: 0, steel: 0.5 },
    fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
    water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
    electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
    grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
    ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
    fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
    poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
    ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
    flying: { grass: 2, electric: 0.5, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
    psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
    bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
    rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
    ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
    dragon: { dragon: 2, steel: 0.5, fairy: 0 },
    dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
    steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
    fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

// 🌟 倍率計算用ヘルパー関数
export function getTypeMultiplier(attackType: string, defenderTypes: string[]): number {
    let mult = 1;
    for (const defType of defenderTypes) {
        if (TYPE_CHART[attackType] && TYPE_CHART[attackType][defType] !== undefined) {
            mult *= TYPE_CHART[attackType][defType];
        }
    }
    return mult;
}

export function getRequiredExp(level: number, rate: string): number {
    // レベル1以下は一律で経験値0
    if (level <= 1) return 0;

    switch (rate) {
        case 'fast': 
            // 80万タイプ (早い: ピクシー、プリン等)
            return Math.floor(4 * Math.pow(level, 3) / 5);
            
        case 'medium': 
            // 100万タイプ (やや早い: ピカチュウ、リザードン等)
            return Math.floor(Math.pow(level, 3));
            
        case 'medium-slow': 
            // 105万タイプ (やや遅い: フシギダネ、ポッポ等)
            // ※本家再現: (6/5)L^3 - 15L^2 + 100L - 140
            return Math.floor((1.2 * Math.pow(level, 3)) - (15 * Math.pow(level, 2)) + (100 * level) - 140);
            
        case 'slow': 
            // 125万タイプ (遅い: ミニリュウ、伝説系等)
            return Math.floor(5 * Math.pow(level, 3) / 4);
            
        case 'slow-then-very-fast': 
            // 60万タイプ (不規則: ツチニン等) ※レベルによって式が変わる
            if (level <= 50) return Math.floor(Math.pow(level, 3) * (100 - level) / 50);
            if (level <= 68) return Math.floor(Math.pow(level, 3) * (150 - level) / 100);
            if (level <= 98) return Math.floor(Math.pow(level, 3) * Math.floor((1911 - 10 * level) / 3) / 500);
            return Math.floor(Math.pow(level, 3) * (160 - level) / 100);
            
        case 'fast-then-very-slow': 
            // 164万タイプ (変動: キノココ、マルノーム等) ※レベルによって式が変わる
            if (level <= 15) return Math.floor(Math.pow(level, 3) * (Math.floor((level + 1) / 3) + 24) / 50);
            if (level <= 36) return Math.floor(Math.pow(level, 3) * (level + 14) / 50);
            return Math.floor(Math.pow(level, 3) * (Math.floor(level / 2) + 32) / 50);
            
        default:
            // 万が一未知のレートが来たら一番標準的な100万タイプを返す
            return Math.floor(Math.pow(level, 3));
    }
}


function applyNature(stat: number, typeIndex: number, natureName: string): number {
    const effect = NATURE_EFFECTS[natureName];
    if (!effect) return stat;
    if (effect[0] === typeIndex) return Math.floor(stat * 1.1);
    if (effect[1] === typeIndex) return Math.floor(stat * 0.9);
    return stat;
}

// 🌟 ステータスランク（-6 〜 +6）の倍率計算
function getStageMult(stage: number): number {
    const s = Math.max(-6, Math.min(6, stage));
    return Math.max(2, 2 + s) / Math.max(2, 2 - s);
}

interface BattleMove { name: string; power: number; type: string; damageClass?: string; accuracy?: number; pp?: number; maxPp?: number; ailment?: string | null; statChanges?: {stat: string, change: number}[]; healing?: number; target?: string; }
interface BattlePokemon {
    dbId: string; pokedexId: number; nickname: string; level: number;
    hp: number; maxHp: number; atk: number; def: number; spa: number; spd: number; speed: number;
    imageUrl: string; moves: BattleMove[]; types: string[]; exp: number;
    nature: string; captureRate?: number; wildIvs?: any; 
    evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number; }; 
    // 🌟 状態異常とランク補正を追加！
    status: string | null; 
    statusTurns: number; 
    statStages: { atk: number; def: number; spa: number; spd: number; spe: number; };
}
interface Player { id: string; name: string; party: BattlePokemon[]; activeIndex: number; }
interface BattleState {
    id: string; p1: Player; p2: Player; currentTurnUserId: string; log: string; 
    battleType: 'pvp' | 'wild' | 'gym';
    gymData?: any;
    pendingNextNpcIdx?: number; // 👈 これを追加！（相手の次のポケモンを記憶する用）
}

async function saveAllHPs(battle: BattleState) {
    // 🌟 PvP（対人戦）の時は、HPや状態異常をデータベースに保存しない！
    if (battle.battleType === 'pvp') return;

    const promises: any[] = [];
    battle.p1.party.forEach(p => { 
        promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.hp, status_condition: p.status }).eq('id', p.dbId)); 
    });
    // ❌ ここにあった if (battle.battleType === 'pvp') ブロックは削除（上の return で処理済みのため）
    
    await Promise.all(promises);
}


function generateHpBar(current: number, max: number): string {
    const totalBlocks = 10;
    const percent = current / max;
    const filledBlocks = Math.round(percent * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    let blockColor = '🟩';
    if (percent <= 0.2) blockColor = '🟥';
    else if (percent <= 0.5) blockColor = '🟨';
    return blockColor.repeat(Math.max(0, filledBlocks)) + '⬛'.repeat(Math.max(0, emptyBlocks));
}

// 🌟 ランク補正とやけどの攻撃半減を適用したダメージ計算
async function calculateDamage(attacker: BattlePokemon, defender: BattlePokemon, move: BattleMove) {
    if (move.power === 0) return { damage: 0, log: '' }; // 変化技はダメージ0

    // 🌟 さっき作った爆速関数で倍率を取得！ APIは呼ばない！
    let mult = getTypeMultiplier(move.type, defender.types);
    if (attacker.types.includes(move.type)) mult *= 1.5; // タイプ一致ボーナス

    const isSpecial = move.damageClass === 'special';
    
    // 🌟 ランク補正の適用！
    let attackStat = isSpecial ? (attacker.spa * getStageMult(attacker.statStages.spa)) : (attacker.atk * getStageMult(attacker.statStages.atk));
    let defenseStat = isSpecial ? (defender.spd * getStageMult(defender.statStages.spd)) : (defender.def * getStageMult(defender.statStages.def));

    // やけど状態なら物理攻撃半減
    if (attacker.status === 'burn' && !isSpecial) attackStat *= 0.5;

    const isCritical = Math.random() < (1 / 24);
    const critMult = isCritical ? 1.5 : 1.0;

    const random = (Math.floor(Math.random() * 16) + 85) / 100; 
    let baseDamage = Math.floor(Math.floor(Math.floor(2 * attacker.level / 5 + 2) * move.power * attackStat / defenseStat) / 50) + 2;
    let damage = Math.floor(baseDamage * mult * critMult * random);
    if (damage < 1 && mult !== 0) damage = 1;

    let log = '';
    if (isCritical) log += '💥 **急所に当たった！**\n';
    if (mult > 1.5) log += '🌟 **こうかばつぐんだ！**\n';
    if (mult > 0 && mult < 1) log += '📉 こうかはいまひとつのようだ…\n';
    if (mult === 0) log += '❌ こうかがないみたいだ…\n';

    return { damage, log };
}

// 🌟 修正版：executeMoveEffects 関数
async function executeMoveEffects(attacker: BattlePokemon, defender: BattlePokemon, move: BattleMove) {
    let log = ``;
    let effectApplied = false;

    // 🌟 【修正】自分への技（ターゲットがuser）や、回復技の場合は相性チェックをパスする！
    const isSelfTarget = move.target === 'user' || (move.healing && move.healing > 0);

    if (!isSelfTarget) {
        const typeMult = getTypeMultiplier(move.type, defender.types);
        if (typeMult === 0 && move.name !== 'わるあがき') {
            return `❌ **${defender.nickname}** には 効果がないみたいだ…\n`;
        }
    }

    // ① ダメージ処理
    if (move.power > 0) {
        const dmgRes = await calculateDamage(attacker, defender, move);
        defender.hp = Math.max(0, defender.hp - dmgRes.damage);
        log += `${dmgRes.log}💥 **${dmgRes.damage}** ダメージ！\n`;
        effectApplied = true;
    }
    
// ･･･これ以降は元のコードのまま（②回復処理〜）でOKです！
    
    // ② 回復処理
    if (move.healing && move.healing > 0) {
        const healAmount = Math.floor(attacker.maxHp * (move.healing / 100));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmount);
        log += `✨ 体力が 回復した！\n`;
        effectApplied = true;
    }
    
    // ③ ステータス変化（バフ・デバフ）処理
    if (move.statChanges && move.statChanges.length > 0) {
        const statNameMap: Record<string, string> = { 'attack': 'atk', 'defense': 'def', 'special-attack': 'spa', 'special-defense': 'spd', 'speed': 'spe' };
        const jpStatName: Record<string, string> = { 'atk': 'こうげき', 'def': 'ぼうぎょ', 'spa': 'とくこう', 'spd': 'とくぼう', 'spe': 'すばやさ' };
        for (const sc of move.statChanges) {
            const sKey = statNameMap[sc.stat];
            if (sKey) {
                // 🌟 ここを修正：move.target によって対象を変える
                const targetPoke = move.target === 'user' ? attacker : defender;
                const currentStage = targetPoke.statStages[sKey as keyof typeof targetPoke.statStages];
                
                // 上限・下限のチェック
                if (sc.change > 0 && currentStage >= 6) {
                    log += `💨 **${targetPoke.nickname}** の ${jpStatName[sKey]} は もう 上がらない！\n`;
                    continue;
                } else if (sc.change < 0 && currentStage <= -6) {
                    log += `💨 **${targetPoke.nickname}** の ${jpStatName[sKey]} は もう 下がらない！\n`;
                    continue;
                }

                // 実際の変化量を計算
                const newStage = Math.max(-6, Math.min(6, currentStage + sc.change));
                const actualChange = newStage - currentStage;
                targetPoke.statStages[sKey as keyof typeof targetPoke.statStages] = newStage;

                // テキスト演出
                let updownStr = '';
                if (actualChange === 1) updownStr = '上がった！';
                else if (actualChange === 2) updownStr = 'ぐーんと 上がった！';
                else if (actualChange >= 3) updownStr = 'ぐぐーんと 上がった！';
                else if (actualChange === -1) updownStr = '下がった！';
                else if (actualChange === -2) updownStr = 'がくっと 下がった！';
                else if (actualChange <= -3) updownStr = 'がくーんと 下がった！';

                log += `📈 **${targetPoke.nickname}** の ${jpStatName[sKey]}が ${updownStr}\n`;
                effectApplied = true;
            }
        }
    }
    
    // ④ 状態異常処理
    if (move.ailment && move.ailment !== 'none') {
        const validAilments = ['paralysis', 'sleep', 'freeze', 'burn', 'poison'];
        if (validAilments.includes(move.ailment)) {
            if (!defender.status) {
                defender.status = move.ailment;
                if (move.ailment === 'sleep') defender.statusTurns = Math.floor(Math.random() * 2) + 1;
                log += `⚠️ **${STATUS_MAP[move.ailment]}** になった！\n`;
            } else {
                // 🌟 追加：すでに状態異常の場合は失敗メッセージを出す
                log += `💨 **${defender.nickname}** は すでに 状態異常だ！\n`;
            }
        }
    }

    // ⑤ 何も起きなかった時の処理（最強のセーフティネット）
    // 🌟 修正：最終的に log が空っぽ（何も処理されなかった）なら確実にエラーテキストを出す
    if (log === '') {
        if (move.name === 'はねる') {
            log += `しかし なにも おこらない！\n`;
        } else {
            log += `しかし うまく きまらなかった！\n`;
        }
    }

    return log;
}


// 🌟 修正版：Lv50固定対応 & DB上書き防止
export async function buildBattlePokemon(dbPoke: any, forcedLevel?: number): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const speciesRes = await fetch(data.species.url);
    const speciesData = await speciesRes.json();
    const growthRate = speciesData.growth_rate.name;

    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const originalLevel = dbPoke.level;
    const lv = forcedLevel || originalLevel; // 🌟 指定があれば50、なければ元のレベル
    const nature = dbPoke.nature || 'まじめ';

    let safeMoves = dbPoke.moves;
    if (typeof safeMoves === 'string') { try { safeMoves = JSON.parse(safeMoves); } catch (e) { safeMoves = []; } }

    let needsMoveUpdate = false;
    if (!Array.isArray(safeMoves) || safeMoves.length === 0 || (safeMoves.length === 1 && safeMoves[0].name === 'わるあがき')) {
        safeMoves = await getMovesForLevel(data, originalLevel); // 👈 技は元のレベルで取得
        if (!safeMoves || safeMoves.length === 0) {
            safeMoves = [{ name: 'たいあたり', power: 40, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 35, maxPp: 35 }];
        }
        needsMoveUpdate = true;
    }

    for (const m of safeMoves) {
        if (m.pp === undefined) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; needsMoveUpdate = true; }
    }

    let safeTypes = dbPoke.types;
    if (typeof safeTypes === 'string') { try { safeTypes = JSON.parse(safeTypes); } catch (e) { safeTypes = []; } }

    let currentExp = dbPoke.exp || 0;
    const requiredExp = getRequiredExp(originalLevel, growthRate); // 👈 経験値チェックも元のレベル！
    if (currentExp < requiredExp) { currentExp = requiredExp; needsMoveUpdate = true; }

    // 🌟 重要：強制レベル指定（PvP）の時は、絶対にデータベースを更新しない！！
    if (needsMoveUpdate && !forcedLevel) { 
        supabase.from('poke_caught_pokemons').update({ moves: safeMoves, exp: currentExp }).eq('id', dbPoke.id).then(); 
    }

    const evs = { hp: dbPoke.ev_hp||0, atk: dbPoke.ev_attack||0, def: dbPoke.ev_defense||0, spa: dbPoke.ev_sp_atk||0, spd: dbPoke.ev_sp_def||0, spe: dbPoke.ev_speed||0 };
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp + Math.floor((dbPoke.ev_hp||0) / 4)) * lv) / 100) + lv + 10;
    const currentHp = forcedLevel ? maxHp : (dbPoke.current_hp !== undefined ? Math.min(dbPoke.current_hp, maxHp) : maxHp);

    return {
        dbId: dbPoke.id, pokedexId: dbPoke.pokedex_id, nickname: dbPoke.nickname, level: lv,
        hp: currentHp, maxHp: maxHp,
        atk: applyNature(Math.floor(((2 * base['attack'] + dbPoke.iv_attack + Math.floor(evs.atk / 4)) * lv) / 100) + 5, 1, nature),
        def: applyNature(Math.floor(((2 * base['defense'] + dbPoke.iv_defense + Math.floor(evs.def / 4)) * lv) / 100) + 5, 2, nature),
        spa: applyNature(Math.floor(((2 * base['special-attack'] + (dbPoke.iv_sp_atk || 0) + Math.floor(evs.spa / 4)) * lv) / 100) + 5, 3, nature),
        spd: applyNature(Math.floor(((2 * base['special-defense'] + (dbPoke.iv_sp_def || 0) + Math.floor(evs.spd / 4)) * lv) / 100) + 5, 4, nature),
        speed: applyNature(Math.floor(((2 * base['speed'] + dbPoke.iv_speed + Math.floor(evs.spe / 4)) * lv) / 100) + 5, 5, nature),
        imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
        moves: safeMoves, types: safeTypes, exp: currentExp, status: forcedLevel ? null : (dbPoke.status_condition || null),
        nature: nature, captureRate: dbPoke.captureRate, wildIvs: dbPoke.wildIvs, evs: evs,
        statusTurns: 0, 
        statStages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } 
    };
}

// 🌟 状態異常の表示用マップ
const STATUS_MAP: Record<string, string> = {
    'paralysis': '⚡まひ', 'sleep': '💤ねむり', 'freeze': '❄️こおり', 'burn': '🔥やけど', 'poison': '☠️どく'
};

// 🌟 行動前の状態異常チェック関数（状態異常を大幅に弱体化！）
function checkStatusBeforeMove(poke: BattlePokemon): { canMove: boolean, log: string } {
    if (poke.status === 'sleep') {
        if (poke.statusTurns <= 0) { poke.status = null; return { canMove: true, log: `\n💤 **${poke.nickname}** は 目を覚ました！\n` }; }
        poke.statusTurns--; return { canMove: false, log: `\n💤 **${poke.nickname}** は ぐうぐう 眠っている…\n` };
    }
    if (poke.status === 'freeze') {
        // 🌟 20% -> 40% で溶けるように！
        if (Math.random() < 0.4) { poke.status = null; return { canMove: true, log: `\n❄️ **${poke.nickname}** の こおりが とけた！\n` }; }
        return { canMove: false, log: `\n❄️ **${poke.nickname}** は こおってしまって 動けない！\n` };
    }
    if (poke.status === 'paralysis') {
        // 🌟 25% -> 15% で動けない確率を下げる！
        if (Math.random() < 0.15) return { canMove: false, log: `\n⚡ **${poke.nickname}** は 体が しびれて 動けない！\n` };
    }
    return { canMove: true, log: '' };
}

export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();
    try {
        const fetchParty = async (uid: string) => {
            let { data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', uid).eq('is_party', true).order('party_order', { ascending: true });
            if (data && data.length > 6) {
                const overflowIds = data.slice(6).map(p => p.id);
                await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
                data = data.slice(0, 6);
            }
            return data;
        };

        const [p1Data, p2Data] = await Promise.all([fetchParty(challengerId), fetchParty(targetId)]);
        if (!p1Data?.length || !p2Data?.length) return interaction.followUp('パーティ情報の取得に失敗しました。');

        const [p1Party, p2Party] = await Promise.all([ 
            Promise.all(p1Data.map(p => buildBattlePokemon(p, 50))), // 🌟 50を指定
            Promise.all(p2Data.map(p => buildBattlePokemon(p, 50)))  // 🌟 50を指定
        ]);
        const p1Active = p1Party.findIndex(p => p.hp > 0);
        const p2Active = p2Party.findIndex(p => p.hp > 0);

        const battle: BattleState = {
            id: interaction.message.id,
            p1: { id: challengerId, name: '挑戦者', party: p1Party, activeIndex: p1Active !== -1 ? p1Active : 0 },
            p2: { id: targetId, name: '相手', party: p2Party, activeIndex: p2Active !== -1 ? p2Active : 0 },
            currentTurnUserId: p1Party[p1Active].speed >= p2Party[p2Active].speed ? challengerId : targetId,
            log: '**バトル開始！**', battleType: 'pvp'
        };

        activeBattles.set(battle.id, battle);
        await updateBattleMessage(interaction as any, battle.id);
    } catch (e) { await interaction.followUp('バトル開始エラー'); }
}

async function getValidWildPokemon(area: string | null, baseLevel: number, badges: string[], forceLevel?: number) {
    let pokeId = await getRandomPokemonIdByArea(area);
    let res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
    let data = await res.json();
    let speciesRes = await fetch(data.species.url);
    let speciesData = await speciesRes.json();

    // 🌟 チュートリアル時（forceLevelがある時）は伝説・幻を絶対に弾く
    if (forceLevel !== undefined) {
        while (speciesData.is_legendary || speciesData.is_mythical) {
            pokeId = await getRandomPokemonIdByArea(area);
            res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
            data = await res.json();
            speciesRes = await fetch(data.species.url);
            speciesData = await speciesRes.json();
        }
    }

    const isLegendary = speciesData.is_legendary || speciesData.is_mythical;
    let wildLevel = forceLevel;

    // 🌟 レベルが指定されていない（通常の野生）場合のドラマチックガチャ
    if (wildLevel === undefined) {
        if (isLegendary) {
            if (Math.random() < 0.05) wildLevel = Math.floor(Math.random() * 10) + 1; // 奇跡の低レベル
            else wildLevel = Math.floor(Math.random() * 31) + 50; // 圧倒的な強者
        } else {
            const randomRoll = Math.random();
            if (randomRoll < 0.20) wildLevel = Math.floor(Math.random() * 14) + 2;
            else if (randomRoll < 0.30) wildLevel = baseLevel + Math.floor(Math.random() * 11) + 10;
            else wildLevel = Math.max(1, baseLevel + Math.floor(Math.random() * 7) - 3);

            // 初心者を守るレベルシールド（伝説には適用しない！）
            let maxWildLevel = 12; 
            if (badges.includes('🌿 グリーンバッジ')) maxWildLevel = 100;
            else if (badges.includes('🔥 クリムゾンバッジ')) maxWildLevel = 80;
            else if (badges.includes('🟡 ゴールドバッジ')) maxWildLevel = 70;
            else if (badges.includes('💖 ピンクバッジ')) maxWildLevel = 60;
            else if (badges.includes('🌈 レインボーバッジ')) maxWildLevel = 50;
            else if (badges.includes('⚡ オレンジバッジ')) maxWildLevel = 40;
            else if (badges.includes('💧 ブルーバッジ')) maxWildLevel = 30;
            else if (badges.includes('🪨 グレーバッジ')) maxWildLevel = 20;

            wildLevel = Math.min(wildLevel, maxWildLevel);
        }
    }

    const evoRes = await fetch(speciesData.evolution_chain.url);
    const evoData = await evoRes.json();
    let currentStage = evoData.chain;
    let targetSpeciesName = currentStage.species.name;

    while (currentStage.evolves_to && currentStage.evolves_to.length > 0) {
        let evolved = false;
        for (const nextStage of currentStage.evolves_to) {
            const minLevel = nextStage.evolution_details[0]?.min_level;
            // 🌟 決定した wildLevel を使って、進化しているか判定！
            if (minLevel && wildLevel! >= minLevel) {
                targetSpeciesName = nextStage.species.name;
                currentStage = nextStage;
                evolved = true;
                break;
            }
        }
        if (!evolved) break;
    }

    // 🌟 修正：APIの仕様で「種族名」と「ポケモン名」が違う場合のエラー(Not Found)を回避！
    const finalRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${targetSpeciesName}`);
    
    if (finalRes.ok) {
        // 正常に取得できた場合のみ上書きする
        data = await finalRes.json();
        pokeId = data.id;
        const finalSpeciesRes = await fetch(data.species.url);
        speciesData = await finalSpeciesRes.json();
    } else {
        // 取得できなかった場合（フォルム違いなど）は、進化前のデータのまま戦わせる！
        console.warn(`⚠️ [PokeAPI] ${targetSpeciesName} のデータ取得に失敗したため、進化前を使用します。`);
    }
    
    return { pokeId, data, speciesData, wildLevel: wildLevel! };
}

// 🌟 チュートリアル連打バグ対策のロック用Set（ファイルの上の方や関数の外に置く）
const tutorialLocks = new Set<string>();

export async function startWildBattle(interaction: ChatInputCommandInteraction, userId: string, area: string | null) {
    // 🌟 連打対策：すでにチュートリアル処理中の人はここで弾く
    if (tutorialLocks.has(userId)) {
        return interaction.editReply('⚠️ チュートリアル処理中です。連打せずに少しお待ちください！');
    }

    try {
        let { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true });
        
        if (p1Data && p1Data.length > 6) {
            const overflowIds = p1Data.slice(6).map(p => p.id);
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
            p1Data = p1Data.slice(0, 6);
        }

        // 🟢 最初の1匹をもらう処理（チュートリアル）
        if (!p1Data || p1Data.length === 0) {
            tutorialLocks.add(userId); // 🔒 ロック開始！

            try {
                // 🌟 保存エラー対策＆改善案2：初期資金3000円を持たせる！
                await supabase.from('poke_users').upsert(
                    [{ discord_id: userId, money: 3000 }], 
                    { onConflict: 'discord_id', ignoreDuplicates: true }
                );

                // 🌟 初心者応援アイテムを付与（モンスターボール5個、きずぐすり5個）
                const { data: invCheck } = await supabase.from('poke_inventory').select('id').eq('user_id', userId).limit(1);
                if (!invCheck || invCheck.length === 0) { // インベントリが空(初回)の時だけ配る
                    await supabase.from('poke_inventory').insert([
                        { user_id: userId, item_id: 'monster_ball', quantity: 5 },
                        { user_id: userId, item_id: 'potion', quantity: 5 }
                    ]);
                }

                // チュートリアルなのでLv5固定で強制呼び出し
                const { pokeId, data, speciesData, wildLevel } = await getValidWildPokemon(area, 5, [], 5);
                const level = wildLevel;
                const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();
                const imageUrl = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;

                const embed = new EmbedBuilder()
                    .setTitle(`あ！ やせいの **${jaName}** が とびだしてきた！`)
                    .setDescription(`...しかし、あなたは戦うためのポケモンを1匹も持っていない！\n\nなんと！ **${jaName}** は こちらに 興味を持っているようだ！\nそのまま 仲間になった！🎉`)
                    .setImage(imageUrl)
                    .setColor(0x00FF00);

                const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
                const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
                const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);
                const baseHp = data.stats.find((s:any) => s.stat.name === 'hp').base_stat;
                const maxHp = Math.floor(((2 * baseHp + iv_hp) * level) / 100) + level + 10;
                const moves = await getMovesForLevel(data, level);
                for (const m of moves) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; }

                // 🌟 エラーをしっかり監視する
                const { data: inserted, error } = await supabase.from('poke_caught_pokemons').insert([{
                    owner_id: userId, original_trainer_id: userId, pokedex_id: pokeId, nickname: jaName, level: level, exp: 0, 
                    nature: wildNature, iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed, current_hp: maxHp, 
                    types: data.types.map((t: any) => t.type.name), moves: moves,
                    is_party: true, party_order: 1,
                    ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0
                }]).select('id').single();

                if (error) {
                    console.error("チュートリアルのDB保存エラー:", error);
                    tutorialLocks.delete(userId); // 🔓 エラー時はロック解除
                    return interaction.editReply('⚠️ データベースへの保存に失敗しました。もう一度コマンドを実行してください。');
                }

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`nickbtn_${inserted?.id}`).setLabel('ニックネームをつける').setStyle(ButtonStyle.Primary).setEmoji('🏷️')
                );

                const tutorialText = 
                    '💡 **初めてのポケモンをゲットしました！**\n' +
                    'ここからあなたの冒険が始まります。\n\n' +
                    '📝 **【次にやることガイド】**\n' +
                    '1️⃣ もう一度 `/wild` を実行して、ポケモンを倒してレベルを上げよう！\n' +
                    '2️⃣ HPが減ったら `/heal` で全回復できるぞ！\n' +
                    '3️⃣ レベルが15くらいになったら `/gym` で最初のリーダー「タケシ」に挑戦だ！';
                
                await interaction.editReply({ content: tutorialText, embeds: [embed], components: [row] });
                tutorialLocks.delete(userId); // 🔓 成功したらロック解除
                return;

            } catch (err) {
                tutorialLocks.delete(userId); // 🔓 通信エラーなどが起きても必ずロック解除
                console.error("チュートリアル通信エラー:", err);
                return interaction.editReply('⚠️ 通信エラーが発生しました。もう一度お試しください。');
            }
        }
        const p1Party = await Promise.all(p1Data.map(p => buildBattlePokemon(p)));
        const baseLevel = p1Party[0].level;

        // 🌟 バッジ情報を取得して、上で作った関数に丸投げするだけ！
        const { data: u } = await supabase.from('poke_users').select('badges').eq('discord_id', userId).single();
        let badges = u?.badges || [];
        if (typeof badges === 'string') badges = JSON.parse(badges);

        const { pokeId, data, speciesData, wildLevel } = await getValidWildPokemon(area, baseLevel, badges);

        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        const base: any = {};
        data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

        const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
        const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
        const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);

        const maxHp = Math.floor(((2 * base['hp'] + iv_hp) * wildLevel) / 100) + wildLevel + 10;
        const moves = await getMovesForLevel(data, wildLevel);
        for (const m of moves) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; }

        const wildPoke: BattlePokemon = {
            dbId: 'wild', pokedexId: pokeId, nickname: jaName, level: wildLevel, hp: maxHp, maxHp: maxHp,
            atk: applyNature(Math.floor(((2 * base['attack'] + iv_attack) * wildLevel) / 100) + 5, 1, wildNature), 
            def: applyNature(Math.floor(((2 * base['defense'] + iv_defense) * wildLevel) / 100) + 5, 2, wildNature),
            spa: applyNature(Math.floor(((2 * base['special-attack'] + iv_sp_atk) * wildLevel) / 100) + 5, 3, wildNature),
            spd: applyNature(Math.floor(((2 * base['special-defense'] + iv_sp_def) * wildLevel) / 100) + 5, 4, wildNature),
            speed: applyNature(Math.floor(((2 * base['speed'] + iv_speed) * wildLevel) / 100) + 5, 5, wildNature),
            imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
            moves: moves, types: data.types.map((t: any) => t.type.name), exp: 0,
            nature: wildNature, captureRate: speciesData.capture_rate || 45,
            wildIvs: { iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed },
            evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
            status: null, statusTurns: 0, statStages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
        };

        const p1Active = p1Party.findIndex(p => p.hp > 0);
        
        const battle: BattleState = {
            id: interaction.id, 
            p1: { id: userId, name: 'あなた', party: p1Party, activeIndex: p1Active !== -1 ? p1Active : 0 },
            p2: { id: 'wild', name: '野生', party: [wildPoke], activeIndex: 0 },
            currentTurnUserId: userId,
            log: `あ！ やせいの **${jaName}** が とびだしてきた！\n(性格: ${wildNature})`, battleType: 'wild'
        };

        activeBattles.set(battle.id, battle);
        await updateBattleMessage(interaction as any, battle.id);
    } catch (e) { console.error(e); await interaction.editReply('探索中にエラーが発生しました。'); }
}

async function processWildVictory(battle: BattleState, interaction: MessageComponentInteraction, battleId: string) {
    const attacker = battle.p1;
    const defPoke = battle.p2.party[0];
    
    try {
        // 🌟 修正: 野生はお金を落とさないように削除
        let victoryLog = `\n🏆 **やせいの ${defPoke.nickname} を たおした！**`;

        // 🌟 高速化: 敵のデータを取得
        const defPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${defPoke.pokedexId}`).then(r => r.json());
        const baseExp = defPokeRes.base_experience || 50;

        // 🌟 隠し連戦ボーナス処理
        const currentChain = (hiddenWildChains.get(attacker.id) || 0);
        hiddenWildChains.set(attacker.id, currentChain + 1);
        
        // 例: 1回倒すたびに10%アップ、最大で2倍（2.0）まで上がる設定
        const chainMult = Math.min(2.0, 1.0 + (currentChain * 0.1));
        const gainedExp = Math.floor(((1.0 * baseExp * defPoke.level) / 7) * chainMult);

        const evYields = {
            hp: defPokeRes.stats.find((s:any) => s.stat.name === 'hp')?.effort || 0,
            atk: defPokeRes.stats.find((s:any) => s.stat.name === 'attack')?.effort || 0,
            def: defPokeRes.stats.find((s:any) => s.stat.name === 'defense')?.effort || 0,
            spa: defPokeRes.stats.find((s:any) => s.stat.name === 'special-attack')?.effort || 0,
            spd: defPokeRes.stats.find((s:any) => s.stat.name === 'special-defense')?.effort || 0,
            spe: defPokeRes.stats.find((s:any) => s.stat.name === 'speed')?.effort || 0,
        };

        const { data: invData } = await supabase.from('poke_inventory').select('quantity').eq('user_id', attacker.id).eq('item_id', 'exp_share').single();
        const hasExpShare = (invData?.quantity || 0) > 0;

        let expLog = '';
        
        // 🌟 高速化: パーティ全員の処理を並列(Promise.all)で一気に実行！
        const partyPromises = attacker.party.map(async (p, i) => {
            if (p.hp <= 0) return ''; 

            const isActPoke = (i === attacker.activeIndex);
            if (!isActPoke && !hasExpShare) return '';

            let totalEVs = p.evs.hp + p.evs.atk + p.evs.def + p.evs.spa + p.evs.spd + p.evs.spe;
            const addEv = (current: number, yieldVal: number) => {
                if (totalEVs >= 510) return current;
                const gain = Math.min(yieldVal, 510 - totalEVs);
                const next = Math.min(252, current + gain);
                totalEVs += (next - current); 
                return next;
            };

            p.evs.hp = addEv(p.evs.hp, evYields.hp);
            p.evs.atk = addEv(p.evs.atk, evYields.atk);
            p.evs.def = addEv(p.evs.def, evYields.def);
            p.evs.spa = addEv(p.evs.spa, evYields.spa);
            p.evs.spd = addEv(p.evs.spd, evYields.spd);
            p.evs.spe = addEv(p.evs.spe, evYields.spe);

            const actualGainedExp = isActPoke ? gainedExp : Math.floor(gainedExp / 2);
            if (actualGainedExp <= 0) return '';

            let currentExp = p.exp + actualGainedExp;
            let currentLevel = p.level;
            let levelUpText = ''; let evolutionText = '';

            // 🌟 限界突破: レベルアップ判定をループではなく一発計算で！(API呼び出し回数を激減)
            // ただし経験値タイプ(growth_rate)を知るために1回だけAPIを叩く
            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${p.pokedexId}`).then(r => r.json());
            const speciesRes = await fetch(pokeRes.species.url).then(r => r.json());
            const growthRate = speciesRes.growth_rate.name;

            let leveledUp = false;
            const startLevel = currentLevel; // 🌟 上がる前のレベルを記憶しておく

            // 経験値が足りる限り、裏でレベルだけをどんどん上げる
            while (currentLevel < 100 && currentExp >= getRequiredExp(currentLevel + 1, growthRate)) {
                currentLevel++;
                leveledUp = true;
            }

            if (leveledUp) {
                // 🌟 ループが終わった後に、まとめて1回だけログを作る！
                if (currentLevel - startLevel >= 2) {
                    levelUpText += `\n🎉 **${p.nickname}** は レベル**${currentLevel}** に 一気に上がった！`;
                } else {
                    levelUpText += `\n🎉 **${p.nickname}** は レベル**${currentLevel}** に上がった！`;
                }

                // レベルが上がった時だけ、技と進化のAPIを叩く
                const newMoves = await getMovesForLevel(pokeRes, currentLevel);
                if (p.moves.map(m => m.name).join() !== newMoves.map(m => m.name).join()) {
                    const learned = newMoves.find(m => !p.moves.some(om => om.name === m.name));
                    
                    // 🌟 修正: 勝手に上書きする処理（p.moves = newMoves;）を完全削除！
                    
                    // 🌟 修正: 通知テキストを「入れ替え可能」という案内に変更
                    if (learned) {
                        levelUpText += `\n💡 **${p.nickname}** は 新しい技（${learned.name} 等）を思いつきそうだ！(\`/moves\`で入れ替え可能)`;
                    }
                }
                
                if (speciesRes.evolution_chain) {
                    const evoData = await fetch(speciesRes.evolution_chain.url).then(r => r.json());
                    const checkEvo = (chain: any): any => {
                        if (chain.species.name === speciesRes.name) {
                            for (const next of chain.evolves_to) {
                                if (next.evolution_details[0]?.min_level && currentLevel >= next.evolution_details[0].min_level) return next;
                            }
                        }
                        for (const next of chain.evolves_to) { const result = checkEvo(next); if (result) return result; }
                        return null;
                    };
                    const nextEvo = checkEvo(evoData.chain);
                    if (nextEvo) {
                        const nextId = parseInt(nextEvo.species.url.split('/').filter(Boolean).pop()!);
                        const nextSpeciesData = await fetch(nextEvo.species.url).then(r => r.json());
                        const nextJaName = nextSpeciesData.names.find((n: any) => n.language.name === 'ja')?.name || nextEvo.species.name;
                        const defaultJaName = speciesRes.names.find((n: any) => n.language.name === 'ja')?.name || speciesRes.name.toUpperCase();
                        if (p.nickname === defaultJaName) p.nickname = nextJaName;

                        const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                        p.types = nextPokeData.types.map((t: any) => t.type.name);
                        p.pokedexId = nextId;
                        evolutionText += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                    }
                }
            }
            
            p.level = currentLevel; p.exp = currentExp;
            for (const m of p.moves) {
                if (m.pp === undefined) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; }
            }

            await supabase.from('poke_caught_pokemons').update({ 
                level: currentLevel, exp: currentExp, moves: p.moves, types: p.types, pokedex_id: p.pokedexId, nickname: p.nickname,
                ev_hp: p.evs.hp, ev_attack: p.evs.atk, ev_defense: p.evs.def, ev_sp_atk: p.evs.spa, ev_sp_def: p.evs.spd, ev_speed: p.evs.spe,
                status_condition: null
            }).eq('id', p.dbId);
            
            let thisPokeLog = '';
            if (isActPoke) {
                thisPokeLog += `\n✨ **${actualGainedExp} EXP** をもらった！${levelUpText}${evolutionText}`;
            } else if (levelUpText || evolutionText) {
                thisPokeLog += `${levelUpText}${evolutionText}`;
            }
            return thisPokeLog;
        });

        // 並列処理した結果をすべて受け取る
        const logResults = await Promise.all(partyPromises);
        expLog = logResults.join('');

        battle.log += victoryLog + expLog;

    } catch (e) { console.error("EXPエラー:", e); }

    await updateBattleMessage(interaction, battleId, true);
    await saveAllHPs(battle);
    activeBattles.delete(battleId);
}


export async function handleBattleAction(interaction: MessageComponentInteraction, battleId: string, action: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return interaction.reply({ content: '無効なバトルです。', ephemeral: true });
    if (interaction.user.id !== battle.currentTurnUserId) return interaction.reply({ content: '今は相手のターンです。', ephemeral: true });

    await interaction.deferUpdate();
    
    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    if (action === 'stay' && battle.pendingNextNpcIdx !== undefined) {
        const nextIdx = battle.pendingNextNpcIdx;
        battle.p2.activeIndex = nextIdx;
        battle.pendingNextNpcIdx = undefined; // 状態をリセット
        
        // 演出のために少し間を開ける
        battle.log = `▶ そのまま 戦いを 続ける！\n`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1000);

        battle.log += `\n🔄 **${battle.p2.name}** は **${battle.p2.party[nextIdx].nickname}** を繰り出した！\n`;
        battle.currentTurnUserId = battle.p1.id; // プレイヤーのターンへ
        return updateBattleMessage(interaction, battleId);
    }

    if (action === 'attack') {
        const moveButtons: ButtonBuilder[] = [];
        let hasUsableMove = false;
        
        atkPoke.moves.forEach((m, i) => {
            if (m.pp === undefined) { m.pp = 15; m.maxPp = 15; }
            if (m.pp > 0) hasUsableMove = true;

            // 🌟 威力と相性テキストの生成
            let effText = '';
            // 自分を対象にする技（つるぎのまい等）は相性計算をパスする
            const mult = m.target === 'user' ? 1 : getTypeMultiplier(m.type, defPoke.types);
            
            if (m.power > 0) {
                if (mult > 1) effText = 'ばつぐん';
                else if (mult === 0) effText = 'こうかなし';
                else if (mult < 1) effText = 'いまひとつ';
                else effText = '通常'; // 👈 【修正】ここが空っぽでした！
            } else {
                if (mult === 0) effText = 'こうかなし'; // 👈 【修正】無効タイプなら変化技でも表示
                else effText = 'へんか';
            }

            const powerText = m.power > 0 ? `威${m.power}` : '威-';
            const labelStr = `${m.name} (${powerText}/${effText}) [PP:${m.pp}/${m.maxPp}]`.substring(0, 80);

            moveButtons.push(
                new ButtonBuilder()
                    .setCustomId(`btl_usemove_${battleId}_${i}`)
                    .setLabel(labelStr)
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(m.pp <= 0) 
            );
        });

        if (!hasUsableMove) {
            moveButtons.length = 0;
            moveButtons.push(new ButtonBuilder().setCustomId(`btl_usemove_${battleId}_-1`).setLabel(`わるあがき`).setStyle(ButtonStyle.Danger));
        }

        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        return interaction.editReply({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...moveButtons), new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn)] });
    }

    if (action === 'switchmenu') {
        const switchButtons = attacker.party.map((p, i) => new ButtonBuilder().setCustomId(`btl_switch_${battleId}_${i}`).setLabel(`${p.nickname} (HP:${p.hp})`).setStyle(ButtonStyle.Success).setDisabled(i === attacker.activeIndex || p.hp <= 0));
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < switchButtons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        if (rows[rows.length - 1].components.length < 5) rows[rows.length - 1].addComponents(backBtn); else rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn));
        return interaction.editReply({ components: rows });
    }

    if (action === 'bag' && battle.battleType === 'wild') {
        const { data: inv } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id);
        const getQty = (id: string) => inv?.find(i => i.item_id === id)?.quantity || 0;
        const balls = [
            { id: 'monster_ball', name: 'モンスターボール', emoji: '🔴', rate: 1.0, qty: getQty('monster_ball') },
            { id: 'super_ball', name: 'スーパーボール', emoji: '🔵', rate: 1.5, qty: getQty('super_ball') },
            { id: 'hyper_ball', name: 'ハイパーボール', emoji: '🟡', rate: 2.0, qty: getQty('hyper_ball') },
            { id: 'premier_ball', name: 'プレミアムボール', emoji: '⭐', rate: 1.5, qty: getQty('premier_ball') },
            { id: 'master_ball', name: 'マスターボール', emoji: '🟣', rate: 100.0, qty: getQty('master_ball') }
        ].filter(b => b.qty > 0);

        if (balls.length === 0) return interaction.followUp({ content: '❌ ボールを 1つも 持っていない！', ephemeral: true });

        const selectMenu = new StringSelectMenuBuilder().setCustomId(`btl_throw_${battleId}`).setPlaceholder('投げるボールを選択').addOptions(balls.map(b => ({ label: `${b.name} (残り: ${b.qty}個)`, value: `${b.id}_${b.rate}`, emoji: b.emoji })));
        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        return interaction.editReply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu), new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn)] });
    }

    if (action === 'back') return updateBattleMessage(interaction, battleId);

    if (action === 'run') {
        if (battle.battleType === 'pvp') {
            battle.log = `🏳️ <@${attacker.id}> は 勝負を 投げ出した！\n\n🏆 **<@${defender.id}> の勝利！**`;
            try {
                const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', defender.id).single();
                const newStreak = (u?.win_streak || 0) + 1;
                await supabase.from('poke_users').update({ money: (u?.money || 0) + 500, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', defender.id);
                await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', attacker.id);
                battle.log += `\n💰 賞金 **500円** を手に入れた！`;
            } catch (e) {}
        } else {
            battle.log = `💨 うまく 逃げ切れた！`;
            hiddenWildChains.delete(interaction.user.id); // 🌟 逃げたらリセット
        }
        await updateBattleMessage(interaction, battleId, true);
        await saveAllHPs(battle);
        return activeBattles.delete(battleId);
    }

    if (action === 'switch') {
        const isForcedSwitch = attacker.party[attacker.activeIndex].hp <= 0;
        attacker.activeIndex = parseInt(interaction.customId.split('_')[3]);
        battle.log = `🔄 <@${attacker.id}> は **${attacker.party[attacker.activeIndex].nickname}** を繰り出した！`;
        if (battle.battleType === 'pvp') battle.currentTurnUserId = defender.id; 

        if (battle.pendingNextNpcIdx !== undefined) {
            const nextIdx = battle.pendingNextNpcIdx;
            battle.p2.activeIndex = nextIdx;
            battle.pendingNextNpcIdx = undefined;
            
            await updateBattleMessage(interaction, battleId); // 自分が交代したログを表示
            await sleep(1000);
            
            battle.log += `\n🔄 **${battle.p2.name}** は **${battle.p2.party[nextIdx].nickname}** を繰り出した！\n`;
            battle.currentTurnUserId = battle.p1.id; // プレイヤーのターンから再開
            return updateBattleMessage(interaction, battleId);
        }

        if ((battle.battleType === 'wild' || battle.battleType === 'gym') && !isForcedSwitch && defPoke.hp > 0) {
            const currentAtkPoke = attacker.party[attacker.activeIndex];
            const usableWildMoves = defPoke.moves.filter(m => (m.pp === undefined || m.pp > 0));
            let wMove: BattleMove = { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 };
            if (usableWildMoves.length > 0) {
                // 🌟 AI強化：威力のある技を優先的に選ぶ確率を高くする
                const attackMoves = usableWildMoves.filter(m => m.power > 0);
                const statusMoves = usableWildMoves.filter(m => m.power === 0);
                
                // 攻撃技があれば、70%の確率で攻撃技を選ぶ。なければ変化技。
                if (attackMoves.length > 0 && Math.random() < 0.7) {
                    wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                } else {
                    wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                }
            }
            const hitChance = wMove.accuracy || 100;
            const isHit = (Math.random() * 100) <= hitChance;

            if (!isHit) {
                 battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${wMove.name}**！\n💨 しかし **${currentAtkPoke.nickname}** には 当たらなかった！`;
            } else {
                 battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${wMove.name}**！\n`;
                 // 🌟 修正: 新しい共通関数で効果を全部適用！
                 battle.log += await executeMoveEffects(defPoke, currentAtkPoke, wMove);

                 if (currentAtkPoke.hp === 0) {
                     battle.log += `\n💀 **${currentAtkPoke.nickname}** は たおれた！\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
                     const myNextIdx = attacker.party.findIndex(p => p.hp > 0);
                     if (myNextIdx === -1) {
                        battle.log += `\n\n目の前が まっくらになった……\n(やせいの ${defPoke.nickname} から逃げ出した)`;
                        hiddenWildChains.delete(battle.p1.id); // 🌟 負けたらリセット
                        await updateBattleMessage(interaction, battleId, true);
                         await saveAllHPs(battle);
                         return activeBattles.delete(battleId);
                     }
                 }
            }
        }
    }

    if (action === 'usemove') {
        const moveIdx = parseInt(interaction.customId.split('_')[3]);
        const pMove = moveIdx === -1 ? { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 } : atkPoke.moves[moveIdx];

        if (battle.battleType === 'wild' || battle.battleType === 'gym') {
            const usableWildMoves = defPoke.moves.filter(m => (m.pp === undefined || m.pp > 0));
            let wMove: BattleMove = { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 };
            if (usableWildMoves.length > 0) {
                // 🌟 AI強化：威力のある技を優先的に選ぶ確率を高くする
                const attackMoves = usableWildMoves.filter(m => m.power > 0);
                const statusMoves = usableWildMoves.filter(m => m.power === 0);
                
                // 攻撃技があれば、70%の確率で攻撃技を選ぶ。なければ変化技。
                if (attackMoves.length > 0 && Math.random() < 0.7) {
                    wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                } else {
                    wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                }
            }
            // 🌟 まひ状態だと素早さが半減！
            const p1Speed = atkPoke.speed * (atkPoke.status === 'paralysis' ? 0.5 : 1) * getStageMult(atkPoke.statStages.spe);
            const p2Speed = defPoke.speed * (defPoke.status === 'paralysis' ? 0.5 : 1) * getStageMult(defPoke.statStages.spe);
            
            const p1First = p1Speed >= p2Speed;
            const turnOrder = p1First ? 
                [{poke: atkPoke, target: defPoke, move: pMove, isP1: true, mIdx: moveIdx}, {poke: defPoke, target: atkPoke, move: wMove, isP1: false, mIdx: null}] :
                [{poke: defPoke, target: atkPoke, move: wMove, isP1: false, mIdx: null}, {poke: atkPoke, target: defPoke, move: pMove, isP1: true, mIdx: moveIdx}];

            battle.log = ``; 

            // === バトルターンの開始 ===
            for (const act of turnOrder) {
                if (act.poke.hp <= 0) continue; // 先制で倒されていたらスキップ

                // 🌟 状態異常で動けないかチェック！
                const statusCheck = checkStatusBeforeMove(act.poke);
                if (!statusCheck.canMove) {
                    battle.log += statusCheck.log;
                    await updateBattleMessage(interaction, battleId); // 👈 画面更新
                    await sleep(1500); // 👈 1.5秒待つ
                    continue;
                }

                if (act.isP1 && act.mIdx !== null && act.mIdx !== -1) act.poke.moves[act.mIdx].pp!--; // PP消費

                const hitChance = act.move.accuracy || 100;
                const isHit = (Math.random() * 100) <= hitChance;

                if (!isHit) {
                    battle.log += `▶ **${act.poke.nickname}** の **${act.move.name}**！\n💨 しかし **${act.target.nickname}** には 当たらなかった！\n\n`;
                    await updateBattleMessage(interaction, battleId); // 👈 画面更新
                    await sleep(1500); // 👈 1.5秒待つ
                    continue;
                }

                battle.log += `▶ **${act.poke.nickname}** の **${act.move.name}**！\n`;

                battle.log += await executeMoveEffects(act.poke, act.target, act.move);

                battle.log += `\n`;
                
                // 🌟 攻撃が当たってログが作られた直後に「画面更新」と「間」を入れる！
                await updateBattleMessage(interaction, battleId);
                await sleep(1500);

                if (act.target.hp === 0) {
                    battle.log += `💀 **${act.target.nickname}** は たおれた！\n`;
                    if (act.isP1) { 
                        if (battle.battleType === 'gym') {
                            const nextNpcIdx = battle.p2.party.findIndex(p => p.hp > 0);
                            if (nextNpcIdx === -1) {
                                // 🌟 ジムリーダー全滅（勝利！）
                                const badge = battle.gymData.badge;
                                const { data: u } = await supabase.from('poke_users').select('badges, money').eq('discord_id', battle.p1.id).single();
                                let badges = u?.badges || [];
                                if (typeof badges === 'string') badges = JSON.parse(badges);
                                
                                if (!badges.includes(badge)) {
                                    // 🌟 初回勝利時（バッジ未所持）：フルで報酬を渡す
                                    badges.push(badge);
                                    await supabase.from('poke_users').update({ 
                                        badges: badges, 
                                        money: (u?.money || 0) + battle.gymData.reward 
                                    }).eq('discord_id', battle.p1.id);
                                    battle.log += `\n🏆 **ジムリーダー ${battle.p2.name} に勝利した！**\n🎊 **${badge}** を手に入れた！\n💰 賞金 **${battle.gymData.reward}円** を獲得！\n`;
                                } else {
                                    // 🌟 2回目以降の勝利時：少額のファイトマネーだけにする（無限金策対策）
                                    const repeatReward = 1500; // ※額は適当に調整してください
                                    await supabase.from('poke_users').update({ 
                                        money: (u?.money || 0) + repeatReward 
                                    }).eq('discord_id', battle.p1.id);
                                    battle.log += `\n🏆 **ジムリーダー ${battle.p2.name} に勝利した！**\n💰 ファイトマネー **${repeatReward}円** を獲得！\n`;
                                }
                
                                await processWildVictory(battle, interaction, battleId);

                                return;
                            } else {
                                // 🌟 演出強化＆入れ替え提案！
                                battle.pendingNextNpcIdx = nextNpcIdx; // 次のインデックスを記憶
                                const nextPoke = battle.p2.party[nextNpcIdx];
                                
                                battle.log += `\n⚠️ **${battle.p2.name}** は 次に **${nextPoke.nickname}** を 出そうとしている！\n🔄 ポケモンを 入れ替えますか？`;
                                await updateBattleMessage(interaction, battleId);
                                break; // ターン処理を抜けて入れ替え入力待ちへ
                            }
                        } else {
                            await processWildVictory(battle, interaction, battleId);
                            return; 
                        }
                    } else {
                        const myNextIdx = battle.p1.party.findIndex(p => p.hp > 0);
                        if (myNextIdx === -1) {
                            battle.log += `\n\n目の前が まっくらになった……\n(やせいの ${defPoke.nickname} から逃げ出した)`;
                            hiddenWildChains.delete(battle.p1.id); // 🌟 負けたらリセット
                            await updateBattleMessage(interaction, battleId, true);
                            await saveAllHPs(battle);
                            return activeBattles.delete(battleId);
                        } else {
                            battle.log += `\n⚠️ 次に 出す ポケモンを 選んでください！\n`;
                            await updateBattleMessage(interaction, battleId); // 👈 待機前にも更新しておく
                            break; // 死に出し待機へ
                        }
                    }
                }
            }

            // 🌟 ターン終了時のダメージ処理（どく・やけど）
            let tookStatusDamage = false;
            for (const p of [atkPoke, defPoke]) {
                if (p.hp > 0) {
                    if (p.status === 'poison') {
                        const dmg = Math.max(1, Math.floor(p.maxHp / 8));
                        p.hp = Math.max(0, p.hp - dmg);
                        battle.log += `☠️ **${p.nickname}** は どくの ダメージを 受けている！\n`;
                        tookStatusDamage = true;
                    } else if (p.status === 'burn') {
                        const dmg = Math.max(1, Math.floor(p.maxHp / 16));
                        p.hp = Math.max(0, p.hp - dmg);
                        battle.log += `🔥 **${p.nickname}** は やけどの ダメージを 受けている！\n`;
                        tookStatusDamage = true;
                    }
                    
                    if (p.hp <= 0) {
                        battle.log += `💀 **${p.nickname}** は 力尽きた…！\n`;
                        if (p === defPoke) { 
                            await updateBattleMessage(interaction, battleId); // 👈 ダメージ更新
                            await sleep(1000);
                            await processWildVictory(battle, interaction, battleId); 
                            return; 
                        } else {
                            const myNextIdx = battle.p1.party.findIndex(x => x.hp > 0);
                            if (myNextIdx === -1) {
                                battle.log += `\n\n目の前が まっくらになった……\n(やせいの ${defPoke.nickname} から逃げ出した)`;
                                hiddenWildChains.delete(battle.p1.id); // 🌟 負けたらリセット
                                await updateBattleMessage(interaction, battleId, true);
                                await saveAllHPs(battle);
                                return activeBattles.delete(battleId);
                            } else { 
                                battle.log += `\n⚠️ 次に 出す ポケモンを 選んでください！\n`; 
                                break; 
                            }
                        }
                    }
                }
            }
            
            // もし毒や火傷のダメージが入ったら、一瞬だけ間をあけて見せる
            if (tookStatusDamage) {
                await updateBattleMessage(interaction, battleId);
                await sleep(1000);
            }
            
            await supabase.from('poke_caught_pokemons').update({ moves: atkPoke.moves }).eq('id', atkPoke.dbId);
            await updateBattleMessage(interaction, battleId);
            return;

        } else if (battle.battleType === 'pvp') {
            // PvPはUIが複雑なため交互ターン制ですが、状態異常の処理は適応します
            if (moveIdx !== -1) atkPoke.moves[moveIdx].pp!--;
            
            const statusCheck = checkStatusBeforeMove(atkPoke);
            if (!statusCheck.canMove) {
                battle.log = statusCheck.log;
            } else {
                const hitChance = pMove.accuracy || 100;
                const isHit = (Math.random() * 100) <= hitChance;

                if (!isHit) {
                    battle.log = `▶ **${atkPoke.nickname}** の **${pMove.name}**！\n💨 しかし **${defPoke.nickname}** には 当たらなかった！`;
                } else {
                    battle.log = `▶ **${atkPoke.nickname}** の **${pMove.name}**！\n`;
                    
                    // 🌟 【特大修正】長ったらしくてバグの温床だった手書き処理を消し、共通関数を呼ぶだけにする！
                    battle.log += await executeMoveEffects(atkPoke, defPoke, pMove);

                    if (defPoke.hp === 0) {
                        battle.log += `\n💀 **${defPoke.nickname}** は たおれた！`;
                        const nextIdx = defender.party.findIndex(p => p.hp > 0);
                        if (nextIdx === -1) {
                            battle.log += `\n\n🏆 **<@${attacker.id}> の勝利！**`;
                            try {
                                const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', attacker.id).single();
                                const newStreak = (u?.win_streak || 0) + 1;
                                await supabase.from('poke_users').update({ money: (u?.money || 0) + 500, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', attacker.id);
                                await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', defender.id);
                                battle.log += `\n💰 賞金 **500円** を手に入れた！`;
                            } catch (e) {}
                            await updateBattleMessage(interaction, battleId, true);
                            await saveAllHPs(battle);
                            return activeBattles.delete(battleId);
                        }
                        // 🌟 ここを修正: 強制交代ではなく相手に「死に出し」を選ばせる！
                        battle.log += `\n⚠️ <@${defender.id}> は 次に 出す ポケモンを 選んでください！`;
                        battle.currentTurnUserId = defender.id; // 死んだ側にターンを渡して待機
                        await updateBattleMessage(interaction, battleId);
                        return;
                    }
                }
            }
            await supabase.from('poke_caught_pokemons').update({ moves: atkPoke.moves }).eq('id', atkPoke.dbId);
            // 🌟 修正: 相手が倒れようが生き残ろうが、無条件で相手のターンに渡す！
            battle.currentTurnUserId = defender.id; 
            await updateBattleMessage(interaction, battleId);
            return;
        }
    }

    if (action === 'throw' && 'values' in interaction) {
        const selectedVal = interaction.values[0]; 
        const lastIdx = selectedVal.lastIndexOf('_');
        const ballId = selectedVal.substring(0, lastIdx);
        const ballMult = parseFloat(selectedVal.substring(lastIdx + 1));

        const { data: inv } = await supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', ballId).single();
        await supabase.from('poke_inventory').update({ quantity: (inv?.quantity || 1) - 1 }).eq('user_id', interaction.user.id).eq('item_id', ballId);
        
        // 状態異常だと捕まりやすくなるボーナス！(ねむり/こおりは2倍、他は1.5倍)
        const statusBonus = defPoke.status === 'sleep' || defPoke.status === 'freeze' ? 2.0 : defPoke.status ? 1.5 : 1.0;
        const hpFactor = ((defPoke.maxHp * 3) - (defPoke.hp * 2)) / (defPoke.maxHp * 3);

        // 🌟 ここから追加！【レベル差ボーナス】
        // 自分(atkPoke)のレベルが、相手(defPoke)より高い分だけボーナスがかかる！
        const levelDiff = Math.max(0, atkPoke.level - defPoke.level);
        // 例：レベルが10高いごとに 0.5 ずつ倍率が乗る（最大上限は設けないか、あるいは5倍くらいまで）
        const levelBonus = 1.0 + (levelDiff * 0.05); 

        // 🌟 修正：baseChance の計算に levelBonus を掛け合わせる！
        const baseChance = (defPoke.captureRate! / 255) * hpFactor * statusBonus * levelBonus;
        let finalChance = Math.min(1.0, baseChance * ballMult);
        
        if (ballId === 'master_ball') finalChance = 1.0; // 🟣 どんな伝説でも絶対捕まる！
        
        const ballName = ballId.replace('_', ' ').toUpperCase();
        battle.log = `▶ **${ballName}** を投げた！\n揺れるボール……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1000); 
        
        battle.log += ` コロッ……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1000); 

        battle.log += ` コロッ……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1200); 
        
        if (Math.random() < finalChance) {
            battle.log += ` カチッ！\n\n🎊 やったー！ **${defPoke.nickname}** を つかまえた！`;
            
            const { count: partyCount } = await supabase.from('poke_caught_pokemons').select('*', { count: 'exact' }).eq('owner_id', interaction.user.id).eq('is_party', true);
            const isParty = (partyCount || 0) < 6;
            const partyOrder = isParty ? (partyCount || 0) + 1 : null;

            const { data: inserted } = await supabase.from('poke_caught_pokemons').insert([{
                owner_id: interaction.user.id, original_trainer_id: interaction.user.id, pokedex_id: defPoke.pokedexId,
                nickname: defPoke.nickname, level: defPoke.level, exp: 0, 
                nature: defPoke.nature, iv_hp: defPoke.wildIvs.iv_hp, iv_attack: defPoke.wildIvs.iv_attack, iv_defense: defPoke.wildIvs.iv_defense,
                iv_sp_atk: defPoke.wildIvs.iv_sp_atk, iv_sp_def: defPoke.wildIvs.iv_sp_def, iv_speed: defPoke.wildIvs.iv_speed,
                current_hp: defPoke.hp, types: defPoke.types, moves: defPoke.moves,
                is_party: isParty, party_order: partyOrder,
                ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0,
                status_condition: defPoke.status // 捕まえた時の状態異常もそのまま持ち帰る
            }]).select('id').single();

            const boxText = isParty ? '手持ち' : 'ボックス';
            battle.log += `\n(${boxText}に送られました。残りボール: ${inv!.quantity - 1}個)`;

            // 🌟 隠し連戦ボーナス処理（捕まえた時もチェーン継続＆ボーナス適用！）
            const currentChain = (hiddenWildChains.get(interaction.user.id) || 0);
            hiddenWildChains.set(interaction.user.id, currentChain + 1);
            const chainMult = Math.min(2.0, 1.0 + (currentChain * 0.1));

            const defPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${defPoke.pokedexId}`).then(r => r.json());
            const baseExp = defPokeRes.base_experience || 50;
            // 🌟 倍率(chainMult)をかける！
            const gainedExp = Math.floor(((1.0 * baseExp * defPoke.level) / 7) * chainMult);
            
            const pRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${atkPoke.pokedexId}`).then(r => r.json());
            const sRes = await fetch(pRes.species.url).then(r => r.json());
            const rate = sRes.growth_rate.name;

            atkPoke.exp += gainedExp;
            battle.log += `\n✨ **${atkPoke.nickname}** は **${gainedExp}** の経験値をもらった！`;

            let currentLevel = atkPoke.level;
            while (currentLevel < 100 && atkPoke.exp >= getRequiredExp(currentLevel + 1, rate)) {
                currentLevel++;
                battle.log += `\n🆙 **${atkPoke.nickname}** は Lv.**${currentLevel}** に上がった！`;
            }
            atkPoke.level = currentLevel;
            await supabase.from('poke_caught_pokemons').update({ level: currentLevel, exp: atkPoke.exp }).eq('id', atkPoke.dbId);
            
            await updateBattleMessage(interaction, battleId, true, true, inserted?.id); 
            await saveAllHPs(battle);
            return activeBattles.delete(battleId);
        } else {
            battle.log += ` アァッ！\n\n💨 **${defPoke.nickname}** は ボールから 抜け出してしまった！`;
            
            // 🌟 ボール抜け出し後の反撃も状態異常に対応
            const statusCheck = checkStatusBeforeMove(defPoke);
            if (!statusCheck.canMove) {
                 battle.log += statusCheck.log;
            } else {
                const usableWildMoves = defPoke.moves.filter(m => (m.pp === undefined || m.pp > 0));
                let wMove: BattleMove = { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 };
                if (usableWildMoves.length > 0) {
                    // 🌟 AI強化：威力のある技を優先的に選ぶ確率を高くする
                    const attackMoves = usableWildMoves.filter(m => m.power > 0);
                    const statusMoves = usableWildMoves.filter(m => m.power === 0);
                    
                    // 攻撃技があれば、70%の確率で攻撃技を選ぶ。なければ変化技。
                    if (attackMoves.length > 0 && Math.random() < 0.7) {
                        wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                    } else {
                        wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                    }
                }
                const hitChance = wMove.accuracy || 100;
                const isHit = (Math.random() * 100) <= hitChance;

                if (!isHit) {
                     battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${wMove.name}**！\n💨 しかし **${atkPoke.nickname}** には 当たらなかった！`;
                } else {
                     battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${wMove.name}**！\n`;
                     // 🌟 修正: 新しい共通関数で効果を全部適用！
                     battle.log += await executeMoveEffects(defPoke, atkPoke, wMove);

                     if (atkPoke.hp === 0) {
                         battle.log += `\n💀 **${atkPoke.nickname}** は たおれた！`;
                         const myNextIdx = attacker.party.findIndex(p => p.hp > 0);
                         if (myNextIdx === -1) {
                            battle.log += `\n\n目の前が まっくらになった……\n(やせいの ${defPoke.nickname} から逃げ出した)`;
                            hiddenWildChains.delete(battle.p1.id); // 🌟 負けたらリセット
                            await updateBattleMessage(interaction, battleId, true);
                             await saveAllHPs(battle);
                             return activeBattles.delete(battleId);
                         } else {
                             battle.log += `\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
                         }
                     }
                }
            }
            
            // どく・やけどダメージ
            if (atkPoke.hp > 0 && (atkPoke.status === 'poison' || atkPoke.status === 'burn')) {
                 const dmg = Math.max(1, Math.floor(atkPoke.maxHp / (atkPoke.status === 'poison' ? 8 : 16)));
                 atkPoke.hp = Math.max(0, atkPoke.hp - dmg);
                 battle.log += `\n${atkPoke.status === 'poison' ? '☠️ どく' : '🔥 やけど'} の ダメージを 受けている！`;
                 if (atkPoke.hp <= 0) battle.log += `\n💀 **${atkPoke.nickname}** は 力尽きた…！\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
            }

            battle.currentTurnUserId = attacker.id;
            await updateBattleMessage(interaction, battleId);
            return;
        }
    }

    await updateBattleMessage(interaction, battleId);
}

// 👇 [攻↑2] [防↓1] のように表示するスタイルに変更！
function getBuffString(stages: {atk: number, def: number, spa: number, spd: number, spe: number}): string {
    const jpMap: Record<string, string> = { atk: '攻', def: '防', spa: '特攻', spd: '特防', spe: '速' };
    let buffs = [];
    
    for (const [key, val] of Object.entries(stages)) {
        if (val > 0) {
            buffs.push(`[${jpMap[key]}↑${val}]`);
        } else if (val < 0) {
            buffs.push(`[${jpMap[key]}↓${Math.abs(val)}]`);
        }
    }
    
    // 変化がある場合のみ、スペース区切りで連結して返す
    return buffs.length > 0 ? ` ${buffs.join(' ')}` : '';
}

async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false, isCaught = false, caughtDbId?: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1p = battle.p1.party[battle.p1.activeIndex];
    const p2p = battle.p2.party[battle.p2.activeIndex];
    const p1Alive = battle.p1.party.filter(p => p.hp > 0).length;
    const p2Alive = battle.p2.party.filter(p => p.hp > 0).length;

    let titleText = '⚔️ ポケモンバトル 進行中！';
    let embedColor = battle.battleType === 'wild' ? 0x2E8B57 : 0xFF4500; // 戦闘中の基本カラー

    if (isCaught) {
        titleText = `🎊 ${p2p.nickname} ゲットだぜ！`;
        embedColor = 0x00FF00; // 🟢 捕獲成功：グリーン
    } else if (isFinished) {
        // 🌟 生き残っているポケモンの数で「なぜ終わったか」を判定して色とタイトルを変える！
        if (p2Alive === 0) {
            titleText = '🏆 バトル勝利！';
            embedColor = 0xFFD700; // 🟡 勝利：輝くゴールド！
        } else if (p1Alive === 0) {
            titleText = '💀 目の前が まっくらになった……';
            embedColor = 0x36393F; // ⚫ 敗北：絶望のダークカラー
        } else {
            titleText = '💨 バトル終了（逃走）';
            embedColor = 0x808080; // ⚪ 逃走：無機質なグレー
        }
    } else if (battle.battleType === 'wild') {
        titleText = `あ！ やせいの ${p2p.nickname} が とびだしてきた！`;
    }

    const p1HpBar = generateHpBar(p1p.hp, p1p.maxHp);
    const p2HpBar = generateHpBar(p2p.hp, p2p.maxHp);

    // 🌟 状態異常アイコンをHPの隣に表示する！
    const p1Status = p1p.status ? ` [${STATUS_MAP[p1p.status]}]` : '';
    const p2Status = p2p.status ? ` [${STATUS_MAP[p2p.status]}]` : '';

    const p1Buffs = getBuffString(p1p.statStages);
    const p2Buffs = getBuffString(p2p.statStages);

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setDescription(battle.log)
        .setColor(embedColor)
        .addFields(
            { name: `🔵 相手: ${battle.battleType === 'pvp' ? `<@${battle.p2.id}>` : '野生'}`, value: `**${p2p.nickname}** Lv.${p2p.level}${p2Status}${p2Buffs}\n${p2HpBar} [ **${p2p.hp}** / ${p2p.maxHp} ]\n(残り: ${p2Alive}匹)`, inline: false },
            { name: `🔴 自分: <@${battle.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level}${p1Status}${p1Buffs}\n${p1HpBar} [ **${p1p.hp}** / ${p1p.maxHp} ]\n(残り: ${p1Alive}匹)`, inline: false }
        )
        .setImage(p2p.imageUrl)
        .setThumbnail(p1p.imageUrl);

    let components: any[] = [];
    
    if (!isFinished) {
        if (battle.pendingNextNpcIdx !== undefined) {
            // 入れ替え提案
            components = [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('はい（入れ替える）').setStyle(ButtonStyle.Success).setEmoji('🔄'),
                    new ButtonBuilder().setCustomId(`btl_stay_${battleId}`).setLabel('いいえ（そのまま）').setStyle(ButtonStyle.Secondary).setEmoji('⚔️')
                )
            ];
        }
        else if (p1p.hp <= 0 && p1Alive > 0) {
            // P1死に出し
            const switchButtons = battle.p1.party.map((p, i) => 
                new ButtonBuilder().setCustomId(`btl_switch_${battleId}_${i}`).setLabel(`${p.nickname} (HP:${p.hp})`).setStyle(ButtonStyle.Success).setDisabled(p.hp <= 0)
            );
            const rows: ActionRowBuilder<ButtonBuilder>[] = [];
            for (let i = 0; i < switchButtons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
            
            if (battle.battleType === 'wild' || battle.battleType === 'gym') {
                const runBtn = new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨');
                if (rows[rows.length - 1].components.length < 5) rows[rows.length - 1].addComponents(runBtn); else rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(runBtn));
            }
            components = rows;
        } 
        // 👇 🌟 追加！ P2(相手側)の死に出し対応 (PvPのみ)
        else if (p2p.hp <= 0 && p2Alive > 0 && battle.battleType === 'pvp') {
            const switchButtons = battle.p2.party.map((p, i) => 
                new ButtonBuilder().setCustomId(`btl_switch_${battleId}_${i}`).setLabel(`${p.nickname} (HP:${p.hp})`).setStyle(ButtonStyle.Success).setDisabled(p.hp <= 0)
            );
            const rows: ActionRowBuilder<ButtonBuilder>[] = [];
            for (let i = 0; i < switchButtons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
            components = rows;
        }
        // 👆 🌟 追加ここまで
        else {
            components = [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
                    ...(battle.battleType === 'wild' ? [new ButtonBuilder().setCustomId(`btl_bag_${battleId}`).setLabel('バッグ').setStyle(ButtonStyle.Success).setEmoji('🎒')] : []),
                    new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
                    new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel(battle.battleType === 'pvp' ? '降参する' : 'にげる').setStyle(ButtonStyle.Secondary).setEmoji(battle.battleType === 'pvp' ? '🏳️' : '💨')
                )
            ];
        }
    } else if (isCaught && caughtDbId) {
        components = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`nickbtn_${caughtDbId}`).setLabel('ニックネームをつける').setStyle(ButtonStyle.Primary).setEmoji('🏷️')
            )
        ];
    }

    // 🌟 修正: 通信エラーやボタン連打によるクラッシュを防ぐバリア！
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [embed], components });
        } else {
            await interaction.update({ embeds: [embed], components });
        }
    } catch (e) {
        console.error('UI更新エラー（無視してOK）:', e);
    }
}

export async function startGymBattle(interaction: ChatInputCommandInteraction, userId: string, leaderId: string) {
    // 🌟 本家のジムリーダーのデータ（赤・緑ベース）
    const GYM_LEADERS: Record<string, any> = {
        'rock': { name: 'タケシ', badge: '🪨 グレーバッジ', reward: 3000, team: [{ id: 74, level: 12 }, { id: 95, level: 14 }] },
        'water': { name: 'カスミ', badge: '💧 ブルーバッジ', reward: 5000, team: [{ id: 120, level: 18 }, { id: 121, level: 21 }] },
        'electric': { name: 'マチス', badge: '⚡ オレンジバッジ', reward: 8000, team: [{ id: 100, level: 21 }, { id: 25, level: 18 }, { id: 26, level: 24 }] },
        // 🌟 追加したジムリーダー
        'grass': { name: 'エリカ', badge: '🌈 レインボーバッジ', reward: 12000, team: [{ id: 71, level: 29 }, { id: 114, level: 24 }, { id: 45, level: 29 }] }, // ウツボット, モンジャラ, ラフレシア
        'poison': { name: 'キョウ', badge: '💖 ピンクバッジ', reward: 15000, team: [{ id: 109, level: 37 }, { id: 89, level: 39 }, { id: 109, level: 37 }, { id: 110, level: 43 }] }, // ドガース, ベトベトン, ドガース, マタドガス
        'psychic': { name: 'ナツメ', badge: '🟡 ゴールドバッジ', reward: 18000, team: [{ id: 64, level: 38 }, { id: 122, level: 37 }, { id: 49, level: 38 }, { id: 65, level: 43 }] }, // ユンゲラー, バリヤード, モルフォン, フーディン
        'fire': { name: 'カツラ', badge: '🔥 クリムゾンバッジ', reward: 22000, team: [{ id: 58, level: 42 }, { id: 77, level: 40 }, { id: 78, level: 42 }, { id: 59, level: 47 }] }, // ガーディ, ポニータ, ギャロップ, ウインディ
        'ground': { name: 'サカキ', badge: '🌿 グリーンバッジ', reward: 30000, team: [{ id: 111, level: 45 }, { id: 51, level: 42 }, { id: 31, level: 44 }, { id: 34, level: 45 }, { id: 112, level: 50 }] } // サイホーン, ダグトリオ, ニドクイン, ニドキング, サイドン
    };

    const leader = GYM_LEADERS[leaderId];
    if (!leader) return interaction.editReply('そのジムリーダーは見つかりません。');

    const { data: u } = await supabase.from('poke_users').select('badges').eq('discord_id', userId).single();
    let badges = u?.badges || [];
    if (typeof badges === 'string') badges = JSON.parse(badges);

    // 🌟 挑戦条件の追加
    const reqMap: Record<string, [string, string]> = {
        'water': ['タケシ', '🪨 グレーバッジ'], 'electric': ['カスミ', '💧 ブルーバッジ'],
        'grass': ['マチス', '⚡ オレンジバッジ'], 'poison': ['エリカ', '🌈 レインボーバッジ'],
        'psychic': ['キョウ', '💖 ピンクバッジ'], 'fire': ['ナツメ', '🟡 ゴールドバッジ'],
        'ground': ['カツラ', '🔥 クリムゾンバッジ']
    };
    if (reqMap[leaderId] && !badges.includes(reqMap[leaderId][1])) {
        return interaction.editReply(`⚠️ ${leader.name}に挑戦するには、先に${reqMap[leaderId][0]}を倒して「${reqMap[leaderId][1]}」を手に入れる必要があります！`);
    }

    let { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true });
    if (!p1Data || p1Data.length === 0) return interaction.editReply('手持ちのポケモンがいません！ /wild で捕まえましょう。');
    
    const p1Party = await Promise.all(p1Data.map((p: any) => buildBattlePokemon(p)));
    const p1Active = p1Party.findIndex(p => p.hp > 0);
    if (p1Active === -1) return interaction.editReply('戦えるポケモンがいません！ /heal で回復してください。');

    const leaderParty = [];
    for (const poke of leader.team) {
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${poke.id}`);
        const data = await res.json();
        const speciesRes = await fetch(data.species.url);
        const speciesData = await speciesRes.json();
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();
        const moves = await getMovesForLevel(data, poke.level);
        for (const m of moves) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; }

        // 🌟 ジムリーダー大幅強化パッチ！
        const mockDb = {
            id: `npc_${poke.id}_${Math.random()}`, pokedex_id: poke.id, nickname: jaName, level: poke.level,
            // 性格を「すなお（無補正）」にして特攻ダウンを防ぎ、個体値(IV)を最大の31、努力値(EV)をALL85に底上げして最強ステータス化！
            nature: 'すなお', iv_hp: 31, iv_attack: 31, iv_defense: 31, iv_sp_atk: 31, iv_sp_def: 31, iv_speed: 31,
            ev_hp: 85, ev_attack: 85, ev_defense: 85, ev_sp_atk: 85, ev_sp_def: 85, ev_speed: 85,
            types: data.types.map((t: any) => t.type.name), moves: moves, exp: 9999, current_hp: 999
        };
        leaderParty.push(await buildBattlePokemon(mockDb));
    }

    const battle: BattleState = {
        id: interaction.id,
        p1: { id: userId, name: 'あなた', party: p1Party, activeIndex: p1Active },
        p2: { id: `gym_${leaderId}`, name: leader.name, party: leaderParty, activeIndex: 0 },
        currentTurnUserId: userId,
        log: `**ジムリーダーの ${leader.name}** が 勝負を しかけてきた！`,
        battleType: 'gym', gymData: leader
    };

    activeBattles.set(battle.id, battle);
    await updateBattleMessage(interaction as any, battle.id);
}
