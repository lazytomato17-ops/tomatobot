// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { supabase } from './pokeDb';

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
    dbId: string; nickname: string; level: number;
    hp: number; maxHp: number;
    atk: number; def: number; speed: number;
    imageUrl: string;
    moves: BattleMove[];
    types: string[];
}

interface Player {
    id: string; name: string;
    party: BattlePokemon[]; activeIndex: number;
}

interface BattleState {
    id: string; p1: Player; p2: Player;
    currentTurnUserId: string; log: string;
}

// ==========================================
// 🛠️ ポケモン生成（＋技とタイプの取得）
// ==========================================
async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const pokeTypes = data.types.map((t: any) => t.type.name);

    // ✅ 修正：ランダムを廃止し、本家のように「レベルアップで覚える技」をレベルの高い順に取得
    const levelUpMoves = data.moves
        .map((m: any) => {
            const levelDetails = m.version_group_details.filter((v: any) => v.move_learn_method.name === 'level-up');
            if (levelDetails.length === 0) return null;
            const maxLevel = Math.max(...levelDetails.map((v: any) => v.level_learned_at));
            return { url: m.move.url, level: maxLevel };
        })
        .filter((m: any) => m !== null && m.level > 0 && m.level <= dbPoke.level) // 現在のレベル以下で覚える技
        .sort((a: any, b: any) => b.level - a.level); // 最近覚えた強力な技を上に

    const validMoves: BattleMove[] = [];
    // 上位10個の中から、威力が設定されている攻撃技を4つ選出
    const movePromises = levelUpMoves.slice(0, 10).map((m: any) => fetch(m.url).then(r => r.json()).catch(() => null));
    const fetchedMoves = await Promise.all(movePromises);
    
    for (const mData of fetchedMoves) {
        if (mData && mData.power && validMoves.length < 4) {
            const jaName = mData.names.find((n:any)=>n.language.name==='ja-Hrkt' || n.language.name==='ja')?.name || mData.name;
            validMoves.push({ name: jaName, power: mData.power, type: mData.type.name });
        }
    }
    if (validMoves.length === 0) validMoves.push({ name: 'たいあたり', power: 40, type: 'normal' });

    const lv = dbPoke.level;
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp) * lv) / 100) + lv + 10;
    
    return {
        dbId: dbPoke.id, nickname: dbPoke.nickname, level: lv,
        hp: dbPoke.current_hp > 0 ? dbPoke.current_hp : maxHp, maxHp: maxHp,
        atk: Math.floor(((2 * base['attack'] + dbPoke.iv_attack) * lv) / 100) + 5,
        def: Math.floor(((2 * base['defense'] + dbPoke.iv_defense) * lv) / 100) + 5,
        speed: Math.floor(((2 * base['speed'] + dbPoke.iv_speed) * lv) / 100) + 5,
        imageUrl: data.sprites.front_default || data.sprites.other['official-artwork'].front_default,
        moves: validMoves,
        types: pokeTypes
    };
}

