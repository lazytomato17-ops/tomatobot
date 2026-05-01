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
        
        // エリアと危険度の両方を取得！
        const { data: user } = await supabase
            .from('poke_users')
            .select('current_area, current_rank')
            .eq('discord_id', interaction.user.id)
            .single();
            
        const area = user?.current_area || '草原';
        const rank = user?.current_rank || 'low';
        
        // ランク（危険度）も一緒に渡すように変更
        await startWildBattle(interaction, interaction.user.id, area, rank);
    }
};