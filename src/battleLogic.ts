// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageComponentInteraction, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './pokeDb';
import { getMovesForLevel, getRandomPokemonIdByArea } from './pokeApiUtils';

const activeBattles = new Map<string, BattleState>();
export const hiddenWildChains = new Map<string, number>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const NATURES = [
    'さみしがり', 'いじっぱり', 'やんちゃ', 'ゆうかん', 'ずぶとい', 'わんぱく', 'のうてんき', 'のんき', 'ひかえめ', 'おっとり', 'うっかりや', 'れいせい', 'おだやか', 'おとなしい', 'しんちょう', 'なまいき', 'おくびょう', 'せっかち', 'ようき', 'むじゃき', 'てれや', 'がんばりや', 'すなお', 'きまぐれ', 'まじめ'
];

const NATURE_EFFECTS: Record<string, [number, number] | null> = {
    'さみしがり': [1, 2], 'いじっぱり': [1, 3], 'やんちゃ': [1, 4], 'ゆうかん': [1, 5], 'ずぶとい': [2, 1], 'わんぱく': [2, 3], 'のうてんき': [2, 4], 'のんき': [2, 5], 'ひかえめ': [3, 1], 'おっとり': [3, 2], 'うっかりや': [3, 4], 'れいせい': [3, 5], 'おだやか': [4, 1], 'おとなしい': [4, 2], 'しんちょう': [4, 3], 'なまいき': [4, 5], 'おくびょう': [5, 1], 'せっかち': [5, 2], 'ようき': [5, 3], 'むじゃき': [5, 4], 'てれや': null, 'がんばりや': null, 'すなお': null, 'きまぐれ': null, 'まじめ': null
};

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
    if (level <= 1) return 0;
    switch (rate) {
        case 'fast': return Math.floor(4 * Math.pow(level, 3) / 5);
        case 'medium': return Math.floor(Math.pow(level, 3));
        case 'medium-slow': return Math.floor((1.2 * Math.pow(level, 3)) - (15 * Math.pow(level, 2)) + (100 * level) - 140);
        case 'slow': return Math.floor(5 * Math.pow(level, 3) / 4);
        case 'slow-then-very-fast': 
            if (level <= 50) return Math.floor(Math.pow(level, 3) * (100 - level) / 50);
            if (level <= 68) return Math.floor(Math.pow(level, 3) * (150 - level) / 100);
            if (level <= 98) return Math.floor(Math.pow(level, 3) * Math.floor((1911 - 10 * level) / 3) / 500);
            return Math.floor(Math.pow(level, 3) * (160 - level) / 100);
        case 'fast-then-very-slow': 
            if (level <= 15) return Math.floor(Math.pow(level, 3) * (Math.floor((level + 1) / 3) + 24) / 50);
            if (level <= 36) return Math.floor(Math.pow(level, 3) * (level + 14) / 50);
            return Math.floor(Math.pow(level, 3) * (Math.floor(level / 2) + 32) / 50);
        default: return Math.floor(Math.pow(level, 3));
    }
}

function applyNature(stat: number, typeIndex: number, natureName: string): number {
    const effect = NATURE_EFFECTS[natureName];
    if (!effect) return stat;
    if (effect[0] === typeIndex) return Math.floor(stat * 1.1);
    if (effect[1] === typeIndex) return Math.floor(stat * 0.9);
    return stat;
}

function getStageMult(stage: number): number {
    const s = Math.max(-6, Math.min(6, stage));
    return Math.max(2, 2 + s) / Math.max(2, 2 - s);
}

interface BattleMove { name: string; power: number; type: string; damageClass?: string; accuracy?: number; pp?: number; maxPp?: number; ailment?: string | null; statChanges?: {stat: string, change: number}[]; healing?: number; target?: string; ailmentChance?: number; statChance?: number; }
interface BattlePokemon {
    dbId: string; pokedexId: number; nickname: string; level: number;
    hp: number; maxHp: number; atk: number; def: number; spa: number; spd: number; speed: number;
    imageUrl: string; moves: BattleMove[]; types: string[]; exp: number;
    nature: string; captureRate?: number; isLegendary?: boolean; wildIvs?: any; 
    evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number; }; 
    status: string | null; 
    statusTurns: number; 
    confusionTurns: number; 
    statStages: { atk: number; def: number; spa: number; spd: number; spe: number; };
    ability: string; 
    heldItem: string | null; 
}

interface Player { id: string; name: string; party: BattlePokemon[]; activeIndex: number; }
interface BattleState {
    id: string; p1: Player; p2: Player; currentTurnUserId: string; log: string; 
    battleType: 'pvp' | 'wild' | 'gym';
    gymData?: any;
    pendingNextNpcIdx?: number;
    isProcessing?: boolean;
    nextTurnAfterSwitchUserId?: string;
}

async function saveAllHPs(battle: BattleState) {
    if (battle.battleType === 'pvp') return;
    const promises: any[] = [];
    battle.p1.party.forEach(p => { 
        promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.hp, status_condition: p.status }).eq('id', p.dbId)); 
    });
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

async function calculateDamage(attacker: BattlePokemon, defender: BattlePokemon, move: BattleMove) {
    if (move.power === 0) return { damage: 0, log: '' };

    const ignoreAbility = attacker.ability === 'かたやぶり';
    let movePower = move.power;

    if (attacker.ability === 'テクニシャン' && movePower <= 60) movePower = Math.floor(movePower * 1.5);

    let mult = getTypeMultiplier(move.type, defender.types);

    if (!ignoreAbility) {
        if (defender.ability === 'ふゆう' && move.type === 'ground') return { damage: 0, log: `🎈 **${defender.nickname}** は ふゆう で 地面にいない！\n` };
        if (defender.ability === 'もらいび' && move.type === 'fire') return { damage: 0, log: `🔥 **${defender.nickname}** は もらいび で 炎を 無効化した！\n` };
        if (defender.ability === 'ふしぎなまもり' && mult <= 1) return { damage: 0, log: `🛡️ ふしぎなまもり で 効果がない！\n` };

        if (defender.ability === 'あついしぼう' && (move.type === 'fire' || move.type === 'ice')) mult *= 0.5;
        if (defender.ability === 'マルチスケイル' && defender.hp === defender.maxHp) mult *= 0.5;
        if ((defender.ability === 'ハードロック' || defender.ability === 'フィルター') && mult > 1) mult *= 0.75;
    }

    if (attacker.types.includes(move.type)) {
        mult *= (attacker.ability === 'てきおうりょく') ? 2.0 : 1.5;
    }

    const isSpecial = move.damageClass === 'special';
    
    let atkStage = (defender.ability === 'てんねん') ? 0 : attacker.statStages[isSpecial ? 'spa' : 'atk'];
    let defStage = (attacker.ability === 'てんねん') ? 0 : defender.statStages[isSpecial ? 'spd' : 'def'];

    let attackStat = isSpecial ? (attacker.spa * getStageMult(atkStage)) : (attacker.atk * getStageMult(atkStage));
    let defenseStat = isSpecial ? (defender.spd * getStageMult(defStage)) : (defender.def * getStageMult(defStage));

    // 👇 ここから追加！ 👇

    // 🌑 ダークオーラ (悪技の威力1.33倍)
    if (move.type === 'dark' && (attacker.ability === 'ダークオーラ' || defender.ability === 'ダークオーラ')) {
        mult *= 1.33;
    }

    // 💥 わざわい系 (四凶) 特性
    // 相手が「おふだ(攻撃↓)」「うつわ(特攻↓)」を持っていると、自分の攻撃/特攻が下がる
    if (defender.ability === 'わざわいのおふだ' && !isSpecial) attackStat = Math.floor(attackStat * 0.75);
    if (defender.ability === 'わざわいのうつわ' && isSpecial) attackStat = Math.floor(attackStat * 0.75);
    
    // 自分が「つるぎ(防御↓)」「たま(特防↓)」を持っていると、相手の防御/特防が下がる
    if (attacker.ability === 'わざわいのつるぎ' && !isSpecial) defenseStat = Math.floor(defenseStat * 0.75);
    if (attacker.ability === 'わざわいのたま' && isSpecial) defenseStat = Math.floor(defenseStat * 0.75);


    if ((attacker.ability === 'ちからもち' || attacker.ability === 'ヨガパワー') && !isSpecial) attackStat *= 2;

    // ⚡ ハドロンエンジン (ミライドン)
    // エレキフィールドを展開する（簡易再現：自身の特攻が1.33倍 ＋ でんき技の威力が1.3倍！）
    if (attacker.ability === 'ハドロンエンジン') {
        if (isSpecial) attackStat = Math.floor(attackStat * 1.33);
        if (move.type === 'electric') mult *= 1.3;
    }

    // 🛡️ マルチスケイル (カイリュー/海流)
    // 自身のHPがMAX（満タン）のとき、受けるダメージを強制的に「半減」する！
    if (defender.ability === 'マルチスケイル' && defender.hp === defender.maxHp) {
        mult *= 0.5;
    }

    // 👆 ここまで追加！ 👆
    if (attacker.heldItem === 'choice_band' && !isSpecial) attackStat = Math.floor(attackStat * 1.5);

    if (attacker.status === 'burn' && !isSpecial && attacker.ability !== 'こんじょう') {
        attackStat *= 0.5; 
    }

    if (attacker.ability === 'こんじょう' && attacker.status && !isSpecial) attackStat *= 1.5;

    const isCritical = Math.random() < (1 / 24);
    const critMult = isCritical ? (attacker.ability === 'スナイパー' ? 2.25 : 1.5) : 1.0;

    const random = (Math.floor(Math.random() * 16) + 85) / 100; 
    let baseDamage = Math.floor(Math.floor(Math.floor(2 * attacker.level / 5 + 2) * movePower * attackStat / defenseStat) / 50) + 2;
    let damage = Math.floor(baseDamage * mult * critMult * random);

    if (attacker.heldItem === 'life_orb') damage = Math.floor(damage * 1.3);
    
    if (damage < 1 && mult !== 0 && move.power > 0) damage = 1;

    let log = '';
    if (isCritical) log += '💥 **急所に当たった！**\n';
    if (getTypeMultiplier(move.type, defender.types) > 1) log += '🌟 **こうかばつぐんだ！**\n';
    if (getTypeMultiplier(move.type, defender.types) < 1 && mult !== 0) log += '📉 こうかはいまひとつのようだ…\n';
    if (mult === 0) log += '❌ こうかがないみたいだ…\n';

    return { damage, log };
}

