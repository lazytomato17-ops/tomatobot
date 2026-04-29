// src/commands/party.ts
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const partyCommand = {
    data: new SlashCommandBuilder()
        .setName('party')
        .setDescription('ボックスから最大6匹を選んで手持ちに設定する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const { data: pokemons, error } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).order('caught_at', { ascending: false });
        
        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ボックスにポケモンがいません。まずは `/wild` で捕まえましょう！');
        }

        const options = pokemons.slice(0, 25).map(poke => ({
            label: `${poke.nickname} (Lv.${poke.level})`,
            description: `個体値合計: ${poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed}`,
            value: poke.id
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('party_select')
            .setPlaceholder('手持ちに入れるポケモンを選んでください（最大6匹）')
            .setMinValues(1)
            .setMaxValues(Math.min(6, options.length))
            .addOptions(options);

        const response = await interaction.editReply({
            content: '👇 手持ちに設定するポケモンを選んでください！\n※選んだ順番で仮のパーティ順が設定されます（後で `/order` で変更可能）',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        try {
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });
            const selectedIds = confirmation.values;

            // ✅ 修正：一旦全員を手持ちから外し、order をリセット
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: 0 }).eq('owner_id', interaction.user.id);

            // ✅ 修正：選ばれたポケモンに 1番目〜 の順番を振りながら手持ちに入れる
            for (let i = 0; i < selectedIds.length; i++) {
                await supabase.from('poke_caught_pokemons').update({ is_party: true, party_order: i + 1 }).eq('id', selectedIds[i]);
            }

            await confirmation.update({ content: `✅ **${selectedIds.length}匹** のポケモンを手持ちに設定しました！\n順番を変えたい場合は \`/order\` コマンドを使ってください！`, components: [] });
        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度コマンドを実行してください。', components: [] });
        }
    }
};
