// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb'; // 👈 先ほど作ったDBファイルをインポート

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('捕まえたポケモンを確認する（最新6匹を表示）'),

    async execute(interaction: ChatInputCommandInteraction) {
        // DBアクセスがあるので「考え中...」にする
        await interaction.deferReply();

        try {
            // 1. Supabaseから自分のポケモンを「捕まえた日時の新しい順」に6匹取得
            const { data: pokemons, error } = await supabase
                .from('poke_caught_pokemons')
                .select('*')
                .eq('owner_id', interaction.user.id)
                .order('caught_at', { ascending: false })
                .limit(6);

            if (error) throw error;

            // 2. 1匹も持っていない場合
            if (!pokemons || pokemons.length === 0) {
                return interaction.editReply('ボックスには まだ 何も いないようだ……\nまずは `/wild` でポケモンを探してみよう！');
            }

            // 3. Embed（埋め込みメッセージ）の作成
            const embed = new EmbedBuilder()
                .setTitle(`📦 ${interaction.user.username} のボックス（最新6匹）`)
                .setColor(0x00BFFF)
                .setFooter({ text: '※個体値(IV)は各ステータス最大31です' });

            // 4. 取得したポケモンをループ処理してリストに追加
            pokemons.forEach((poke, index) => {
                // 個体値を本家プレイヤーっぽく「H-A-B-C-D-S」で表記
                const ivs = `H${poke.iv_hp} A${poke.iv_attack} B${poke.iv_defense} C${poke.iv_sp_atk} D${poke.iv_sp_def} S${poke.iv_speed}`;
                
                // 個体値の合計（最大186）を計算して、強さの目安にする
                const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
                let evaluation = '';
                if (totalIv >= 150) evaluation = '🌟 神個体！';
                else if (totalIv >= 120) evaluation = '✨ 優秀';
                else evaluation = '凡才';

                embed.addFields({
                    name: `${index + 1}. ${poke.nickname} (Lv.${poke.level})`,
                    value: `**せいかく**: ${poke.nature}\n**個体値**: \`${ivs}\`\n**評価**: ${totalIv}/186 (${evaluation})`,
                    inline: false
                });
            });

            // 結果を送信！
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('ボックス取得エラー:', error);
            await interaction.editReply('❌ データの取得に失敗しました。');
        }
    }
};