const STATUS_MAP: Record<string, string> = {
    'paralysis': '⚡まひ', 'sleep': '💤ねむり', 'freeze': '❄️こおり', 'burn': '🔥やけど', 'poison': '☠️どく', 'bad_poison': '☠️もうどく'
};

export async function executeMoveEffects(attacker: BattlePokemon, defender: BattlePokemon, move: BattleMove) {
    let log = ``;
    let effectApplied = false;

    const isSelfTarget = move.target === 'user' || (move.healing && move.healing > 0);
    const ignoreAbility = attacker.ability === 'かたやぶり';

    if (!isSelfTarget) {
        const typeMult = getTypeMultiplier(move.type, defender.types);
        if (typeMult === 0 && move.name !== 'わるあがき') {
            return `❌ **${defender.nickname}** には 効果がないみたいだ…\n`;
        }

        if (!ignoreAbility) {
            if ((defender.ability === 'ちょすい' && move.type === 'water') ||
                (defender.ability === 'ちくでん' && move.type === 'electric') ||
                (defender.ability === 'そうしょく' && move.type === 'grass')) {
                
                log += `✨ **${defender.nickname}** は 特性「${defender.ability}」で 技を無効化し、`;
                if (defender.ability === 'そうしょく') {
                    defender.statStages.atk = Math.min(6, defender.statStages.atk + 1);
                    log += `攻撃が 上がった！\n`;
                } else {
                    const healAmt = Math.floor(defender.maxHp / 4);
                    defender.hp = Math.min(defender.maxHp, defender.hp + healAmt);
                    log += `体力を 回復した！\n`;
                }
                return log;
            }
        }
    }

    if (move.power > 0) {
        if (!ignoreAbility && defender.ability === 'ばけのかわ') {
            log += `👻 **${defender.nickname}** の ばけのかわ が 身代わりになった！\n`;
            defender.ability = 'ばけのかわ(はがれた)';
            const recoil = Math.max(1, Math.floor(defender.maxHp / 8));
            defender.hp = Math.max(0, defender.hp - recoil);
            log += `💥 ばけのかわ が はがれて **${recoil}** ダメージ！\n`;
            effectApplied = true;
        } else {
            const dmgRes = await calculateDamage(attacker, defender, move);
            
            if (dmgRes.damage === 0 && (dmgRes.log.includes('🎈') || dmgRes.log.includes('🔥') || dmgRes.log.includes('🛡️'))) {
                log += dmgRes.log;
            } else {
                let finalDmg = dmgRes.damage;
                if (!ignoreAbility && defender.ability === 'がんじょう' && defender.hp === defender.maxHp && finalDmg >= defender.hp) {
                    finalDmg = defender.hp - 1;
                    log += `${dmgRes.log}💥 **${finalDmg}** ダメージ！\n🛡️ **${defender.nickname}** は がんじょう で 持ちこたえた！\n`;
// --- src/battleLogic.ts の 180行目付近 ---
// `defender.hp = Math.max(0, defender.hp - finalDmg);` の直後に追加します。

                } else {
                    log += `${dmgRes.log}💥 **${finalDmg}** ダメージ！\n`;
                }
                defender.hp = Math.max(0, defender.hp - finalDmg);
                effectApplied = true;

                // 👇 ここから追加！ 👇
                // 🌟 ビーストブーストの発動判定
                if (defender.hp === 0 && attacker.ability === 'ビーストブースト') {
                    const stats = [
                        { name: 'atk', val: attacker.atk }, { name: 'def', val: attacker.def },
                        { name: 'spa', val: attacker.spa }, { name: 'spd', val: attacker.spd }, { name: 'spe', val: attacker.speed }
                    ];
                    stats.sort((a, b) => b.val - a.val);
                    const highest = stats[0].name;
                    
                    const currentStage = attacker.statStages[highest as keyof typeof attacker.statStages];
                    if (currentStage < 6) {
                        attacker.statStages[highest as keyof typeof attacker.statStages]++;
                        const jpStatName: Record<string, string> = { 'atk': 'こうげき', 'def': 'ぼうぎょ', 'spa': 'とくこう', 'spd': 'とくぼう', 'spe': 'すばやさ' };
                        log += `👽 **${attacker.nickname}** の ビーストブースト！\n📈 一番高い ${jpStatName[highest]} が 上がった！\n`;
                    }
                }
                // 👆 ここまで追加！ 👆
            }
        }
    }
    
    if (move.healing && move.healing > 0) {
        const healAmount = Math.floor(attacker.maxHp * (move.healing / 100));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmount);
        log += `✨ 体力が 回復した！\n`;
        effectApplied = true;
    }
    
    // 🌟 ステータス変化（能力アップ・ダウン）の確率チェック
    if (move.statChanges && move.statChanges.length > 0) {
        let chance = 100;
        if (move.statChance === undefined || move.statChance === null) {
            chance = move.power === 0 ? 100 : 10; // 昔のデータ用
        } else if (move.statChance === 0) {
            chance = 100; // 🌟 PokeAPIの仕様: 0は「100%発動」を意味する
        } else {
            chance = move.statChance;
        }
        
        if (Math.random() * 100 <= chance) {
            const statNameMap: Record<string, string> = { 'attack': 'atk', 'defense': 'def', 'special-attack': 'spa', 'special-defense': 'spd', 'speed': 'spe' };
            const jpStatName: Record<string, string> = { 'atk': 'こうげき', 'def': 'ぼうぎょ', 'spa': 'とくこう', 'spd': 'とくぼう', 'spe': 'すばやさ' };
            for (const sc of move.statChanges) {
                const sKey = statNameMap[sc.stat];
                if (sKey) {
                    const targetPoke = move.target === 'user' ? attacker : defender;
                    const currentStage = targetPoke.statStages[sKey as keyof typeof targetPoke.statStages];
                    if (sc.change > 0 && currentStage >= 6) { log += `💨 **${targetPoke.nickname}** の ${jpStatName[sKey]} は もう 上がらない！\n`; continue; }
                    else if (sc.change < 0 && currentStage <= -6) { log += `💨 **${targetPoke.nickname}** の ${jpStatName[sKey]} は もう 下がらない！\n`; continue; }

                    const newStage = Math.max(-6, Math.min(6, currentStage + sc.change));
                    const actualChange = newStage - currentStage;
                    targetPoke.statStages[sKey as keyof typeof targetPoke.statStages] = newStage;

                    let updownStr = actualChange === 1 ? '上がった！' : actualChange === 2 ? 'ぐーんと 上がった！' : actualChange >= 3 ? 'ぐぐーんと 上がった！' : actualChange === -1 ? '下がった！' : actualChange === -2 ? 'がくっと 下がった！' : 'がくーんと 下がった！';
                    log += `📈 **${targetPoke.nickname}** の ${jpStatName[sKey]}が ${updownStr}\n`;
                    effectApplied = true;
                }
            }
        }
    }
    // 🌟 状態異常（マヒ・やけど・どくなど）の確率チェック
    if (move.ailment && move.ailment !== 'none') {
        let chance = 100;
        if (move.ailmentChance === undefined || move.ailmentChance === null) {
            chance = move.power === 0 ? 100 : 10; // 昔のデータ用
        } else if (move.ailmentChance === 0) {
            chance = 100; // 🌟 PokeAPIの仕様: 0は「100%発動」を意味する
        } else {
            chance = move.ailmentChance;
        }

        if (Math.random() * 100 <= chance) {
            const validAilments = ['paralysis', 'sleep', 'freeze', 'burn', 'poison'];
            const ailmentName = move.ailment === 'toxic' ? 'bad_poison' : move.ailment;

            if (validAilments.includes(ailmentName) || ailmentName === 'bad_poison') {
                let immuneLog = '';
                if (!ignoreAbility) {
                    if (defender.ability === 'めんえき' && (ailmentName === 'poison' || ailmentName === 'bad_poison')) immuneLog = `🛡️ 特性「めんえき」で 毒をふせいだ！\n`;
                    if (defender.ability === 'じゅうなん' && ailmentName === 'paralysis') immuneLog = `🛡️ 特性「じゅうなん」で マヒをふせいだ！\n`;
                    if (defender.ability === 'みずのベール' && ailmentName === 'burn') immuneLog = `🛡️ 特性「みずのベール」で やけどをふせいだ！\n`;
                    if (defender.ability === 'ふみん' && ailmentName === 'sleep') immuneLog = `🛡️ 特性「ふみん」で 眠りをふせいだ！\n`;
                    if (defender.ability === 'マグマのよろい' && ailmentName === 'freeze') immuneLog = `🛡️ 特性「マグマのよろい」で こおりをふせいだ！\n`;
                }

                if (immuneLog) {
                    log += immuneLog;
                    effectApplied = true;
                } else if (!defender.status) {
                    defender.status = ailmentName;
                    if (ailmentName === 'sleep') defender.statusTurns = Math.floor(Math.random() * 3) + 1; 
                    else if (ailmentName === 'bad_poison') defender.statusTurns = 1; 
                    log += `⚠️ **${defender.nickname}** は **${STATUS_MAP[ailmentName]}** になった！\n`;
                    effectApplied = true;
                } else {
                    log += `💨 **${defender.nickname}** は すでに 状態異常だ！\n`;
                }
            } else if (ailmentName === 'confusion') {
                if (!ignoreAbility && defender.ability === 'マイペース') {
                    log += `🛡️ **${defender.nickname}** は マイペースで こんらんを防いだ！\n`;
                    effectApplied = true;
                } else if (defender.confusionTurns <= 0) {
                    defender.confusionTurns = Math.floor(Math.random() * 4) + 2;
                    log += `💫 **${defender.nickname}** は こんらんした！\n`;
                    effectApplied = true;
                } else {
                    log += `💨 **${defender.nickname}** は すでに こんらんしている！\n`;
                }
            }
        }
    }

    if (log === '') {
        if (move.name === 'はねる') log += `しかし なにも おこらない！\n`;
        else log += `しかし うまく きまらなかった！\n`;
    }

    if (attacker.heldItem === 'life_orb' && effectApplied && move.power > 0) {
        const recoil = Math.max(1, Math.floor(attacker.maxHp / 10));
        attacker.hp = Math.max(0, attacker.hp - recoil);
        log += `💥 **${attacker.nickname}** は いのちのたまで 少しダメージを受けた！\n`;
    }

    if (attacker.heldItem === 'leftovers' && attacker.hp > 0 && attacker.hp < attacker.maxHp) {
        const healAmt = Math.max(1, Math.floor(attacker.maxHp / 16));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
        log += `🍎 **${attacker.nickname}** は たべのこしで 少し回復した！\n`;
    }

    return log;
}


