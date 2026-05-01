// src/commands/daily.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';
import { getTodaysOutbreak } from '../pokeApiUtils';

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
        
        // 🌟 バグ修正：JST（日本時間）基準で正確に日付を判定する
        const toJSTDateStr = (d: Date) => {
            const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
            return jst.toISOString().slice(0, 10);
        };
        const isSameDay = toJSTDateStr(now) === toJSTDateStr(lastDaily);

        if (isSameDay) {
            return interaction.editReply('⚠️ 今日のボーナスは既に受け取っています！また明日来てください。');
        }

        // 連続ログイン判定 (前日かどうか)
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

        // 🌟 改善案1：アイテムの現物支給
        const itemsToGive = [
            { id: 'monster_ball', qty: 3, name: '🔴 モンスターボール' },
            { id: 'potion', qty: 1, name: '🩹 きずぐすり' }
        ];
        
        // 連続ログインの特別ボーナス
        if (newStreak % 7 === 0) {
            itemsToGive.push({ id: 'rare_candy', qty: 1, name: '💊 レベルアップアメ' });
        } else if (newStreak % 3 === 0) {
            itemsToGive.push({ id: 'super_ball', qty: 1, name: '🔵 スーパーボール' });
        }
        
        // アイテムをDBに付与
        for (const item of itemsToGive) {
            const { data: inv } = await supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', item.id).single();
            if (inv) {
                await supabase.from('poke_inventory').update({ quantity: inv.quantity + item.qty }).eq('user_id', interaction.user.id).eq('item_id', item.id);
            } else {
                await supabase.from('poke_inventory').insert([{ user_id: interaction.user.id, item_id: item.id, quantity: item.qty }]);
            }
        }

        const itemLog = itemsToGive.map(i => `・${i.name} ×${i.qty}`).join('\n');
        const outbreak = await getTodaysOutbreak(); // 👈 今日のニュースを取得

        const embed = new EmbedBuilder()
            .setTitle('🎁 デイリーボーナス！')
            .setColor(0xFFD700)
            .setDescription(`**${totalReward} 円** を手に入れた！\n\n🔥 連続ログイン: **${newStreak}日** (ボーナス +${streakBonus}円)\n\n📦 **今日の支給品アイテム**\n${itemLog}`)
            // 👇 フィールドを追加してニュースを表示！
            .addFields({ 
                name: '📺 今日のポケモンニュース', 
                value: `本日は **【${outbreak.area}】** エリアで **${outbreak.name}** が大量発生しているようです！\n\`/area name:${outbreak.area}\` で探しに行きましょう！` 
            });

        await interaction.editReply({ embeds: [embed] });
    }
};
