// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️', psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🕶️', steel: '⚙️', fairy: '✨'
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

        // 🌟 最新順に取得、ページネーション用に全件数も取得
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
            .setTitle(`📦 ${interaction.user.username} のボックス (${page + 1} / ${totalPages})`)
            .setColor(0x00BFFF);

        let descriptionText = '';
        pokemons.forEach((poke, index) => {
            const typeIcons = poke.types ? poke.types.map((t: string) => TYPE_MAP[t] || t).join('') : '';
            const partyIcon = poke.is_party ? '🎈' : '';
            
            // 🌟 本格的な個体値表示 (H-A-B-C-D-S)
            const ivStr = `H${poke.iv_hp} A${poke.iv_attack} B${poke.iv_defense} C${poke.iv_sp_atk} D${poke.iv_sp_def} S${poke.iv_speed}`;
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;

            descriptionText += `**${offset + index + 1}.** ${partyIcon} **${poke.nickname}** (Lv.${poke.level}) ${typeIcons}\n`;
            descriptionText += `\`[ ${ivStr} ]\` 計:${totalIv}\n\n`;
        });

        embed.setDescription(descriptionText);

        // 🌟 ページ移動ボタン
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
