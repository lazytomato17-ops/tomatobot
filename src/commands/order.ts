// src/commands/order.ts
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const orderCommand = {
    data: new SlashCommandBuilder()
        .setName('order')
        .setDescription('手持ちのポケモンの順番（先頭）を入れ替える'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        const { data: party } = await supabase.from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true)
            .order('party_order', { ascending: true });

        if (!party || party.length <= 1) {
            return interaction.editReply('順番を入れ替えるには、手持ちに2匹以上のポケモンが必要です。');
        }

        const pokeOptions = party.map((p, index) => ({
            label: `${index + 1}番目: ${p.nickname} (Lv.${p.level})`,
            value: p.id.toString() // 🌟 念のため確実に文字列化
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('order_select')
            .setPlaceholder('先頭（1番目）にしたいポケモンを選択')
            .addOptions(pokeOptions);

        const response = await interaction.editReply({ 
            content: '👇 バトルの最初に繰り出す「先頭のポケモン」を選んでください！',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)] 
        });

        try {
            const conf = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
            const selectedId = conf.values[0];
            
            // 🌟 修正：IDの型が違っても正しく見つけ出せるように toString() で比較！
            const selectedPoke = party.find(p => p.id.toString() === selectedId);

            if (!selectedPoke) {
                return interaction.editReply({ content: '⚠️ エラー：選択したポケモンが見つかりませんでした。', components: [] });
            }

            await conf.deferUpdate();

            // 🌟 修正：選んだポケモンを一番上にし、残りを除外する時も toString() を使う！
            const newParty = [selectedPoke, ...party.filter(p => p.id.toString() !== selectedId)];

            const updatePromises = newParty.map((p, i) => 
                supabase.from('poke_caught_pokemons').update({ party_order: i + 1 }).eq('id', p.id)
            );
            await Promise.all(updatePromises);

            await interaction.editReply({ 
                content: `✅ **${selectedPoke.nickname}** を 先頭 に入れ替えました！`, 
                components: [] 
            });

        } catch (e) {
            console.error("Order Error:", e);
            await interaction.editReply({ content: '⏳ タイムアウトしたか、エラーが発生しました。', components: [] });
        }
    }
};
