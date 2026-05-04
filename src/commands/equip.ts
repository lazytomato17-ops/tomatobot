// src/commands/equip.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const HOLDABLE_ITEMS: Record<string, string> = {
    'rusted_sword': '🗡️ くちたけん (ザシアン専用)',
    'leftovers': '🍎 たべのこし (毎ターン少し回復)',
    'life_orb': '🔮 いのちのたま (威力1.3倍 / 少し反動ダメージ)',
    'choice_band': '🧣 こだわりハチマキ (物理攻撃1.5倍)'
};

export const equipCommand = {
    data: new SlashCommandBuilder()
        .setName('equip')
        .setDescription('ポケモンにどうぐを持たせる、または外す'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: party } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).eq('is_party', true).order('party_order', { ascending: true });
        if (!party || party.length === 0) return interaction.editReply('手持ちのポケモンがいません！');

        const pokeOptions = party.map(p => ({
            label: `${p.nickname} (現在: ${p.held_item ? HOLDABLE_ITEMS[p.held_item].split(' ')[1] : 'なし'})`,
            value: p.id
        }));

        const pokeSelect = new StringSelectMenuBuilder().setCustomId('equip_poke_select').setPlaceholder('どうぐを持たせるポケモンを選択').addOptions(pokeOptions);
        const response = await interaction.editReply({ content: '🎒 どのポケモンにどうぐを持たせますか？', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pokeSelect)] });

        try {
            const pokeConf = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
            const targetPoke = party.find(p => p.id === pokeConf.values[0])!;

            // 持たせられるアイテム一覧を取得
            const { data: inv } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id).gt('quantity', 0);
            const holdableInv = inv?.filter(i => HOLDABLE_ITEMS[i.item_id]) || [];

            const itemOptions = holdableInv.map(i => ({ label: `${HOLDABLE_ITEMS[i.item_id]} (所持: ${i.quantity}個)`, value: i.item_id }));
            itemOptions.push({ label: '🚫 持っているどうぐを外す', value: 'remove_item' });

            const itemSelect = new StringSelectMenuBuilder().setCustomId('equip_item_select').setPlaceholder('持たせるどうぐを選択').addOptions(itemOptions);

            await pokeConf.update({
                content: `**${targetPoke.nickname}** に何を持たせますか？\n（現在の持ち物: ${targetPoke.held_item ? HOLDABLE_ITEMS[targetPoke.held_item] : 'なし'}）`,
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect)]
            });

            const itemConf = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
            const selectedItem = itemConf.values[0];

            // 既にアイテムを持っている場合はインベントリに戻す
            if (targetPoke.held_item) {
                const { data: oldInv } = await supabase.from('poke_inventory').select('quantity').eq('user_id', interaction.user.id).eq('item_id', targetPoke.held_item).single();
                if (oldInv) await supabase.from('poke_inventory').update({ quantity: oldInv.quantity + 1 }).eq('user_id', interaction.user.id).eq('item_id', targetPoke.held_item);
                else await supabase.from('poke_inventory').insert([{ user_id: interaction.user.id, item_id: targetPoke.held_item, quantity: 1 }]);
            }

            if (selectedItem === 'remove_item') {
                await supabase.from('poke_caught_pokemons').update({ held_item: null }).eq('id', targetPoke.id);
                return itemConf.update({ content: `✅ **${targetPoke.nickname}** から どうぐを外してバッグに戻しました！`, components: [] });
            }

            // 新しいアイテムを持たせてインベントリから減らす
            const usedItem = holdableInv.find(i => i.item_id === selectedItem)!;
            await supabase.from('poke_inventory').update({ quantity: usedItem.quantity - 1 }).eq('id', usedItem.id);
            await supabase.from('poke_caught_pokemons').update({ held_item: selectedItem }).eq('id', targetPoke.id);

            await itemConf.update({ content: `✅ **${targetPoke.nickname}** に **${HOLDABLE_ITEMS[selectedItem]}** を持たせました！`, components: [] });

        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。', components: [] });
        }
    }
};
