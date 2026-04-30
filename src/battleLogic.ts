// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageComponentInteraction, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './pokeDb';
import { getMovesForLevel, getRandomPokemonIdByArea } from './pokeApiUtils';

const activeBattles = new Map<string, BattleState>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const NATURES = [
    'さみしがり', 'いじっぱり', 'やんちゃ', 'ゆうかん',
    'ずぶとい', 'わんぱく', 'のうてんき', 'のんき',
    'ひかえめ', 'おっとり', 'うっかりや', 'れいせい',
    'おだやか', 'おとなしい', 'しんちょう', 'なまいき',
    'おくびょう', 'せっかち', 'ようき', 'むじゃき',
    'てれや', 'がんばりや', 'すなお', 'きまぐれ', 'まじめ'
];

const NATURE_EFFECTS: Record<string, [number, number] | null> = {
    'さみしがり': [1, 2], 'いじっぱり': [1, 3], 'やんちゃ': [1, 4], 'ゆうかん': [1, 5],
    'ずぶとい': [2, 1], 'わんぱく': [2, 3], 'のうてんき': [2, 4], 'のんき': [2, 5],
    'ひかえめ': [3, 1], 'おっとり': [3, 2], 'うっかりや': [3, 4], 'れいせい': [3, 5],
    'おだやか': [4, 1], 'おとなしい': [4, 2], 'しんちょう': [4, 3], 'なまいき': [4, 5],
    'おくびょう': [5, 1], 'せっかち': [5, 2], 'ようき': [5, 3], 'むじゃき': [5, 4],
    'てれや': null, 'がんばりや': null, 'すなお': null, 'きまぐれ': null, 'まじめ': null
};

function getRequiredExp(level: number, rate: string): number {
    if (level <= 1) return 0;
    if (rate === 'erratic') {
        if (level <= 50) return Math.floor((Math.pow(level, 3) * (100 - level)) / 50);
        if (level <= 68) return Math.floor((Math.pow(level, 3) * (150 - level)) / 100);
        if (level <= 98) return Math.floor((Math.pow(level, 3) * Math.floor((1911 - 10 * level) / 3)) / 500);
        return Math.floor((Math.pow(level, 3) * (160 - level)) / 100);
    }
    if (rate === 'fast') return Math.floor(4 * Math.pow(level, 3) / 5);
    if (rate === 'medium-slow') return Math.floor((6/5) * Math.pow(level, 3) - 15 * Math.pow(level, 2) + 100 * level - 140);
    if (rate === 'slow') return Math.floor(5 * Math.pow(level, 3) / 4);
    if (rate === 'fluctuating') {
        if (level <= 15) return Math.floor(Math.pow(level, 3) * (Math.floor((level + 1) / 3) + 24) / 50);
        if (level <= 36) return Math.floor(Math.pow(level, 3) * (level + 14) / 50);
        return Math.floor(Math.pow(level, 3) * (Math.floor(level / 2) + 32) / 50);
    }
    return Math.floor(Math.pow(level, 3));
}

function applyNature(stat: number, typeIndex: number, natureName: string): number {
    const effect = NATURE_EFFECTS[natureName];
    if (!effect) return stat;
    if (effect[0] === typeIndex) return Math.floor(stat * 1.1);
    if (effect[1] === typeIndex) return Math.floor(stat * 0.9);
    return stat;
}

interface BattleMove { name: string; power: number; type: string; damageClass?: string; accuracy?: number; }
interface BattlePokemon {
    dbId: string; pokedexId: number; nickname: string; level: number;
    hp: number; maxHp: number; atk: number; def: number; spa: number; spd: number; speed: number;
    imageUrl: string; moves: BattleMove[]; types: string[]; exp: number;
    nature: string; captureRate?: number; wildIvs?: any; 
    evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number; }; 
}
interface Player { id: string; name: string; party: BattlePokemon[]; activeIndex: number; }
interface BattleState {
    id: string; p1: Player; p2: Player; currentTurnUserId: string; log: string;
    battleType: 'pvp' | 'wild';
}

