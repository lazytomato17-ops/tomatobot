// src/commands/wild.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startWildBattle } from '../battleLogic';

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('エリアを選んで、野生のポケモンを探す')
        .addStringOption(option => 
            option.setName('area')
                .setDescription('探索するエリアを選択（指定しない場合はランダム）')
                .setRequired(false)
                .addChoices(
                    { name: '🌱 草原', value: '草原' },
                    { name: '🌲 森', value: '森' },
                    { name: '🌊 海', value: '海' },
                    { name: '⛰️ 洞窟', value: '洞窟' },
                    { name: '🌋 火山', value: '火山' },
                    { name: '❄️ 雪山', value: '雪山' },
                    { name: '👻 霊園', value: '霊園' },
                    { name: '🏛️ 神殿', value: '神殿' }
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const area = interaction.options.getString('area');
        await startWildBattle(interaction, interaction.user.id, area);
    }
};