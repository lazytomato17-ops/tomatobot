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

        // 1段目: 捕獲用ボール
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('buy_monster_ball_200').setLabel('モンスターボール (200円)').setStyle(ButtonStyle.Primary).setEmoji('🔴'),
            new ButtonBuilder().setCustomId('buy_super_ball_600').setLabel('スーパーボール (600円)').setStyle(ButtonStyle.Primary).setEmoji('🔵'),
            new ButtonBuilder().setCustomId('buy_hyper_ball_1200').setLabel('ハイパーボール (1200円)').setStyle(ButtonStyle.Primary).setEmoji('🟡')
        );

        // 2段目: たいせつなもの（回復アイテムを削除し、ここにがくしゅうそうちを配置）
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('buy_exp_share_10000').setLabel('がくしゅうそうち (10000円)').setStyle(ButtonStyle.Danger).setEmoji('⚙️')
        );

        await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    }
};