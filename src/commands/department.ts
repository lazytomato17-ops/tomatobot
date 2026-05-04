// src/commands/department.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const departmentCommand = {
    data: new SlashCommandBuilder()
        .setName('department')
        .setDescription('タマムシデパートで育成用アイテム（ミントや努力値アイテム）を購入する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
        const money = user?.money || 0;

        const embed = new EmbedBuilder()
            .setTitle('🏢 タマムシデパート（育成アイテム売り場）')
            .setDescription(`現在の所持金: **${money.toLocaleString()} 円**\n\nポケモンの能力を極限まで引き出すアイテムを取り揃えております。`)
            .setColor(0x00FF00);

        // 🌟 アイテムに分かりやすい `desc` (説明文) を追加！
        const options = [
            // ドーピング（努力値+10）
            { id: 'item_hp_up', label: '💊 マックスアップ', price: 10000, desc: 'HPの基礎ポイント(努力値)を上げる' },
            { id: 'item_protein', label: '💊 タウリン', price: 10000, desc: '攻撃の基礎ポイント(努力値)を上げる' },
            { id: 'item_iron', label: '💊 ブロムヘキシン', price: 10000, desc: '防御の基礎ポイント(努力値)を上げる' },
            { id: 'item_calcium', label: '💊 リゾチウム', price: 10000, desc: '特攻の基礎ポイント(努力値)を上げる' },
            { id: 'item_zinc', label: '💊 キトサン', price: 10000, desc: '特防の基礎ポイント(努力値)を上げる' },
            { id: 'item_carbos', label: '💊 インドメタシン', price: 10000, desc: '素早さの基礎ポイント(努力値)を上げる' },
            
            // リセット
            { id: 'item_reset_mochi', label: '🍡 まっさらもち', price: 10000, desc: '基礎ポイント(努力値)をすべて0にリセットする' },
            
            // ミント（性格補正の変更）
            { id: 'mint_adamant', label: '🌿 いじっぱりミント', price: 20000, desc: '攻撃が上がりやすく、特攻が上がりにくくなる' },
            { id: 'mint_modest', label: '🌿 ひかえめミント', price: 20000, desc: '特攻が上がりやすく、攻撃が上がりにくくなる' },
            { id: 'mint_jolly', label: '🌿 ようきミント', price: 20000, desc: '素早さが上がりやすく、特攻が上がりにくくなる' },
            { id: 'mint_timid', label: '🌿 おくびょうミント', price: 20000, desc: '素早さが上がりやすく、攻撃が上がりにくくなる' },
            { id: 'item_ability_patch', label: '🧬 とくせいパッチ', price: 200000, desc: 'ポケモンの特性を「隠れ特性」に変更する' },

            // 王冠
            { id: 'item_silver_crown', label: '🥈 ぎんのおうかん', price: 20000, desc: 'Lv50以上のポケモンの1つの才能(個体値)を最大にする' },

            { id: 'scroll_dark', label: '📜 あくのかけじく', price: 50000, desc: 'ダクマに見せると「いちげきのかた」に進化する' },
            { id: 'scroll_water', label: '🌊 みずのかけじく', price: 50000, desc: 'ダクマに見せると「れんげきのかた」に進化する' },

            // 🌟 追加した持ち物アイテム
            { id: 'leftovers', label: '🍎 たべのこし', price: 50000, desc: '持たせると、毎ターンHPが少し回復する' },
            { id: 'life_orb', label: '🔮 いのちのたま', price: 80000, desc: '技の威力が上がるが、攻撃するたびHPが少し減る' },
            { id: 'choice_band', label: '🧣 こだわりハチマキ', price: 100000, desc: '物理攻撃が1.5倍になる超火力アイテム' },
            { id: 'amulet_coin', label: '🪙 おまもりこばん', price: 20000, desc: '持たせてバトルに勝つと、賞金が2倍になる！' },
            { id: 'booster_energy', label: '⚡ ブーストエナジー', price: 150000, desc: 'バトル開始時、一番高いステータスが強力にアップ！' },
            { id: 'rusted_sword', label: '🗡️ くちたけん', price: 500000, desc: 'ザシアンに持たせると「けんのおう」の姿に覚醒する' }
        ].map(item => ({
            label: `${item.label} (${item.price.toLocaleString()}円)`,
            description: item.desc, // 🌟 ここで説明文をメニューにセット！
            value: `${item.id}_1_${item.price}`
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_buy_select') // 処理はshopと同じものを使い回す
            .setPlaceholder('購入するアイテムを選択してください')
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
