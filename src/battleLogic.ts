// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { supabase } from './pokeDb';
import { getMovesForLevel } from './pokeApiUtils'; // レベルアップ時の技習得用

// ==========================================
// 🧠 バトルの状態・構造体
// ==========================================
const activeBattles = new Map<string, BattleState>();

interface BattleMove {
    name: string;
    power: number;
    type: string;
}

interface BattlePokemon {
    dbId: string; 
    pokedexId: number; 
    nickname: string; 
    level: number;
    hp: number; 
    maxHp: number;
    atk: number; 
    def: number; 
    speed: number;
    imageUrl: string; 
    moves: BattleMove[]; 
    types: string[];
    exp: number; // 経験値もメモリで管理
}

interface Player {
    id: string; 
    name: string; 
    party: BattlePokemon[]; 
    activeIndex: number; 
}

interface BattleState {
    id: string; 
    p1: Player; 
    p2: Player; 
    currentTurnUserId: string; 
    log: string; 
}

// ==========================================
// 💾 バトル終了時のHP一括保存関数
// ==========================================
async function saveAllHPs(battle: BattleState) {
    const promises: any[] = [];
    
    // 挑戦者(p1)のHPを保存
    battle.p1.party.forEach(p => {
        promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.hp }).eq('id', p.dbId));
    });
    
    // 相手(p2)のHPを保存
    battle.p2.party.forEach(p => {
        promises.push(supabase.from('poke_caught_pokemons').update({ current_hp: p.hp }).eq('id', p.dbId));
    });

    await Promise.all(promises);
}

// ==========================================
// 🛠️ ポケモン生成（技とタイプはDBから爆速読み込み）
// ==========================================
async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    // ステータス計算と画像URL取得のため、最低限のAPI通信を行う
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    
    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const lv = dbPoke.level;
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp) * lv) / 100) + lv + 10;
    
    // DBに保存された current_hp を使う。上限はmaxHpにキャップする（回復対応）
    let currentHp = dbPoke.current_hp;
    if (currentHp > maxHp) {
        currentHp = maxHp; 
    }

    return {
        dbId: dbPoke.id, 
        pokedexId: dbPoke.pokedex_id, 
        nickname: dbPoke.nickname, 
        level: lv,
        hp: currentHp, 
        maxHp: maxHp,
        atk: Math.floor(((2 * base['attack'] + dbPoke.iv_attack) * lv) / 100) + 5,
        def: Math.floor(((2 * base['defense'] + dbPoke.iv_defense) * lv) / 100) + 5,
        speed: Math.floor(((2 * base['speed'] + dbPoke.iv_speed) * lv) / 100) + 5,
        imageUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
        moves: dbPoke.moves, // DBから直接読み込み（API通信不要）
        types: dbPoke.types, // DBから直接読み込み（API通信不要）
        exp: dbPoke.exp || 0
    };
}

// ==========================================
// ⚔️ バトル開始処理
// ==========================================
export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();

    try {
        const fetchParty = (uid: string) => supabase.from('poke_caught_pokemons').select('*').eq('owner_id', uid).eq('is_party', true).order('party_order', { ascending: true });
        
        const [{ data: p1Data }, { data: p2Data }] = await Promise.all([
            fetchParty(challengerId), 
            fetchParty(targetId)
        ]);

        if (!p1Data?.length || !p2Data?.length) {
            return interaction.followUp('パーティ情報の取得に失敗しました。');
        }

        const [p1Party, p2Party] = await Promise.all([
            Promise.all(p1Data.map(p => buildBattlePokemon(p))),
            Promise.all(p2Data.map(p => buildBattlePokemon(p)))
        ]);

        // HPが全員0ならバトルできない
        if (p1Party.every(p => p.hp <= 0)) {
            return interaction.followUp('手持ちのポケモンが全員ひんし状態です！ `/heal` を使ってください。');
        }

        // 最初のポケモンが瀕死なら、生きているポケモンまでインデックスをずらす
        const p1Active = p1Party.findIndex(p => p.hp > 0);
        const p2Active = p2Party.findIndex(p => p.hp > 0);

        const battle: BattleState = {
            id: interaction.message.id,
            p1: { id: challengerId, name: '挑戦者', party: p1Party, activeIndex: p1Active !== -1 ? p1Active : 0 },
            p2: { id: targetId, name: '相手', party: p2Party, activeIndex: p2Active !== -1 ? p2Active : 0 },
            currentTurnUserId: p1Party[p1Active].speed >= p2Party[p2Active].speed ? challengerId : targetId,
            log: '**バトル開始！**'
        };

        activeBattles.set(battle.id, battle);
        await updateBattleMessage(interaction, battle.id);

    } catch (e) { 
        console.error(e); 
        await interaction.followUp('バトル開始エラー'); 
    }
}