// ==========================================
// ⚔️ バトル開始処理
// ==========================================
export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();
    try {
        const { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', challengerId).eq('is_party', true);
        const { data: p2Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', targetId).eq('is_party', true);

        if (!p1Data?.length || !p2Data?.length) return interaction.followUp('手持ちエラーのためバトルを中止しました。');

        // ✅ 修正：先頭の1匹だけでなく、手持ち（最大6匹）すべてをバトル用に構築
        const p1Party = await Promise.all(p1Data.map(p => buildBattlePokemon(p)));
        const p2Party = await Promise.all(p2Data.map(p => buildBattlePokemon(p)));

        const p1: Player = { id: challengerId, name: '挑戦者', party: p1Party, activeIndex: 0 };
        const p2: Player = { id: targetId, name: '相手', party: p2Party, activeIndex: 0 };

        const battleId = interaction.message.id;
        const firstTurnId = p1.party[0].speed >= p2.party[0].speed ? p1.id : p2.id;

        const battle: BattleState = {
            id: battleId, p1, p2, currentTurnUserId: firstTurnId,
            log: `**バトル開始！**\n素早さの高い <@${firstTurnId}> の先制だ！`
        };

        activeBattles.set(battleId, battle);
        await updateBattleMessage(interaction, battleId);
    } catch (e) {
        console.error(e);
        await interaction.followUp('バトル初期化エラー（通信に時間がかかった可能性があります）');
    }
}

// ==========================================
// 🎮 バトルの行動処理
// ==========================================
export async function handleBattleAction(interaction: MessageComponentInteraction, battleId: string, action: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return interaction.reply({ content: 'このバトルは既に終了しているか無効です。', ephemeral: true });
    if (interaction.user.id !== battle.currentTurnUserId) return interaction.reply({ content: '⏳ 今は相手のターンです！待機してください。', ephemeral: true });

    await interaction.deferUpdate();

    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    // ── 1. 「たたかう」を押した時（技一覧） ──
    if (action === 'attack') {
        const moveButtons = atkPoke.moves.map((move, index) => {
            return new ButtonBuilder().setCustomId(`btl_usemove_${battleId}_${index}`).setLabel(`${move.name}`).setStyle(ButtonStyle.Danger);
        });
        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        await interaction.editReply({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...moveButtons), new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn)] });
        return;
    }

    // ── 2. 「ポケモン」を押した時（交代画面） ──
    if (action === 'switchmenu') {
        const switchButtons = attacker.party.map((poke, index) => {
            const btn = new ButtonBuilder()
                .setCustomId(`btl_switch_${battleId}_${index}`)
                .setLabel(`${poke.nickname} (HP:${poke.hp}/${poke.maxHp})`)
                .setStyle(ButtonStyle.Success);
            if (index === attacker.activeIndex || poke.hp === 0) btn.setDisabled(true); // 戦闘中や瀕死のポケモンは選べない
            return btn;
        });

        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        
        // 最大5個ずつボタンを並べる（Discordの仕様）
        for (let i = 0; i < switchButtons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
        const lastRow = rows[rows.length - 1];
        if (lastRow.components.length < 5) lastRow.addComponents(backBtn);
        else rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn));

        await interaction.editReply({ components: rows });
        return;
    }

    // ── 3. 実際にポケモンを交代した時 ──
    if (action === 'switch') {
        const targetIndex = parseInt(interaction.customId.split('_')[3], 10);
        attacker.activeIndex = targetIndex;
        const newPoke = attacker.party[targetIndex];
        
        battle.log = `🔄 <@${attacker.id}> は **${newPoke.nickname}** を繰り出した！`;
        battle.currentTurnUserId = defender.id; // 交代したら相手のターン
        await updateBattleMessage(interaction, battleId);
        return;
    }

    // ── 4. 「もどる」を押した時 ──
    if (action === 'back') {
        await updateBattleMessage(interaction, battleId);
        return;
    }

    // ── 5. 「にげる」を押した時 ──
    if (action === 'run') {
        battle.log = `💨 <@${attacker.id}> は 逃げ出した！\nバトル終了！`;
        await updateBattleMessage(interaction, battleId, true);
        activeBattles.delete(battleId);
        return;
    }

    // ── 6. 技を使った時の処理 ──
    if (action === 'usemove') {
        const moveIndex = parseInt(interaction.customId.split('_')[3], 10);
        const selectedMove = atkPoke.moves[moveIndex];

        // タイプ相性の判定
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${selectedMove.type}`);
        const typeData = await typeRes.json();
        let multiplier = 1;
        defPoke.types.forEach(defType => {
            if (typeData.damage_relations.double_damage_to.some((t:any) => t.name === defType)) multiplier *= 2;
            if (typeData.damage_relations.half_damage_to.some((t:any) => t.name === defType)) multiplier *= 0.5;
            if (typeData.damage_relations.no_damage_to.some((t:any) => t.name === defType)) multiplier *= 0;
        });
        if (atkPoke.types.includes(selectedMove.type)) multiplier *= 1.5;

        // ダメージ計算
        const power = selectedMove.power;
        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * power * atkPoke.atk / defPoke.def) / 50 + 2) * multiplier * random);
        if (damage < 1 && multiplier !== 0) damage = 1;

        defPoke.hp -= damage;
        if (defPoke.hp < 0) defPoke.hp = 0;

        let effectLog = '';
        if (multiplier > 1.5) effectLog = '🌟 **こうかばつぐんだ！**\n';
        if (multiplier > 0 && multiplier < 1) effectLog = '📉 こうかはいまひとつのようだ…\n';
        if (multiplier === 0) effectLog = '❌ こうかがないみたいだ…\n';

        battle.log = `▶ **${atkPoke.nickname}** の **${selectedMove.name}**！\n${effectLog}💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

        // --- 🏆 倒した時の処理 ---
        if (defPoke.hp === 0) {
            let victoryLog = `\n\n💀 **${defPoke.nickname}** は たおれた！`;

            // ✅ 個別撃破時の経験値付与
            try {
                const gainedExp = defPoke.level * 10;
                const { data: pokeData } = await supabase.from('poke_caught_pokemons').select('level, exp').eq('id', atkPoke.dbId).single();
                if (pokeData) {
                    let currentExp = pokeData.exp + gainedExp;
                    let currentLevel = pokeData.level;
                    let levelUpText = '';
                    while (currentExp >= currentLevel * 100) {
                        currentExp -= currentLevel * 100;
                        currentLevel++;
                        levelUpText += `\n🎉 **${atkPoke.nickname}** は レベル**${currentLevel}** に上がった！`;
                    }
                    await supabase.from('poke_caught_pokemons').update({ level: currentLevel, exp: currentExp }).eq('id', atkPoke.dbId);
                    atkPoke.level = currentLevel; // メモリも更新
                    victoryLog += `\n✨ **${atkPoke.nickname}** は **${gainedExp} EXP** をもらった！${levelUpText}`;
                }
            } catch (e) { console.error(e); }

            // ✅ 相手のパーティに残り（生きているポケモン）がいるか確認
            const nextPokeIndex = defender.party.findIndex(p => p.hp > 0);
            
            if (nextPokeIndex === -1) {
                // 全滅させた場合（完全勝利）
                victoryLog += `\n\n🏆 **${attacker.name} (<@${attacker.id}>) の勝利！**`;
                try {
                    const { data: userData } = await supabase.from('poke_users').select('money').eq('discord_id', attacker.id).single();
                    const newMoney = (userData?.money || 0) + 500;
                    await supabase.from('poke_users').update({ money: newMoney }).eq('discord_id', attacker.id);
                    victoryLog += `\n💰 賞金 **500円** を手に入れた！`;
                } catch (e) { console.error(e); }

                battle.log += victoryLog;
                await updateBattleMessage(interaction, battleId, true);
                activeBattles.delete(battleId);
                return;
            } else {
                // まだ生き残りがいる場合（自動で次のポケモンを出す）
                defender.activeIndex = nextPokeIndex;
                const nextPoke = defender.party[nextPokeIndex];
                victoryLog += `\n\n🔄 <@${defender.id}> は **${nextPoke.nickname}** を繰り出した！`;
                
                battle.log += victoryLog;
                battle.currentTurnUserId = defender.id; // 相手のターンに
                await updateBattleMessage(interaction, battleId);
                return;
            }
        }

        // 倒れなかった場合は普通にターン交代
        battle.currentTurnUserId = defender.id;
        await updateBattleMessage(interaction, battleId);
        return;
    }
}