async function saveAllHPs(battle: BattleState) {
    const promises: any[] = [];
    battle.p1.party.forEach(p => { promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.maxHp }).eq('id', p.dbId)); });
    if (battle.battleType === 'pvp') {
        battle.p2.party.forEach(p => { promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.maxHp }).eq('id', p.dbId)); });
    }
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

async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const speciesRes = await fetch(data.species.url);
    const speciesData = await speciesRes.json();
    const growthRate = speciesData.growth_rate.name;

    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const lv = dbPoke.level;
    const nature = dbPoke.nature || 'まじめ';

    let safeMoves = dbPoke.moves;
    if (typeof safeMoves === 'string') {
        try { safeMoves = JSON.parse(safeMoves); } catch (e) { safeMoves = []; }
    }

    let needsMoveUpdate = false;
    if (!Array.isArray(safeMoves) || safeMoves.length === 0 || (safeMoves.length === 1 && safeMoves[0].name === 'わるあがき')) {
        safeMoves = await getMovesForLevel(data, lv);
        if (!safeMoves || safeMoves.length === 0) {
            safeMoves = [{ name: 'たいあたり', power: 40, type: 'normal', damageClass: 'physical', accuracy: 100 }];
        }
        needsMoveUpdate = true;
    }

    let safeTypes = dbPoke.types;
    if (typeof safeTypes === 'string') {
        try { safeTypes = JSON.parse(safeTypes); } catch (e) { safeTypes = []; }
    }

    let currentExp = dbPoke.exp || 0;
    const requiredExp = getRequiredExp(lv, growthRate); 
    if (currentExp < requiredExp) {
        currentExp = requiredExp;
        needsMoveUpdate = true;
    }

    if (needsMoveUpdate) {
        supabase.from('poke_caught_pokemons').update({ moves: safeMoves, exp: currentExp }).eq('id', dbPoke.id).then();
    }

    const evs = {
        hp: dbPoke.ev_hp || 0, atk: dbPoke.ev_attack || 0, def: dbPoke.ev_defense || 0,
        spa: dbPoke.ev_sp_atk || 0, spd: dbPoke.ev_sp_def || 0, spe: dbPoke.ev_speed || 0
    };

    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp + Math.floor(evs.hp / 4)) * lv) / 100) + lv + 10;
    const currentHp = maxHp;

    return {
        dbId: dbPoke.id, pokedexId: dbPoke.pokedex_id, nickname: dbPoke.nickname, level: lv,
        hp: currentHp, maxHp: maxHp,
        atk: applyNature(Math.floor(((2 * base['attack'] + dbPoke.iv_attack + Math.floor(evs.atk / 4)) * lv) / 100) + 5, 1, nature),
        def: applyNature(Math.floor(((2 * base['defense'] + dbPoke.iv_defense + Math.floor(evs.def / 4)) * lv) / 100) + 5, 2, nature),
        spa: applyNature(Math.floor(((2 * base['special-attack'] + (dbPoke.iv_sp_atk || 0) + Math.floor(evs.spa / 4)) * lv) / 100) + 5, 3, nature),
        spd: applyNature(Math.floor(((2 * base['special-defense'] + (dbPoke.iv_sp_def || 0) + Math.floor(evs.spd / 4)) * lv) / 100) + 5, 4, nature),
        speed: applyNature(Math.floor(((2 * base['speed'] + dbPoke.iv_speed + Math.floor(evs.spe / 4)) * lv) / 100) + 5, 5, nature),
        imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
        moves: safeMoves, types: safeTypes, exp: currentExp,
        nature: nature, captureRate: dbPoke.captureRate, wildIvs: dbPoke.wildIvs,
        evs: evs
    };
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

        const [p1Party, p2Party] = await Promise.all([ Promise.all(p1Data.map(p => buildBattlePokemon(p))), Promise.all(p2Data.map(p => buildBattlePokemon(p))) ]);

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

