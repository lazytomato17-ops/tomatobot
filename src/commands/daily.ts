// src/commands/daily.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const dailyCommand = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('1日1回のログインボーナスを受け取る'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('*').eq('discord_id', interaction.user.id).single();
        if (!user) return interaction.editReply('ユーザーデータが見つかりません。');

        const now = new Date();
        const lastDaily = user.last_daily_at ? new Date(user.last_daily_at) : new Date(0);
        
        // 日付が変わっているかチェック (JST基準の簡易判定)
        const toJSTDateStr = (d: Date) => {
            const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            return jst.toISOString().slice(0, 10); // "2025-01-15"
        };
        const isSameDay = toJSTDateStr(now) === toJSTDateStr(lastDaily);

        if (isSameDay) {
            return interaction.editReply('⚠️ 今日のボーナスは既に受け取っています！また明日来てください。');
        }

        // 連続ログイン判定も同様に修正
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const isConsecutive = toJSTDateStr(yesterday) === toJSTDateStr(lastDaily);
        let newStreak = isConsecutive ? (user.daily_streak || 0) + 1 : 1;

        // 報酬計算 (基本100〜500円 + ストリークボーナス)
        const baseReward = Math.floor(Math.random() * 401) + 100;
        const streakBonus = Math.min(newStreak * 50, 1000); // 最大1000円ボーナス
        const totalReward = baseReward + streakBonus;

        await supabase.from('poke_users').update({ 
            money: (user.money || 0) + totalReward,
            last_daily_at: now.toISOString(),
            daily_streak: newStreak
        }).eq('discord_id', interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('🎁 デイリーボーナス！')
            .setColor(0xFFD700)
            .setDescription(`**${totalReward} 円** を手に入れた！\n\n🔥 連続ログイン: **${newStreak}日** (ボーナス +${streakBonus}円)`);

        await interaction.editReply({ embeds: [embed] });
    }
};
