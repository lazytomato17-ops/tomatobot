// src/commands/info.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const infoCommand = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('現在手持ちに設定しているポケモンの詳細ステータスを見る'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: party, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true);

        if (error || !party || party.length === 0) {
            return interaction.editReply('手持ちにポケモンがいません。`/party` で設定してください！');
        }

        // 最初の1匹（先頭）の詳細を表示する
        const leadPoke = party[0];

        try {
            // PokeAPIから画像データを取得
            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${leadPoke.pokedex_id}`);
            const pokeData = await pokeRes.json();
            const imageUrl = pokeData.sprites.other['official-artwork'].front_default;

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${leadPoke.nickname} のステータス`)
                .setImage(imageUrl)
                .setColor(0xFFA500)
                .addFields(
                    { name: '基本情報', value: `Lv: **${leadPoke.level}**\n性格: **${leadPoke.nature}**`, inline: true },
                    { name: 'HP', value: `${leadPoke.current_hp} / (最大値未計算)`, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true }, // 空白調整
                    { name: '個体値 (才能)', value: `H:**${leadPoke.iv_hp}** A:**${leadPoke.iv_attack}** B:**${leadPoke.iv_defense}**\nC:**${leadPoke.iv_sp_atk}** D:**${leadPoke.iv_sp_def}** S:**${leadPoke.iv_speed}**`, inline: false }
                );

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('通信エラーが発生しました。');
        }
    }
};