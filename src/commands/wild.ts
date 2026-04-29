import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';

// 1〜1025（最新の全国図鑑）のランダムなIDを生成
const getRandomPokedexId = () => Math.floor(Math.random() * 1025) + 1;

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('草むらを探して野生のポケモンを見つける'),

    async execute(interaction: ChatInputCommandInteraction) {
        // API通信に少し時間がかかる場合があるため、一旦「考え中...」にする
        await interaction.deferReply();

        try {
            const pokeId = getRandomPokedexId();

            // 1. 基本データ（画像やステータス）を取得
            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`);
            const pokeData = await pokeRes.json();

            // 2. 種族データ（日本語名など）を取得
            const speciesRes = await fetch(pokeData.species.url);
            const speciesData = await speciesRes.json();

            // 日本語名を抽出（見つからなければ英語名を大文字にして代用）
            const jaNameObj = speciesData.names.find((n: any) => n.language.name === 'ja');
            const jaName = jaNameObj ? jaNameObj.name : pokeData.name.toUpperCase();

            // 画像は公式の高画質アートワークを使用
            const imageUrl = pokeData.sprites.other['official-artwork'].front_default || pokeData.sprites.front_default;

            // Embedを作成してリッチに表示
            const embed = new EmbedBuilder()
                .setTitle(`あ！ やせいの **${jaName}** がとびだしてきた！`)
                .setImage(imageUrl)
                .setColor(0x2E8B57) // 草むらっぽい緑色
                .addFields(
                    // とりあえずHPだけ表示（タイプはAPIの仕様上英語になるので一旦保留）
                    { name: 'HP', value: `${pokeData.stats.find((s: any) => s.stat.name === 'hp').base_stat}`, inline: true },
                    { name: '重さ', value: `${pokeData.weight / 10} kg`, inline: true }
                )
                .setTimestamp();

            // モンスターボールを投げるボタンを作成
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    // カスタムIDに「種類（catch）」と「ポケモンのID」を仕込んでおく
                    .setCustomId(`catch_${pokeId}_${jaName}`) 
                    .setLabel('モンスターボールを投げる')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔴')
            );

            // メッセージを送信（更新）
            await interaction.editReply({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('PokeAPI取得エラー:', error);
            await interaction.editReply('草むらには 何も いなかった…… (通信エラー)');
        }
    }
};