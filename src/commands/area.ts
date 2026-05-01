// src/commands/area.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const areaCommand = {
    data: new SlashCommandBuilder()
        .setName('area')
        .setDescription('探索するエリアを移動します')
        .addStringOption(option => 
            option.setName('name') // オプション名を 'name' 等にしておくと自然です
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
        const areaName = interaction.options.getString('name', true);
        
        // ユーザーの現在地を更新
        const { error } = await supabase
            .from('poke_users')
            .update({ current_area: areaName })
            .eq('discord_id', interaction.user.id);
            
        if (error) {
            console.error('移動エラー:', error);
            return interaction.editReply('❌ 移動に失敗しました。先に `/wild` を一度実行してトレーナー登録を済ませてください。');
        }
        
        await interaction.editReply(`🚶‍♂️ **${areaName}** に到着しました！\nこれ以降 \`/wild\` を実行すると、このエリアのポケモンが出現します。`);
    }
};