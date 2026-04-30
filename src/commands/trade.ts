// src/commands/trade.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startTrade } from '../tradeLogic';

export const tradeCommand = {
    data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('他のプレイヤーとポケモンを通信交換する')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('交換したい相手のユーザー')
                .setRequired(true)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await startTrade(interaction);
    }
};
