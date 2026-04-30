// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('ボックスのポケモンを確認する'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        if (interaction.isButton()) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply(); 
            // 🌟 強制修復パッチ: ボックスを開いた瞬間、手持ちが7匹以上バグで存在していたら6匹にカットする！
            const { data: currentParty } = await supabase.from('poke_caught_pokemons').select('id').eq('owner_id', interaction.user.id).eq('is_party', true).order('party_order', { ascending: true });
            if (currentParty && currentParty.length > 6) {
                const overflowIds = currentParty.slice(6).map(p => p.id);
                await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
            }
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
            return interaction.editReply({ content: 'ボックスには 何も いないようだ……', embeds: [], components: [] });
        }

        const totalPages = Math.ceil((count || 0) / limit);
        const embed = new EmbedBuilder()
            .setTitle(`📦 ${interaction.user.username} のボックス（最新 ${count} 匹）`)
            .setColor(0x00BFFF);

        let descriptionText = '';
        pokemons.forEach((poke, index) => {
            const partyIcon = poke.is_party ? ' 🎈手持ち' : '';

            // 評価ロジック
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            let evaluation = '';
            if (totalIv >= 150) evaluation = '🌟 神個体！';
            else if (totalIv >= 120) evaluation = '✨ 優秀';
            else evaluation = '凡才';

            // 🌟 名前の白さを保ち、情報を整理したレイアウト
            descriptionText += `**${offset + index + 1}. ${poke.nickname} (Lv.${poke.level})**${partyIcon}\n`;
            descriptionText += `**せいかく**: ${poke.nature}\n`;
            descriptionText += `**個体値**: \`H${poke.iv_hp} A${poke.iv_attack} B${poke.iv_defense} C${poke.iv_sp_atk} D${poke.iv_sp_def} S${poke.iv_speed}\`\n`;
            descriptionText += `**評価**: ${totalIv}/186 (${evaluation})\n\n`;
        });

        embed.setDescription(descriptionText);

        // 🌟 ご指摘の通り、補足説明とページ情報を「した（フッター）」に集約
        embed.setFooter({ 
            text: `※個体値(IV)は各ステータス最大31です | ページ ${page + 1} / ${totalPages}` 
        });

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