async function getValidWildPokemon(area: string | null) {
    let pokeId = await getRandomPokemonIdByArea(area);
    let res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
    let data = await res.json();
    let speciesRes = await fetch(data.species.url);
    let speciesData = await speciesRes.json();

    while (speciesData.is_legendary || speciesData.is_mythical) {
        pokeId = await getRandomPokemonIdByArea(area);
        res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
        data = await res.json();
        speciesRes = await fetch(data.species.url);
        speciesData = await speciesRes.json();
    }

    if (speciesData.evolves_from_species) {
        const evoRes = await fetch(speciesData.evolution_chain.url);
        const evoData = await evoRes.json();
        const baseSpeciesName = evoData.chain.species.name;
        
        const baseRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${baseSpeciesName}`);
        data = await baseRes.json();
        pokeId = data.id;
        const baseSpeciesRes = await fetch(data.species.url);
        speciesData = await baseSpeciesRes.json();
    }
    
    return { pokeId, data, speciesData };
}

export async function startWildBattle(interaction: ChatInputCommandInteraction, userId: string, area: string | null) {
    try {
        let { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true });
        
        if (p1Data && p1Data.length > 6) {
            const overflowIds = p1Data.slice(6).map(p => p.id);
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
            p1Data = p1Data.slice(0, 6);
        }

        if (!p1Data || p1Data.length === 0) {
            const { pokeId, data, speciesData } = await getValidWildPokemon(area);
            const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();
            const imageUrl = data.sprites.other['official-artwork'].front_default || data.sprites.front_default;

            const embed = new EmbedBuilder()
                .setTitle(`あ！ やせいの **${jaName}** が とびだしてきた！`)
                .setDescription(`...しかし、あなたは戦うためのポケモンを1匹も持っていない！\n\nなんと！ **${jaName}** は こちらに 興味を持っているようだ！\nそのまま 仲間になった！🎉`)
                .setImage(imageUrl)
                .setColor(0x00FF00);

            const level = 5;
            const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
            const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
            const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);
            const baseHp = data.stats.find((s:any) => s.stat.name === 'hp').base_stat;
            const maxHp = Math.floor(((2 * baseHp + iv_hp) * level) / 100) + level + 10;
            const moves = await getMovesForLevel(data, level);

            const { data: inserted } = await supabase.from('poke_caught_pokemons').insert([{
                owner_id: userId, original_trainer_id: userId, pokedex_id: pokeId, nickname: jaName, level: level, exp: 0, 
                nature: wildNature, iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed, current_hp: maxHp, 
                types: data.types.map((t: any) => t.type.name), moves: moves,
                is_party: true, party_order: 1,
                ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0
            }]).select('id').single();

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`nickbtn_${inserted?.id}`).setLabel('ニックネームをつける').setStyle(ButtonStyle.Primary).setEmoji('🏷️')
            );

            await interaction.editReply({ content: '💡 初めてのポケモンをゲットしました！', embeds: [embed], components: [row] });
            return;
        }

        const p1Party = await Promise.all(p1Data.map(p => buildBattlePokemon(p)));
        const baseLevel = p1Party[0].level;
        const wildLevel = Math.max(1, baseLevel + Math.floor(Math.random() * 5) - 2);

        const { pokeId, data, speciesData } = await getValidWildPokemon(area);
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        const base: any = {};
        data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

        const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
        const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
        const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);

        const maxHp = Math.floor(((2 * base['hp'] + iv_hp) * wildLevel) / 100) + wildLevel + 10;
        const moves = await getMovesForLevel(data, wildLevel);

        const wildPoke: BattlePokemon = {
            dbId: 'wild', pokedexId: pokeId, nickname: jaName, level: wildLevel, hp: maxHp, maxHp: maxHp,
            atk: applyNature(Math.floor(((2 * base['attack'] + iv_attack) * wildLevel) / 100) + 5, 1, wildNature), 
            def: applyNature(Math.floor(((2 * base['defense'] + iv_defense) * wildLevel) / 100) + 5, 2, wildNature),
            spa: applyNature(Math.floor(((2 * base['special-attack'] + iv_sp_atk) * wildLevel) / 100) + 5, 3, wildNature),
            spd: applyNature(Math.floor(((2 * base['special-defense'] + iv_sp_def) * wildLevel) / 100) + 5, 4, wildNature),
            speed: applyNature(Math.floor(((2 * base['speed'] + iv_speed) * wildLevel) / 100) + 5, 5, wildNature),
            imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
            moves: moves, types: data.types.map((t: any) => t.type.name), exp: 0,
            nature: wildNature, 
            captureRate: speciesData.capture_rate || 45,
            wildIvs: { iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed },
            evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
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

    if (action === 'attack') {
        const moveButtons = atkPoke.moves.map((m, i) => new ButtonBuilder().setCustomId(`btl_usemove_${battleId}_${i}`).setLabel(m.name).setStyle(ButtonStyle.Danger));
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
            { id: 'hyper_ball', name: 'ハイパーボール', emoji: '🟡', rate: 2.0, qty: getQty('hyper_ball') }
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
        }
        await updateBattleMessage(interaction, battleId, true);
        await saveAllHPs(battle);
        return activeBattles.delete(battleId);
    }

    if (action === 'switch') {
        attacker.activeIndex = parseInt(interaction.customId.split('_')[3]);
        battle.log = `🔄 <@${attacker.id}> は **${attacker.party[attacker.activeIndex].nickname}** を繰り出した！`;
    }

    if (action === 'usemove') {
        const move = atkPoke.moves[parseInt(interaction.customId.split('_')[3])];

        const hitChance = move.accuracy || 100;
        const isHit = (Math.random() * 100) <= hitChance;

        if (!isHit) {
            battle.log = `▶ **${atkPoke.nickname}** の **${move.name}**！\n💨 しかし **${defPoke.nickname}** には 当たらなかった！`;
            await updateBattleMessage(interaction, battleId);
            await sleep(1500);
            
            if (battle.battleType === 'wild' && defPoke.hp > 0) {
                 battle.currentTurnUserId = attacker.id;
            } else if (battle.battleType === 'pvp') {
                 battle.currentTurnUserId = defender.id;
            }
        } else {
            const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${move.type}`).then(r => r.json());
            let mult = 1;
            defPoke.types.forEach(t => {
                if (typeRes.damage_relations.double_damage_to.some((d: any) => d.name === t)) mult *= 2;
                if (typeRes.damage_relations.half_damage_to.some((d: any) => d.name === t)) mult *= 0.5;
                if (typeRes.damage_relations.no_damage_to.some((d: any) => d.name === t)) mult *= 0;
            });
            if (atkPoke.types.includes(move.type)) mult *= 1.5; 

            const isSpecial = move.damageClass === 'special';
            const attackStat = isSpecial ? (atkPoke.spa || atkPoke.atk) : atkPoke.atk;
            const defenseStat = isSpecial ? (defPoke.spd || defPoke.def) : defPoke.def;

            const isCritical = Math.random() < (1 / 24);
            const critMult = isCritical ? 1.5 : 1.0;

            const random = (Math.floor(Math.random() * 16) + 85) / 100; 
            let baseDamage = Math.floor(Math.floor(Math.floor(2 * atkPoke.level / 5 + 2) * move.power * attackStat / defenseStat) / 50) + 2;
            let damage = Math.floor(baseDamage * mult * critMult * random);
            if (damage < 1 && mult !== 0) damage = 1;

            defPoke.hp = Math.max(0, defPoke.hp - damage);
            
            let effectLog = '';
            if (isCritical) effectLog += '💥 **急所に当たった！**\n';
            if (mult > 1.5) effectLog += '🌟 **こうかばつぐんだ！**\n';
            if (mult > 0 && mult < 1) effectLog += '📉 こうかはいまひとつのようだ…\n';
            if (mult === 0) effectLog += '❌ こうかがないみたいだ…\n';

            battle.log = `▶ **${atkPoke.nickname}** の **${move.name}**！\n${effectLog}💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

            if (defPoke.hp === 0) {
                let victoryLog = `\n\n💀 **${defPoke.nickname}** は たおれた！`;

                try {
                    const defPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${defPoke.pokedexId}`).then(r => r.json());
                    const baseExp = defPokeRes.base_experience || 50;
                    const trainerBonus = battle.battleType === 'pvp' ? 1.5 : 1.0;
                    const gainedExp = Math.floor((trainerBonus * baseExp * defPoke.level) / 7);

                    const evYields = {
                        hp: defPokeRes.stats.find((s:any) => s.stat.name === 'hp')?.effort || 0,
                        atk: defPokeRes.stats.find((s:any) => s.stat.name === 'attack')?.effort || 0,
                        def: defPokeRes.stats.find((s:any) => s.stat.name === 'defense')?.effort || 0,
                        spa: defPokeRes.stats.find((s:any) => s.stat.name === 'special-attack')?.effort || 0,
                        spd: defPokeRes.stats.find((s:any) => s.stat.name === 'special-defense')?.effort || 0,
                        spe: defPokeRes.stats.find((s:any) => s.stat.name === 'speed')?.effort || 0,
                    };

                    const { data: invData } = await supabase.from('poke_inventory')
                        .select('quantity')
                        .eq('user_id', attacker.id)
                        .eq('item_id', 'exp_share')
                        .single();
                    const hasExpShare = (invData?.quantity || 0) > 0;

                    let expLog = '';
                    for (let i = 0; i < attacker.party.length; i++) {
                        const p = attacker.party[i];
                        if (p.hp <= 0) continue; 

                        const isActPoke = (i === attacker.activeIndex);
                        if (!isActPoke && !hasExpShare) continue;

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
                        if (actualGainedExp <= 0) continue;

                        const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${p.pokedexId}`).then(r => r.json());
                        const speciesRes = await fetch(pokeRes.species.url).then(r => r.json());
                        const growthRate = speciesRes.growth_rate.name;

                        let currentExp = p.exp + actualGainedExp;
                        let currentLevel = p.level;
                        let levelUpText = ''; let evolutionText = '';

                        while (currentExp >= getRequiredExp(currentLevel + 1, growthRate)) {
                            currentLevel++;
                            levelUpText += `\n🎉 **${p.nickname}** は レベル**${currentLevel}** に上がった！`;

                            const newMoves = await getMovesForLevel(pokeRes, currentLevel);
                            if (p.moves.map(m => m.name).join() !== newMoves.map(m => m.name).join()) {
                                const learned = newMoves.find(m => !p.moves.some(om => om.name === m.name));
                                p.moves = newMoves;
                                if(learned) levelUpText += `\n💡 新しく **${learned.name}** を覚えた！`;
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
                        
                        await supabase.from('poke_caught_pokemons').update({ 
                            level: currentLevel, exp: currentExp, moves: p.moves, types: p.types, pokedex_id: p.pokedexId, nickname: p.nickname,
                            ev_hp: p.evs.hp, ev_attack: p.evs.atk, ev_defense: p.evs.def, ev_sp_atk: p.evs.spa, ev_sp_def: p.evs.spd, ev_speed: p.evs.spe
                        }).eq('id', p.dbId);
                        
                        if (isActPoke) {
                            expLog += `\n✨ **${actualGainedExp} EXP** をもらった！${levelUpText}${evolutionText}`;
                        } else if (levelUpText || evolutionText) {
                            expLog += `\n(控えの **${p.nickname}** も成長した！)${levelUpText}${evolutionText}`;
                        }
                    }
                    victoryLog += expLog;
                } catch (e) { console.error("EXPエラー:", e); }

                const nextIdx = defender.party.findIndex(p => p.hp > 0);
                if (nextIdx === -1) {
                    if (battle.battleType === 'pvp') {
                        victoryLog += `\n\n🏆 **<@${attacker.id}> の勝利！**`;
                        try {
                            const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', attacker.id).single();
                            const newStreak = (u?.win_streak || 0) + 1;
                            await supabase.from('poke_users').update({ money: (u?.money || 0) + 500, wins: (u?.wins || 0) + 1, win_streak: newStreak, max_win_streak: Math.max(newStreak, u?.max_win_streak || 0) }).eq('discord_id', attacker.id);
                            await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', defender.id);
                            victoryLog += `\n💰 賞金 **500円** を手に入れた！`;
                        } catch (e) {}
                    } else {
                        victoryLog += `\n\nやせいの **${defPoke.nickname}** との バトルに 勝利した！`;
                        try {
                            const prizeMoney = (defPoke.level * 30) + Math.floor(Math.random() * 50);
                            const { data: u } = await supabase.from('poke_users').select('money').eq('discord_id', attacker.id).single();
                            await supabase.from('poke_users').update({ money: (u?.money || 0) + prizeMoney }).eq('discord_id', attacker.id);
                            victoryLog += `\n💰 戦利品として **${prizeMoney}円** を見つけた！`;
                        } catch (e) { console.error("賞金付与エラー:", e); }
                    }
                    battle.log += victoryLog;
                    await updateBattleMessage(interaction, battleId, true);
                    await saveAllHPs(battle);
                    return activeBattles.delete(battleId);
                }
                
                defender.activeIndex = nextIdx;
                battle.log += victoryLog + `\n\n🔄 <@${defender.id}> は **${defender.party[nextIdx].nickname}** を繰り出した！`;
                
                if (battle.battleType === 'pvp') {
                    battle.currentTurnUserId = defender.id;
                }
                
                return updateBattleMessage(interaction, battleId);
            }
        }
        await updateBattleMessage(interaction, battleId);
        await sleep(1500);
    }

    if (action === 'throw' && 'values' in interaction) {
        const selectedVal = interaction.values[0]; 
        const lastIdx = selectedVal.lastIndexOf('_');
        const ballId = selectedVal.substring(0, lastIdx);
        const ballMult = parseFloat(selectedVal.substring(lastIdx + 1));

        const { data: inv } = await supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', ballId).single();
        await supabase.from('poke_inventory').update({ quantity: (inv?.quantity || 1) - 1 }).eq('user_id', interaction.user.id).eq('item_id', ballId);

        const hpFactor = ((defPoke.maxHp * 3) - (defPoke.hp * 2)) / (defPoke.maxHp * 3);
        const baseChance = (defPoke.captureRate! / 255) * hpFactor;
        const finalChance = Math.min(1.0, baseChance * ballMult);
        
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
                ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0
            }]).select('id').single();

            const boxText = isParty ? '手持ち' : 'ボックス';
            battle.log += `\n(${boxText}に送られました。残りボール: ${inv!.quantity - 1}個)`;
            
            await updateBattleMessage(interaction, battleId, true, true, inserted?.id); 
            await saveAllHPs(battle);
            return activeBattles.delete(battleId);
        } else {
            battle.log += ` アァッ！\n\n💨 **${defPoke.nickname}** は ボールから 抜け出してしまった！`;
            await updateBattleMessage(interaction, battleId);
            await sleep(1500); 
        }
    }

    if (battle.battleType === 'wild' && defPoke.hp > 0) {
        const currentAtkPoke = attacker.party[attacker.activeIndex];

        const randomMove = defPoke.moves[Math.floor(Math.random() * defPoke.moves.length)];
        
        const hitChance = randomMove.accuracy || 100;
        const isHit = (Math.random() * 100) <= hitChance;

        if (!isHit) {
             battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${randomMove.name}**！\n💨 しかし **${currentAtkPoke.nickname}** には 当たらなかった！`;
             battle.currentTurnUserId = attacker.id;
             return updateBattleMessage(interaction, battleId);
        }

        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${randomMove.type}`).then(r => r.json());
        let mult = 1;
        currentAtkPoke.types.forEach(t => {
            if (typeRes.damage_relations.double_damage_to.some((d: any) => d.name === t)) mult *= 2;
            if (typeRes.damage_relations.half_damage_to.some((d: any) => d.name === t)) mult *= 0.5;
            if (typeRes.damage_relations.no_damage_to.some((d: any) => d.name === t)) mult *= 0;
        });
        if (defPoke.types.includes(randomMove.type)) mult *= 1.5;

        const isSpecial = randomMove.damageClass === 'special';
        const wildAttackStat = isSpecial ? (defPoke.spa || defPoke.atk) : defPoke.atk;
        const myDefenseStat = isSpecial ? (currentAtkPoke.spd || currentAtkPoke.def) : currentAtkPoke.def;

        const isCritical = Math.random() < (1 / 24);
        const critMult = isCritical ? 1.5 : 1.0;

        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let wildDamage = Math.floor((((2 * defPoke.level / 5 + 2) * randomMove.power * wildAttackStat / myDefenseStat) / 50 + 2) * mult * critMult * random);
        if (wildDamage < 1 && mult !== 0) wildDamage = 1;

        currentAtkPoke.hp = Math.max(0, currentAtkPoke.hp - wildDamage);

        let effectLog = '';
        if (isCritical) effectLog += '💥 **急所に当たった！**\n';
        if (mult > 1.5) effectLog += '🌟 **こうかばつぐんだ！**\n';
        if (mult > 0 && mult < 1) effectLog += '📉 こうかはいまひとつのようだ…\n';
        if (mult === 0) effectLog += '❌ こうかがないみたいだ…\n';

        battle.log += `\n\n◀ やせいの **${defPoke.nickname}** の **${randomMove.name}**！\n${effectLog}💥 **${currentAtkPoke.nickname}** は **${wildDamage}** のダメージを受けた！`;

        if (currentAtkPoke.hp === 0) {
            battle.log += `\n💀 **${currentAtkPoke.nickname}** は たおれた！`;
            const myNextIdx = attacker.party.findIndex(p => p.hp > 0);
            if (myNextIdx === -1) {
                battle.log += `\n\n目の前が まっくらになった……\n(やせいの ${defPoke.nickname} から逃げ出した)`;
                await updateBattleMessage(interaction, battleId, true);
                await saveAllHPs(battle);
                return activeBattles.delete(battleId);
            } else {
                attacker.activeIndex = myNextIdx;
                battle.log += `\n🔄 続いて **${attacker.party[myNextIdx].nickname}** を繰り出した！`;
            }
        }
        
        battle.currentTurnUserId = attacker.id;
        return updateBattleMessage(interaction, battleId);
    } else if (battle.battleType === 'pvp') {
        battle.currentTurnUserId = defender.id;
    }

    await updateBattleMessage(interaction, battleId);
}

async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false, isCaught = false, caughtDbId?: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1p = battle.p1.party[battle.p1.activeIndex];
    const p2p = battle.p2.party[battle.p2.activeIndex];
    const p1Alive = battle.p1.party.filter(p => p.hp > 0).length;
    const p2Alive = battle.p2.party.filter(p => p.hp > 0).length;

    let titleText = '⚔️ ポケモンバトル 進行中！';
    let embedColor = isFinished ? 0x808080 : (battle.battleType === 'wild' ? 0x2E8B57 : 0xFF4500);

    if (isCaught) {
        titleText = `🎊 ${p2p.nickname} ゲットだぜ！`;
        embedColor = 0x00FF00; 
    } else if (isFinished) {
        titleText = '🏁 バトル終了';
    } else if (battle.battleType === 'wild') {
        titleText = `あ！ やせいの ${p2p.nickname} が とびだしてきた！`;
    }

    const p1HpBar = generateHpBar(p1p.hp, p1p.maxHp);
    const p2HpBar = generateHpBar(p2p.hp, p2p.maxHp);

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setDescription(battle.log)
        .setColor(embedColor)
        .addFields(
            { name: `🔵 相手: ${battle.battleType === 'pvp' ? `<@${battle.p2.id}>` : '野生'}`, value: `**${p2p.nickname}** Lv.${p2p.level}\n${p2HpBar} [ **${p2p.hp}** / ${p2p.maxHp} ]\n(残り: ${p2Alive}匹)`, inline: false },
            { name: `🔴 自分: <@${battle.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level}\n${p1HpBar} [ **${p1p.hp}** / ${p1p.maxHp} ]\n(残り: ${p1Alive}匹)`, inline: false }
        )
        .setImage(p2p.imageUrl)
        .setThumbnail(p1p.imageUrl);

    let components: any[] = [];
    
    if (!isFinished) {
        components = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
                ...(battle.battleType === 'wild' ? [new ButtonBuilder().setCustomId(`btl_bag_${battleId}`).setLabel('バッグ').setStyle(ButtonStyle.Success).setEmoji('🎒')] : []),
                new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
                new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel(battle.battleType === 'pvp' ? '降参する' : 'にげる').setStyle(ButtonStyle.Secondary).setEmoji(battle.battleType === 'pvp' ? '🏳️' : '💨')
            )
        ];
    } else if (isCaught && caughtDbId) {
        components = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`nickbtn_${caughtDbId}`).setLabel('ニックネームをつける').setStyle(ButtonStyle.Primary).setEmoji('🏷️')
            )
        ];
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components });
    } else {
        await interaction.update({ embeds: [embed], components });
    }
}
