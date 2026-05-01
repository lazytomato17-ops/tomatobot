// src/commands/wild.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';
import { startWildBattle } from '../battleLogic';

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('現在いるエリアの草むらを歩き回って、野生のポケモンを探す'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        
        // ユーザーの現在のエリアをDBから取得
        const { data: user } = await supabase
            .from('poke_users')
            .select('current_area')
            .eq('discord_id', interaction.user.id)
            .single();
            
        // DBに記録がない（初回など）場合は「草原」をデフォルトにする
        const area = user?.current_area || '草原';
        
        // 取得したエリアを渡してバトル開始
        await startWildBattle(interaction, interaction.user.id, area);
    }
};