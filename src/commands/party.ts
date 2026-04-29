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

            // 🚀 【追加】Discordの「3秒の壁」を回避するために、すぐにローディング状態にする！
            await confirmation.deferUpdate();

            // 一旦全員を手持ちから外し、order をリセット
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: 0 }).eq('owner_id', interaction.user.id);

            // 🚀 【変更】1匹ずつ順番に更新するのではなく、Promise.allで一斉に（並列で）更新して爆速化する！
            const updatePromises = selectedIds.map((id, index) => {
                return supabase.from('poke_caught_pokemons').update({ is_party: true, party_order: index + 1 }).eq('id', id);
            });
            await Promise.all(updatePromises);

            // 最後に元のメッセージ（interaction.editReply）を書き換えて完了！
            await interaction.editReply({ 
                content: `✅ **${selectedIds.length}匹** のポケモンを手持ちに設定しました！\n順番を変えたい場合は \`/order\` コマンドを使ってください！`, 
                components: [] 
            });
            
        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度コマンドを実行してください。', components: [] });
        }
    }
};
