import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { supabase } from './pokeDb';

const activeBattles = new Map<string, BattleState>();

interface BattleMove { name: string; power: number; type: string; }
interface BattlePokemon {
    dbId: string; nickname: string; level: number; hp: number; maxHp: number;
    atk: number; def: number; speed: number; imageUrl: string; moves: BattleMove[]; types: string[];
}
interface Player { id: string; name: string; party: BattlePokemon[]; activeIndex: number; }
interface BattleState { id: string; p1: Player; p2: Player; currentTurnUserId: string; log: string; }

async function buildBattlePokemon(dbPoke: any): Promise<BattlePokemon> {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dbPoke.pokedex_id}`);
    const data = await res.json();
    const base: any = {};
    data.stats.forEach((s: any) => { base[s.stat.name] = s.base_stat; });

    // ✅ シャッフル廃止：現在のレベル以下で覚える「最新の技」を優先
    const levelUpMoves = data.moves
        .map((m: any) => {
            const detail = m.version_group_details.find((v: any) => v.move_learn_method.name === 'level-up');
            return detail ? { url: m.move.url, level: detail.level_learned_at } : null;
        })
        .filter((m: any) => m && m.level <= dbPoke.level)
        .sort((a: any, b: any) => b.level - a.level);

    const validMoves: BattleMove[] = [];
    const moveDataList = await Promise.all(levelUpMoves.slice(0, 12).map((m: any) => fetch(m.url).then(r => r.json())));
    for (const m of moveDataList) {
        if (m.power && validMoves.length < 4) {
            const name = m.names.find((n: any) => n.language.name === 'ja-Hrkt')?.name || m.name;
            validMoves.push({ name, power: m.power, type: m.type.name });
        }
    }
    if (validMoves.length === 0) validMoves.push({ name: 'たいあたり', power: 40, type: 'normal' });

    const lv = dbPoke.level;
    const maxHp = Math.floor(((2 * base['hp'] + dbPoke.iv_hp) * lv) / 100) + lv + 10;
    return {
        dbId: dbPoke.id, nickname: dbPoke.nickname, level: lv,
        hp: dbPoke.current_hp > 0 ? dbPoke.current_hp : maxHp, maxHp,
        atk: Math.floor(((2 * base['attack'] + dbPoke.iv_attack) * lv) / 100) + 5,
        def: Math.floor(((2 * base['defense'] + dbPoke.iv_defense) * lv) / 100) + 5,
        speed: Math.floor(((2 * base['speed'] + dbPoke.iv_speed) * lv) / 100) + 5,
        imageUrl: data.sprites.front_default || data.sprites.other['official-artwork'].front_default,
        moves: validMoves, types: data.types.map((t: any) => t.type.name)
    };
}

export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    await interaction.deferUpdate();
    try {
        const fetchParty = (uid: string) => supabase.from('poke_caught_pokemons').select('*').eq('owner_id', uid).eq('is_party', true).order('party_order', { ascending: true });
        const [{ data: p1Data }, { data: p2Data }] = await Promise.all([fetchParty(challengerId), fetchParty(targetId)]);
        if (!p1Data?.length || !p2Data?.length) return interaction.followUp('パーティ情報の取得に失敗しました。');

        const [p1Party, p2Party] = await Promise.all([
            Promise.all(p1Data.map(p => buildBattlePokemon(p))),
            Promise.all(p2Data.map(p => buildBattlePokemon(p)))
        ]);

        const battle: BattleState = {
            id: interaction.message.id,
            p1: { id: challengerId, name: '挑戦者', party: p1Party, activeIndex: 0 },
            p2: { id: targetId, name: '相手', party: p2Party, activeIndex: 0 },
            currentTurnUserId: p1Party[0].speed >= p2Party[0].speed ? challengerId : targetId,
            log: '**バトル開始！**'
        };
        activeBattles.set(battle.id, battle);
        await updateBattleMessage(interaction, battle.id);
    } catch (e) { await interaction.followUp('バトル開始エラー'); }
}

export async function handleBattleAction(interaction: MessageComponentInteraction, battleId: string, action: string) {
    const battle = activeBattles.get(battleId);
    if (!battle) return interaction.reply({ content: '無効なバトルです。', ephemeral: true });
    if (interaction.user.id !== battle.currentTurnUserId) return interaction.reply({ content: '相手のターンです。', ephemeral: true });

    await interaction.deferUpdate();
    const isP1 = interaction.user.id === battle.p1.id;
    const attacker = isP1 ? battle.p1 : battle.p2;
    const defender = isP1 ? battle.p2 : battle.p1;
    const atkPoke = attacker.party[attacker.activeIndex];
    const defPoke = defender.party[defender.activeIndex];

    if (action === 'attack') {
        const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...atkPoke.moves.map((m, i) => new ButtonBuilder().setCustomId(`btl_usemove_${battleId}_${i}`).setLabel(m.name).setStyle(ButtonStyle.Danger))
        ), new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`btl_back_${battleId}`).setLabel('もどる').setStyle(ButtonStyle.Secondary))];
        return interaction.editReply({ components: rows });
    }

    if (action === 'switchmenu') {
        const buttons = attacker.party.map((p, i) => new ButtonBuilder().setCustomId(`btl_switch_${battleId}_${i}`).setLabel(`${p.nickname} (HP:${p.hp})`).setStyle(ButtonStyle.Success).setDisabled(i === attacker.activeIndex || p.hp <= 0));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
        return interaction.editReply({ components: rows });
    }

    if (action === 'switch') {
        attacker.activeIndex = parseInt(interaction.customId.split('_')[3]);
        battle.log = `🔄 <@${attacker.id}> は **${attacker.party[attacker.activeIndex].nickname}** を出した！`;
        battle.currentTurnUserId = defender.id;
        return updateBattleMessage(interaction, battleId);
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

        let damage = Math.floor((((2 * atkPoke.level / 5 + 2) * move.power * atkPoke.atk / defPoke.def) / 50 + 2) * mult * ((Math.floor(Math.random() * 16) + 85) / 100));
        defPoke.hp = Math.max(0, defPoke.hp - damage);
        
        battle.log = `▶ **${atkPoke.nickname}** の **${move.name}**！\n${mult > 1.5 ? '🌟効果抜群！' : mult < 1 ? '📉効果今ひとつ…' : ''} 💥 **${damage}** ダメージ！`;

        if (defPoke.hp === 0) {
            battle.log += `\n💀 **${defPoke.nickname}** は倒れた！`;
            const nextIdx = defender.party.findIndex(p => p.hp > 0);
            if (nextIdx === -1) {
                battle.log += `\n🏆 <@${attacker.id}> の勝利！`;
                await updateBattleMessage(interaction, battleId, true);
                return activeBattles.delete(battleId);
            }
            defender.activeIndex = nextIdx;
            battle.log += `\n🔄 <@${defender.id}> は **${defender.party[nextIdx].nickname}** を出した！`;
        }
        battle.currentTurnUserId = defender.id;
    }

    if (action === 'back') return updateBattleMessage(interaction, battleId);
    if (action === 'run') {
        battle.log = `💨 <@${attacker.id}> は逃げ出した！`;
        await updateBattleMessage(interaction, battleId, true);
        return activeBattles.delete(battleId);
    }
    await updateBattleMessage(interaction, battleId);
}

async function updateBattleMessage(interaction: MessageComponentInteraction, battleId: string, isFinished = false) {
    const b = activeBattles.get(battleId); if (!b) return;
    const [p1p, p2p] = [b.p1.party[b.p1.activeIndex], b.p2.party[b.p2.activeIndex]];
    const embed = new EmbedBuilder().setTitle(isFinished ? '🏁 終了' : '⚔️ バトル進行中').setDescription(b.log).setColor(isFinished ? 0x808080 : 0xFF4500)
        .addFields(
            { name: `🔵 相手: <@${b.p2.id}>`, value: `**${p2p.nickname}** Lv.${p2p.level} HP:${p2p.hp}/${p2p.maxHp}`, inline: false },
            { name: `🔴 自分: <@${b.p1.id}>`, value: `**${p1p.nickname}** Lv.${p1p.level} HP:${p1p.hp}/${p1p.maxHp}`, inline: false }
        ).setImage(p1p.imageUrl).setThumbnail(p2p.imageUrl);
    const rows = isFinished ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`btl_attack_${battleId}`).setLabel('たたかう').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`btl_switchmenu_${battleId}`).setLabel('ポケモン').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`btl_run_${battleId}`).setLabel('にげる').setStyle(ButtonStyle.Secondary)
    )];
    await interaction.editReply({ embeds: [embed], components: rows });
}
