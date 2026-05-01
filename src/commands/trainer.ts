import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const trainerCommand = {
    data: new SlashCommandBuilder()
        .setName('trainer')
        .setDescription('自分のトレーナーカード（所持金・バッジなど）を確認する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const { data: user } = await supabase.from('poke_users').select('*').eq('discord_id', interaction.user.id).single();
        if (!user) return interaction.editReply('トレーナー情報が見つかりません。先に `/wild` を実行してください。');

        let badges = user.badges || [];
        if (typeof badges === 'string') badges = JSON.parse(badges);
        const badgeDisplay = badges.length > 0 ? badges.join('\n') : 'まだバッジを持っていません';

        const embed = new EmbedBuilder()
            .setTitle(`💳 ${interaction.user.username} のトレーナーカード`)
            .setColor(0x3498db)
            .setThumbnail(interaction.user.displayAvatarURL())
            .addFields(
                { name: '💰 所持金', value: `${user.money || 0}円`, inline: true },
                { name: '⚔️ PvP戦績', value: `${user.wins || 0}勝 (最高連勝: ${user.max_win_streak || 0})`, inline: true },
                { name: `🎖️ ジムバッジ (${badges.length}個)`, value: badgeDisplay, inline: false }
            );

        await interaction.editReply({ embeds: [embed] });
    }
};