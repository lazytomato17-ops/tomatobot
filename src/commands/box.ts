// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChatInputCommandInteraction, ComponentType } from 'discord.js';
import { supabase } from '../pokeDb';

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('捕まえたポケモンを確認・ロックする（最新10匹を表示）'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false })
            .limit(10); // 10匹に拡張

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ボックスには 何も いないようだ……\n`/wild` で探してみよう！');
        }

        const embed = new EmbedBuilder()
            .setTitle(`📦 ${interaction.user.username} のボックス`)
            .setColor(0x00BFFF);

        const selectOptions: any[] = [];

        pokemons.forEach((poke, index) => {
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            
            // 🌟 本家ライクなフレーバーテキストと星評価
            let stars = '';
            let flavor = '';
            if (totalIv >= 160) { stars = '⭐⭐⭐'; flavor = 'とびきり すばらしい 能力を 持っている！'; }
            else if (totalIv >= 120) { stars = '⭐⭐'; flavor = 'すばらしい 能力を 持っている！'; }
            else if (totalIv >= 90) { stars = '⭐'; flavor = 'かなりの 能力を 持っている。'; }
            else { stars = '・'; flavor = 'まずまずの 能力を 持っているようだ。'; }

            const lockIcon = poke.is_locked ? '🔒' : '🔓';
            const partyIcon = poke.is_party ? '🎈' : '';

            embed.addFields({
                name: `${index + 1}. ${lockIcon}${partyIcon} ${poke.nickname} (Lv.${poke.level})`,
                value: `評価: ${stars} \n*「${flavor}」*`,
                inline: true
            });

            selectOptions.push({
                label: `${poke.nickname} を ${poke.is_locked ? 'ロック解除' : 'ロック'}`,
                value: poke.id,
                emoji: poke.is_locked ? '🔓' : '🔒'
            });
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('box_lock_toggle')
            .setPlaceholder('お気に入りをロック / ロック解除')
            .addOptions(selectOptions);

        await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] });
    }
};
