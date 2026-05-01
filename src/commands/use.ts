// src/commands/use.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// 使えるどうぐの定義と表示名
const USABLE_ITEMS: Record<string, string> = {
    'rare_candy': '💊 レベルアップアメ',
    'tm_fire': '📀 わざマシン【ほのお】（かえんほうしゃ）',
    'tm_water': '📀 わざマシン【みず】（なみのり）',
    'tm_electric': '📀 わざマシン【でんき】（10まんボルト）'
};

export const useCommand = {
    data: new SlashCommandBuilder()
        .setName('use')
        .setDescription('どうぐ（アメやわざマシン）をポケモンに使う'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 1. インベントリから使えるアイテムを取得
        const { data: inv } = await supabase.from('poke_inventory')
            .select('*')
            .eq('user_id', interaction.user.id)
            .gt('quantity', 0);

        const usableInv = inv?.filter(i => USABLE_ITEMS[i.item_id]) || [];

        if (usableInv.length === 0) {
            return interaction.editReply('⚠️ 使えるどうぐ（アメやわざマシン）を持っていません！\n`/shop` で購入しましょう。');
        }

        const itemOptions = usableInv.map(i => ({
            label: `${USABLE_ITEMS[i.item_id]} (所持: ${i.quantity}個)`,
            value: i.item_id
        }));

        const itemSelect = new StringSelectMenuBuilder()
            .setCustomId('use_item_select')
            .setPlaceholder('使うどうぐを選んでください')
            .addOptions(itemOptions);

        const response = await interaction.editReply({
            content: '🎒 どのどうぐを使いますか？',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect)]
        });

        try {
            // アイテム選択を待機
            const itemConfirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedItemId = itemConfirmation.values[0];

            // 2. ポケモンを選択
            const { data: party } = await supabase.from('poke_caught_pokemons')
                .select('*')
                .eq('owner_id', interaction.user.id)
                .eq('is_party', true)
                .order('party_order', { ascending: true });

            if (!party || party.length === 0) return itemConfirmation.update({ content: '手持ちのポケモンがいません！', components: [] });

            const pokeOptions = party.map(p => ({
                label: `${p.nickname} (Lv.${p.level})`,
                value: p.id
            }));

            const pokeSelect = new StringSelectMenuBuilder()
                .setCustomId('use_poke_select')
                .setPlaceholder('どのポケモンに使いますか？')
                .addOptions(pokeOptions);

            await itemConfirmation.update({
                content: `使うどうぐ: **${USABLE_ITEMS[selectedItemId]}**\n誰に使いますか？（手持ちのポケモン）`,
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pokeSelect)]
            });

            // ポケモン選択を待機
            const pokeConfirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedPokeId = pokeConfirmation.values[0];
            const targetPoke = party.find(p => p.id === selectedPokeId)!;

            // 3. アイテムの効果を適用
            let log = '';
            
            if (selectedItemId === 'rare_candy') {
                if (targetPoke.level >= 100) {
                    return pokeConfirmation.update({ content: '⚠️ これ以上レベルは上がりません！', components: [] });
                }
                targetPoke.level += 1;
                log = `💊 **${targetPoke.nickname}** に レベルアップアメ を使った！\nレベルが **${targetPoke.level}** に上がった！🎉`;
                
                await supabase.from('poke_caught_pokemons').update({ level: targetPoke.level }).eq('id', targetPoke.id);

            } else if (selectedItemId.startsWith('tm_')) {
                let newMove: any = null;
                if (selectedItemId === 'tm_fire') newMove = { name: 'かえんほうしゃ', power: 90, type: 'fire', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };
                if (selectedItemId === 'tm_water') newMove = { name: 'なみのり', power: 90, type: 'water', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };
                if (selectedItemId === 'tm_electric') newMove = { name: '10まんボルト', power: 90, type: 'electric', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };

                let moves = typeof targetPoke.moves === 'string' ? JSON.parse(targetPoke.moves) : targetPoke.moves;
                if (!Array.isArray(moves)) moves = [];

                if (moves.some((m: any) => m.name === newMove.name)) {
                    return pokeConfirmation.update({ content: `⚠️ **${targetPoke.nickname}** は すでに ${newMove.name} を覚えている！`, components: [] });
                }

                if (moves.length >= 4) {
                    const oldMove = moves[0];
                    moves.shift(); // 技が4つの場合は一番上の技を忘れる
                    moves.push(newMove);
                    log = `📀 **${targetPoke.nickname}** は ${oldMove.name} を忘れて、新しく **${newMove.name}** を覚えた！✨`;
                } else {
                    moves.push(newMove);
                    log = `📀 **${targetPoke.nickname}** は 新しく **${newMove.name}** を覚えた！✨`;
                }
                await supabase.from('poke_caught_pokemons').update({ moves: moves }).eq('id', targetPoke.id);
            }

            // 4. アイテムを消費
            const usedItem = usableInv.find(i => i.item_id === selectedItemId)!;
            await supabase.from('poke_inventory').update({ quantity: usedItem.quantity - 1 }).eq('id', usedItem.id);

            await pokeConfirmation.update({ content: log, components: [] });

        } catch (err) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度 `/use` を実行してください。', components: [] });
        }
    }
};
