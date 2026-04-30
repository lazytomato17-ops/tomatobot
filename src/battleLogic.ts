// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageComponentInteraction, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './pokeDb';
import { getMovesForLevel, getRandomPokemonIdByArea } from './pokeApiUtils';

const activeBattles = new Map<string, BattleState>();

// 🌟 演出用：指定したミリ秒だけ処理を一時停止する関数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 🌟 性格補正データの定義
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

function applyNature(stat: number, typeIndex: number, natureName: string): number {
    const effect = NATURE_EFFECTS[natureName];
    if (!effect) return stat;
    if (effect[0] === typeIndex) return Math.floor(stat * 1.1);
    if (effect[1] === typeIndex) return Math.floor(stat * 0.9);
    return stat;
}

interface BattleMove { name: string; power: number; type: string; }
interface BattlePokemon {
    dbId: string; pokedexId: number; nickname: string; level: number;
    hp: number; maxHp: number; atk: number; def: number; speed: number;
    imageUrl: string; moves: BattleMove[]; types: string[]; exp: number;
    nature: string; // 👈 性格データをバトル中も保持する
    captureRate?: number; wildIvs?: any; 
}
interface Player { id: string; name: string; party: BattlePokemon[]; activeIndex: number; }
interface BattleState {
    id: string; p1: Player; p2: Player; currentTurnUserId: string; log: string;
    battleType: 'pvp' | 'wild';
}

async function saveAllHPs(battle: BattleState) {
    const promises: any[] = [];
    
    // 🌟 自動回復仕様：バトル終了時に全回復（maxHp）で保存する
    battle.p1.party.forEach(p => { 
        promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.maxHp }).eq('id', p.dbId)); 
    });
    if (battle.battleType === 'pvp') {
        battle.p2.party.forEach(p => { 
            promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.maxHp }).eq('id', p.dbId)); 
        });
    }
    
    await Promise.all(promises);
}

function generateHpBar(current: number, max: number): string {
    const totalBlocks = 10;
    const percent = current / max;
    const filledBlocks = Math.round(percent * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    
    // HPの割合で色を変える（50%以上は緑、20%以上は黄、それ未満は赤）
    let blockColor = '🟩';
    if (percent <= 0.2) blockColor = '🟥';
    else if (percent <= 0.5) blockColor = '🟨';

    return blockColor.repeat(Math.max(0, filledBlocks)) + '⬛'.repeat(Math.max(0, emptyBlocks));
}

async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const lv = dbPoke.level;
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp) * lv) / 100) + lv + 10;
    const nature = dbPoke.nature || 'まじめ';
    
    // 🌟 先ほど直した完全自動回復
    let currentHp = maxHp; 

    // 🌟 最強パッチ: 技データを安全に解析する
    let safeMoves = dbPoke.moves;
    if (typeof safeMoves === 'string') {
        try { safeMoves = JSON.parse(safeMoves); } catch (e) { safeMoves = []; }
    }
    // 技を1つも覚えていないバグデータの場合の救済措置
    if (!Array.isArray(safeMoves) || safeMoves.length === 0) {
        safeMoves = [{ name: 'わるあがき', power: 50, type: 'normal' }];
    }

    // 🌟 最強パッチ: タイプデータも安全に解析する
    let safeTypes = dbPoke.types;
    if (typeof safeTypes === 'string') {
        try { safeTypes = JSON.parse(safeTypes); } catch (e) { safeTypes = []; }
    }

    return {
        dbId: dbPoke.id, pokedexId: dbPoke.pokedex_id, nickname: dbPoke.nickname, level: lv,
        hp: currentHp, maxHp: maxHp,
        atk: applyNature(Math.floor(((2 * base['attack'] + dbPoke.iv_attack) * lv) / 100) + 5, 1, nature),
        def: applyNature(Math.floor(((2 * base['defense'] + dbPoke.iv_defense) * lv) / 100) + 5, 2, nature),
        speed: applyNature(Math.floor(((2 * base['speed'] + dbPoke.iv_speed) * lv) / 100) + 5, 5, nature),
        imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
        moves: safeMoves, types: safeTypes, exp: dbPoke.exp || 0, // 👈 safeMoves と safeTypes に変更
        nature: nature
    };
}

