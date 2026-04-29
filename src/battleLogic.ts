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
    types: string[]; // 👈 タイプ相性計算のために追加
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

    // ポケモンのタイプ（英語名）を取得
    const pokeTypes = data.types.map((t: any) => t.type.name);

    // 攻撃技を最大4つ取得
    const validMoves: BattleMove[] = [];
    const movePromises = data.moves.slice(0, 15).map((m: any) => fetch(m.move.url).then(r => r.json()).catch(() => null));
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

        const p1: Player = { id: challengerId, name: '挑戦者', party: [await buildBattlePokemon(p1Data[0])], activeIndex: 0 };
        const p2: Player = { id: targetId, name: '相手', party: [await buildBattlePokemon(p2Data[0])], activeIndex: 0 };

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
        await interaction.followUp('バトル初期化エラー');
    }
}

// ==========================================
// 🎮 バトルの行動処理（たたかう、技選択など）
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

    if (action === 'attack') {
        const moveButtons = atkPoke.moves.map((move, index) => {
            return new ButtonBuilder()
                .setCustomId(`btl_usemove_${battleId}_${index}`)
                .setLabel(`${move.name}`)
                .setStyle(ButtonStyle.Danger);
        });

        const backBtn = new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary);
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(...moveButtons);
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

        await interaction.editReply({ components: [row1, row2] });
        return;
    }

    if (action === 'back') {
        await updateBattleMessage(interaction, battleId);
        return;
    }

    // 💥 技を使った時の処理
    if (action === 'usemove') {
        const parts = interaction.customId.split('_');
        const moveIndex = parseInt(parts[3], 10);
        const selectedMove = atkPoke.moves[moveIndex];

        // --- 📊 タイプ相性の判定（PokeAPIから技のタイプ情報を動的に取得） ---
        const typeRes = await fetch(`https://pokeapi.co/api/v2/type/${selectedMove.type}`);
        const typeData = await typeRes.json();
        let multiplier = 1;

        // 相手のタイプに対して弱点・抵抗を判定
        defPoke.types.forEach(defType => {
            if (typeData.damage_relations.double_damage_to.some((t:any) => t.name === defType)) multiplier *= 2;
            if (typeData.damage_relations.half_damage_to.some((t:any) => t.name === defType)) multiplier *= 0.5;
            if (typeData.damage_relations.no_damage_to.some((t:any) => t.name === defType)) multiplier *= 0;
        });

        // タイプ一致ボーナス (STAB)
        if (atkPoke.types.includes(selectedMove.type)) multiplier *= 1.5;

        // --- ⚔️ ダメージ計算 ---
        const power = selectedMove.power;
        const random = (Math.floor(Math.random() * 16) + 85) / 100;
        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * power * atkPoke.atk / defPoke.def) / 50 + 2) * multiplier * random);
        if (damage < 1 && multiplier !== 0) damage = 1;

        defPoke.hp -= damage;
        if (defPoke.hp < 0) defPoke.hp = 0;

        // --- 📝 ログの作成 ---
        let effectLog = '';
        if (multiplier > 1.5) effectLog = '🌟 **こうかばつぐんだ！**\n';
        if (multiplier > 0 && multiplier < 1) effectLog = '📉 こうかはいまひとつのようだ…\n';
        if (multiplier === 0) effectLog = '❌ こうかがないみたいだ…\n';

        battle.log = `▶ **${atkPoke.nickname}** の **${selectedMove.name}**！\n${effectLog}💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

        // --- 🏆 勝敗判定と報酬処理 ---
        if (defPoke.hp === 0) {
            let victoryLog = `\n\n💀 **${defPoke.nickname}** は たおれた！\n🏆 **${attacker.name} (<@${attacker.id}>) の勝利！**`;

            try {
                // 💰 1. お金の付与 (500円)
                const { data: userData } = await supabase.from('poke_users').select('money').eq('discord_id', attacker.id).single();
                const newMoney = (userData?.money || 0) + 500;
                await supabase.from('poke_users').update({ money: newMoney }).eq('discord_id', attacker.id);

                // ✨ 2. 経験値の付与とレベルアップ判定
                const gainedExp = defPoke.level * 10;
                const { data: pokeData } = await supabase.from('poke_caught_pokemons').select('level, exp').eq('id', atkPoke.dbId).single();
                
                if (pokeData) {
                    let currentExp = pokeData.exp + gainedExp;
                    let currentLevel = pokeData.level;
                    let levelUpText = '';

                    // 次のレベルに必要な経験値 ＝ 現在のレベル × 100 とした簡易計算
                    while (currentExp >= currentLevel * 100) {
                        currentExp -= currentLevel * 100;
                        currentLevel++;
                        levelUpText += `\n🎉 **${atkPoke.nickname}** は レベル**${currentLevel}** に上がった！`;
                    }

                    // DBにレベルと経験値を保存
                    await supabase.from('poke_caught_pokemons').update({ level: currentLevel, exp: currentExp }).eq('id', atkPoke.dbId);

                    victoryLog += `\n\n💰 賞金 **500円** を手に入れた！\n✨ **${atkPoke.nickname}** は **${gainedExp} EXP** をもらった！${levelUpText}`;
                }
            } catch (error) {
                console.error("報酬付与エラー:", error);
            }

            battle.log += victoryLog;
            activeBattles.delete(battleId);
            await updateBattleMessage(interaction, battleId, true);
            return;
        }

        // ターン交代
        battle.currentTurnUserId = defender.id;
        await updateBattleMessage(interaction, battleId);
        return;
    }

    if (action === 'run') {
        battle.log = `💨 <@${attacker.id}> は 逃げ出した！\nバトル終了！`;
        activeBattles.delete(battleId);
        await updateBattleMessage(interaction, battleId, true);
        return;
    }

    await updateBattleMessage(interaction, battleId);
}

// ==========================================
// 📺 画面更新用ヘルパー関数
// ==========================================
async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false) {
    const battle = activeBattles.get(battleId);
    if (!battle) return;

    const p1Poke = battle.p1.party[battle.p1.activeIndex];
    const p2Poke = battle.p2.party[battle.p2.activeIndex];

    const embed = new EmbedBuilder()
        .setTitle(isFinished ? '🏁 バトル終了' : '⚔️ ポケモンバトル 進行中！')
        .setColor(isFinished ? 0x808080 : 0xFF4500)
        .setDescription(`**📜 バトルログ**\n${battle.log}`)
        .addFields(
            { name: `🔵 相手: <@${battle.p2.id}>`, value: `**${p2Poke.nickname}** Lv.${p2Poke.level}\n❤️ HP: **${p2Poke.hp}** / ${p2Poke.maxHp}`, inline: false },
            { name: `🔴 挑戦者: <@${battle.p1.id}>`, value: `**${p1Poke.nickname}** Lv.${p1Poke.level}\n❤️ HP: **${p1Poke.hp}** / ${p1Poke.maxHp}`, inline: false }
        )
        .setThumbnail(p2Poke.imageUrl)
        .setImage(p1Poke.imageUrl);

    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨')
        )
    ];

    await interaction.editReply({ embeds: [embed], components });
}