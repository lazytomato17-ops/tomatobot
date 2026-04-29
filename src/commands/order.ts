import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const orderCommand = {
    data: new SlashCommandBuilder()
        .setName('order')
        .setDescription('手持ちの「先頭」にするポケモンを変更する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true }); // 他の人には見せない
        
        const { data: party, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true)
            .order('party_order', { ascending: true });

        if (error || !party || party.length === 0) {
            return interaction.editReply('手持ちにポケモンがいません。まずは `/party` で設定しましょう！');
        }

        const options = party.map(poke => ({
            label: `${poke.nickname} (Lv.${poke.level})`,
            value: poke.id
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('order_select_single')
            .setPlaceholder('先頭にしたいポケモンを選んでください')
            .addOptions(options);

        const response = await interaction.editReply({
            content: '👇 バトルで最初に出す「先頭のポケモン」を選んでください！',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        try {
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedId = confirmation.values[0];
            await confirmation.deferUpdate();

            // 選ばれたポケモンを1番目にし、他を順番にずらす
            const newParty = party.filter(p => p.id !== selectedId);
            const selectedPoke = party.find(p => p.id === selectedId);
            if (selectedPoke) newParty.unshift(selectedPoke); // 先頭に追加

            // 並行処理で爆速アップデート
            const updatePromises = newParty.map((p, index) => {
                return supabase.from('poke_caught_pokemons').update({ party_order: index + 1 }).eq('id', p.id);
            });
            await Promise.all(updatePromises);

            await interaction.editReply({ content: `✅ **${selectedPoke?.nickname}** を先頭にしました！`, components: [] });
        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。', components: [] });
        }
    }
};
