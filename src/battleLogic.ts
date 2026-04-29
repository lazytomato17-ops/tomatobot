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
    leadSelected: boolean; // 先頭ポケモン選択済みフラグ
}

interface BattleState {
    id: string; p1: Player; p2: Player;
    currentTurnUserId: string; log: string;
    phase: 'select_lead' | 'battle'; // バトルのフェーズ
    forcedSwitchUserId?: string;     // 強制交代待ちのユーザーID（倒れた後）
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

    const levelUpMoves = data.moves
        .map((m: any) => {
            const levelDetails = m.version_group_details.filter((v: any) => v.move_learn_method.name === 'level-up');
            if (levelDetails.length === 0) return null;
            const maxLevel = Math.max(...levelDetails.map((v: any) => v.level_learned_at));
            return { url: m.move.url, level: maxLevel };
        })
        .filter((m: any) => m !== null && m.level > 0 && m.level <= dbPoke.level)
        .sort((a: any, b: any) => b.level - a.level);

    const validMoves: BattleMove[] = [];
    const movePromises = levelUpMoves.slice(0, 10).map((m: any) => fetch(m.url).then(r => r.json()).catch(() => null));
    const fetchedMoves = await Promise.all(movePromises);

    for (const mData of fetchedMoves) {
        if (mData && mData.power && validMoves.length < 4) {
            const jaName = mData.names.find((n: any) => n.language.name === 'ja-Hrkt' || n.language.name === 'ja')?.name || mData.name;
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

        const p1Party = await Promise.all(p1Data.map(p => buildBattlePokemon(p)));
        const p2Party = await Promise.all(p2Data.map(p => buildBattlePokemon(p)));

        // ── 2匹以上の場合は先頭選択フェーズへ、1匹ずつなら即バトル開始 ──
        const needLeadSelect = p1Party.length > 1 || p2Party.length > 1;

        const p1: Player = {
            id: challengerId, name: '挑戦者', party: p1Party, activeIndex: 0,
            leadSelected: !needLeadSelect
        };
        const p2: Player = {
            id: targetId, name: '相手', party: p2Party, activeIndex: 0,
            leadSelected: !needLeadSelect
        };

        const battleId = interaction.message.id;
        let phase: 'select_lead' | 'battle';
        let firstTurnId: string;
        let initialLog: string;

        if (needLeadSelect) {
            phase = 'select_lead';
            firstTurnId = challengerId; // 先頭選択中はターン不問
            initialLog = '**両プレイヤーは先頭ポケモンを選んでください！**\n下のボタンからバトルに出すポケモンを選択してください。';
        } else {
            phase = 'battle';
            firstTurnId = p1Party[0].speed >= p2Party[0].speed ? p1.id : p2.id;
            initialLog = `**バトル開始！**\n素早さの高い <@${firstTurnId}> の先制だ！`;
        }

        const battle: BattleState = {
            id: battleId, p1, p2,
            currentTurnUserId: firstTurnId,
            log: initialLog,
            phase
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

    // ══════════════════════════════════════════════════
    // 特殊アクション①：先頭ポケモン選択（ターン順不問）
    // ══════════════════════════════════════════════════
    if (action === 'leadselect') {
        const parts = interaction.customId.split('_');
        // customId: btl_leadselect_{battleId}_{p1orP2}_{index}
        const targetPlayer = parts[3]; // 'p1' or 'p2'
        const pokeIndex = parseInt(parts[4], 10);

        // 正しいプレイヤーだけ操作できる
        const isP1Correct = targetPlayer === 'p1' && interaction.user.id === battle.p1.id;
        const isP2Correct = targetPlayer === 'p2' && interaction.user.id === battle.p2.id;
        if (!isP1Correct && !isP2Correct) {
            return interaction.reply({ content: '❌ これはあなたのボタンではありません！', ephemeral: true });
        }

        // 既に選択済みなら無視
        const already = (targetPlayer === 'p1' && battle.p1.leadSelected) || (targetPlayer === 'p2' && battle.p2.leadSelected);
        if (already) return interaction.reply({ content: '✅ あなたは既に選択しています！', ephemeral: true });

        await interaction.deferUpdate();

        if (targetPlayer === 'p1') {
            battle.p1.activeIndex = pokeIndex;
            battle.p1.leadSelected = true;
        } else {
            battle.p2.activeIndex = pokeIndex;
            battle.p2.leadSelected = true;
        }

        // 両プレイヤーが選んだらバトル開始
        if (battle.p1.leadSelected && battle.p2.leadSelected) {
            battle.phase = 'battle';
            const p1Poke = battle.p1.party[battle.p1.activeIndex];
            const p2Poke = battle.p2.party[battle.p2.activeIndex];
            battle.currentTurnUserId = p1Poke.speed >= p2Poke.speed ? battle.p1.id : battle.p2.id;
            battle.log =
                `**バトル開始！**\n` +
                `🔴 **${p1Poke.nickname}** vs 🔵 **${p2Poke.nickname}**\n` +
                `素早さの高い <@${battle.currentTurnUserId}> の先制だ！`;
        } else {
            // まだ片方が選んでいない
            const who = targetPlayer === 'p1' ? battle.p1 : battle.p2;
            battle.log =
                `<@${who.id}> が **${who.party[pokeIndex].nickname}** を選んだ！\n` +
                `もう一方のプレイヤーの選択を待っています...`;
        }

        await updateBattleMessage(interaction, battleId);
        return;
    }

    // ══════════════════════════════════════════════════
    // 特殊アクション②：強制交代（倒れた後のポケモン選択）
    // ══════════════════════════════════════════════════
    if (action === 'forceswitch') {
        if (!battle.forcedSwitchUserId || interaction.user.id !== battle.forcedSwitchUserId) {
            return interaction.reply({ content: '❌ 今はあなたがポケモンを選ぶ時間ではありません！', ephemeral: true });
        }

        await interaction.deferUpdate();

        // customId: btl_forceswitch_{battleId}_{index}
        const switchIndex = parseInt(interaction.customId.split('_')[3], 10);
        const isP1 = interaction.user.id === battle.p1.id;
        const switcher = isP1 ? battle.p1 : battle.p2;

        if (switcher.party[switchIndex].hp <= 0) {
            // 念のためチェック（UI上は瀕死のボタンを無効化しているので通常来ない）
            return;
        }

        switcher.activeIndex = switchIndex;
        const newPoke = switcher.party[switchIndex];

        battle.log += `\n🔄 <@${switcher.id}> は **${newPoke.nickname}** を繰り出した！`;
        battle.forcedSwitchUserId = undefined;
        battle.currentTurnUserId = switcher.id; // 交代後はこのプレイヤーのターン
        await updateBattleMessage(interaction, battleId);
        return;
    }

    // ══════════════════════════════════════════════════
    // 通常アクション（ターンチェック）
    // ══════════════════════════════════════════════════
    if (interaction.user.id !== battle.currentTurnUserId) {
        return interaction.reply({ content: '⏳ 今は相手のターンです！待機してください。', ephemeral: true });
    }

    await interaction.deferUpdate();

    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    // ── 1. 「たたかう」を押した時（技一覧） ──
    if (action === 'attack') {
        const moveButtons = atkPoke.moves.map((move, index) =>
            new ButtonBuilder().setCustomId(`btl_usemove_${battleId}_${index}`).setLabel(`${move.name}`).setStyle(ButtonStyle.Danger)
        );
        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        await interaction.editReply({
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...moveButtons),
                new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn)
            ]
        });
        return;
    }

