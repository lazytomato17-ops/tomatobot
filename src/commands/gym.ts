import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startGymBattle } from '../battleLogic';

export const gymCommand = {
    data: new SlashCommandBuilder()
        .setName('gym')
        .setDescription('ジムリーダーに挑戦してバッジを集める')
        .addStringOption(option => 
            option.setName('leader')
                .setDescription('挑戦するジムリーダーを選択')
                .setRequired(true)
                .addChoices(
                    { name: '🪨 タケシ (推奨Lv: 15)', value: 'rock' },
                    { name: '💧 カスミ (推奨Lv: 21)', value: 'water' },
                    { name: '⚡ マチス (推奨Lv: 25)', value: 'electric' }
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const leaderId = interaction.options.getString('leader', true);
        await startGymBattle(interaction, interaction.user.id, leaderId);
    }
};