export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();
    try {
        // 🌟 自動修復パッチ：手持ちが7匹以上いるバグ状態なら、先頭6匹を残して残りをボックスに強制送還する
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

export async function startWildBattle(interaction: ChatInputCommandInteraction, userId: string, area: string | null) {
    try {
        let { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true });
        
        // 🌟 自動修復パッチ：野生バトル開始時にも、バグで増殖した手持ちを6匹に強制カット！
        if (p1Data && p1Data.length > 6) {
            const overflowIds = p1Data.slice(6).map(p => p.id);
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
            p1Data = p1Data.slice(0, 6);
        }

        if (!p1Data || p1Data.length === 0) {
            const pokeId = await getRandomPokemonIdByArea(area);
            const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
            const data = await res.json();
            const speciesRes = await fetch(data.species.url);
            const speciesData = await speciesRes.json();
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

            // 🌟 修正：チュートリアルゲットで確実に「手持ち1匹目」として登録する！
            const { data: inserted } = await supabase.from('poke_caught_pokemons').insert([{
                owner_id: userId, original_trainer_id: userId, pokedex_id: pokeId, nickname: jaName, level: level, exp: 0, 
                nature: wildNature, iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed, current_hp: maxHp, 
                types: data.types.map((t: any) => t.type.name), moves: moves,
                is_party: true, party_order: 1 // 👈 これが抜けていたため、手持ち0匹と判定され続けていました
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

        const pokeId = await getRandomPokemonIdByArea(area);
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
        const data = await res.json();
        const speciesRes = await fetch(data.species.url);
        const speciesData = await speciesRes.json();
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        const base: any = {};
        data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

        // 🌟 ここで野生ポケモンの性格と個体値を「確定」させる
        const wildNature = NATURES[Math.floor(Math.random() * NATURES.length)];
        const iv_hp = Math.floor(Math.random() * 32); const iv_attack = Math.floor(Math.random() * 32); const iv_defense = Math.floor(Math.random() * 32);
        const iv_sp_atk = Math.floor(Math.random() * 32); const iv_sp_def = Math.floor(Math.random() * 32); const iv_speed = Math.floor(Math.random() * 32);

        const maxHp = Math.floor(((2 * base['hp'] + iv_hp) * wildLevel) / 100) + wildLevel + 10;
        const moves = await getMovesForLevel(data, wildLevel);

        const wildPoke: BattlePokemon = {
            dbId: 'wild', pokedexId: pokeId, nickname: jaName, level: wildLevel, hp: maxHp, maxHp: maxHp,
            atk: applyNature(Math.floor(((2 * base['attack'] + iv_attack) * wildLevel) / 100) + 5, 1, wildNature), 
            def: applyNature(Math.floor(((2 * base['defense'] + iv_defense) * wildLevel) / 100) + 5, 2, wildNature),
            speed: applyNature(Math.floor(((2 * base['speed'] + iv_speed) * wildLevel) / 100) + 5, 5, wildNature),
            imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
            moves: moves, types: data.types.map((t: any) => t.type.name), exp: 0,
            nature: wildNature, // 👈 確定した性格をオブジェクトに持たせる
            captureRate: speciesData.capture_rate || 45,
            wildIvs: { iv_hp, iv_attack, iv_defense, iv_sp_atk, iv_sp_def, iv_speed }
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
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${move.type}`).then(r => r.json());
        let mult = 1;
        defPoke.types.forEach(t => {
            if (typeRes.damage_relations.double_damage_to.some((d: any) => d.name === t)) mult *= 2;
            if (typeRes.damage_relations.half_damage_to.some((d: any) => d.name === t)) mult *= 0.5;
            if (typeRes.damage_relations.no_damage_to.some((d: any) => d.name === t)) mult *= 0;
        });
        if (atkPoke.types.includes(move.type)) mult *= 1.5;

        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * move.power * atkPoke.atk / defPoke.def) / 50 + 2) * mult * random);
        if (damage < 1 && mult !== 0) damage = 1;

        defPoke.hp = Math.max(0, defPoke.hp - damage);
        
        let effectLog = '';
        if (mult > 1.5) effectLog = '🌟 **こうかばつぐんだ！**\n';
        if (mult > 0 && mult < 1) effectLog = '📉 こうかはいまひとつのようだ…\n';
        if (mult === 0) effectLog = '❌ こうかがないみたいだ…\n';

        battle.log = `▶ **${atkPoke.nickname}** の **${move.name}**！\n${effectLog}💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

        if (defPoke.hp === 0) {
            let victoryLog = `\n\n💀 **${defPoke.nickname}** は たおれた！`;

            try {
                const gainedExp = defPoke.level * 20;
                let currentExp = atkPoke.exp + gainedExp;
                let currentLevel = atkPoke.level;
                let levelUpText = ''; let evolutionText = '';

                while (currentExp >= (currentLevel * currentLevel) * 50) {
                    currentLevel++;
                    levelUpText += `\n🎉 **${atkPoke.nickname}** は レベル**${currentLevel}** に上がった！`;

                    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${atkPoke.pokedexId}`);
                    const pokeData = await res.json();
                    const newMoves = await getMovesForLevel(pokeData, currentLevel);
                    if (atkPoke.moves.map(m => m.name).join() !== newMoves.map(m => m.name).join()) {
                        const learned = newMoves.find(m => !atkPoke.moves.some(om => om.name === m.name));
                        atkPoke.moves = newMoves;
                        if(learned) levelUpText += `\n💡 新しく **${learned.name}** を覚えた！`;
                    }
                    
                    const speciesData = await fetch(pokeData.species.url).then(r => r.json());
                    if (speciesData.evolution_chain) {
                        const evoData = await fetch(speciesData.evolution_chain.url).then(r => r.json());
                        const checkEvo = (chain: any): any => {
                            if (chain.species.name === speciesData.name) {
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
                            const defaultJaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || speciesData.name.toUpperCase();
                            if (atkPoke.nickname === defaultJaName) atkPoke.nickname = nextJaName;

                            const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                            atkPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                            atkPoke.pokedexId = nextId;
                            evolutionText += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                        }
                    }
                }
                atkPoke.level = currentLevel; atkPoke.exp = currentExp;
                await supabase.from('poke_caught_pokemons').update({ level: currentLevel, exp: currentExp, moves: atkPoke.moves, types: atkPoke.types, pokedex_id: atkPoke.pokedexId, nickname: atkPoke.nickname }).eq('id', atkPoke.dbId);
                victoryLog += `\n✨ **${gainedExp} EXP** をもらった！${levelUpText}${evolutionText}`;
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
                }
                battle.log += victoryLog;
                await updateBattleMessage(interaction, battleId, true);
                await saveAllHPs(battle);
                return activeBattles.delete(battleId);
            }
            defender.activeIndex = nextIdx;
            battle.log += victoryLog + `\n\n🔄 <@${defender.id}> は **${defender.party[nextIdx].nickname}** を繰り出した！`;
            
            // 🌟敵を倒して新しいポケモンが出てきた場合は、相手の反撃ターンをスキップして終わる
            return updateBattleMessage(interaction, battleId);
        }

        // 🌟🌟🌟 敵が生き残っている場合、反撃の前に「間」を作る！ 🌟🌟🌟
        // まず自分の攻撃結果だけを画面に表示する
        await updateBattleMessage(interaction, battleId);
        
        // 1.5秒待機する（敵の思考時間を演出）
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
        
        // 🌟 UX究極改善: ドキドキする「間」の演出
        const ballName = ballId.replace('_', ' ').toUpperCase();
        battle.log = `▶ **${ballName}** を投げた！\n揺れるボール……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1000); // 1秒待つ
        
        battle.log += ` コロッ……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1000); // 1秒待つ

        battle.log += ` コロッ……`;
        await updateBattleMessage(interaction, battleId);
        await sleep(1200); // 最後の判定前は少しだけ長く待つ（緊張感）
        
        if (Math.random() < finalChance) {
            battle.log += ` カチッ！\n\n🎊 やったー！ **${defPoke.nickname}** を つかまえた！`;
            
            // 🌟 修正：現在のパーティ人数をカウントして、6匹未満なら手持ちへ、超えていればボックスへ送る！
            const { count: partyCount } = await supabase.from('poke_caught_pokemons').select('*', { count: 'exact' }).eq('owner_id', interaction.user.id).eq('is_party', true);
            const isParty = (partyCount || 0) < 6;
            const partyOrder = isParty ? (partyCount || 0) + 1 : null;

            await supabase.from('poke_caught_pokemons').insert([{
                owner_id: interaction.user.id, original_trainer_id: interaction.user.id, pokedex_id: defPoke.pokedexId,
                nickname: defPoke.nickname, level: defPoke.level, exp: 0, 
                nature: defPoke.nature, iv_hp: defPoke.wildIvs.iv_hp, iv_attack: defPoke.wildIvs.iv_attack, iv_defense: defPoke.wildIvs.iv_defense,
                iv_sp_atk: defPoke.wildIvs.iv_sp_atk, iv_sp_def: defPoke.wildIvs.iv_sp_def, iv_speed: defPoke.wildIvs.iv_speed,
                current_hp: defPoke.hp, types: defPoke.types, moves: defPoke.moves,
                is_party: isParty, party_order: partyOrder // 👈 ここで空き容量に合わせて振り分ける
            }]);

            const boxText = isParty ? '手持ち' : 'ボックス';
            battle.log += `\n(${boxText}に送られました。残りボール: ${inv!.quantity - 1}個)`;
            
            await updateBattleMessage(interaction, battleId, true, true); // 🌟 前回設定した緑色背景
            await saveAllHPs(battle);
            return activeBattles.delete(battleId);
        } else {
            battle.log += ` アァッ！\n\n💨 **${defPoke.nickname}** は ボールから 抜け出してしまった！`;
            await updateBattleMessage(interaction, battleId);
            await sleep(1500); // 敵の反撃までの「悔しい間」
        }
    }

    if (battle.battleType === 'wild' && defPoke.hp > 0) {
        // 🌟 ここを追加！交代後の「新しいポケモン」のデータを取得し直す
        const currentAtkPoke = attacker.party[attacker.activeIndex];

        const randomMove = defPoke.moves[Math.floor(Math.random() * defPoke.moves.length)];
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${randomMove.type}`).then(r => r.json());
        let mult = 1;
        currentAtkPoke.types.forEach(t => {
            if (typeRes.damage_relations.double_damage_to.some((d: any) => d.name === t)) mult *= 2;
            if (typeRes.damage_relations.half_damage_to.some((d: any) => d.name === t)) mult *= 0.5;
            if (typeRes.damage_relations.no_damage_to.some((d: any) => d.name === t)) mult *= 0;
        });
        if (defPoke.types.includes(randomMove.type)) mult *= 1.5;

        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let wildDamage = Math.floor((((2 * defPoke.level / 5 + 2) * randomMove.power * defPoke.atk / currentAtkPoke.def) / 50 + 2) * mult * random);
        if (wildDamage < 1 && mult !== 0) wildDamage = 1;

        // 🌟 ダメージ計算も新しいポケモン(currentAtkPoke)を対象にする
        currentAtkPoke.hp = Math.max(0, currentAtkPoke.hp - wildDamage);

        let effectLog = '';
        if (mult > 1.5) effectLog = '🌟 **こうかばつぐんだ！**\n';
        if (mult > 0 && mult < 1) effectLog = '📉 こうかはいまひとつのようだ…\n';
        if (mult === 0) effectLog = '❌ こうかがないみたいだ…\n';

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

async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1p = battle.p1.party[battle.p1.activeIndex];
    const p2p = battle.p2.party[battle.p2.activeIndex];
    const p1Alive = battle.p1.party.filter(p => p.hp > 0).length;
    const p2Alive = battle.p2.party.filter(p => p.hp > 0).length;

    let titleText = '';
    if (isFinished) titleText = '🏁 バトル終了';
    else if (battle.battleType === 'wild') titleText = `あ！ やせいの ${p2p.nickname} が とびだしてきた！`;
    else titleText = '⚔️ ポケモンバトル 進行中！';

    // 🌟 UI改善: HPバーを生成
    const p2HpBar = generateHpBar(p2p.hp, p2p.maxHp);
    const p1HpBar = generateHpBar(p1p.hp, p1p.maxHp);

    const embed = new EmbedBuilder()
        .setTitle(titleText)
        .setDescription(battle.log)
        .setColor(isFinished ? 0x808080 : (battle.battleType === 'wild' ? 0x2E8B57 : 0xFF4500))
        .addFields(
            // 🌟 UI改善: 数字だけでなく、ゲージで直感的にHPを伝える
            { name: `🔵 相手: ${battle.battleType === 'pvp' ? `<@${battle.p2.id}>` : '野生'}`, value: `**${p2p.nickname}** Lv.${p2p.level}\n${p2HpBar} [ **${p2p.hp}** / ${p2p.maxHp} ]\n(残り: ${p2Alive}匹)`, inline: false },
            { name: `🔴 自分: <@${battle.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level}\n${p1HpBar} [ **${p1p.hp}** / ${p1p.maxHp} ]\n(残り: ${p1Alive}匹)`, inline: false }
        )
        .setImage(p2p.imageUrl)
        .setThumbnail(p1p.imageUrl);

    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            ...(battle.battleType === 'wild' ? [new ButtonBuilder().setCustomId(`btl_bag_${battleId}`).setLabel('バッグ').setStyle(ButtonStyle.Success).setEmoji('🎒')] : []),
            new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel(battle.battleType === 'pvp' ? '降参する' : 'にげる').setStyle(ButtonStyle.Secondary).setEmoji(battle.battleType === 'pvp' ? '🏳️' : '💨')
        )
    ];

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components });
    } else {
        await interaction.update({ embeds: [embed], components });
    }
}
