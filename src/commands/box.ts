// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️', psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🕶️', steel: '⚙️', fairy: '✨'
};

// 🌟 UI改善: 総合値を直感的なランク(S〜D)に変換する関数
function getRank(totalIv: number): string {
    if (totalIv >= 160) return '🏆`[ S ]`';
    if (totalIv >= 130) return '🥇`[ A ]`';
    if (totalIv >= 100) return '🥈`[ B ]`';
    if (totalIv >= 70)  return '🥉`[ C ]`';
    return '💨`[ D ]`';
}

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('手持ちとボックスのポケモンを確認する'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (interaction.isButton()) await interaction.deferUpdate();
        else await interaction.deferReply(); 

        const limit = 5; // 🌟 UI改善: 画面占有率を考慮し、1ページ5匹にするとスマホで完璧に収まります
        const offset = page * limit;

        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false })
            .range(offset, offset + limit);

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply({ content: 'ボックスには 何も いないようだ……', embeds: [], components: [] });
        }

        const hasNext = pokemons.length > limit;
        const displayPokemons = pokemons.slice(0, limit);

        const embed = new EmbedBuilder()
            .setTitle(`🗃️ ポケモンボックス (PAGE: ${page + 1})`)
            .setColor(0x2B2D31);

        let descriptionText = '';
        displayPokemons.forEach((poke, index) => {
            let typeArray = poke.types;
            if (typeof typeArray === 'string') {
                try { typeArray = JSON.parse(typeArray); } catch (e) { typeArray = []; }
            }
            const typeIcons = Array.isArray(typeArray) ? typeArray.map((t: any) => {
                const typeName = typeof t === 'string' ? t : (t?.type?.name || t?.name || 'unknown');
                return TYPE_MAP[typeName] || typeName;
            }).join(' / ') : '❓';

            const partyBadge = poke.is_party ? ' 🏷️`PARTY`' : '';
            
            const ivH = poke.iv_hp.toString().padStart(2, '0');
            const ivA = poke.iv_attack.toString().padStart(2, '0');
            const ivB = poke.iv_defense.toString().padStart(2, '0');
            const ivC = poke.iv_sp_atk.toString().padStart(2, '0');
            const ivD = poke.iv_sp_def.toString().padStart(2, '0');
            const ivS = poke.iv_speed.toString().padStart(2, '0');
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            const rankStr = getRank(totalIv);

            // 🌟 UI改善: 視線誘導（Fの法則）を意識したレイアウト
            descriptionText += `**${offset + index + 1}. ${poke.nickname}** (Lv.${poke.level}) ${typeIcons}${partyBadge}\n`;
            descriptionText += `> 📊 評価: ${rankStr}  (計:${totalIv})\n`;
            descriptionText += `> 🧬 個体: \`H${ivH} A${ivA} B${ivB} C${ivC} D${ivD} S${ivS}\`\n\n`;
        });

        embed.setDescription(descriptionText);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`box_page_${page - 1}`)
                .setLabel('◀ 前のページ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`box_page_${page + 1}`)
                .setLabel('次のページ ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!hasNext)
        );

        await interaction.editReply({ content: '', embeds: [embed], components: [row] });
    }
};
