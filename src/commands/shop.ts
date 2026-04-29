// src/commands/shop.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const shopCommand = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('フレンドリィショップでアイテムを購入する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
        const money = user?.money || 0;

        const embed = new EmbedBuilder()
            .setTitle('🛒 フレンドリィショップ')
            .setDescription(`現在の所持金: **${money} 円**\n\n必要なアイテムを選んでください。`)
            .setColor(0x0000FF);

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('buy_monster_ball_200').setLabel('モンスターボール (200円)').setStyle(ButtonStyle.Primary).setEmoji('🔴'),
            new ButtonBuilder().setCustomId('buy_super_ball_600').setLabel('スーパーボール (600円)').setStyle(ButtonStyle.Primary).setEmoji('🔵'),
            new ButtonBuilder().setCustomId('buy_hyper_ball_1200').setLabel('ハイパーボール (1200円)').setStyle(ButtonStyle.Primary).setEmoji('🟡')
        );

        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('buy_potion_300').setLabel('きずぐすり (300円)').setStyle(ButtonStyle.Success).setEmoji('🩹'),
            new ButtonBuilder().setCustomId('buy_max_potion_1500').setLabel('まんたんのくすり (1500円)').setStyle(ButtonStyle.Success).setEmoji('💊')
        );

        await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    }
};
