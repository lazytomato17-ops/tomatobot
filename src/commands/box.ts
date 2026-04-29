// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️', psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🕶️', steel: '⚙️', fairy: '✨'
};

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
        .setDescription('ボックスのポケモンを確認する'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (interaction.isButton()) await interaction.deferUpdate();
        else await interaction.deferReply(); 

        const limit = 5; 
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
            // 🌟 どんな形式のタイプデータが来ても「アイコン / アイコン」に直す最強処理
            let types: any[] = poke.types;
            if (typeof types === 'string') {
                try { types = JSON.parse(types); } catch (e) { types = []; }
            }
            
            const typeString = Array.isArray(types) 
                ? types.map(t => {
                    const name = (typeof t === 'string') ? t : (t.type?.name || t.name || 'unknown');
                    return TYPE_MAP[name] || name;
                  }).join(' / ')
                : '❓';

            const partyBadge = poke.is_party ? ' 🏷️`PARTY`' : '';
            
            const ivStr = `H${poke.iv_hp.toString().padStart(2, '0')} A${poke.iv_attack.toString().padStart(2, '0')} B${poke.iv_defense.toString().padStart(2, '0')} C${poke.iv_sp_atk.toString().padStart(2, '0')} D${poke.iv_sp_def.toString().padStart(2, '0')} S${poke.iv_speed.toString().padStart(2, '0')}`;
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            const rankStr = getRank(totalIv);

            // 🌟 UX改善: 名前行から「> 」を外して、真っ白な太字で目立たせる
            descriptionText += `**${offset + index + 1}. ${poke.nickname}** (Lv.${poke.level}) ${typeString}${partyBadge}\n`;
            descriptionText += `> 📊 評価: ${rankStr}  (計:${totalIv})\n`;
            descriptionText += `> 🧬 個体: \`${ivStr}\`\n\n`;
        });

        embed.setDescription(descriptionText);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`box_page_${page - 1}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`box_page_${page + 1}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!hasNext)
        );

        await interaction.editReply({ content: '', embeds: [embed], components: [row] });
    }
};
