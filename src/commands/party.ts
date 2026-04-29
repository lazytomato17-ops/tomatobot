// src/commands/party.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const partyCommand = {
    data: new SlashCommandBuilder()
        .setName('party')
        .setDescription('ボックスから最大6匹を選んで手持ちに設定する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 自分のポケモンを全取得
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false });

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ボックスにポケモンがいません。まずは `/wild` で捕まえましょう！');
        }

        // セレクトメニューの選択肢を作成（最大25匹まで表示可能）
        const options = pokemons.slice(0, 25).map(poke => ({
            label: `${poke.nickname} (Lv.${poke.level})`,
            description: `個体値合計: ${poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed}`,
            value: poke.id // DBのUUID
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('party_select')
            .setPlaceholder('手持ちに入れるポケモンを選んでください（最大6匹）')
            .setMinValues(1)
            .setMaxValues(Math.min(6, options.length))
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const response = await interaction.editReply({
            content: '👇 手持ちに設定するポケモンを選んでください！',
            components: [row]
        });

        // ユーザーの選択を待機（1分でタイムアウト）
        try {
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedIds = confirmation.values;

            // 1. 一旦、自分のポケモンの is_party をすべて FALSE にする
            await supabase.from('poke_caught_pokemons')
                .update({ is_party: false })
                .eq('owner_id', interaction.user.id);

            // 2. 選ばれたポケモンだけ is_party を TRUE にする
            await supabase.from('poke_caught_pokemons')
                .update({ is_party: true })
                .in('id', selectedIds);

            await confirmation.update({ content: `✅ **${selectedIds.length}匹** のポケモンを手持ちに設定しました！`, components: [] });
        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度コマンドを実行してください。', components: [] });
        }
    }
};