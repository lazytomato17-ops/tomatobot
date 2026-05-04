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

// src/commands/department.ts の options 配列を以下に上書き

        const options = [
            // ドーピング（努力値+10）
            { id: 'item_hp_up', label: '💊 マックスアップ', price: 10000 },
            { id: 'item_protein', label: '💊 タウリン', price: 10000 },
            { id: 'item_iron', label: '💊 ブロムヘキシン', price: 10000 },
            { id: 'item_calcium', label: '💊 リゾチウム', price: 10000 },
            { id: 'item_zinc', label: '💊 キトサン', price: 10000 },
            { id: 'item_carbos', label: '💊 インドメタシン', price: 10000 },
            
            // リセット
            { id: 'item_reset_mochi', label: '🍡 まっさらもち', price: 10000 },
            
            // ミント（性格補正の変更）
            { id: 'mint_adamant', label: '🌿 いじっぱりミント', price: 20000 },
            { id: 'mint_modest', label: '🌿 ひかえめミント', price: 20000 },
            { id: 'mint_jolly', label: '🌿 ようきミント', price: 20000 },
            { id: 'mint_timid', label: '🌿 おくびょうミント', price: 20000 },

            { id: 'item_silver_crown', label: '🥈 ぎんのおうかん (1項目MAX)', price: 20000 },
            // 持ち物（バトル用アイテム）
            { id: 'leftovers', label: '🍎 たべのこし', price: 50000 },
            { id: 'life_orb', label: '🔮 いのちのたま', price: 80000 },
            { id: 'choice_band', label: '🧣 こだわりハチマキ', price: 100000 },
            { id: 'rusted_sword', label: '🗡️ くちたけん (ザシアン専用)', price: 500000 },
            { id: 'amulet_coin', label: '🪙 おまもりこばん', price: 20000 }, // 👈 追加！（すぐに元が取れる価格設定）
            { id: 'booster_energy', label: '⚡ ブーストエナジー', price: 150000 } // 👈 追加！

        ].map(item => ({
            label: `${item.label} (${item.price.toLocaleString()}円)`,
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