export async function buildBattlePokemon(dbPoke: any, forcedLevel?: number): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const speciesRes = await fetch(data.species.url);
    const speciesData = await speciesRes.json();
    const growthRate = speciesData.growth_rate.name;

    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const originalLevel = dbPoke.level;
    const lv = forcedLevel || originalLevel; 
    const nature = dbPoke.nature || 'まじめ';

    let safeMoves = dbPoke.moves;
    if (typeof safeMoves === 'string') { try { safeMoves = JSON.parse(safeMoves); } catch (e) { safeMoves = []; } }

    let needsMoveUpdate = false;
    if (!Array.isArray(safeMoves) || safeMoves.length === 0 || (safeMoves.length === 1 && safeMoves[0].name === 'わるあがき')) {
        safeMoves = await getMovesForLevel(data, originalLevel); 
        if (!safeMoves || safeMoves.length === 0) safeMoves = [{ name: 'たいあたり', power: 40, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 35, maxPp: 35 }];
        needsMoveUpdate = true;
    }

    for (const m of safeMoves) {
        if (m.pp === undefined) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; needsMoveUpdate = true; }
    }

    let safeTypes = dbPoke.types;
    if (typeof safeTypes === 'string') { try { safeTypes = JSON.parse(safeTypes); } catch (e) { safeTypes = []; } }

    let currentExp = dbPoke.exp || 0;
    const requiredExp = getRequiredExp(originalLevel, growthRate);
    if (currentExp < requiredExp) { currentExp = requiredExp; needsMoveUpdate = true; }

    if (needsMoveUpdate && !forcedLevel) { 
        supabase.from('poke_caught_pokemons').update({ moves: safeMoves, exp: currentExp }).eq('id', dbPoke.id).then(); 
    }

    const evs = { hp: dbPoke.ev_hp||0, atk: dbPoke.ev_attack||0, def: dbPoke.ev_defense||0, spa: dbPoke.ev_sp_atk||0, spd: dbPoke.ev_sp_def||0, spe: dbPoke.ev_speed||0 };
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp + Math.floor((dbPoke.ev_hp||0) / 4)) * lv) / 100) + lv + 10;
    const currentHp = forcedLevel ? maxHp : (dbPoke.current_hp !== undefined ? Math.min(dbPoke.current_hp, maxHp) : maxHp);

    let currentAbility = dbPoke.ability;
    const heldItem = dbPoke.held_item || null;
    
    // 🌟 画像URLの初期値を設定
    let pokemonImageUrl = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;

    // 🌟 ザシアン ＋ くちたけん（けんのおう フォルムチェンジ！）
    if (heldItem === 'rusted_sword' && dbPoke.pokedex_id === 888) {
        safeTypes = ['fairy', 'steel']; 
        base['attack'] += 40; 
        base['speed'] += 10; 

        // 🌟 画像も「けんのおう」のものに差し替える (PokeAPIの10188番が該当)
        pokemonImageUrl = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/10188.png";
        
        const ironHeadIdx = safeMoves.findIndex((m: any) => m.name === 'アイアンヘッド');
        if (ironHeadIdx !== -1) {
            safeMoves[ironHeadIdx] = { name: 'きょじゅうざん', power: 100, type: 'steel', damageClass: 'physical', accuracy: 100, pp: 5, maxPp: 5 };
        } else {
            safeMoves[0] = { name: 'きょじゅうざん', power: 100, type: 'steel', damageClass: 'physical', accuracy: 100, pp: 5, maxPp: 5 };
        }
        
        // フォルムチェンジ時は特性も「ふとうのけん」に固定（任意）
        currentAbility = 'ふとうのけん';
    }
    if (!currentAbility || currentAbility === 'なし') {
        const abilityOptions = data.abilities.filter((a: any) => !a.is_hidden);
        const selectedAbilityInfo = abilityOptions.length > 0 ? abilityOptions[Math.floor(Math.random() * abilityOptions.length)].ability : data.abilities[0].ability;
        const abilityRes = await fetch(selectedAbilityInfo.url).then(r => r.json());
        currentAbility = abilityRes.names.find((n: any) => n.language.name === 'ja')?.name || selectedAbilityInfo.name;
        await supabase.from('poke_caught_pokemons').update({ ability: currentAbility }).eq('id', dbPoke.id);
    }

    // 🌟 一旦すべてのステータスを計算して変数に格納する
    let atkStat = applyNature(Math.floor(((2 * base['attack'] + dbPoke.iv_attack + Math.floor(evs.atk / 4)) * lv) / 100) + 5, 1, nature);
    let defStat = applyNature(Math.floor(((2 * base['defense'] + dbPoke.iv_defense + Math.floor(evs.def / 4)) * lv) / 100) + 5, 2, nature);
    let spaStat = applyNature(Math.floor(((2 * base['special-attack'] + (dbPoke.iv_sp_atk || 0) + Math.floor(evs.spa / 4)) * lv) / 100) + 5, 3, nature);
    let spdStat = applyNature(Math.floor(((2 * base['special-defense'] + (dbPoke.iv_sp_def || 0) + Math.floor(evs.spd / 4)) * lv) / 100) + 5, 4, nature);
    let speStat = applyNature(Math.floor(((2 * base['speed'] + dbPoke.iv_speed + Math.floor(evs.spe / 4)) * lv) / 100) + 5, 5, nature);

// --- src/battleLogic.ts の 300行目付近 ---
// 変更前: if (heldItem === 'booster_energy') {
// 👇 以下のように書き換えてください

    // ⚡ ブーストエナジー、こだいかっせい、クォークチャージ の処理
    if (heldItem === 'booster_energy' || currentAbility === 'こだいかっせい' || currentAbility === 'クォークチャージ') {
        const stats = [
            { name: 'atk', val: atkStat, mult: 1.3 },
            { name: 'def', val: defStat, mult: 1.3 },
            { name: 'spa', val: spaStat, mult: 1.3 },
            { name: 'spd', val: spdStat, mult: 1.3 },
            { name: 'spe', val: speStat, mult: 1.5 } // 素早さだけ1.5倍
        ];
        // 数値が高い順に並び替え
        stats.sort((a, b) => b.val - a.val);
        const highest = stats[0];
        
        // 一番高いステータスに倍率をかける
        if (highest.name === 'atk') atkStat = Math.floor(atkStat * highest.mult);
        else if (highest.name === 'def') defStat = Math.floor(defStat * highest.mult);
        else if (highest.name === 'spa') spaStat = Math.floor(spaStat * highest.mult);
        else if (highest.name === 'spd') spdStat = Math.floor(spdStat * highest.mult);
        else if (highest.name === 'spe') speStat = Math.floor(speStat * highest.mult);
    }

    // 🌟 計算済みのステータスを return する
    return {
        dbId: dbPoke.id, pokedexId: dbPoke.pokedex_id, nickname: dbPoke.nickname, level: lv,
        hp: currentHp, maxHp: maxHp,
        atk: atkStat, 
        def: defStat, 
        spa: spaStat, 
        spd: spdStat, 
        speed: speStat,
        imageUrl: pokemonImageUrl, // 🌟 差し替えたURLを使用
        moves: safeMoves, types: safeTypes, exp: currentExp, status: forcedLevel ? null : (dbPoke.status_condition || null),
        nature: nature, captureRate: dbPoke.captureRate, wildIvs: dbPoke.wildIvs, evs: evs,
        statusTurns: 0, confusionTurns: 0, 
        // 🌟 特性「ふとうのけん」なら、バトル開始時から攻撃を1段階アップ！
        statStages: { 
            atk: (currentAbility === 'ふとうのけん' ? 1 : 0), 
            def: 0, spa: 0, spd: 0, spe: 0 
        },
        ability: currentAbility,
        heldItem: heldItem
    };
}


