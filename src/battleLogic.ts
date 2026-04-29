// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { supabase } from './pokeDb';

// ==========================================
// 🧠 バトルの状態を一時保存するメモリ領域
// ==========================================
const activeBattles = new Map<string, BattleState>();

interface BattlePokemon {
    dbId: string; nickname: string; level: number;
    hp: number; maxHp: number;
    atk: number; def: number; speed: number;
    imageUrl: string;
}

interface Player {
    id: string; name: string;
    party: BattlePokemon[]; activeIndex: number;
}

interface BattleState {
    id: string;
    p1: Player; // 挑戦者
    p2: Player; // 相手
    currentTurnUserId: string; // 現在行動できるプレイヤーのID
    log: string; // バトルの実況ログ
}

// ==========================================
// 🛠️ ポケモンの実数値を計算して構築する関数
// ==========================================
async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    const lv = dbPoke.level;
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp) * lv) / 100) + lv + 10;
    
    return {
        dbId: dbPoke.id,
        nickname: dbPoke.nickname,
        level: lv,
        hp: dbPoke.current_hp > 0 ? dbPoke.current_hp : maxHp, // とりあえず最大HPからスタート
        maxHp: maxHp,
        atk: Math.floor(((2 * base['attack'] + dbPoke.iv_attack) * lv) / 100) + 5,
        def: Math.floor(((2 * base['defense'] + dbPoke.iv_defense) * lv) / 100) + 5,
        speed: Math.floor(((2 * base['speed'] + dbPoke.iv_speed) * lv) / 100) + 5,
        imageUrl: data.sprites.front_default || data.sprites.other['official-artwork'].front_default
    };
}

// ==========================================
// ⚔️ バトル開始処理（前回からのアップデート）
// ==========================================
export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();

    try {
        const { data: p1Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', challengerId).eq('is_party', true);
        const { data: p2Data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', targetId).eq('is_party', true);

        if (!p1Data?.length || !p2Data?.length) return interaction.followUp('手持ちエラーのためバトルを中止しました。');

        // 実数値を計算してプレイヤー情報を作成
        const p1: Player = { id: challengerId, name: '挑戦者', party: [await buildBattlePokemon(p1Data[0])], activeIndex: 0 };
        const p2: Player = { id: targetId, name: '相手', party: [await buildBattlePokemon(p2Data[0])], activeIndex: 0 };

        const battleId = interaction.message.id;
        
        // 素早さ（Speed）を比較して、最初のターンを決定
        const firstTurnId = p1.party[0].speed >= p2.party[0].speed ? p1.id : p2.id;

        const battle: BattleState = {
            id: battleId, p1, p2,
            currentTurnUserId: firstTurnId,
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
// 🎮 バトルの行動処理（たたかう等）
// ==========================================
export async function handleBattleAction(interaction: MessageComponentInteraction, battleId: string, action: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return interaction.reply({ content: 'このバトルは既に終了しているか無効です。', ephemeral: true });

    // 自分のターンじゃないのにボタンを押した時のブロック
    if (interaction.user.id !== battle.currentTurnUserId) {
        return interaction.reply({ content: '⏳ 今は相手のターンです！待機してください。', ephemeral: true });
    }

    await interaction.deferUpdate();

    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    if (action === 'attack') {
        // --- 💥 ダメージ計算（本家ライクな簡易版） ---
        const power = 50; // 技の威力（今回は「たいあたり」固定）
        const random = (Math.floor(Math.random() * 16) + 85) / 100; // 0.85〜1.00の乱数
        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * power * atkPoke.atk / defPoke.def) / 50 + 2) * random);
        if (damage < 1) damage = 1;

        defPoke.hp -= damage;
        if (defPoke.hp < 0) defPoke.hp = 0;

        battle.log = `▶ **${atkPoke.nickname}** の たいあたり！\n💥 **${defPoke.nickname}** に **${damage}** のダメージ！`;

        // 勝敗判定
        if (defPoke.hp === 0) {
            battle.log += `\n\n💀 **${defPoke.nickname}** は たおれた！\n🏆 **${attacker.name} (<@${attacker.id}>) の勝利！**`;
            activeBattles.delete(battleId); // メモリから削除
            await updateBattleMessage(interaction, battleId, true);
            // ※ここで本来はDBのHPや経験値を更新します
            return;
        }

        // ターンを相手に渡す
        battle.currentTurnUserId = defender.id;
    } 
    else if (action === 'run') {
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

    // バトル終了時はボタンを消す
    const components = isFinished ? [] : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary).setEmoji('💨')
        )
    ];

    await interaction.editReply({ embeds: [embed], components });
}