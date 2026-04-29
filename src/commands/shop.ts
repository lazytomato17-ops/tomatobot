// src/commands/shop.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const shopCommand = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('アイテムを購入する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 所持金を取得
        const { data: user } = await supabase
            .from('poke_users')
            .select('money')
            .eq('discord_id', interaction.user.id)
            .single();

        const money = user?.money || 0;

        const embed = new EmbedBuilder()
            .setTitle('🛒 フレンドリィショップ')
            .setDescription(`現在の所持金: **${money} 円**\n\n何を買いますか？`)
            .setColor(0x0000FF);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('buy_pokeball_200') // アイテム名と値段を仕込む
                .setLabel('モンスターボール (200円)')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔴')
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};