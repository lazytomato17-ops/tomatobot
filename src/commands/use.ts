// src/commands/use.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// 使えるどうぐの定義と表示名
const USABLE_ITEMS: Record<string, string> = {
    'rare_candy': '💊 レベルアップアメ',
    'tm_fire': '📀 わざマシン【ほのお】',
    'tm_water': '📀 わざマシン【みず】',
    'tm_electric': '📀 わざマシン【でんき】',
    'golden_crown': '👑 きんのおうかん',
    // 👇 ここから追加
    'item_silver_crown': '🥈 ぎんのおうかん', // 👈 これを追加！
    'item_hp_up': '💊 マックスアップ',
    'item_protein': '💊 タウリン',
    'item_iron': '💊 ブロムヘキシン',
    'item_calcium': '💊 リゾチウム',
    'item_zinc': '💊 キトサン',
    'item_carbos': '💊 インドメタシン',
    'item_reset_mochi': '🍡 まっさらもち',
    'mint_adamant': '🌿 いじっぱりミント',
    'mint_modest': '🌿 ひかえめミント',
    'mint_jolly': '🌿 ようきミント',
    'mint_timid': '🌿 おくびょうミント',
    'mint_bold': '🌿 ずぶといミント',
    'mint_calm': '🌿 おだやかミント'
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
                log = `💊 **${targetPoke.nickname}** に レベルアップアメ を使った！\n🆙 レベルが **${targetPoke.level}** に上がった！🎉`;

                // 🌟 追加：アメを使った時の進化チェック！
                try {
                    const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${targetPoke.pokedex_id}`).then(r => r.json());
                    const speciesRes = await fetch(pokeRes.species.url).then(r => r.json());
                    
                    if (speciesRes.evolution_chain) {
                        const evoData = await fetch(speciesRes.evolution_chain.url).then(r => r.json());
                        const checkEvo = (chain: any): any => {
                            if (chain.species.name === speciesRes.name) {
                                for (const next of chain.evolves_to) {
                                    if (next.evolution_details[0]?.min_level && targetPoke.level >= next.evolution_details[0].min_level) return next;
                                }
                            }
                            for (const next of chain.evolves_to) { const result = checkEvo(next); if (result) return result; }
                            return null;
                        };
                        
                        const nextEvo = checkEvo(evoData.chain);
                        if (nextEvo) {
                            const nextId = parseInt(nextEvo.species.url.split('/').filter(Boolean).pop()!);
                            const nextSpeciesData = await fetch(nextEvo.species.url).then(r => r.json());
                            const nextJaName = nextSpeciesData.names.find((n: any) => n.language.name === 'ja')?.name || nextEvo.species.name;
                            
                            // ニックネームをつけていなければ、進化後の名前に更新する
                            const defaultJaName = speciesRes.names.find((n: any) => n.language.name === 'ja')?.name || speciesRes.name.toUpperCase();
                            if (targetPoke.nickname === defaultJaName) targetPoke.nickname = nextJaName;

                            const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                            targetPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                            targetPoke.pokedex_id = nextId;
                            
                            log += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                        }
                    }
                } catch (e) {
                    console.error("アメ進化エラー:", e);
                }

                // 🌟 修正：レベルだけでなく、進化した場合は図鑑IDやタイプなどもまとめてDBに保存する
                await supabase.from('poke_caught_pokemons').update({ 
                    level: targetPoke.level, 
                    pokedex_id: targetPoke.pokedex_id,
                    nickname: targetPoke.nickname,
                    types: targetPoke.types
                }).eq('id', targetPoke.id);
                
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
            } else if (selectedItemId === 'golden_crown') {
                const totalIv = targetPoke.iv_hp + targetPoke.iv_attack + targetPoke.iv_defense + targetPoke.iv_sp_atk + targetPoke.iv_sp_def + targetPoke.iv_speed;
                if (totalIv >= 186) {
                    return pokeConfirmation.update({ content: `⚠️ **${targetPoke.nickname}** の才能はすでに限界（全ステータス最大）です！おうかんは使われませんでした。`, components: [] });
                }

                await supabase.from('poke_caught_pokemons').update({
                    iv_hp: 31, iv_attack: 31, iv_defense: 31, iv_sp_atk: 31, iv_sp_def: 31, iv_speed: 31
                }).eq('id', targetPoke.id);
                
                log = `👑 すごい とっくんが 終わった！\n**${targetPoke.nickname}** の 全ての才能（個体値）が 極限まで 引き上げられた！✨`;
            } else if (selectedItemId === 'item_reset_mochi') {
                // 🍡 まっさらもち（努力値全リセット）
                await supabase.from('poke_caught_pokemons').update({
                    ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0
                }).eq('id', targetPoke.id);
                log = `🍡 **${targetPoke.nickname}** に まっさらもち を使った！\nこれまでの 基礎ポイント（努力値）が すべて 0になった！✨`;

            } else if (selectedItemId.startsWith('item_')) {
                // 💊 ドーピングアイテム（努力値+10）
                const evKeys: Record<string, [string, string]> = {
                    'item_hp_up': ['ev_hp', 'HP'], 'item_protein': ['ev_attack', '攻撃'], 
                    'item_iron': ['ev_defense', '防御'], 'item_calcium': ['ev_sp_atk', '特攻'], 
                    'item_zinc': ['ev_sp_def', '特防'], 'item_carbos': ['ev_speed', '素早さ']
                };
                
                const [targetStat, statName] = evKeys[selectedItemId];
                const currentEv = targetPoke[targetStat as keyof typeof targetPoke] as number;
                const totalEVs = targetPoke.ev_hp + targetPoke.ev_attack + targetPoke.ev_defense + targetPoke.ev_sp_atk + targetPoke.ev_sp_def + targetPoke.ev_speed;

                if (totalEVs >= 510) return pokeConfirmation.update({ content: `⚠️ **${targetPoke.nickname}** の基礎ポイント（努力値）は これ以上上がらない！（合計510上限）`, components: [] });
                if (currentEv >= 252) return pokeConfirmation.update({ content: `⚠️ **${targetPoke.nickname}** の **${statName}** の基礎ポイントは これ以上上がらない！（各ステータス252上限）`, components: [] });

                let gain = 10;
                if (totalEVs + gain > 510) gain = 510 - totalEVs;
                if (currentEv + gain > 252) gain = 252 - currentEv;

                await supabase.from('poke_caught_pokemons').update({ [targetStat]: currentEv + gain }).eq('id', targetPoke.id);
                log = `💊 **${targetPoke.nickname}** に ${USABLE_ITEMS[selectedItemId].replace('💊 ', '')} を使った！\n**${statName}** の 基礎ポイント（努力値）が 上がった！💪`;

            } else if (selectedItemId === 'item_silver_crown') {
                // 🥈 銀の王冠：ステータス選択メニューを出す
                const stats = [
                    { label: 'HP', value: 'iv_hp' },
                    { label: '攻撃', value: 'iv_attack' },
                    { label: '防御', value: 'iv_defense' },
                    { label: '特攻', value: 'iv_sp_atk' },
                    { label: '特防', value: 'iv_sp_def' },
                    { label: '素早さ', value: 'iv_speed' }
                ];

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`select_iv_max_${targetPoke.id}`) // IDにポケモンIDを埋め込む
                    .setPlaceholder('最大にしたい才能を選んでください')
                    .addOptions(stats.map(s => ({ label: s.label, value: s.value })));

                const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

                // アイテム消費はここでは行わず、選んだ後の index.ts で行います
                return pokeConfirmation.update({ 
                    content: `🥈 **${targetPoke.nickname}** に ぎんのおうかん を使います。\nどの才能を 極限まで 引き上げますか？`, 
                    components: [row] 
                });
            } else if (selectedItemId.startsWith('mint_')) {
                // 🌿 ミント（性格の上書きによるステータス補正変更）
                const natureMap: Record<string, string> = {
                    'mint_adamant': 'いじっぱり', 'mint_modest': 'ひかえめ', 'mint_jolly': 'ようき', 
                    'mint_timid': 'おくびょう', 'mint_bold': 'ずぶとい', 'mint_calm': 'おだやか'
                };
                const newNature = natureMap[selectedItemId];
                
                await supabase.from('poke_caught_pokemons').update({ nature: newNature }).eq('id', targetPoke.id);
                log = `🌿 **${targetPoke.nickname}** に ${USABLE_ITEMS[selectedItemId].replace('🌿 ', '')} を使った！\nかすかに **${newNature}** な性格の匂いがするようになった！\n（ステータス補正が変更されました✨）`;
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