export function checkStatusBeforeMove(poke: BattlePokemon): { canMove: boolean, log: string, selfDamage: number } {
    let log = '';
    let canMove = true;
    let selfDamage = 0;

    if (poke.status === 'sleep') {
        if (poke.statusTurns <= 0) { 
            poke.status = null; log += `\n💤 **${poke.nickname}** は 目を覚ました！\n`; 
        } else {
            poke.statusTurns--; return { canMove: false, log: `\n💤 **${poke.nickname}** は ぐうぐう 眠っている…\n`, selfDamage: 0 };
        }
    } else if (poke.status === 'freeze') {
        if (Math.random() < 0.20) { 
            poke.status = null; log += `\n❄️ **${poke.nickname}** の こおりが とけた！\n`; 
        } else {
            return { canMove: false, log: `\n❄️ **${poke.nickname}** は こおってしまって 動けない！\n`, selfDamage: 0 };
        }
    } else if (poke.status === 'paralysis') {
        if (Math.random() < 0.25) { 
            return { canMove: false, log: `\n⚡ **${poke.nickname}** は 体が しびれて 動けない！\n`, selfDamage: 0 };
        }
    }

    if (poke.confusionTurns > 0) {
        poke.confusionTurns--;
        log += `\n💫 **${poke.nickname}** は こんらんしている！\n`;
        if (poke.confusionTurns <= 0) {
            log += `💫 **${poke.nickname}** の こんらんが とけた！\n`;
        } else if (Math.random() < 0.33) { 
            canMove = false;
            const attackStat = poke.atk * getStageMult(poke.statStages.atk);
            const defenseStat = poke.def * getStageMult(poke.statStages.def);
            let baseDamage = Math.floor(Math.floor(Math.floor(2 * poke.level / 5 + 2) * 40 * attackStat / defenseStat) / 50) + 2;
            selfDamage = Math.floor(baseDamage * (0.85 + Math.random() * 0.15));
            log += `💥 わけも わからず 自分を 攻撃した！\n`;
        }
    }

    return { canMove, log, selfDamage };
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
            Promise.all(p1Data.map(p => buildBattlePokemon(p, 50))),
            Promise.all(p2Data.map(p => buildBattlePokemon(p, 50))) 
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

    if (wildLevel === undefined) {
        if (isLegendary) {
            if (Math.random() < 0.05) wildLevel = Math.floor(Math.random() * 10) + 1; 
            else wildLevel = Math.floor(Math.random() * 31) + 50; 
        } else {
            let maxWildLevel = 12; 
            if (badges.includes('👑 殿堂入り')) maxWildLevel = 70; 
            else if (badges.includes('🐉 竜の紋章')) maxWildLevel = 65;
            else if (badges.includes('👻 霊の紋章')) maxWildLevel = 60;
            else if (badges.includes('👊 闘の紋章')) maxWildLevel = 55;
            else if (badges.includes('❄️ 氷の紋章')) maxWildLevel = 50;
            else if (badges.includes('🌿 グリーンバッジ')) maxWildLevel = 45; 
            else if (badges.includes('🔥 クリムゾンバッジ')) maxWildLevel = 42; 
            else if (badges.includes('🟡 ゴールドバッジ')) maxWildLevel = 38; 
            else if (badges.includes('💖 ピンクバッジ')) maxWildLevel = 34; 
            else if (badges.includes('🌈 レインボーバッジ')) maxWildLevel = 29; 
            else if (badges.includes('⚡ オレンジバッジ')) maxWildLevel = 24; 
            else if (badges.includes('💧 ブルーバッジ')) maxWildLevel = 19; 
            else if (badges.includes('🪨 グレーバッジ')) maxWildLevel = 15;

            const effectiveBase = Math.min(baseLevel, maxWildLevel);
            const randomRoll = Math.random();
            if (randomRoll < 0.20) {
                wildLevel = Math.floor(Math.random() * 14) + 2; 
            } else if (randomRoll < 0.30) {
                wildLevel = effectiveBase + Math.floor(Math.random() * 8) + 5; 
            } else {
                wildLevel = Math.max(1, effectiveBase + Math.floor(Math.random() * 7) - 3);
            }
            wildLevel = Math.min(wildLevel, maxWildLevel + 5);
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
            if (minLevel && wildLevel! >= minLevel) {
                targetSpeciesName = nextStage.species.name;
                currentStage = nextStage;
                evolved = true;
                break;
            }
        }
        if (!evolved) break;
    }

    const finalRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${targetSpeciesName}`);
    
    if (finalRes.ok) {
        data = await finalRes.json();
        pokeId = data.id;
        const finalSpeciesRes = await fetch(data.species.url);
        speciesData = await finalSpeciesRes.json();
    }
    
    return { pokeId, data, speciesData, wildLevel: wildLevel! };
}

const tutorialLocks = new Set<string>();

export async function startWildBattle(interaction: ChatInputCommandInteraction, userId: string, area: string | null) {
    if (tutorialLocks.has(userId)) return interaction.editReply('⚠️ 処理中です。');

    try {
        let { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true });
        
        if (p1Data && p1Data.length > 6) {
            const overflowIds = p1Data.slice(6).map(p => p.id);
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
            p1Data = p1Data.slice(0, 6);
        }

        if (!p1Data || p1Data.length === 0) {
            tutorialLocks.add(userId); 
            try {
                await supabase.from('poke_users').upsert([{ discord_id: userId, money: 3000 }], { onConflict: 'discord_id', ignoreDuplicates: true });
                const { data: invCheck } = await supabase.from('poke_inventory').select('id').eq('user_id', userId).limit(1);
                if (!invCheck || invCheck.length === 0) { 
                    await supabase.from('poke_inventory').insert([
                        { user_id: userId, item_id: 'monster_ball', quantity: 5 },
                        { user_id: userId, item_id: 'potion', quantity: 5 }
                    ]);
                }

                const { pokeId, data, speciesData, wildLevel } = await getValidWildPokemon(area, 5, [], 5);
                const level = wildLevel;
                const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();
                const imageUrl = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;

                const embed = new EmbedBuilder()
                    .setTitle(`あ！ やせいの **${jaName}** が とびだしてきた！`)
                    .setDescription(`...しかし、あなたは戦うためのポケモンを1匹も持っていない！\n\nなんと！ **${jaName}** は こちらに 興味を持っているようだ！\nそのまま 仲間になった！🎉`)
                    .setImage(imageUrl).setColor(0x00FF00);

                const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
                const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
                const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);
                const baseHp = data.stats.find((s:any) => s.stat.name === 'hp').base_stat;
                const maxHp = Math.floor(((2 * baseHp + iv_hp) * level) / 100) + level + 10;
                const moves = await getMovesForLevel(data, level);
                for (const m of moves) { m.maxPp = m.power >= 100 ? 5 : m.power >= 80 ? 10 : m.power >= 60 ? 15 : 20; m.pp = m.maxPp; }

                const { data: inserted } = await supabase.from('poke_caught_pokemons').insert([{
                    owner_id: userId, original_trainer_id: userId, pokedex_id: pokeId, nickname: jaName, level: level, exp: 0, 
                    nature: wildNature, iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed, current_hp: maxHp, 
                    types: data.types.map((t: any) => t.type.name), moves: moves,
                    is_party: true, party_order: 1, ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0
                }]).select('id').single();

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`nickbtn_${inserted?.id}`).setLabel('ニックネームをつける').setStyle(ButtonStyle.Primary).setEmoji('🏷️'));
                await interaction.editReply({ content: '初めてのポケモンをゲットしました！', embeds: [embed], components: [row] });
                tutorialLocks.delete(userId); 
                return;
            } catch (err) { tutorialLocks.delete(userId); return interaction.editReply('エラーが発生しました。'); }
        }

        const p1Party = await Promise.all(p1Data.map(p => buildBattlePokemon(p)));
        const baseLevel = p1Party[0].level;

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

        const abilityOptions = data.abilities.filter((a: any) => !a.is_hidden); 
        const selectedAbilityInfo = abilityOptions.length > 0 ? abilityOptions[Math.floor(Math.random() * abilityOptions.length)].ability : data.abilities[0].ability;
        const abilityRes = await fetch(selectedAbilityInfo.url).then(r => r.json());
        const wildAbility = abilityRes.names.find((n: any) => n.language.name === 'ja')?.name || selectedAbilityInfo.name;

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
            isLegendary: speciesData.is_legendary || speciesData.is_mythical || false,
            wildIvs: { iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed },
            evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
            status: null, statusTurns: 0, confusionTurns: 0, statStages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
            ability: wildAbility,
            heldItem: null
        };

        const p1Active = p1Party.findIndex(p => p.hp > 0);
        const battle: BattleState = {
            id: interaction.id, 
            p1: { id: userId, name: 'あなた', party: p1Party, activeIndex: p1Active !== -1 ? p1Active : 0 },
            p2: { id: 'wild', name: '野生', party: [wildPoke], activeIndex: 0 },
            currentTurnUserId: userId,
            log: `あ！ やせいの **${jaName}** が とびだしてきた！\n(性格: ${wildNature})`,
            battleType: 'wild'
        };

        activeBattles.set(battle.id, battle);
        await updateBattleMessage(interaction as any, battle.id);
    } catch (e) { console.error(e); await interaction.editReply('エラーが発生しました。'); }
}

async function processWildVictory(battle: BattleState, interaction: MessageComponentInteraction, battleId: string) {
    const attacker = battle.p1;
    const defPoke = battle.p2.party[battle.p2.activeIndex];
    
    try {
        let victoryLog = `\n🏆 **${battle.battleType === 'gym' ? '相手の' : 'やせいの'} ${defPoke.nickname} を たおした！**`;

        const defPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${defPoke.pokedexId}`).then(r => r.json());
        const baseExp = defPokeRes.base_experience || 50;

        const currentChain = (hiddenWildChains.get(attacker.id) || 0);
        hiddenWildChains.set(attacker.id, currentChain + 1);
        
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

            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${p.pokedexId}`).then(r => r.json());
            const speciesRes = await fetch(pokeRes.species.url).then(r => r.json());
            const growthRate = speciesRes.growth_rate.name;

            let leveledUp = false;
            const startLevel = currentLevel; 

            while (currentLevel < 100 && currentExp >= getRequiredExp(currentLevel + 1, growthRate)) {
                currentLevel++;
                leveledUp = true;
            }

            if (leveledUp) {
                if (currentLevel - startLevel >= 2) {
                    levelUpText += `\n🎉 **${p.nickname}** は レベル**${currentLevel}** に 一気に上がった！`;
                } else {
                    levelUpText += `\n🎉 **${p.nickname}** は レベル**${currentLevel}** に上がった！`;
                }

                const newMoves = await getMovesForLevel(pokeRes, currentLevel);
                if (p.moves.map(m => m.name).join() !== newMoves.map(m => m.name).join()) {
                    const learned = newMoves.find(m => !p.moves.some(om => om.name === m.name));
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
    if (!battle) {
        try { await interaction.reply({ content: '無効なバトルです。', ephemeral: true }); } catch (e) {}
        return;
    }

    if (battle.isProcessing) {
        try { await interaction.reply({ content: '⏳ 現在ターンの処理中です！画面が更新されるまでお待ちください。', ephemeral: true }); } catch (e) {}
        return;
    }

    if (interaction.user.id !== battle.currentTurnUserId) {
        try { await interaction.reply({ content: '今は相手のターンです。', ephemeral: true }); } catch (e) {}
        return;
    }

    if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferUpdate(); } catch (e) { return; }
    }

    battle.isProcessing = true;

    try {
        const isP1 = interaction.user.id === battle.p1.id;
        const attacker = isP1 ? battle.p1 : battle.p2;
        const defender = isP1 ? battle.p2 : battle.p1;
        const atkPoke = attacker.party[attacker.activeIndex];
        const defPoke = defender.party[defender.activeIndex];

        if (action === 'stay' && battle.pendingNextNpcIdx !== undefined) {
            const nextIdx = battle.pendingNextNpcIdx;
            battle.p2.activeIndex = nextIdx;
            battle.pendingNextNpcIdx = undefined; 
            
            battle.log = `▶ そのまま 戦いを 続ける！\n`;
            await updateBattleMessage(interaction, battleId);
            await sleep(1000);

            battle.log += `\n🔄 **${battle.p2.name}** は **${battle.p2.party[nextIdx].nickname}** を繰り出した！\n`;
            battle.currentTurnUserId = battle.p1.id; 
            return updateBattleMessage(interaction, battleId);
        }

        if (action === 'attack') {
            const moveButtons: ButtonBuilder[] = [];
            let hasUsableMove = false;
            
            atkPoke.moves.forEach((m, i) => {
                if (m.pp === undefined) { m.pp = 15; m.maxPp = 15; }
                if (m.pp > 0) hasUsableMove = true;

                let effText = '';
                const mult = m.target === 'user' ? 1 : getTypeMultiplier(m.type, defPoke.types);
                
                if (m.power > 0) {
                    if (mult > 1) effText = 'ばつぐん';
                    else if (mult === 0) effText = 'こうかなし';
                    else if (mult < 1) effText = 'いまひとつ';
                    else effText = '通常'; 
                } else {
                    if (mult === 0) effText = 'こうかなし'; 
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
                    
                    let prizeMoney = 500 + ((newStreak - 1) * 200);
                    const hasAmuletCoin = defender.party.some(p => p.heldItem === 'amulet_coin');
                    if (hasAmuletCoin) prizeMoney *= 2;

                    await supabase.from('poke_users').update({ money: (u?.money || 0) + prizeMoney, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', defender.id);
                    await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', attacker.id);
                    battle.log += `\n💰 賞金 **${prizeMoney.toLocaleString()}円** を手に入れた！`;
                    if (hasAmuletCoin) battle.log += ` (🪙 こばんで2倍！)`;
                } catch (e) {}
            } else {
                battle.log = `💨 うまく 逃げ切れた！`;
                hiddenWildChains.delete(interaction.user.id); 
            }
            await updateBattleMessage(interaction, battleId, true);
            await saveAllHPs(battle);
            return activeBattles.delete(battleId);
        }

        if (action === 'switch') {
            const isForcedSwitch = attacker.party[attacker.activeIndex].hp <= 0;
            attacker.activeIndex = parseInt(interaction.customId.split('_')[3]);
            battle.log = `🔄 <@${attacker.id}> は **${attacker.party[attacker.activeIndex].nickname}** を繰り出した！`;
            
            attacker.party[attacker.activeIndex].confusionTurns = 0;
            if (attacker.party[attacker.activeIndex].status === 'bad_poison') {
                attacker.party[attacker.activeIndex].statusTurns = 1;
            }

            if (battle.battleType === 'pvp') {
                if (isForcedSwitch) {
                    battle.currentTurnUserId = battle.nextTurnAfterSwitchUserId || attacker.id;
                    battle.nextTurnAfterSwitchUserId = undefined;
                } else {
                    battle.currentTurnUserId = defender.id; 
                }
            }

            if (battle.pendingNextNpcIdx !== undefined) {
                const nextIdx = battle.pendingNextNpcIdx;
                battle.p2.activeIndex = nextIdx;
                battle.pendingNextNpcIdx = undefined;
                
                await updateBattleMessage(interaction, battleId); 
                await sleep(1000);
                
                battle.log += `\n🔄 **${battle.p2.name}** は **${battle.p2.party[nextIdx].nickname}** を繰り出した！\n`;
                battle.currentTurnUserId = battle.p1.id; 
                return updateBattleMessage(interaction, battleId);
            }

            if ((battle.battleType === 'wild' || battle.battleType === 'gym') && !isForcedSwitch && defPoke.hp > 0) {
                const currentAtkPoke = attacker.party[attacker.activeIndex];
                
                const statusCheck = checkStatusBeforeMove(defPoke);
                battle.log += statusCheck.log;
                
                if (!statusCheck.canMove) {
                    if (statusCheck.selfDamage > 0) {
                        defPoke.hp = Math.max(0, defPoke.hp - statusCheck.selfDamage);
                        battle.log += `💥 **${statusCheck.selfDamage}** ダメージ！\n`;
                        if (defPoke.hp <= 0) battle.log += `💀 **${defPoke.nickname}** は たおれた！\n`;
                    }
                } else {
                    const usableWildMoves = defPoke.moves.filter(m => (m.pp === undefined || m.pp > 0));
                    let wMove: BattleMove = { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 };
                    if (usableWildMoves.length > 0) {
                        const attackMoves = usableWildMoves.filter(m => m.power > 0);
                        if (attackMoves.length > 0 && Math.random() < 0.7) {
                            wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                        } else {
                            wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                        }
                    }
                    const hitChance = wMove.accuracy || 100;
                    const isHit = (Math.random() * 100) <= hitChance;

                    if (!isHit) {
                        battle.log += `\n\n◀ ${battle.battleType === 'gym' ? '相手の' : 'やせいの'} **${defPoke.nickname}** の **${wMove.name}**！\n💨 しかし **${currentAtkPoke.nickname}** には 当たらなかった！`;
                    } else {
                        battle.log += `\n\n◀ ${battle.battleType === 'gym' ? '相手の' : 'やせいの'} **${defPoke.nickname}** の **${wMove.name}**！\n`;
                        battle.log += await executeMoveEffects(defPoke, currentAtkPoke, wMove);

                        if (currentAtkPoke.hp === 0) {
                            battle.log += `\n💀 **${currentAtkPoke.nickname}** は たおれた！\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
                            const myNextIdx = attacker.party.findIndex(p => p.hp > 0);
                            if (myNextIdx === -1) {
                                battle.log += `\n\n目の前が まっくらになった……\n(${battle.battleType === 'gym' ? battle.p2.name + ' との 勝負に 負けた……' : 'やせいの ' + defPoke.nickname + ' から逃げ出した'})`;
                                hiddenWildChains.delete(battle.p1.id); 
                                await updateBattleMessage(interaction, battleId, true);
                                await saveAllHPs(battle);
                                return activeBattles.delete(battleId);
                            }
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
                    const attackMoves = usableWildMoves.filter(m => m.power > 0);
                    if (attackMoves.length > 0 && Math.random() < 0.7) {
                        wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                    } else {
                        wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                    }
                }
                const p1Speed = atkPoke.speed * (atkPoke.status === 'paralysis' ? 0.5 : 1) * getStageMult(atkPoke.statStages.spe);
                const p2Speed = defPoke.speed * (defPoke.status === 'paralysis' ? 0.5 : 1) * getStageMult(defPoke.statStages.spe);
                
                const p1First = p1Speed >= p2Speed;
                const turnOrder = p1First ? 
                    [{poke: atkPoke, target: defPoke, move: pMove, isP1: true, mIdx: moveIdx}, {poke: defPoke, target: atkPoke, move: wMove, isP1: false, mIdx: null}] :
                    [{poke: defPoke, target: atkPoke, move: wMove, isP1: false, mIdx: null}, {poke: atkPoke, target: defPoke, move: pMove, isP1: true, mIdx: moveIdx}];

                battle.log = ``; 

                for (const act of turnOrder) {
                    if (act.poke.hp <= 0) continue; 

                    const statusCheck = checkStatusBeforeMove(act.poke);
                    if (!statusCheck.canMove) {
                        battle.log += statusCheck.log;
                        if (statusCheck.selfDamage > 0) {
                            act.poke.hp = Math.max(0, act.poke.hp - statusCheck.selfDamage);
                            battle.log += `💥 **${statusCheck.selfDamage}** ダメージ！\n`;
                            if (act.poke.hp <= 0) battle.log += `💀 **${act.poke.nickname}** は たおれた！\n`;
                        }
                        await updateBattleMessage(interaction, battleId); 
                        await sleep(1500); 
                        if (act.poke.hp <= 0) break;
                        continue;
                    }
                    battle.log += statusCheck.log; 

                    if (act.isP1 && act.mIdx !== null && act.mIdx !== -1) act.poke.moves[act.mIdx].pp!--; 

                    const hitChance = act.move.accuracy || 100;
                    const isHit = (Math.random() * 100) <= hitChance;

                    if (!isHit) {
                        battle.log += `▶ **${act.poke.nickname}** の **${act.move.name}**！\n💨 しかし **${act.target.nickname}** には 当たらなかった！\n\n`;
                        await updateBattleMessage(interaction, battleId); 
                        await sleep(1500); 
                        continue;
                    }

                    battle.log += `▶ **${act.poke.nickname}** の **${act.move.name}**！\n`;
                    battle.log += await executeMoveEffects(act.poke, act.target, act.move);
                    battle.log += `\n`;
                    
                    await updateBattleMessage(interaction, battleId);
                    await sleep(1500);

                    if (act.target.hp === 0) {
                        battle.log += `💀 **${act.target.nickname}** は たおれた！\n`;
                        if (act.isP1) { 
                            if (battle.battleType === 'gym') {
                                const nextNpcIdx = battle.p2.party.findIndex(p => p.hp > 0);
                                if (nextNpcIdx === -1) {
                                    const badge = battle.gymData.badge;
                                    const { data: u } = await supabase.from('poke_users').select('badges, money').eq('discord_id', battle.p1.id).single();
                                    let badges = u?.badges || [];
                                    if (typeof badges === 'string') badges = JSON.parse(badges);
                                    
                                    const hasAmuletCoin = battle.p1.party.some(p => p.heldItem === 'amulet_coin');
                                    const moneyMultiplier = hasAmuletCoin ? 2 : 1;

                                    if (!badges.includes(badge)) {
                                        badges.push(badge);
                                        const finalReward = battle.gymData.reward * moneyMultiplier;
                                        await supabase.from('poke_users').update({ 
                                            badges: badges, 
                                            money: (u?.money || 0) + finalReward 
                                        }).eq('discord_id', battle.p1.id);
                                        
                                        battle.log += `\n🏆 **${battle.p2.name} に勝利した！**\n🎊 **${badge}** を手に入れた！\n💰 賞金 **${finalReward.toLocaleString()}円** を獲得！\n`;
                                        if (hasAmuletCoin) battle.log += ` (🪙 おまもりこばんで2倍！)\n`;

                                        if (battle.p2.id === 'gym_rock') {
                                            const { data: inv } = await supabase.from('poke_inventory').select('quantity').eq('user_id', battle.p1.id).eq('item_id', 'exp_share').single();
                                            if (!inv) {
                                                await supabase.from('poke_inventory').insert([{ user_id: battle.p1.id, item_id: 'exp_share', quantity: 1 }]);
                                                battle.log += `\n🎁 タケシから **がくしゅうそうち** をもらった！\n（手持ちのポケモン全員に経験値が入るようになるぞ！）\n`;
                                            }
                                        }
                                        
                                    } else {
                                        const repeatReward = Math.floor(battle.gymData.reward / 10) * moneyMultiplier; 
                                        
                                        await supabase.from('poke_users').update({ 
                                            money: (u?.money || 0) + repeatReward 
                                        }).eq('discord_id', battle.p1.id);
                                        battle.log += `\n🏆 **${battle.p2.name} に勝利した！**\n💰 ファイトマネー **${repeatReward.toLocaleString()}円** を獲得！\n`;
                                        if (hasAmuletCoin) battle.log += ` (🪙 おまもりこばんで2倍！)\n`;
                                    }
                    
                                    await processWildVictory(battle, interaction, battleId);
                                    return;
                                } else {
                                    battle.pendingNextNpcIdx = nextNpcIdx; 
                                    const nextPoke = battle.p2.party[nextNpcIdx];
                                    
                                    battle.log += `\n⚠️ **${battle.p2.name}** は 次に **${nextPoke.nickname}** を 出そうとしている！\n🔄 ポケモンを 入れ替えますか？`;
                                    await updateBattleMessage(interaction, battleId);
                                    break; 
                                }
                            } else {
                                await processWildVictory(battle, interaction, battleId);
                                return; 
                            }
                        } else {
                            const myNextIdx = battle.p1.party.findIndex(p => p.hp > 0);
                            if (myNextIdx === -1) {
                                battle.log += `\n\n目の前が まっくらになった……\n(${battle.battleType === 'gym' ? battle.p2.name + ' との 勝負に 負けた……' : 'やせいの ' + defPoke.nickname + ' から逃げ出した'})`;
                                hiddenWildChains.delete(battle.p1.id); 
                                await updateBattleMessage(interaction, battleId, true);
                                await saveAllHPs(battle);
                                return activeBattles.delete(battleId);
                            } else {
                                battle.log += `\n⚠️ 次に 出す ポケモンを 選んでください！\n`;
                                await updateBattleMessage(interaction, battleId); 
                                break; 
                            }
                        }
                    }
                }

                let tookStatusDamage = false;
                for (const p of [atkPoke, defPoke]) {
                    if (p.hp > 0) {
                        if (p.status === 'poison') {
                            const dmg = Math.max(1, Math.floor(p.maxHp / 8));
                            p.hp = Math.max(0, p.hp - dmg);
                            battle.log += `☠️ **${p.nickname}** は どくの ダメージを 受けている！\n`;
                            tookStatusDamage = true;
                        } else if (p.status === 'bad_poison') {
                            const dmg = Math.max(1, Math.floor((p.maxHp * p.statusTurns) / 16));
                            p.hp = Math.max(0, p.hp - dmg);
                            battle.log += `☠️ **${p.nickname}** は もうどくの ダメージを 受けている！\n`;
                            p.statusTurns++; 
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
                                await updateBattleMessage(interaction, battleId); 
                                await sleep(1000);
                                await processWildVictory(battle, interaction, battleId); 
                                return; 
                            } else {
                                const myNextIdx = battle.p1.party.findIndex(x => x.hp > 0);
                                if (myNextIdx === -1) {
                                    battle.log += `\n\n目の前が まっくらになった……\n(${battle.battleType === 'gym' ? battle.p2.name + ' との 勝負に 負けた……' : 'やせいの ' + defPoke.nickname + ' から逃げ出した'})`;
                                    hiddenWildChains.delete(battle.p1.id); 
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
                
                if (tookStatusDamage) {
                    await updateBattleMessage(interaction, battleId);
                    await sleep(1000);
                }
                
                await supabase.from('poke_caught_pokemons').update({ moves: atkPoke.moves }).eq('id', atkPoke.dbId);
                await updateBattleMessage(interaction, battleId);
                return;

            } else if (battle.battleType === 'pvp') {
                if (moveIdx !== -1) atkPoke.moves[moveIdx].pp!--;
                
                const statusCheck = checkStatusBeforeMove(atkPoke);
                if (!statusCheck.canMove) {
                    battle.log = statusCheck.log;
                    if (statusCheck.selfDamage > 0) {
                        atkPoke.hp = Math.max(0, atkPoke.hp - statusCheck.selfDamage);
                        battle.log += `💥 **${statusCheck.selfDamage}** ダメージ！\n`;
                    }
                } else {
                    battle.log = statusCheck.log;
                    const hitChance = pMove.accuracy || 100;
                    const isHit = (Math.random() * 100) <= hitChance;

                    if (!isHit) {
                        battle.log += `▶ **${atkPoke.nickname}** の **${pMove.name}**！\n💨 しかし **${defPoke.nickname}** には 当たらなかった！`;
                    } else {
                        battle.log += `▶ **${atkPoke.nickname}** の **${pMove.name}**！\n`;
                        battle.log += await executeMoveEffects(atkPoke, defPoke, pMove);

                        if (defPoke.hp === 0) {
                            battle.log += `\n💀 **${defPoke.nickname}** は たおれた！`;
                            const nextIdx = defender.party.findIndex(p => p.hp > 0);
                            if (nextIdx === -1) {
                                battle.log += `\n\n🏆 **<@${attacker.id}> の勝利！**`;
                                try {
                                    const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', attacker.id).single();
                                    const newStreak = (u?.win_streak || 0) + 1;
                                    
                                    let prizeMoney = 500 + ((newStreak - 1) * 200);
                                    const hasAmuletCoin = attacker.party.some(p => p.heldItem === 'amulet_coin');
                                    if (hasAmuletCoin) prizeMoney *= 2;

                                    await supabase.from('poke_users').update({ money: (u?.money || 0) + prizeMoney, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', attacker.id);
                                    await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', defender.id);
                                    
                                    battle.log += `\n🔥 **${newStreak}連勝！**`;
                                    battle.log += `\n💰 賞金 **${prizeMoney.toLocaleString()}円** を手に入れた！`;
                                    if (hasAmuletCoin) battle.log += ` (🪙 こばんで2倍！)`;
                                } catch (e) {}
                                await updateBattleMessage(interaction, battleId, true);
                                await saveAllHPs(battle);
                                return activeBattles.delete(battleId);
                            }
                            battle.log += `\n⚠️ <@${defender.id}> は 次に 出す ポケモンを 選んでください！`;
                            battle.currentTurnUserId = defender.id; 
                            battle.nextTurnAfterSwitchUserId = defender.id; 
                            await updateBattleMessage(interaction, battleId);
                            return;
                        }
                    }
                }

                if (atkPoke.hp > 0) {
                    if (atkPoke.status === 'poison') {
                        const dmg = Math.max(1, Math.floor(atkPoke.maxHp / 8));
                        atkPoke.hp = Math.max(0, atkPoke.hp - dmg);
                        battle.log += `\n☠️ **${atkPoke.nickname}** は どくの ダメージを 受けている！`;
                    } else if (atkPoke.status === 'bad_poison') {
                        const dmg = Math.max(1, Math.floor((atkPoke.maxHp * atkPoke.statusTurns) / 16));
                        atkPoke.hp = Math.max(0, atkPoke.hp - dmg);
                        battle.log += `\n☠️ **${atkPoke.nickname}** は もうどくの ダメージを 受けている！`;
                        atkPoke.statusTurns++;
                    } else if (atkPoke.status === 'burn') {
                        const dmg = Math.max(1, Math.floor(atkPoke.maxHp / 16));
                        atkPoke.hp = Math.max(0, atkPoke.hp - dmg);
                        battle.log += `\n🔥 **${atkPoke.nickname}** は やけどの ダメージを 受けている！`;
                    }
                }

                if (atkPoke.hp <= 0) {
                    if (!battle.log.includes('たおれた！')) battle.log += `\n💀 **${atkPoke.nickname}** は 力尽きた…！`;
                    const nextIdx = attacker.party.findIndex(p => p.hp > 0);
                    if (nextIdx === -1) {
                        battle.log += `\n\n🏆 **<@${defender.id}> の勝利！**`;
                        try {
                            const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', defender.id).single();
                            const newStreak = (u?.win_streak || 0) + 1;

                            let prizeMoney = 500 + ((newStreak - 1) * 200);
                            const hasAmuletCoin = defender.party.some(p => p.heldItem === 'amulet_coin');
                            if (hasAmuletCoin) prizeMoney *= 2;

                            await supabase.from('poke_users').update({ money: (u?.money || 0) + prizeMoney, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', defender.id);
                            await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', attacker.id);
                            battle.log += `\n💰 賞金 **${prizeMoney.toLocaleString()}円** を手に入れた！`;
                            if (hasAmuletCoin) battle.log += ` (🪙 こばんで2倍！)`;
                        } catch (e) {}
                        await updateBattleMessage(interaction, battleId, true);
                        await saveAllHPs(battle);
                        return activeBattles.delete(battleId);
                    }
                    battle.log += `\n⚠️ <@${attacker.id}> は 次に 出す ポケモンを 選んでください！`;
                    battle.currentTurnUserId = attacker.id; 
                    battle.nextTurnAfterSwitchUserId = defender.id; 
                    await updateBattleMessage(interaction, battleId);
                    return;
                }

                await supabase.from('poke_caught_pokemons').update({ moves: atkPoke.moves }).eq('id', atkPoke.dbId);
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
            
            const statusBonus = defPoke.status === 'sleep' || defPoke.status === 'freeze' ? 2.0 : defPoke.status ? 1.5 : 1.0;
            const hpFactor = ((defPoke.maxHp * 3) - (defPoke.hp * 2)) / (defPoke.maxHp * 3);

            const levelDiff = Math.max(0, atkPoke.level - defPoke.level);
            const levelBonus = 1.0 + (levelDiff * 0.05); 

            const legendaryPenalty = defPoke.isLegendary ? 0.5 : 1.0;

            const baseChance = (defPoke.captureRate! / 255) * hpFactor * statusBonus * levelBonus;
            let finalChance = Math.min(1.0, baseChance * ballMult * legendaryPenalty);
            
            if (ballId === 'master_ball') finalChance = 1.0; 
            
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
                    status_condition: defPoke.status,
                    ability: defPoke.ability
                }]).select('id').single();

                const boxText = isParty ? '手持ち' : 'ボックス';
                battle.log += `\n(${boxText}に送られました。残りボール: ${inv!.quantity - 1}個)`;

                const currentChain = (hiddenWildChains.get(interaction.user.id) || 0);
                hiddenWildChains.set(interaction.user.id, currentChain + 1);
                const chainMult = Math.min(2.0, 1.0 + (currentChain * 0.1));

                const defPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${defPoke.pokedexId}`).then(r => r.json());
                const baseExp = defPokeRes.base_experience || 50;
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
                
                const statusCheck = checkStatusBeforeMove(defPoke);
                if (!statusCheck.canMove) {
                    battle.log += statusCheck.log;
                } else {
                    const usableWildMoves = defPoke.moves.filter(m => (m.pp === undefined || m.pp > 0));
                    let wMove: BattleMove = { name: 'わるあがき', power: 50, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 0, maxPp: 0 };
                    if (usableWildMoves.length > 0) {
                        const attackMoves = usableWildMoves.filter(m => m.power > 0);
                        if (attackMoves.length > 0 && Math.random() < 0.7) {
                            wMove = attackMoves[Math.floor(Math.random() * attackMoves.length)];
                        } else {
                            wMove = usableWildMoves[Math.floor(Math.random() * usableWildMoves.length)];
                        }
                    }
                    const hitChance = wMove.accuracy || 100;
                    const isHit = (Math.random() * 100) <= hitChance;

                    if (!isHit) {
                        battle.log += `\n\n◀ ${battle.battleType === 'gym' ? '相手の' : 'やせいの'} **${defPoke.nickname}** の **${wMove.name}**！\n💨 しかし **${atkPoke.nickname}** には 当たらなかった！`;
                    } else {
                        battle.log += `\n\n◀ ${battle.battleType === 'gym' ? '相手の' : 'やせいの'} **${defPoke.nickname}** の **${wMove.name}**！\n`;
                        battle.log += await executeMoveEffects(defPoke, atkPoke, wMove);

                        if (atkPoke.hp === 0) {
                            battle.log += `\n💀 **${atkPoke.nickname}** は たおれた！`;
                            const myNextIdx = attacker.party.findIndex(p => p.hp > 0);
                            if (myNextIdx === -1) {
                                battle.log += `\n\n目の前が まっくらになった……\n(${battle.battleType === 'gym' ? battle.p2.name + ' との 勝負に 負けた……' : 'やせいの ' + defPoke.nickname + ' から逃げ出した'})`;
                                hiddenWildChains.delete(battle.p1.id); 
                                await updateBattleMessage(interaction, battleId, true);
                                await saveAllHPs(battle);
                                return activeBattles.delete(battleId);
                            } else {
                                battle.log += `\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
                            }
                        }
                    }
                }
                
                if (atkPoke.hp > 0 && (atkPoke.status === 'poison' || atkPoke.status === 'burn')) {
                    const dmg = Math.max(1, Math.floor(atkPoke.maxHp / (atkPoke.status === 'poison' ? 8 : 16)));
                    atkPoke.hp = Math.max(0, atkPoke.hp - dmg);
                    battle.log += `\n${atkPoke.status === 'poison' ? '☠️ どく' : '🔥 やけど'} の ダメージを 受けている！`;
                    if (atkPoke.hp <= 0) battle.log += `\n💀 **${atkPoke.nickname}** は 力尽きた…！\n\n⚠️ 次に 出す ポケモンを 選んでください！`;
                }
                battle.currentTurnUserId = attacker.id;
            }
        } 

        await updateBattleMessage(interaction, battleId);

    } finally {
        if (activeBattles.has(battleId)) {
            activeBattles.get(battleId)!.isProcessing = false;
        }
    }
}