// ==========================================
// 🎮 バトルの行動処理
// ==========================================
export async function handleBattleAction(interaction: MessageComponentInteraction, battleId: string, action: string) {
    const battle = activeBattles.get(battleId);
    
    if (!battle) {
        return interaction.reply({ content: '無効なバトルです。', ephemeral: true });
    }
    if (interaction.user.id !== battle.currentTurnUserId) {
        return interaction.reply({ content: '今は相手のターンです。', ephemeral: true });
    }

    await interaction.deferUpdate();
    
    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    // ── 1. 「たたかう」を押した時（技一覧） ──
    if (action === 'attack') {
        const moveButtons = atkPoke.moves.map((move, index) => {
            return new ButtonBuilder()
                .setCustomId(`btl_usemove_${battleId}_${index}`)
                .setLabel(move.name)
                .setStyle(ButtonStyle.Danger);
        });

        const backBtn = new ButtonBuilder()
            .setCustomId(`btl_back_${battleId}`)
            .setLabel('もどる')
            .setStyle(ButtonStyle.Secondary);

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(...moveButtons);
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

        return interaction.editReply({ components: [row1, row2] });
    }

    // ── 2. 「ポケモン」を押した時（交代画面） ──
    if (action === 'switchmenu') {
        const switchButtons = attacker.party.map((p, i) => {
            return new ButtonBuilder()
                .setCustomId(`btl_switch_${battleId}_${i}`)
                .setLabel(`${p.nickname} (HP:${p.hp})`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(i === attacker.activeIndex || p.hp <= 0);
        });

        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < switchButtons.length; i += 5) {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
        }

        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        if (rows[rows.length - 1].components.length < 5) {
            rows[rows.length - 1].addComponents(backBtn);
        } else {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn));
        }

        return interaction.editReply({ components: rows });
    }

    // ── 3. 実際にポケモンを交代した時 ──
    if (action === 'switch') {
        attacker.activeIndex = parseInt(interaction.customId.split('_')[3]);
        battle.log = `🔄 <@${attacker.id}> は **${attacker.party[attacker.activeIndex].nickname}** を繰り出した！`;
        battle.currentTurnUserId = defender.id;
        return updateBattleMessage(interaction, battleId);
    }

    // ── 4. 技を使った時の処理 ──
    if (action === 'usemove') {
        const move = atkPoke.moves[parseInt(interaction.customId.split('_')[3])];
        
        // タイプ相性の取得と判定
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${move.type}`).then(r => r.json());
        let mult = 1;
        defPoke.types.forEach(t => {
            if (typeRes.damage_relations.double_damage_to.some((d: any) => d.name === t)) mult *= 2;
            if (typeRes.damage_relations.half_damage_to.some((d: any) => d.name === t)) mult *= 0.5;
            if (typeRes.damage_relations.no_damage_to.some((d: any) => d.name === t)) mult *= 0;
        });

        // タイプ一致ボーナス
        if (atkPoke.types.includes(move.type)) mult *= 1.5;

        // ダメージ計算
        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * move.power * atkPoke.atk / defPoke.def) / 50 + 2) * mult * random);
        if (damage < 1 && mult !== 0) damage = 1;

        defPoke.hp = Math.max(0, defPoke.hp - damage);
        
        // ログの作成
        let effectLog = '';
        if (mult > 1.5) effectLog = '🌟 **こうかばつぐんだ！**\n';
        if (mult > 0 && mult < 1) effectLog = '📉 こうかはいまひとつのようだ…\n';
        if (mult === 0) effectLog = '❌ こうかがないみたいだ…\n';

        battle.log = `▶ **${atkPoke.nickname}** の **${move.name}**！\n${effectLog}💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

        // --- 🏆 倒した時の処理 ---
        if (defPoke.hp === 0) {
            let victoryLog = `\n\n💀 **${defPoke.nickname}** は たおれた！`;

            // 🌟 レベルアップ・進化・技習得の処理
            try {
                const gainedExp = defPoke.level * 20; // 経験値調整
                let currentExp = atkPoke.exp + gainedExp;
                let currentLevel = atkPoke.level;
                let levelUpText = '';
                let evolutionText = '';

                // EXP計算式の変更: level^2 * 50
                const getRequiredExp = (lv: number) => (lv * lv) * 50;

                while (currentExp >= getRequiredExp(currentLevel)) {
                    currentLevel++;
                    levelUpText += `\n🎉 **${atkPoke.nickname}** は レベル**${currentLevel}** に上がった！`;

                    // 💡 新しい技の習得チェック
                    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${atkPoke.pokedexId}`);
                    const pokeData = await res.json();
                    const newMoves = await getMovesForLevel(pokeData, currentLevel);
                    
                    const oldMoveNames = atkPoke.moves.map(m => m.name).join();
                    const newMoveNames = newMoves.map(m => m.name).join();
                    
                    if (oldMoveNames !== newMoveNames) {
                        const learned = newMoves.find(m => !atkPoke.moves.some(om => om.name === m.name));
                        atkPoke.moves = newMoves;
                        if(learned) levelUpText += `\n💡 新しく **${learned.name}** を覚えた！`;
                    }
                    
                    // ✨ 進化チェック
                    const speciesRes = await fetch(pokeData.species.url);
                    const speciesData = await speciesRes.json();
                    if (speciesData.evolution_chain) {
                        const evoRes = await fetch(speciesData.evolution_chain.url);
                        const evoData = await evoRes.json();
                        
                        const checkEvo = (chain: any): any => {
                            if (chain.species.name === speciesData.name) {
                                for (const next of chain.evolves_to) {
                                    const details = next.evolution_details[0];
                                    if (details && details.min_level && currentLevel >= details.min_level) return next;
                                }
                            }
                            for (const next of chain.evolves_to) {
                                const result = checkEvo(next);
                                if (result) return result;
                            }
                            return null;
                        };

                        const nextEvo = checkEvo(evoData.chain);
                        if (nextEvo) {
                            const nextId = parseInt(nextEvo.species.url.split('/').filter(Boolean).pop()!);
                            const nextSpeciesRes = await fetch(nextEvo.species.url);
                            const nextSpeciesData = await nextSpeciesRes.json();
                            const nextJaName = nextSpeciesData.names.find((n: any) => n.language.name === 'ja')?.name || nextEvo.species.name;

                            // ニックネームがデフォルトなら新しい名前に更新
                            const defaultJaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || speciesData.name.toUpperCase();
                            if (atkPoke.nickname === defaultJaName) atkPoke.nickname = nextJaName;

                            // 進化後のタイプを取得して更新
                            const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                            atkPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                            atkPoke.pokedexId = nextId;
                            
                            evolutionText += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                        }
                    }
                }

                atkPoke.level = currentLevel; 
                atkPoke.exp = currentExp;

                // DBを更新 (現在の状態をセーブ)
                await supabase.from('poke_caught_pokemons').update({ 
                    level: currentLevel, 
                    exp: currentExp, 
                    moves: atkPoke.moves, 
                    types: atkPoke.types,
                    pokedex_id: atkPoke.pokedexId, 
                    nickname: atkPoke.nickname 
                }).eq('id', atkPoke.dbId);

                victoryLog += `\n✨ **${gainedExp} EXP** をもらった！${levelUpText}${evolutionText}`;
                
            } catch (e) { 
                console.error("EXP・進化処理エラー:", e); 
            }

            // 相手のパーティ全滅チェック
            const nextIdx = defender.party.findIndex(p => p.hp > 0);
            
            if (nextIdx === -1) {
                // 全滅させた場合（完全勝利）
                victoryLog += `\n\n🏆 **<@${attacker.id}> の勝利！**`;
                
                // バトル勝利報酬・ランキング更新
                try {
                    const { data: u } = await supabase.from('poke_users').select('money, wins, win_streak, max_win_streak').eq('discord_id', attacker.id).single();
                    const newStreak = (u?.win_streak || 0) + 1;
                    const newMaxStreak = Math.max(newStreak, u?.max_win_streak || 0);
                    
                    await supabase.from('poke_users').update({ 
                        money: (u?.money || 0) + 500, 
                        wins: (u?.wins || 0) + 1, 
                        win_streak: newStreak, 
                        max_win_streak: newMaxStreak 
                    }).eq('discord_id', attacker.id);
                    
                    // 敗者の連勝ストップ
                    await supabase.from('poke_users').update({ win_streak: 0 }).eq('discord_id', defender.id);

                    victoryLog += `\n💰 賞金 **500円** を手に入れた！`;
                } catch (e) { 
                    console.error("報酬付与エラー:", e); 
                }

                battle.log += victoryLog;
                await updateBattleMessage(interaction, battleId, true);
                await saveAllHPs(battle); // 💾 HP一括セーブ
                return activeBattles.delete(battleId);
            }

            // まだ生き残りがいる場合
            defender.activeIndex = nextIdx;
            battle.log += victoryLog + `\n\n🔄 <@${defender.id}> は **${defender.party[nextIdx].nickname}** を繰り出した！`;
        }

        // 次のターンへ
        battle.currentTurnUserId = defender.id;
    }

    // ── 5. 「もどる」を押した時 ──
    if (action === 'back') {
        return updateBattleMessage(interaction, battleId);
    }

    // ── 6. 「にげる」を押した時 ──
    if (action === 'run') {
        battle.log = `💨 <@${attacker.id}> は逃げ出した！`;
        await updateBattleMessage(interaction, battleId, true);
        await saveAllHPs(battle); // 💾 HP一括セーブ
        return activeBattles.delete(battleId);
    }

    // デフォルトの画面更新
    await updateBattleMessage(interaction, battleId);
}

// ==========================================
// 📺 画面更新用ヘルパー関数
// ==========================================
async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1p = battle.p1.party[battle.p1.activeIndex];
    const p2p = battle.p2.party[battle.p2.activeIndex];
    
    // パーティの生存数を計算
    const p1Alive = battle.p1.party.filter(p => p.hp > 0).length;
    const p2Alive = battle.p2.party.filter(p => p.hp > 0).length;

    const embed = new EmbedBuilder()
        .setTitle(isFinished ? '🏁 バトル終了' : '⚔️ ポケモンバトル 進行中！')
        .setDescription(battle.log)
        .setColor(isFinished ? 0x808080 : 0xFF4500)
        .addFields(
            { name: `🔵 相手: <@${battle.p2.id}>`, value: `**${p2p.nickname}** Lv.${p2p.level}\n❤️ HP: **${p2p.hp}** / ${p2p.maxHp}\n(残りポケモン: ${p2Alive}匹)`, inline: false },
            { name: `🔴 挑戦者: <@${battle.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level}\n❤️ HP: **${p1p.hp}** / ${p1p.maxHp}\n(残りポケモン: ${p1Alive}匹)`, inline: false }
        )
        .setImage(p1p.imageUrl)
        .setThumbnail(p2p.imageUrl);

    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨')
        )
    ];

    await interaction.editReply({ embeds: [embed], components });
}
