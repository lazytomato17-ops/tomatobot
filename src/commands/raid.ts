// src/commands/raid.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType } from 'discord.js';
import { supabase } from '../pokeDb';
import { buildBattlePokemon } from '../battleLogic';

// 現在募集中のレイドを保存しておく場所
export const activeRaids = new Map<string, any>();

// 進行中のレイドバトルの状態を保存する場所
export const raidBattles = new Map<string, any>();

export const raidCommand = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('みんなで協力して強力なボスに挑むレイドバトルを開催します！'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // ボスになるポケモンをランダムに決定（とりあえず1〜151の中から）
        const bossId = Math.floor(Math.random() * 151) + 1;
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${bossId}`);
        const data = await res.json();
        const speciesRes = await fetch(data.species.url);
        const speciesData = await speciesRes.json();
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        // ボスのレベル（参加者が2〜3人なので、少し高めに設定）
        const bossLevel = 50; 
        const bossHp = bossLevel * 30; // 通常のHPの何倍もタフにする！

        const raidId = interaction.id;
        const raidData = {
            id: raidId,
            hostId: interaction.user.id,
            boss: { name: jaName, level: bossLevel, hp: bossHp, maxHp: bossHp, imageUrl: data.sprites.other['official-artwork'].front_default },
            participants: new Set<string>([interaction.user.id]) // ホストは最初から参加
        };
        
        activeRaids.set(raidId, raidData);

        const embed = new EmbedBuilder()
            .setTitle(`🔴 巨大な ${jaName} の巣穴を発見！`)
            .setDescription(`強力なレイドボスが出現しました！みんなで協力して討伐しよう！\n\n**【参加者】**\n<@${interaction.user.id}>`)
            .setImage(raidData.boss.imageUrl)
            .setColor(0xFF00FF)
            .setFooter({ text: 'ホストが出発を押すとバトル開始！' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`raid_join_${raidId}`).setLabel('参加する！').setStyle(ButtonStyle.Primary).setEmoji('✋'),
            new ButtonBuilder().setCustomId(`raid_start_${raidId}`).setLabel('出発する').setStyle(ButtonStyle.Danger).setEmoji('⚔️')
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};

// 🌟 新しく追加するバトル開始関数
export async function startRaidBattle(interaction: any, raidId: string) {
    const raidData = activeRaids.get(raidId);
    if (!raidData) return;

    // 参加者全員の「先頭のポケモン」をデータベースから取得！
    const players = [];
    for (const userId of raidData.participants) {
        const { data } = await supabase.from('poke_caught_pokemons')
            .select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true }).limit(1).single();
        
        if (data) {
            const poke = await buildBattlePokemon(data);
            players.push({ id: userId, poke: poke, actionReady: false });
        }
    }

    if (players.length === 0) {
        return interaction.update({ content: '❌ 参加者のポケモンが見つかりませんでした。', embeds: [], components: [] });
    }

    // レイドバトルの状態を保存
    const battleState = {
        id: raidId,
        boss: raidData.boss, // 先ほど作ったボスのデータ
        players: players,
        turn: 1,
        log: `🌟 **レイドバトル 開始！**\n巨大な **${raidData.boss.name}** が 立ちはだかる！`
    };
    raidBattles.set(raidId, battleState);
    activeRaids.delete(raidId); // 募集ロビーからは削除

    // 🌟 バトル画面のUI（全員のHPなどを表示）
    let playersStatus = '';
    for (const p of players) {
        playersStatus += `<@${p.id}>: **${p.poke.nickname}** (HP: ${p.poke.hp}/${p.poke.maxHp})\n`;
    }

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ VS 巨大 ${battleState.boss.name} (ターン ${battleState.turn})`)
        .setDescription(battleState.log)
        .setColor(0xFF4500)
        .addFields(
            { name: '😈 ボス', value: `**${battleState.boss.name}** Lv.${battleState.boss.level}\nHP: [ **${battleState.boss.hp}** / ${battleState.boss.maxHp} ]`, inline: false },
            { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
        )
        .setImage(battleState.boss.imageUrl);

    // 今回はターン制（同時入力）なので、「技を選ぶ」ボタンだけを用意
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`raid_act_${raidId}`).setLabel('技を選ぶ！').setStyle(ButtonStyle.Success).setEmoji('⚔️')
    );

    // update で元の募集メッセージをバトル画面に書き換える
    await interaction.update({ content: '', embeds: [embed], components: [row] });
}