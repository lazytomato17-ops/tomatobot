// src/commands/area.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const areaCommand = {
    data: new SlashCommandBuilder()
        .setName('area')
        .setDescription('探索するエリアと危険度（レベル帯）を移動します')
        .addStringOption(option => 
            option.setName('name')
                .setDescription('移動先のエリアを選択')
                .setRequired(true)
                .addChoices(
                    { name: '🌱 草原 (ノーマル/ひこう)', value: '草原' },
                    { name: '🌲 森 (むし/くさ/どく)', value: '森' },
                    { name: '🌊 海 (みず)', value: '海' },
                    { name: '⛰️ 洞窟 (いわ/じめん/あく)', value: '洞窟' },
                    { name: '🌋 火山 (ほのお/かくとう)', value: '火山' },
                    { name: '❄️ 雪山 (こおり/はがね)', value: '雪山' },
                    { name: '👻 霊園 (ゴースト/エスパー)', value: '霊園' },
                    { name: '🏛️ 神殿 (ドラゴン/フェアリー/でんき)', value: '神殿' }
                )
        )
        .addStringOption(option => 
            option.setName('rank')
                .setDescription('エリアの危険度（出現するポケモンのレベル帯）')
                .setRequired(true)
                .addChoices(
                    { name: '🟢 浅瀬 (Lv.2〜15)', value: 'low' },
                    { name: '🟡 奥地 (Lv.16〜35)', value: 'mid' },
                    { name: '🔴 秘境 (Lv.36〜55)', value: 'high' },
                    { name: '🟣 伝説 (Lv.56〜75)', value: 'master' }
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const areaName = interaction.options.getString('name', true);
        const rank = interaction.options.getString('rank', true);
        
        const rankLabels: Record<string, string> = { 'low': '浅瀬', 'mid': '奥地', 'high': '秘境', 'master': '伝説' };
        
        // ユーザーの現在地と危険度をセットで更新
        const { error } = await supabase
            .from('poke_users')
            .update({ current_area: areaName, current_rank: rank })
            .eq('discord_id', interaction.user.id);
            
        if (error) return interaction.editReply('❌ 移動に失敗しました。');
        
        await interaction.editReply(`🚶‍♂️ **${areaName} の ${rankLabels[rank]}** に到着しました！\nこれ以降 \`/wild\` を実行すると、この条件のポケモンが出現します。`);
    }
};