// ==========================================
// 📺 画面更新用ヘルパー関数
// ==========================================
async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1Poke = battle.p1.party[battle.p1.activeIndex];
    const p2Poke = battle.p2.party[battle.p2.activeIndex];

    // パーティの生存数を計算
    const p1AliveCount = battle.p1.party.filter(p => p.hp > 0).length;
    const p2AliveCount = battle.p2.party.filter(p => p.hp > 0).length;

    const embed = new EmbedBuilder()
        .setTitle(isFinished ? '🏁 バトル終了' : '⚔️ ポケモンバトル 進行中！')
        .setColor(isFinished ? 0x808080 : 0xFF4500)
        .setDescription(`**📜 バトルログ**\n${battle.log}`)
        .addFields(
            { name: `🔵 相手: <@${battle.p2.id}>`, value: `**${p2Poke.nickname}** Lv.${p2Poke.level}\n❤️ HP: **${p2Poke.hp}** / ${p2Poke.maxHp}\n(残りポケモン: ${p2AliveCount}匹)`, inline: false },
            { name: `🔴 挑戦者: <@${battle.p1.id}>`, value: `**${p1Poke.nickname}** Lv.${p1Poke.level}\n❤️ HP: **${p1Poke.hp}** / ${p1Poke.maxHp}\n(残りポケモン: ${p1AliveCount}匹)`, inline: false }
        )
        .setThumbnail(p2Poke.imageUrl)
        .setImage(p1Poke.imageUrl);

    // ✅ 修正：「ポケモン（交代）」ボタンをメイン画面に追加
    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨')
        )
    ];

    await interaction.editReply({ embeds: [embed], components });
}
