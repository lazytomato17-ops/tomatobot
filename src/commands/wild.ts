// src/commands/wild.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startWildBattle } from '../battleLogic';

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('草むらを歩き回って、野生のポケモンを探す'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        
        // ⚔️ エリアの指定（null）で、全種類から完全ランダムに出現させます
        await startWildBattle(interaction, interaction.user.id, null);
    }
};
