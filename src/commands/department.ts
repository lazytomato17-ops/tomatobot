import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const departmentCommand = {
    data: new SlashCommandBuilder()
        .setName('department')
        .setDescription('タマムシデパートで育成用アイテム（ミントや努力値アイテム）を購入する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
        const money = user?.money || 0;

        const embed = new EmbedBuilder()
            .setTitle('🏢 タマムシデパート（育成アイテム売り場）')
            .setDescription(`現在の所持金: **${money.toLocaleString()} 円**\n\nポケモンの能力を極限まで引き出すアイテムを取り揃えております。`)
            .setColor(0x00FF00);

        const options = [
            // ドーピング（努力値+10）
            { id: 'item_hp_up', label: '💊 マックスアップ (HP+10)', price: 10000 },
            { id: 'item_protein', label: '💊 タウリン (攻撃+10)', price: 10000 },
            { id: 'item_iron', label: '💊 ブロムヘキシン (防御+10)', price: 10000 },
            { id: 'item_calcium', label: '💊 リゾチウム (特攻+10)', price: 10000 },
            { id: 'item_zinc', label: '💊 キトサン (特防+10)', price: 10000 },
            { id: 'item_carbos', label: '💊 インドメタシン (素早さ+10)', price: 10000 },
            // リセット
            { id: 'item_reset_mochi', label: '🍡 まっさらもち (努力値を全リセット)', price: 20000 },
            // ミント（性格補正の変更）
            { id: 'mint_adamant', label: '🌿 いじっぱりミント (攻↑特攻↓)', price: 20000 },
            { id: 'mint_modest', label: '🌿 ひかえめミント (特攻↑攻↓)', price: 20000 },
            { id: 'mint_jolly', label: '🌿 ようきミント (速↑特攻↓)', price: 20000 },
            { id: 'mint_timid', label: '🌿 おくびょうミント (速↑攻↓)', price: 20000 },
            { id: 'mint_bold', label: '🌿 ずぶといミント (防↑攻↓)', price: 20000 },
            { id: 'mint_calm', label: '🌿 おだやかミント (特防↑攻↓)', price: 20000 }
        ].map(item => ({
            label: `${item.label} (${item.price}円)`,
            value: `${item.id}_1_${item.price}`
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_buy_select') // 処理はshopと同じものを使い回す
            .setPlaceholder('購入するアイテムを選択してください')
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
