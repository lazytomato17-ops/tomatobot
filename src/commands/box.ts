// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// 視認性を上げるため、1タイプにつき1つの絵文字を添える
const TYPE_MAP: Record<string, string> = {
    normal: '⚪ノーマル', fire: '🔥ほのお', water: '💧みず', electric: '⚡でんき', grass: '🌿くさ', ice: '❄️こおり', fighting: '🥊かくとう', poison: '☠️どく', ground: '🌍じめん', flying: '🕊️ひこう', psychic: '🔮エスパー', bug: '🐛むし', rock: '🪨いわ', ghost: '👻ゴースト', dragon: '🐉ドラゴン', dark: '🕶️あく', steel: '⚙️はがね', fairy: '✨フェアリー'
};

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('ボックスのポケモンを確認する'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const limit = 6;
        const offset = page * limit;

        const { data: pokemons, count, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*', { count: 'exact' })
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ボックスには 何も いないようだ……');
        }

        const totalPages = Math.ceil((count || 0) / limit);
        
        const embed = new EmbedBuilder()
            .setTitle(`📦 ボックス (${page + 1} / ${totalPages})`)
            .setColor(0x00BFFF); // ポケモンらしい爽やかなブルー

        let descriptionText = '';
        pokemons.forEach((poke, index) => {
            const typeStr = poke.types ? poke.types.map((t: string) => TYPE_MAP[t] || t).join(' / ') : '不明';
            // 手持ちにはワンポイントで星をつけて目立たせる
            const partyBadge = poke.is_party ? ' 🌟`手持ち`' : '';
            
            const ivStr = `H${poke.iv_hp} A${poke.iv_attack} B${poke.iv_defense} C${poke.iv_sp_atk} D${poke.iv_sp_def} S${poke.iv_speed}`;
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;

            // スッキリしつつも情報がスッと入ってくるレイアウト
            descriptionText += `**${offset + index + 1}. ${poke.nickname}** (Lv.${poke.level})${partyBadge}\n`;
            descriptionText += `タイプ: ${typeStr}\n`;
            descriptionText += `個体値: \`[ ${ivStr} ]\` (計:${totalIv})\n\n`;
        });

        embed.setDescription(descriptionText);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`box_page_${page - 1}`)
                .setLabel('◀ 前へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`box_page_${page + 1}`)
                .setLabel('次へ ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1)
        );

        await interaction.editReply({ 
            embeds: [embed], 
            components: [row] 
        });
    }
};
