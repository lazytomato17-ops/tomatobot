// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️', psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🕶️', steel: '⚙️', fairy: '✨'
};

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('捕まえたポケモンを確認する（全員に見えます）'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (interaction.isButton()) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply(); 
        }

        const limit = 6; // 🌟 枠(フィールド)表示の場合、スマホでも見やすい6匹に設定
        const offset = page * limit;

        // 🌟 バグ修正: { count: 'exact' } で全体の数を正確に取得し、行き過ぎを防止！
        const { data: pokemons, count, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*', { count: 'exact' })
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error || !pokemons || pokemons.length === 0) {
            // 万が一ページ外に飛んだ場合のセーフティ
            if (page > 0) return interaction.editReply({ content: 'このページには ポケモンが いないようだ！', embeds: [], components: [] });
            return interaction.editReply({ content: 'ボックスには 何も いないようだ……\n`/wild` で探してみよう！', embeds: [], components: [] });
        }

        // 🌟 正確な総ページ数を計算（最低1ページ）
        const totalPages = Math.max(1, Math.ceil((count || 0) / limit));

        const embed = new EmbedBuilder()
            .setTitle(`📦 ${interaction.user.username} のボックス (${page + 1} / ${totalPages} ページ)`)
            .setColor(0x00BFFF);

        pokemons.forEach((poke, index) => {
            // 🌟 懐かしの星評価とフレーバーテキストを復活！
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            let stars = ''; let flavor = '';
            if (totalIv >= 160) { stars = '⭐⭐⭐'; flavor = 'とびきり すばらしい 能力！'; }
            else if (totalIv >= 120) { stars = '⭐⭐'; flavor = 'すばらしい 能力！'; }
            else if (totalIv >= 90) { stars = '⭐'; flavor = 'かなりの 能力。'; }
            else { stars = '・'; flavor = 'まずまずの 能力。'; }

            // 安全なタイプ解析（バグ対策済み）
            let typeArray = poke.types;
            if (typeof typeArray === 'string') {
                try { typeArray = JSON.parse(typeArray); } catch (e) { typeArray = []; }
            }
            const typeIcons = Array.isArray(typeArray) ? typeArray.map((t: any) => {
                const typeName = typeof t === 'string' ? t : (t?.type?.name || t?.name || 'unknown');
                return TYPE_MAP[typeName] || typeName;
            }).join('') : '';

            const partyIcon = poke.is_party ? '🎈' : '';
            
            // 🌟 一番見やすかった「フィールド（addFields）」での横並び表示！
            embed.addFields({
                name: `${offset + index + 1}. ${partyIcon}${poke.nickname} (Lv.${poke.level}) ${typeIcons}`,
                value: `評価: ${stars} (計:${totalIv})\n*「${flavor}」*`,
                inline: true
            });
        });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`box_page_${page - 1}`)
                .setLabel('◀ 前へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page <= 0), // 最初のページなら押せない
            new ButtonBuilder()
                .setCustomId(`box_page_${page + 1}`)
                .setLabel('次へ ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1) // 最後のページなら押せない
        );

        await interaction.editReply({ content: '', embeds: [embed], components: [row] });
    }
};