function getBuffString(stages: {atk: number, def: number, spa: number, spd: number, spe: number}): string {
    const jpMap: Record<string, string> = { atk: '攻', def: '防', spa: '特攻', spd: '特防', spe: '速' };
    let buffs = [];
    for (const [key, val] of Object.entries(stages)) {
        if (val > 0) buffs.push(`[${jpMap[key]}↑${val}]`);
        else if (val < 0) buffs.push(`[${jpMap[key]}↓${Math.abs(val)}]`);
    }
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
    let embedColor = battle.battleType === 'wild' ? 0x2E8B57 : 0xFF4500; 

    if (isCaught) {
        titleText = `🎊 ${p2p.nickname} ゲットだぜ！`;
        embedColor = 0x00FF00; 
    } else if (isFinished) {
        if (p2Alive === 0) {
            titleText = '🏆 バトル勝利！';
            embedColor = 0xFFD700; 
        } else if (p1Alive === 0) {
            titleText = '💀 目の前が まっくらになった……';
            embedColor = 0x36393F; 
        } else {
            titleText = '💨 バトル終了（逃走）';
            embedColor = 0x808080; 
        }
    } else if (battle.battleType === 'wild') {
        titleText = `あ！ やせいの ${p2p.nickname} が とびだしてきた！`;
    }

    const p1HpBar = generateHpBar(p1p.hp, p1p.maxHp);
    const p2HpBar = generateHpBar(p2p.hp, p2p.maxHp);

    const p1Status = p1p.status ? ` [${STATUS_MAP[p1p.status]}]` : '';
    const p2Status = p2p.status ? ` [${STATUS_MAP[p2p.status]}]` : '';

    const p1Buffs = getBuffString(p1p.statStages);
    const p2Buffs = getBuffString(p2p.statStages);

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setDescription(battle.log)
        .setColor(embedColor)
        .addFields(
            { name: `🔵 相手: ${battle.battleType === 'pvp' ? `<@${battle.p2.id}>` : battle.battleType === 'gym' ? battle.p2.name : '野生'}`, value: `**${p2p.nickname}** Lv.${p2p.level}${p2Status}${p2Buffs}\n${p2HpBar} [ **${p2p.hp}** / ${p2p.maxHp} ]\n(残り: ${p2Alive}匹)`, inline: false },
            { name: `🔴 自分: <@${battle.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level}${p1Status}${p1Buffs}\n${p1HpBar} [ **${p1p.hp}** / ${p1p.maxHp} ]\n(残り: ${p1Alive}匹)`, inline: false }
        )
        .setImage(p2p.imageUrl)
        .setThumbnail(p1p.imageUrl);

    let components: any[] = [];
    
    if (!isFinished) {
        if (battle.pendingNextNpcIdx !== undefined) {
            components = [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('はい（入れ替える）').setStyle(ButtonStyle.Success).setEmoji('🔄'),
                    new ButtonBuilder().setCustomId(`btl_stay_${battleId}`).setLabel('いいえ（そのまま）').setStyle(ButtonStyle.Secondary).setEmoji('⚔️')
                )
            ];
        }
        else if (p1p.hp <= 0 && p1Alive > 0) {
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
        else if (p2p.hp <= 0 && p2Alive > 0 && battle.battleType === 'pvp') {
            const switchButtons = battle.p2.party.map((p, i) => 
                new ButtonBuilder().setCustomId(`btl_switch_${battleId}_${i}`).setLabel(`${p.nickname} (HP:${p.hp})`).setStyle(ButtonStyle.Success).setDisabled(p.hp <= 0)
            );
            const rows: ActionRowBuilder<ButtonBuilder>[] = [];
            for (let i = 0; i < switchButtons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
            components = rows;
        }
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

    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ embeds: [embed], components });
        } else {
            await interaction.update({ embeds: [embed], components });
        }
    } catch (e) {}
}

