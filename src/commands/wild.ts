// src/commands/wild.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType } from 'discord.js';
import { supabase } from '../pokeDb';
import { getRandomPokemonIdByArea, getMovesForLevel, AREAS } from '../pokeApiUtils';

export const wildCommand = {
    data: new SlashCommandBuilder()
        .setName('wild')
        .setDescription('草むらを探して野生のポケモンを見つける')
        .addStringOption(option => 
            option.setName('area')
            .setDescription('探索するエリア')
            .addChoices(...Object.keys(AREAS).map(a => ({ name: a, value: a })))
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const area = interaction.options.getString('area');

        try {
            const pokeId = await getRandomPokemonIdByArea(area);
            const [pokeRes, speciesRes] = await Promise.all([
                fetch(`https://pokeapi.co/api/v2/pokemon/${pokeId}`),
                fetch(`https://pokeapi.co/api/v2/pokemon-species/${pokeId}`)
            ]);
            const pokeData = await pokeRes.json();
            const speciesData = await speciesRes.json();

            const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || pokeData.name.toUpperCase();
            const imageUrl = pokeData.sprites.other['official-artwork'].front_default || pokeData.sprites.front_default;
            const captureRate = speciesData.capture_rate || 45; // 0~255

            // プレイヤーのインベントリからボールの所持数を取得
            const { data: inventory } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id);
            const getQty = (id: string) => inventory?.find(i => i.item_id === id)?.quantity || 0;
            
            const balls = [
                { id: 'monster_ball', name: 'モンスターボール', emoji: '🔴', rate: 1.0, qty: getQty('monster_ball') },
                { id: 'super_ball', name: 'スーパーボール', emoji: '🔵', rate: 1.5, qty: getQty('super_ball') },
                { id: 'hyper_ball', name: 'ハイパーボール', emoji: '🟡', rate: 2.0, qty: getQty('hyper_ball') }
            ].filter(b => b.qty > 0);

            const embed = new EmbedBuilder()
                .setTitle(`あ！ やせいの **${jaName}** がとびだしてきた！`)
                .setImage(imageUrl)
                .setColor(0x2E8B57)
                .setDescription(`(エリア: ${area || 'ランダム'})`)
                .setFooter({ text: `基礎捕獲率: ${Math.round((captureRate / 255) * 100)}%` });

            if (balls.length === 0) {
                return interaction.editReply({ content: 'ボールを1つも持っていない！\n`/shop` で購入しよう。', embeds: [embed] });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`throw_ball_${pokeId}_${jaName}_${captureRate}`)
                .setPlaceholder('投げるボールを選んでください')
                .addOptions(balls.map(b => ({
                    label: `${b.name} (残り: ${b.qty}個)`,
                    value: `${b.id}_${b.rate}`,
                    emoji: b.emoji
                })));

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            await interaction.editReply({ embeds: [embed], components: [row] });

        } catch (error) {
            await interaction.editReply('通信エラーが発生しました。');
        }
    }
};