    // ── 2. 「ポケモン」を押した時（交代画面） ──
    if (action === 'switchmenu') {
        const switchButtons = attacker.party.map((poke, index) => {
            const btn = new ButtonBuilder()
                .setCustomId(`btl_switch_${battleId}_${index}`)
                .setLabel(`${poke.nickname} (HP:${poke.hp}/${poke.maxHp})`)
                .setStyle(ButtonStyle.Success);
            if (index === attacker.activeIndex || poke.hp === 0) btn.setDisabled(true);
            return btn;
        });

        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
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
        battle.currentTurnUserId = defender.id;
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

        // タイプ相性
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${selectedMove.type}`);
        const typeData = await typeRes.json();
        let multiplier = 1;
        defPoke.types.forEach(defType => {
            if (typeData.damage_relations.double_damage_to.some((t: any) => t.name === defType)) multiplier *= 2;
            if (typeData.damage_relations.half_damage_to.some((t: any) => t.name === defType)) multiplier *= 0.5;
            if (typeData.damage_relations.no_damage_to.some((t: any) => t.name === defType)) multiplier *= 0;
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

            // 個別撃破時の経験値付与
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
                    atkPoke.level = currentLevel;
                    victoryLog += `\n✨ **${atkPoke.nickname}** は **${gainedExp} EXP** をもらった！${levelUpText}`;
                }
            } catch (e) { console.error(e); }

            // 相手のパーティに残りがいるか確認
            const nextPokeIndex = defender.party.findIndex(p => p.hp > 0);

            if (nextPokeIndex === -1) {
                // 全滅 → 完全勝利
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
                // ══ 生き残りがいる → 強制交代画面を表示 ══
                battle.log += victoryLog;
                battle.log += `\n\n⚠️ <@${defender.id}> の次のポケモンを選んでください！`;
                battle.forcedSwitchUserId = defender.id;
                battle.currentTurnUserId = defender.id;
                await updateBattleMessage(interaction, battleId);
                return;
            }
        }

        // 倒れなかった場合はターン交代
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

    // ══════════════════════════════════════════════════
    // フェーズ①：先頭ポケモン選択画面
    // ══════════════════════════════════════════════════
    if (battle.phase === 'select_lead') {
        const p1Buttons = battle.p1.party.map((poke, i) =>
            new ButtonBuilder()
                .setCustomId(`btl_leadselect_${battleId}_p1_${i}`)
                .setLabel(`${poke.nickname} Lv.${poke.level}`)
                .setStyle(battle.p1.leadSelected && battle.p1.activeIndex === i ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(battle.p1.leadSelected) // 選択済みは押せない
        );
        const p2Buttons = battle.p2.party.map((poke, i) =>
            new ButtonBuilder()
                .setCustomId(`btl_leadselect_${battleId}_p2_${i}`)
                .setLabel(`${poke.nickname} Lv.${poke.level}`)
                .setStyle(battle.p2.leadSelected && battle.p2.activeIndex === i ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(battle.p2.leadSelected)
        );

        const p1Status = battle.p1.leadSelected
            ? `✅ **${battle.p1.party[battle.p1.activeIndex].nickname}** を選択！`
            : '⏳ 選択中... 下のボタンを押してください';
        const p2Status = battle.p2.leadSelected
            ? `✅ **${battle.p2.party[battle.p2.activeIndex].nickname}** を選択！`
            : '⏳ 選択中... 下のボタンを押してください';

        const embed = new EmbedBuilder()
            .setTitle('⚔️ バトル前 ── 先頭ポケモンを選んでください！')
            .setColor(0xFF4500)
            .setDescription(battle.log)
            .addFields(
                { name: `🔴 <@${battle.p1.id}>`, value: p1Status, inline: true },
                { name: `🔵 <@${battle.p2.id}>`, value: p2Status, inline: true }
            );

        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        // p1のボタン（上段）
        for (let i = 0; i < p1Buttons.length; i += 5) {
            if (rows.length < 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(p1Buttons.slice(i, i + 5)));
        }
        // p2のボタン（下段）
        for (let i = 0; i < p2Buttons.length; i += 5) {
            if (rows.length < 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(p2Buttons.slice(i, i + 5)));
        }

        await interaction.editReply({ embeds: [embed], components: rows });
        return;
    }

    // ══════════════════════════════════════════════════
    // フェーズ②：強制交代画面（倒れた後）
    // ══════════════════════════════════════════════════
    if (battle.forcedSwitchUserId && !isFinished) {
        const isP1Forced = battle.forcedSwitchUserId === battle.p1.id;
        const switcher = isP1Forced ? battle.p1 : battle.p2;

        // 生きているポケモンのみボタン表示
        const switchButtons = switcher.party
            .map((poke, index) => ({ poke, index }))
            .filter(({ poke }) => poke.hp > 0)
            .map(({ poke, index }) =>
                new ButtonBuilder()
                    .setCustomId(`btl_forceswitch_${battleId}_${index}`)
                    .setLabel(`${poke.nickname} Lv.${poke.level} ❤️${poke.hp}/${poke.maxHp}`)
                    .setStyle(ButtonStyle.Primary)
            );

        const p1Poke = battle.p1.party[battle.p1.activeIndex];
        const p2Poke = battle.p2.party[battle.p2.activeIndex];
        const p1AliveCount = battle.p1.party.filter(p => p.hp > 0).length;
        const p2AliveCount = battle.p2.party.filter(p => p.hp > 0).length;

        const embed = new EmbedBuilder()
            .setTitle('⚔️ ポケモンバトル ── 次のポケモンを選んでください！')
            .setColor(0xFF4500)
            .setDescription(`**📜 バトルログ**\n${battle.log}`)
            .addFields(
                { name: `🔵 <@${battle.p2.id}>`, value: `**${p2Poke.nickname}** Lv.${p2Poke.level}\n❤️ HP: **${p2Poke.hp}** / ${p2Poke.maxHp}\n(残り: ${p2AliveCount}匹)`, inline: false },
                { name: `🔴 <@${battle.p1.id}>`, value: `**${p1Poke.nickname}** Lv.${p1Poke.level}\n❤️ HP: **${p1Poke.hp}** / ${p1Poke.maxHp}\n(残り: ${p1AliveCount}匹)`, inline: false },
            )
            .setThumbnail(p2Poke.imageUrl)
            .setImage(p1Poke.imageUrl)
            .setFooter({ text: `⏳ ${switcher.name}が次のポケモンを選んでいます...` });

        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < switchButtons.length; i += 5) {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(switchButtons.slice(i, i + 5)));
        }

        await interaction.editReply({ embeds: [embed], components: rows });
        return;
    }

    // ══════════════════════════════════════════════════
    // フェーズ③：通常バトル画面
    // ══════════════════════════════════════════════════
    const p1Poke = battle.p1.party[battle.p1.activeIndex];
    const p2Poke = battle.p2.party[battle.p2.activeIndex];
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

    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨')
        )
    ];

    await interaction.editReply({ embeds: [embed], components });
}
