// src/commands/heal.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const healCommand = {
    data: new SlashCommandBuilder()
        .setName('heal')
        .setDescription('ポケモンセンターで手持ちのポケモンを全回復する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        // 🌟 1日1回の制限（last_heal_at のチェック）を完全撤廃！
        // いつでも何度でも無料でポケモンセンターを使えるようにしました。

        const embed = new EmbedBuilder()
            .setTitle('🏥 ポケモンセンター')
            .setDescription('ポケモンセンターへ ようこそ！\nここでは 傷ついた ポケモンを 休ませて 回復させることが できます。\n\n手持ちの ポケモンを 回復させますか？')
            .setColor(0xFF6666);

        // 回復アイテムの所持数を一応取得（外で回復したい時用）
        const { data: inventory } = await supabase.from('poke_inventory')
            .select('item_id, quantity')
            .eq('user_id', interaction.user.id)
            .in('item_id', ['potion', 'max_potion']);

        const potionCount = inventory?.find(i => i.item_id === 'potion')?.quantity || 0;
        const maxPotionCount = inventory?.find(i => i.item_id === 'max_potion')?.quantity || 0;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('heal_free')
                .setLabel('無料で全回復する (PC)')
                .setStyle(ButtonStyle.Success)
                .setEmoji('💖'),
            new ButtonBuilder()
                .setCustomId('heal_potion')
                .setLabel(`きずぐすりを使う (所持: ${potionCount})`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(potionCount <= 0),
            new ButtonBuilder()
                .setCustomId('heal_max_potion')
                .setLabel(`まんたんのくすり (所持: ${maxPotionCount})`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(maxPotionCount <= 0)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
