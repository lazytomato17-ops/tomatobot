// src/commands/move.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const moveCommand = {
    data: new SlashCommandBuilder()
        .setName('move')
        .setDescription('探索するエリアを移動します')
        .addStringOption(option => 
            option.setName('area')
                .setDescription('移動先のエリアを選択')
                .setRequired(true)
                .addChoices(
                    { name: '🌱 草原 (Lv.2〜6)', value: '草原' },
                    { name: '🌲 森 (Lv.5〜12)', value: '森' },
                    { name: '🌊 海 (Lv.15〜29)', value: '海' },
                    { name: '⛰️ 洞窟 (Lv.15〜29)', value: '洞窟' },
                    { name: '🌋 火山 (Lv.30〜49)', value: '火山' },
                    { name: '❄️ 雪山 (Lv.30〜49)', value: '雪山' },
                    { name: '👻 霊園 (Lv.50〜69)', value: '霊園' },
                    { name: '🏛️ 神殿 (Lv.50〜69)', value: '神殿' }
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const area = interaction.options.getString('area', true);
        
        // ユーザーの現在地を更新
        const { error } = await supabase
            .from('poke_users')
            .update({ current_area: area })
            .eq('discord_id', interaction.user.id);
            
        if (error) {
            console.error('移動エラー:', error);
            return interaction.editReply('❌ 移動に失敗しました。先に `/wild` を一度実行してトレーナー登録を済ませてください。');
        }
        
        await interaction.editReply(`🚶‍♂️ **${area}** に移動しました！\nこれ以降 \`/wild\` を実行すると、このエリアのポケモンが出現します。`);
    }
};