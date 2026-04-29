// src/commands/heal.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const healCommand = {
    data: new SlashCommandBuilder()
        .setName('heal')
        .setDescription('手持ちのポケモンを回復する（1日1回無料）'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('*').eq('discord_id', interaction.user.id).single();
        const now = new Date();
        const lastHeal = user?.last_heal_at ? new Date(user.last_heal_at) : new Date(0);
        const isFreeAvailable = now.toDateString() !== lastHeal.toDateString();

        const embed = new EmbedBuilder()
            .setTitle('🏥 ポケモンセンター')
            .setColor(0xFF69B4)
            .setDescription('手持ちのポケモンを休ませますか？\n(※バトルで減ったHPを回復します)');

        const row = new ActionRowBuilder<ButtonBuilder>();

        if (isFreeAvailable) {
            row.addComponents(new ButtonBuilder().setCustomId('heal_free').setLabel('無料で全回復する').setStyle(ButtonStyle.Success).setEmoji('✨'));
        } else {
            embed.setDescription('今日の無料回復は既に使いました。回復アイテムを使用しますか？');
            // アイテム所持数を取得
            const { data: inv } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id);
            const getQty = (id: string) => inv?.find(i => i.item_id === id)?.quantity || 0;
            
            row.addComponents(
                new ButtonBuilder().setCustomId('heal_potion').setLabel(`きずぐすりを使う (所持: ${getQty('potion')})`).setStyle(ButtonStyle.Primary).setEmoji('🩹').setDisabled(getQty('potion') <= 0),
                new ButtonBuilder().setCustomId('heal_max_potion').setLabel(`まんたんのくすり (所持: ${getQty('max_potion')})`).setStyle(ButtonStyle.Primary).setEmoji('💊').setDisabled(getQty('max_potion') <= 0)
            );
        }

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
