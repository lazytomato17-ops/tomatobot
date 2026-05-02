// src/commands/shop.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChatInputCommandInteraction } from 'discord.js';
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
            .setDescription(`現在の所持金: **${money} 円**\n\n購入したいアイテムをリストから選んでください。`)
            .setColor(0x0000FF);

        // セレクトメニューの作成
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_buy_select')
            .setPlaceholder('アイテムを選択してください')
            .addOptions([
                { label: '🔴 モンスターボール (200円)', value: 'monster_ball_1_200', description: 'ポケモンを捕まえるためのボール' },
                { label: '🔵 スーパーボール (600円)', value: 'super_ball_1_600', description: 'モンスターボールより捕まえやすい' },
                { label: '🟡 ハイパーボール (1200円)', value: 'hyper_ball_1_1200', description: '非常に捕まえやすい最高性能のボール' },
                { label: '🟣 マスターボール (100,000円)', value: 'master_ball_1_100000', description: '野生のポケモンを必ず捕まえる究極のボール' },
                { label: '👑 きんのおうかん (150,000円)', value: 'golden_crown_1_150000', description: 'ポケモンの全個体値（IV）を最大(31)にする' },
                { label: '📦 モンスターボール 10個セット (2000円)', value: 'monster_ball_10_2000', description: 'まとめ買い用。中身は10個です' },
                { label: '📦 スーパーボール 10個セット (6000円)', value: 'super_ball_10_6000', description: 'まとめ買い用。中身は10個です' },
                { label: '📦 ハイパーボール 10個セット (12000円)', value: 'hyper_ball_10_12000', description: 'まとめ買い用。中身は10個です' },
                { label: '🩹 きずぐすり (200円)', value: 'potion_1_200', description: 'HPを50回復する（戦闘外で使用可能）' },
                { label: '💊 まんたんのくすり (2500円)', value: 'max_potion_1_2500', description: 'HPと状態異常を全回復する' },
                { label: '⚙️ がくしゅうそうち (10000円)', value: 'exp_share_1_10000', description: '控えのポケモンも経験値をもらえる（1つまで）' },
                { label: '⭐ プレミアムボール (3000円)', value: 'premier_ball_1_3000', description: '捕獲率1.5倍＋見た目が豪華なボール' },
                // 👇 ここから下を追記
                { label: '📀 わざマシン【ほのお系】(5000円)', value: 'tm_fire_1_5000', description: '炎タイプの強力な技を習得させる' },
                { label: '📀 わざマシン【みず系】(5000円)', value: 'tm_water_1_5000', description: '水タイプの強力な技を習得させる' },
                { label: '📀 わざマシン【でんき系】(5000円)', value: 'tm_electric_1_5000', description: '電気タイプの強力な技を習得させる' },
                { label: '💊 レベルアップアメ (8000円)', value: 'rare_candy_1_8000', description: 'ポケモンを1レベル上げる（Lv99まで）' }
            ]);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
