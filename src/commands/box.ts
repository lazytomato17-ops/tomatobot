// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// ── info.ts と共通の定数 ────────────────────────────────────────────
const TYPE_COLOR: Record<string, number> = {
    normal: 0xA8A878, fire: 0xF08030, water: 0x6890F0, electric: 0xF8D030,
    grass: 0x78C850, ice: 0x98D8D8, fighting: 0xC03028, poison: 0xA040A0,
    ground: 0xE0C068, flying: 0xA890F0, psychic: 0xF85888, bug: 0xA8B820,
    rock: 0xB8A038, ghost: 0x705898, dragon: 0x7038F8, dark: 0x705848,
    steel: 0xB8B8D0, fairy: 0xEE99AC
};

const STATUS_MAP: Record<string, string> = {
    burn: '🔥やけど', paralysis: '⚡まひ', poison: '☠️どく',
    'bad-poison': '☠️☠️もうどく', sleep: '💤ねむり', freeze: '❄️こおり', faint: '💀ひんし'
};

const GENDER_MAP: Record<string, string> = { male: '♂', female: '♀', unknown: '' };

// info.ts と同じ評価閾値
function getStars(totalIv: number): string {
    if (totalIv >= 160) return '⭐⭐⭐';
    if (totalIv >= 120) return '⭐⭐';
    if (totalIv >= 90)  return '⭐';
    return '・';
}

// ── boxCommand ──────────────────────────────────────────────────────
export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('ボックスのポケモンを確認する'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (interaction.isButton()) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply();
            // 手持ちが7匹以上のバグを修復
            const { data: currentParty } = await supabase
                .from('poke_caught_pokemons').select('id')
                .eq('owner_id', interaction.user.id).eq('is_party', true)
                .order('party_order', { ascending: true });
            if (currentParty && currentParty.length > 6) {
                const overflowIds = currentParty.slice(6).map(p => p.id);
                await supabase.from('poke_caught_pokemons')
                    .update({ is_party: false, party_order: null }).in('id', overflowIds);
            }
        }

        const limit = 6;
        const offset = page * limit;

        const { data: pokemons, count, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*', { count: 'exact' })
            .eq('owner_id', interaction.user.id)
            .order('is_party', { ascending: false })   // 手持ち優先（info と同順）
            .order('caught_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply({ content: 'ボックスには 何も いないようだ……', embeds: [], components: [] });
        }

        const totalPages = Math.ceil((count || 0) / limit);

        // ページ内の先頭ポケモンのタイプ色をEmbedカラーに使用
        const firstTypes: string[] = pokemons[0].types ?? [];
        const primaryType = firstTypes[0] ?? 'normal';
        const embedColor = TYPE_COLOR[primaryType] ?? 0x00BFFF;

        const embed = new EmbedBuilder()
            .setTitle(`📦 ${interaction.user.username} のボックス（全 ${count} 匹）`)
            .setColor(embedColor);

        let descriptionText = '';
        pokemons.forEach((poke, index) => {
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            const stars    = getStars(totalIv);
            const gender   = GENDER_MAP[poke.gender] ?? '';
            const shiny    = poke.is_shiny ? ' ✨' : '';
            const locked   = poke.is_locked ? ' 🔒' : '';
            const party    = poke.is_party ? ' 🎈手持ち' : '';
            const status   = poke.status_condition ? ` ${STATUS_MAP[poke.status_condition] ?? poke.status_condition}` : '';
            const item     = poke.held_item ? ` 🎒${poke.held_item}` : '';

            descriptionText +=
                `**${offset + index + 1}. ${poke.nickname}${gender}${shiny}${locked} (Lv.${poke.level})**${party}${status}${item}\n` +
                `**せいかく**: ${poke.nature}\n` +
                `**個体値**: \`H${poke.iv_hp} A${poke.iv_attack} B${poke.iv_defense} C${poke.iv_sp_atk} D${poke.iv_sp_def} S${poke.iv_speed}\` (合計: ${totalIv}/186)\n` +
                `**評価**: ${stars}\n\n`;
        });

        embed
            .setDescription(descriptionText)
            .setFooter({ text: `※個体値(IV)は各ステータス最大31 | ⭐⭐⭐:160〜 / ⭐⭐:120〜 / ⭐:90〜 | ページ ${page + 1} / ${totalPages}` });

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

        await interaction.editReply({ content: '', embeds: [embed], components: [row] });
    }
};