import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const battleCommand = {
    data: new SlashCommandBuilder()
        .setName('battle')
        .setDescription('他のプレイヤーにポケモンバトルを挑む')
        .addUserOption(option => 
            option.setName('target')
            .setDescription('対戦相手')
            .setRequired(true)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const targetUser = interaction.options.getUser('target');

        // エラーチェック（相手がいない、Bot、自分自身）
        if (!targetUser) return interaction.editReply('相手が見つかりません。');
        if (targetUser.bot) return interaction.editReply('Botとは対戦できません！');
        if (targetUser.id === interaction.user.id) return interaction.editReply('自分自身とは対戦できません！');

        // 自分の手持ちチェック
        const { data: myParty } = await supabase.from('poke_caught_pokemons').select('id').eq('owner_id', interaction.user.id).eq('is_party', true);
        if (!myParty || myParty.length === 0) return interaction.editReply('手持ちにポケモンがいません。`/party` で準備してください！');

        // 相手の手持ちチェック
        const { data: targetParty } = await supabase.from('poke_caught_pokemons').select('id').eq('owner_id', targetUser.id).eq('is_party', true);
        if (!targetParty || targetParty.length === 0) return interaction.editReply(`❌ <@${targetUser.id}> さんは手持ちポケモンを設定していません！`);

        // 挑戦状のEmbedを作成
        const embed = new EmbedBuilder()
            .setTitle('⚔️ ポケモンバトル 申し込み！')
            .setDescription(`<@${interaction.user.id}> が <@${targetUser.id}> に勝負を仕掛けた！\n\n受けて立ちますか？`)
            .setColor(0xFF0000);

        // 「受ける」「逃げる」ボタン（カスタムIDに両者のIDを仕込む）
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`battle_accept_${interaction.user.id}_${targetUser.id}`)
                .setLabel('勝負を受ける！')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔥'),
            new ButtonBuilder()
                .setCustomId(`battle_decline_${interaction.user.id}_${targetUser.id}`)
                .setLabel('逃げる')
                .setStyle(ButtonStyle.Secondary)
        );

        // 相手にメンションをつけて送信
        await interaction.editReply({ content: `<@${targetUser.id}>`, embeds: [embed], components: [row] });
    }
};