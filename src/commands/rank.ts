// src/commands/rank.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const rankCommand = {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('ポケモンバトルのランキングを表示する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 勝利数ランキングTop10
        const { data: topWins } = await supabase.from('poke_users').select('discord_id, wins').order('wins', { ascending: false }).limit(10);
        
        // 最大連勝数ランキングTop10
        const { data: topStreaks } = await supabase.from('poke_users').select('discord_id, max_win_streak').order('max_win_streak', { ascending: false }).limit(10);

        const buildRankText = (data: any[], key: string, unit: string) => {
            if (!data || data.length === 0) return 'データがありません。';
            return data.map((u, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🔹';
                return `${medal} <@${u.discord_id}> : **${u[key] || 0}** ${unit}`;
            }).join('\n');
        };

        const embed = new EmbedBuilder()
            .setTitle('🏆 バトルランキング')
            .setColor(0xFF8C00)
            .addFields(
                { name: '⚔️ 通算勝利数 トップ10', value: buildRankText(topWins || [], 'wins', '勝'), inline: false },
                { name: '🔥 最大連勝数 トップ10', value: buildRankText(topStreaks || [], 'max_win_streak', '連勝'), inline: false }
            );

        await interaction.editReply({ embeds: [embed] });
    }
};