export async function startGymBattle(interaction: ChatInputCommandInteraction, userId: string, leaderId: string) {
    const GYM_LEADERS: Record<string, any> = {
        'rock': { name: 'ジムリーダー タケシ', badge: '🪨 グレーバッジ', reward: 3000, team: [{ id: 74, level: 12 }, { id: 95, level: 14 }] },
        'water': { name: 'ジムリーダー カスミ', badge: '💧 ブルーバッジ', reward: 5000, team: [{ id: 120, level: 18 }, { id: 121, level: 21 }] },
        'electric': { name: 'ジムリーダー マチス', badge: '⚡ オレンジバッジ', reward: 8000, team: [{ id: 100, level: 21 }, { id: 25, level: 18 }, { id: 26, level: 24 }] },
        'grass': { name: 'ジムリーダー エリカ', badge: '🌈 レインボーバッジ', reward: 12000, team: [{ id: 71, level: 29 }, { id: 114, level: 24 }, { id: 45, level: 29 }] },
        'poison': { name: 'ジムリーダー キョウ', badge: '💖 ピンクバッジ', reward: 15000, team: [{ id: 109, level: 37 }, { id: 89, level: 39 }, { id: 109, level: 37 }, { id: 110, level: 43 }] },
        'psychic': { name: 'ジムリーダー ナツメ', badge: '🟡 ゴールドバッジ', reward: 18000, team: [{ id: 64, level: 38 }, { id: 122, level: 37 }, { id: 49, level: 38 }, { id: 65, level: 43 }] },
        'fire': { name: 'ジムリーダー カツラ', badge: '🔥 クリムゾンバッジ', reward: 22000, team: [{ id: 58, level: 42 }, { id: 77, level: 40 }, { id: 78, level: 42 }, { id: 59, level: 47 }] },
        'ground': { name: 'ジムリーダー サカキ', badge: '🌿 グリーンバッジ', reward: 30000, team: [{ id: 111, level: 45 }, { id: 51, level: 42 }, { id: 31, level: 44 }, { id: 34, level: 45 }, { id: 112, level: 50 }] },
        'e4_ice': { name: '四天王 カンナ', badge: '❄️ 氷の紋章', reward: 50000, team: [{ id: 87, level: 70 }, { id: 91, level: 71 }, { id: 80, level: 72 }, { id: 124, level: 73 }, { id: 131, level: 75 }] },
        'e4_fight': { name: '四天王 シバ', badge: '👊 闘の紋章', reward: 60000, team: [{ id: 95, level: 75 }, { id: 107, level: 76 }, { id: 106, level: 76 }, { id: 95, level: 77 }, { id: 68, level: 80 }] },
        'e4_ghost': { name: '四天王 キクコ', badge: '👻 霊の紋章', reward: 70000, team: [{ id: 94, level: 80 }, { id: 42, level: 81 }, { id: 93, level: 82 }, { id: 24, level: 83 }, { id: 94, level: 85 }] },
        'e4_dragon': { name: '四天王 ワタル', badge: '🐉 竜の紋章', reward: 80000, team: [{ id: 130, level: 85 }, { id: 148, level: 86 }, { id: 148, level: 86 }, { id: 142, level: 88 }, { id: 149, level: 90 }] },
        'champion': { name: 'チャンピオン', badge: '👑 殿堂入り', reward: 150000, team: [{ id: 18, level: 95 }, { id: 65, level: 96 }, { id: 112, level: 97 }, { id: 59, level: 98 }, { id: 103, level: 99 }, { id: 6, level: 100 }] }
    };

    const leader = GYM_LEADERS[leaderId];
    if (!leader) return interaction.editReply('そのジムリーダーは見つかりません。');

    const { data: u } = await supabase.from('poke_users').select('badges').eq('discord_id', userId).single();
    let badges = u?.badges || [];
    if (typeof badges === 'string') badges = JSON.parse(badges);

    const reqMap: Record<string, [string, string]> = {
        'water': ['タケシ', '🪨 グレーバッジ'], 'electric': ['カスミ', '💧 ブルーバッジ'],
        'grass': ['マチス', '⚡ オレンジバッジ'], 'poison': ['エリカ', '🌈 レインボーバッジ'],
        'psychic': ['キョウ', '💖 ピンクバッジ'], 'fire': ['ナツメ', '🟡 ゴールドバッジ'],
        'ground': ['カツラ', '🔥 クリムゾンバッジ'],
        'e4_ice': ['サカキ', '🌿 グリーンバッジ'], 'e4_fight': ['カンナ', '❄️ 氷の紋章'],
        'e4_ghost': ['シバ', '👊 闘の紋章'], 'e4_dragon': ['キクコ', '👻 霊の紋章'],
        'champion': ['ワタル', '🐉 竜の紋章']
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

        const mockDb = {
            id: `npc_${poke.id}_${Math.random()}`, pokedex_id: poke.id, nickname: jaName, level: poke.level,
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
        log: `**${leader.name}** が 勝負を しかけてきた！`,
        battleType: 'gym', gymData: leader
    };

    activeBattles.set(battle.id, battle);
    await updateBattleMessage(interaction as any, battle.id);
}
