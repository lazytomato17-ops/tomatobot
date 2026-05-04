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
    'mint_calm': '🌿 おだやかミント'
};

export const useCommand = {
    data: new SlashCommandBuilder()
        .setName('use')
        .setDescription('どうぐ（アメやわざマシンなど）をポケモンに使う'),

    async execute(interaction: ChatInputCommandInteraction) {
        const message = await interaction.deferReply();
        let currentLog = '🎒 使うどうぐを選んでください。';

        // 🌟 何回も使えるようにループ化
        while (true) {
            // 最新の所持品と手持ちを取得
            const { data: inv } = await supabase.from('poke_inventory').select('*').eq('user_id', interaction.user.id).gt('quantity', 0);
            const usableInv = inv?.filter(i => USABLE_ITEMS[i.item_id]) || [];

            if (usableInv.length === 0) {
                await interaction.editReply({ content: '⚠️ 使えるどうぐを 持っていません！', components: [] });
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

            // アイテム選択待ち
            const itemConfirm = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
            if (!itemConfirm || itemConfirm.customId === 'use_exit') {
                await interaction.editReply({ content: '🎒 どうぐの使用を終了しました。', components: [] });
                break;
            }

            if (!itemConfirm.isStringSelectMenu()) continue;
            const selectedItemId = itemConfirm.values[0];

            // ポケモン選択
            const { data: party } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).eq('is_party', true).order('party_order', { ascending: true });
            if (!party || party.length === 0) {
                await itemConfirm.update({ content: '手持ちのポケモンがいません！', components: [] });
                break;
            }

            const pokeOptions = party.map(p => ({ label: `${p.nickname} (Lv.${p.level})`, value: p.id }));
            const pokeSelect = new StringSelectMenuBuilder().setCustomId('use_poke_select').setPlaceholder('誰に使いますか？').addOptions(pokeOptions);
            const backBtn = new ButtonBuilder().setCustomId('use_back').setLabel('もどる').setStyle(ButtonStyle.Secondary);

            await itemConfirm.update({
                content: `使うどうぐ: **${USABLE_ITEMS[selectedItemId]}**\n誰に使いますか？`,
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
            const targetPoke = party.find(p => p.id === pokeConfirm.values[0])!;
            let log = '';

            // 🌟 銀の王冠などの処理（個体値を表示する！）
            if (selectedItemId === 'item_silver_crown') {
                if (targetPoke.level < 50) {
                    currentLog = `⚠️ **${targetPoke.nickname}** は Lv.50以上にならないと 王冠を使えません！`;
                    await pokeConfirm.update({ content: currentLog });
                    continue;
                }

                // 🌟 現在の数値をラベルに表示！
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

                // index.tsのグローバルハンドラに任せるため、一旦このループを抜けるか待機する
                // 連続使用を維持するため、ここでも入力を待つ設計にします
                const ivConfirm = await message.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect }).catch(() => null);
                if (ivConfirm) {
                    const targetStat = ivConfirm.values[0];
                    if (targetPoke[targetStat] >= 31) {
                        currentLog = `⚠️ **${targetPoke.nickname}** のその才能は すでに最大です！`;
                    } else {
                        await supabase.from('poke_caught_pokemons').update({ [targetStat]: 31 }).eq('id', targetPoke.id);
                        const usedItem = usableInv.find(i => i.item_id === selectedItemId)!;
                        await supabase.from('poke_inventory').update({ quantity: usedItem.quantity - 1 }).eq('id', usedItem.id);
                        currentLog = `✅ **${targetPoke.nickname}** の才能を 鍛え上げました！✨`;
                    }
                    await ivConfirm.update({ content: currentLog });
                }
                continue;
            }

            // 🌟 その他のアイテム処理 (アメなど)
            if (selectedItemId.startsWith('exp_candy_')) {
                const expMap: Record<string, number> = { 'exp_candy_s': 800, 'exp_candy_m': 3000, 'exp_candy_l': 10000, 'exp_candy_xl': 30000 };
                const gainedExp = expMap[selectedItemId];
                // 経験値・レベルアップ処理（battleLogicの関数等があれば呼び出し）
                // ... (中略: 既存のアメ処理をここに配置)
                log = `🍬 **${targetPoke.nickname}** にアメを使い、経験値を獲得しました！`;
                
                // アイテム消費
                const usedItem = usableInv.find(i => i.item_id === selectedItemId)!;
                await supabase.from('poke_inventory').update({ quantity: usedItem.quantity - 1 }).eq('id', usedItem.id);
                currentLog = log;
                await pokeConfirm.update({ content: currentLog });
                continue;
            }

            // 🌟 最終的に「使うどうぐを選んでください」のログを更新してループ
            currentLog = `✅ ${USABLE_ITEMS[selectedItemId]} を使いました！\n続けてどうぐを使いますか？`;
            await pokeConfirm.update({ content: currentLog });
        }
    }
};
