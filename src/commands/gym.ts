import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { startGymBattle } from '../battleLogic';

export const gymCommand = {
    data: new SlashCommandBuilder()
        .setName('gym')
        .setDescription('ジムリーダーや四天王に挑戦してバッジを集める')
        .addStringOption(option => 
            option.setName('leader')
                .setDescription('挑戦する相手を選択')
                .setRequired(true)
                .addChoices(
                    { name: '🪨 タケシ (推奨Lv: 15)', value: 'rock' },
                    { name: '💧 カスミ (推奨Lv: 21)', value: 'water' },
                    { name: '⚡ マチス (推奨Lv: 25)', value: 'electric' },
                    { name: '🌈 エリカ (推奨Lv: 29)', value: 'grass' },
                    { name: '💖 キョウ (推奨Lv: 43)', value: 'poison' },
                    { name: '🟡 ナツメ (推奨Lv: 43)', value: 'psychic' },
                    { name: '🔥 カツラ (推奨Lv: 47)', value: 'fire' },
                    { name: '🌿 サカキ (推奨Lv: 50)', value: 'ground' },
                    // 🌟 絶望の四天王を追加！
                    { name: '❄️ カンナ (推奨Lv: 75)', value: 'e4_ice' },
                    { name: '👊 シバ (推奨Lv: 80)', value: 'e4_fight' },
                    { name: '👻 キクコ (推奨Lv: 85)', value: 'e4_ghost' },
                    { name: '🐉 ワタル (推奨Lv: 90)', value: 'e4_dragon' },
                    { name: '👑 チャンピオン (推奨Lv: 100)', value: 'champion' }
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const leaderId = interaction.options.getString('leader', true);
        await startGymBattle(interaction, interaction.user.id, leaderId);
    }
};
