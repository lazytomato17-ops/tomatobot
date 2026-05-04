　// src/commands/use.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction, ButtonBuilder, ButtonStyle } from 'discord.js';
import { supabase } from '../pokeDb';

const USABLE_ITEMS: Record<string, string> = {
    'exp_candy_s': '🍬 けいけんちアメS',
    'exp_candy_m': '🍬 けいけんちアメM',
    'exp_candy_l': '🍬 けいけんちアメL',
    'exp_candy_xl': '🍬 けいけんちアメXL',
    'rare_candy': '💊 レベルアップアメ',
    'tm_fire': '📀 わざマシン【ほのお】',
    'tm_water': '📀 わざマシン【みず】',
    'tm_electric': '📀 わざマシン【でんき】',
    'golden_crown': '👑 きんのおうかん',
    'item_silver_crown': '🥈 ぎんのおうかん',
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
    'mint_calm': '🌿 おだやかミント',
    'item_ability_patch': '🧬 とくせいパッチ',
    'scroll_dark': '📜 あくのかけじく',
    'scroll_water': '🌊 みずのかけじく',
};

export const useCommand = {
    data: new SlashCommandBuilder()
        .setName('use')
        .setDescription('どうぐ（アメやわざマシンなど）をポケモンに使う'),

    async execute(interaction: ChatInputCommandInteraction) {
        const message = await interaction.deferReply();
        let currentLog = '🎒 使うどうぐを選んでください。';

        while (true) {
            const { data: inv } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id).gt('quantity', 0);
            const usableInv = inv?.filter(i => USABLE_ITEMS[i.item_id]) || [];

            if (usableInv.length === 0) {
                await interaction.editReply({ content: '⚠️ 使えるどうぐを持っていません！', components: [] });
                break;
            }

            const itemOptions = usableInv.map(i => ({ label: `${USABLE_ITEMS[i.item_id]} (所持: ${i.quantity}個)`, value: i.item_id }));
            const itemSelect = new StringSelectMenuBuilder().setCustomId('use_item_select').setPlaceholder('使うどうぐを選んでください').addOptions(itemOptions);
            const exitBtn = new ButtonBuilder().setCustomId('use_exit').setLabel('おわる').setStyle(ButtonStyle.Secondary);

            await interaction.editReply({
                content: currentLog,
                components: [
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(itemSelect),
                    new ActionRowBuilder<ButtonBuilder>().addComponents(exitBtn)
                ]
            });

            const itemConfirm = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
            if (!itemConfirm || itemConfirm.customId === 'use_exit') {
                await interaction.editReply({ content: '🎒 どうぐの使用を終了しました。', components: [] });
                break;
            }

            if (!itemConfirm.isStringSelectMenu()) continue;
            const selectedItemId = itemConfirm.values[0];

            // 🌟 手持ち(最大6) ＋ ボックスの最新(最大19) ＝ 合計25匹 を表示
            const { data: party } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).eq('is_party', true).order('party_order', { ascending: true });
            const remainingSlots = 25 - (party?.length || 0);
            let box: any[] = [];
            if (remainingSlots > 0) {
                const { data } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).eq('is_party', false).order('created_at', { ascending: false }).limit(remainingSlots);
                if (data) box = data;
            }

            const targetPokemons = [...(party || []), ...box];
            if (targetPokemons.length === 0) {
                await itemConfirm.update({ content: 'ポケモンを持っていません！', components: [] });
                break;
            }

            const pokeOptions = targetPokemons.map(p => ({ label: `${p.is_party ? '🎒' : '📦'} ${p.nickname} (Lv.${p.level})`, value: p.id }));
            const pokeSelect = new StringSelectMenuBuilder().setCustomId('use_poke_select').setPlaceholder('誰に使いますか？').addOptions(pokeOptions);
            const backBtn = new ButtonBuilder().setCustomId('use_back').setLabel('もどる').setStyle(ButtonStyle.Secondary);

            await itemConfirm.update({
                content: `使うどうぐ: **${USABLE_ITEMS[selectedItemId]}**\n誰に使いますか？\n（※ボックスのポケモンも最新のものから表示されています）`,
                components: [
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pokeSelect),
                    new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn)
                ]
            });

            const pokeConfirm = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
            if (!pokeConfirm || pokeConfirm.customId === 'use_back') {
                currentLog = '🎒 使うどうぐを選んでください。';
                continue;
            }

            if (!pokeConfirm.isStringSelectMenu()) continue;
            const targetPoke = targetPokemons.find(p => p.id === pokeConfirm.values[0])!;
            let log = '';

            const consumeItem = async () => {
                const usedItem = usableInv.find(i => i.item_id === selectedItemId)!;
                await supabase.from('poke_inventory').update({ quantity: usedItem.quantity - 1 }).eq('id', usedItem.id);
            };

            // 🧬 とくせいパッチの処理
            if (selectedItemId === 'item_ability_patch') {
                const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${targetPoke.pokedex_id}`).then(r => r.json());
                // PokeAPIから隠れ特性（is_hidden: true）を探す
                const hiddenAbilityEntry = pokeRes.abilities.find((a: any) => a.is_hidden);
                
                if (!hiddenAbilityEntry) {
                    currentLog = `⚠️ **${targetPoke.nickname}** には 隠れ特性が 存在しないようです。\n続けてどうぐを使いますか？`;
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                const abilityData = await fetch(hiddenAbilityEntry.ability.url).then(r => r.json());
                const jaAbilityName = abilityData.names.find((n: any) => n.language.name === 'ja')?.name || hiddenAbilityEntry.ability.name;

                if (targetPoke.ability === jaAbilityName) {
                    currentLog = `⚠️ **${targetPoke.nickname}** は すでに 特性 **${jaAbilityName}** を持っています！\n続けてどうぐを使いますか？`;
                } else {
                    await supabase.from('poke_caught_pokemons').update({ ability: jaAbilityName }).eq('id', targetPoke.id);
                    await consumeItem();
                    currentLog = `🧬 **${targetPoke.nickname}** の特性が 隠れ特性の **${jaAbilityName}** に変わった！✨\n続けてどうぐを使いますか？`;
                }
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 📜 ダクマの進化（かけじく）
            if (selectedItemId === 'scroll_dark' || selectedItemId === 'scroll_water') {
                if (targetPoke.pokedex_id !== 891) { // 891はダクマ
                    currentLog = `⚠️ そのどうぐは **ダクマ** にしか 使えません！\n続けてどうぐを使いますか？`;
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                const isDark = selectedItemId === 'scroll_dark';
                // 892: ウーラオス(いちげき), 10191: ウーラオス(れんげき) ※PokeAPIの仕様
                const nextId = isDark ? 892 : 10191; 
                
                const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                const nextSpeciesData = await fetch(nextPokeData.species.url).then(r => r.json());
                const nextJaName = nextSpeciesData.names.find((n: any) => n.language.name === 'ja')?.name || "ウーラオス";
                
                targetPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                targetPoke.pokedex_id = nextId;
                
                // ニックネームがデフォルトの「ダクマ」なら「ウーラオス」に変更
                const currentPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${891}`).then(r => r.json());
                const currentSpeciesData = await fetch(currentPokeData.species.url).then(r => r.json());
                const oldName = currentSpeciesData.names.find((n: any) => n.language.name === 'ja')?.name || "ダクマ";
                if (targetPoke.nickname === oldName) targetPoke.nickname = nextJaName;

                const styleName = isDark ? "いちげきのかた（あく・かくとう）" : "れんげきのかた（みず・かくとう）";
                
                await supabase.from('poke_caught_pokemons').update({ 
                    pokedex_id: targetPoke.pokedex_id,
                    types: targetPoke.types,
                    nickname: targetPoke.nickname
                }).eq('id', targetPoke.id);

                await consumeItem();
                currentLog = `📜 **${targetPoke.nickname}** は 掛け軸の文字を 読み取った……！\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}【${styleName}】** に 進化した！\n\n続けてどうぐを使いますか？`;
                
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 👑 ぎんのおうかん（個体値表示機能付き）
            if (selectedItemId === 'item_silver_crown') {
                if (targetPoke.level < 50) {
                    currentLog = `⚠️ **${targetPoke.nickname}** は Lv.50以上にならないと 王冠を使えません！\n続けてどうぐを使いますか？`;
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                const stats = [
                    { label: `HP (現在: ${targetPoke.iv_hp})`, value: 'iv_hp' },
                    { label: `攻撃 (現在: ${targetPoke.iv_attack})`, value: 'iv_attack' },
                    { label: `防御 (現在: ${targetPoke.iv_defense})`, value: 'iv_defense' },
                    { label: `特攻 (現在: ${targetPoke.iv_sp_atk})`, value: 'iv_sp_atk' },
                    { label: `特防 (現在: ${targetPoke.iv_sp_def})`, value: 'iv_sp_def' },
                    { label: `素早さ (現在: ${targetPoke.iv_speed})`, value: 'iv_speed' }
                ];
                const ivSelect = new StringSelectMenuBuilder().setCustomId(`select_iv_max_${targetPoke.id}`).setPlaceholder('最大にする才能を選んでください').addOptions(stats);
                
                await pokeConfirm.update({
                    content: `🥈 **${targetPoke.nickname}** のどの才能を鍛えますか？\n（※最大値は31です）`,
                    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(ivSelect)]
                });

                const ivConfirm = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect }).catch(() => null);
                if (ivConfirm) {
                    const targetStat = ivConfirm.values[0];
                    if (targetPoke[targetStat] >= 31) {
                        currentLog = `⚠️ **${targetPoke.nickname}** のその才能は すでに最大です！\n続けてどうぐを使いますか？`;
                    } else {
                        await supabase.from('poke_caught_pokemons').update({ [targetStat]: 31 }).eq('id', targetPoke.id);
                        await consumeItem();
                        currentLog = `✅ **${targetPoke.nickname}** の才能を 鍛え上げました！✨\n続けてどうぐを使いますか？`;
                    }
                    await ivConfirm.update({ content: currentLog, components: [] });
                }
                continue;
            }

            // 🍬 けいけんちアメ
            if (selectedItemId.startsWith('exp_candy_')) {
                if (targetPoke.level >= 100) {
                    currentLog = '⚠️ これ以上レベルは上がりません！\n続けてどうぐを使いますか？';
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                const expMap: Record<string, number> = { 'exp_candy_s': 800, 'exp_candy_m': 3000, 'exp_candy_l': 10000, 'exp_candy_xl': 30000 };
                const gainedExp = expMap[selectedItemId];

                const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${targetPoke.pokedex_id}`).then(r => r.json());
                const speciesRes = await fetch(pokeRes.species.url).then(r => r.json());
                const growthRate = speciesRes.growth_rate.name;
                const { getRequiredExp } = require('../battleLogic');

                targetPoke.exp += gainedExp;
                log = `🍬 **${targetPoke.nickname}** に ${USABLE_ITEMS[selectedItemId].split(' ')[1]} を使った！\n✨ 経験値を **${gainedExp}** もらった！`;

                let currentLevel = targetPoke.level;
                let leveledUp = false;
                while (currentLevel < 100 && targetPoke.exp >= getRequiredExp(currentLevel + 1, growthRate)) {
                    currentLevel++;
                    leveledUp = true;
                }

                if (leveledUp) {
                    targetPoke.level = currentLevel;
                    log += `\n🆙 レベルが **${currentLevel}** に上がった！🎉`;

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
                            const defaultJaName = speciesRes.names.find((n: any) => n.language.name === 'ja')?.name || speciesRes.name.toUpperCase();
                            if (targetPoke.nickname === defaultJaName) targetPoke.nickname = nextJaName;

                            const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                            targetPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                            targetPoke.pokedex_id = nextId;
                            
                            log += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                        }
                    }
                }
                
                await supabase.from('poke_caught_pokemons').update({ 
                    level: targetPoke.level, exp: targetPoke.exp, pokedex_id: targetPoke.pokedex_id, nickname: targetPoke.nickname, types: targetPoke.types
                }).eq('id', targetPoke.id);

                await consumeItem();
                currentLog = log + '\n\n続けてどうぐを使いますか？';
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 💊 レベルアップアメ
            if (selectedItemId === 'rare_candy') {
                if (targetPoke.level >= 100) {
                    currentLog = '⚠️ これ以上レベルは上がりません！\n続けてどうぐを使いますか？';
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                targetPoke.level += 1;
                log = `💊 **${targetPoke.nickname}** に レベルアップアメ を使った！\n🆙 レベルが **${targetPoke.level}** に上がった！🎉`;

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
                            
                            const defaultJaName = speciesRes.names.find((n: any) => n.language.name === 'ja')?.name || speciesRes.name.toUpperCase();
                            if (targetPoke.nickname === defaultJaName) targetPoke.nickname = nextJaName;

                            const nextPokeData = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                            targetPoke.types = nextPokeData.types.map((t: any) => t.type.name);
                            targetPoke.pokedex_id = nextId;
                            
                            log += `\n\n✨✨ おや…！？ 様子が……！\n🎊 おめでとう！ **${nextJaName}** に 進化した！`;
                        }
                    }
                } catch (e) {}

                await supabase.from('poke_caught_pokemons').update({ 
                    level: targetPoke.level, pokedex_id: targetPoke.pokedex_id, nickname: targetPoke.nickname, types: targetPoke.types
                }).eq('id', targetPoke.id);

                await consumeItem();
                currentLog = log + '\n\n続けてどうぐを使いますか？';
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 📀 わざマシン
            if (selectedItemId.startsWith('tm_')) {
                let newMove: any = null;
                if (selectedItemId === 'tm_fire') newMove = { name: 'かえんほうしゃ', power: 90, type: 'fire', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };
                if (selectedItemId === 'tm_water') newMove = { name: 'なみのり', power: 90, type: 'water', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };
                if (selectedItemId === 'tm_electric') newMove = { name: '10まんボルト', power: 90, type: 'electric', damageClass: 'special', accuracy: 100, pp: 15, maxPp: 15 };

                let moves = typeof targetPoke.moves === 'string' ? JSON.parse(targetPoke.moves) : targetPoke.moves;
                if (!Array.isArray(moves)) moves = [];

                if (moves.some((m: any) => m.name === newMove.name)) {
                    currentLog = `⚠️ **${targetPoke.nickname}** は すでに ${newMove.name} を覚えている！\n続けてどうぐを使いますか？`;
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }

                if (moves.length >= 4) {
                    const forgetOptions = moves.map((m: any, idx: number) => ({
                        label: `${m.name} (威力:${m.power || '-'} PP:${m.maxPp})`,
                        value: `forget_${idx}`
                    }));
                    forgetOptions.push({ label: '❌ 技を覚えさせずにやめる', value: 'cancel' });

                    const forgetMenu = new StringSelectMenuBuilder()
                        .setCustomId('tm_forget_select')
                        .setPlaceholder('忘れさせる技を選んでください')
                        .addOptions(forgetOptions);

                    await pokeConfirm.update({
                        content: `⚠️ **${targetPoke.nickname}** は すでに技を4つ覚えている！\n新しく **${newMove.name}** を覚えるために、どの技を忘れますか？`,
                        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(forgetMenu)]
                    });

                    const forgetConf = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect }).catch(() => null);
                    
                    if (forgetConf) {
                        const forgetVal = forgetConf.values[0];
                        if (forgetVal === 'cancel') {
                            currentLog = `技の習得をやめました。（わざマシンは消費されません）\n続けてどうぐを使いますか？`;
                        } else {
                            const forgetIdx = parseInt(forgetVal.replace('forget_', ''));
                            const oldMove = moves[forgetIdx];
                            moves[forgetIdx] = newMove; 
                            await supabase.from('poke_caught_pokemons').update({ moves: moves }).eq('id', targetPoke.id);
                            await consumeItem();
                            currentLog = `📀 **${targetPoke.nickname}** は ${oldMove.name} を忘れて、新しく **${newMove.name}** を覚えた！✨\n続けてどうぐを使いますか？`;
                        }
                        await forgetConf.update({ content: currentLog, components: [] });
                    }
                    continue;
                } else {
                    moves.push(newMove);
                    await supabase.from('poke_caught_pokemons').update({ moves: moves }).eq('id', targetPoke.id);
                    await consumeItem();
                    currentLog = `📀 **${targetPoke.nickname}** は 新しく **${newMove.name}** を覚えた！✨\n続けてどうぐを使いますか？`;
                    await pokeConfirm.update({ content: currentLog, components: [] });
                    continue;
                }
            }

            // 👑 きんのおうかん
            if (selectedItemId === 'golden_crown') {
                if (targetPoke.level < 50) {
                    currentLog = `⚠️ **${targetPoke.nickname}** は レベル50以上にならないと 王冠が使えません！\n続けてどうぐを使いますか？`;
                } else {
                    const totalIv = targetPoke.iv_hp + targetPoke.iv_attack + targetPoke.iv_defense + targetPoke.iv_sp_atk + targetPoke.iv_sp_def + targetPoke.iv_speed;
                    if (totalIv >= 186) {
                        currentLog = `⚠️ **${targetPoke.nickname}** の才能はすでに限界（全ステータス最大）です！\n続けてどうぐを使いますか？`;
                    } else {
                        await supabase.from('poke_caught_pokemons').update({ iv_hp: 31, iv_attack: 31, iv_defense: 31, iv_sp_atk: 31, iv_sp_def: 31, iv_speed: 31 }).eq('id', targetPoke.id);
                        await consumeItem();
                        currentLog = `👑 すごい とっくんが 終わった！\n**${targetPoke.nickname}** の 全ての才能（個体値）が 極限まで 引き上げられた！✨\n続けてどうぐを使いますか？`;
                    }
                }
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 🍡 まっさらもち
            if (selectedItemId === 'item_reset_mochi') {
                await supabase.from('poke_caught_pokemons').update({ ev_hp: 0, ev_attack: 0, ev_defense: 0, ev_sp_atk: 0, ev_sp_def: 0, ev_speed: 0 }).eq('id', targetPoke.id);
                await consumeItem();
                currentLog = `🍡 **${targetPoke.nickname}** に まっさらもち を使った！\nこれまでの 基礎ポイント（努力値）が すべて 0になった！✨\n続けてどうぐを使いますか？`;
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 💊 基礎ポイント（ドーピングアイテム）
            if (selectedItemId.startsWith('item_')) {
                const evKeys: Record<string, [string, string]> = {
                    'item_hp_up': ['ev_hp', 'HP'], 'item_protein': ['ev_attack', '攻撃'], 'item_iron': ['ev_defense', '防御'], 
                    'item_calcium': ['ev_sp_atk', '特攻'], 'item_zinc': ['ev_sp_def', '特防'], 'item_carbos': ['ev_speed', '素早さ']
                };
                const [targetStat, statName] = evKeys[selectedItemId];
                const currentEv = targetPoke[targetStat as keyof typeof targetPoke] as number;
                const totalEVs = targetPoke.ev_hp + targetPoke.ev_attack + targetPoke.ev_defense + targetPoke.ev_sp_atk + targetPoke.ev_sp_def + targetPoke.ev_speed;

                if (totalEVs >= 510) {
                    currentLog = `⚠️ **${targetPoke.nickname}** の基礎ポイント（努力値）は これ以上上がらない！（合計510上限）\n続けてどうぐを使いますか？`;
                } else if (currentEv >= 252) {
                    currentLog = `⚠️ **${targetPoke.nickname}** の **${statName}** の基礎ポイントは これ以上上がらない！（各ステータス252上限）\n続けてどうぐを使いますか？`;
                } else {
                    let gain = 10;
                    if (totalEVs + gain > 510) gain = 510 - totalEVs;
                    if (currentEv + gain > 252) gain = 252 - currentEv;

                    await supabase.from('poke_caught_pokemons').update({ [targetStat]: currentEv + gain }).eq('id', targetPoke.id);
                    await consumeItem();
                    currentLog = `💊 **${targetPoke.nickname}** に ${USABLE_ITEMS[selectedItemId].replace('💊 ', '')} を使った！\n**${statName}** の 基礎ポイント（努力値）が 上がった！💪\n続けてどうぐを使いますか？`;
                }
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 🌿 ミント
            if (selectedItemId.startsWith('mint_')) {
                const natureMap: Record<string, string> = { 'mint_adamant': 'いじっぱり', 'mint_modest': 'ひかえめ', 'mint_jolly': 'ようき', 'mint_timid': 'おくびょう', 'mint_bold': 'ずぶとい', 'mint_calm': 'おだやか' };
                const newNature = natureMap[selectedItemId];
                await supabase.from('poke_caught_pokemons').update({ nature: newNature }).eq('id', targetPoke.id);
                await consumeItem();
                currentLog = `🌿 **${targetPoke.nickname}** に ${USABLE_ITEMS[selectedItemId].replace('🌿 ', '')} を使った！\nかすかに **${newNature}** な性格の匂いがするようになった！\n続けてどうぐを使いますか？`;
                await pokeConfirm.update({ content: currentLog, components: [] });
                continue;
            }

            // 万が一ここに来た場合のフェイルセーフ
            await consumeItem();
            currentLog = `✅ ${USABLE_ITEMS[selectedItemId]} を使いました！\n続けてどうぐを使いますか？`;
            await pokeConfirm.update({ content: currentLog, components: [] });
        }
    }
};
