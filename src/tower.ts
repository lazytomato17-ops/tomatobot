import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startTowerBattle } from '../battleLogic';

export const towerCommand = {
    data: new SlashCommandBuilder()
        .setName('tower')
        .setDescription('🏢 限界に挑戦！バトルタワーに入場します'),
    async execute(interaction: ChatInputCommandInteraction) {
        await startTowerBattle(interaction, interaction.user.id, 1);
    }
};
