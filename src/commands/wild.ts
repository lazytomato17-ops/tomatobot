// src/commands/wild.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { AREAS } from '../pokeApiUtils';
import { startWildBattle } from '../battleLogic';

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('草むらを探して野生のポケモンを見つけ、バトルを開始する')
        .addStringOption(option => 
            option.setName('area')
            .setDescription('探索するエリア')
            .addChoices(...Object.keys(AREAS).map(a => ({ name: a, value: a })))
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const area = interaction.options.getString('area');
        
        // ⚔️ 野生バトルを開始する処理に丸投げ！
        await startWildBattle(interaction, interaction.user.id, area);
    }
};
