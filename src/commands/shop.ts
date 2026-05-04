// src/commands/shop.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// 🌟 セール対象にするアイテムのリスト（IDの接頭辞）
const SALE_CANDIDATES = [
    'monster_ball', 'super_ball', 'hyper_ball', 'potion', 
    'rare_candy', 'tm_fire', 'tm_water', 'tm_electric'
];

export const shopCommand = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('フレンドリィショップでアイテムを購入する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: user } = await supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
        const money = user?.money || 0;

        // 🎲 日付から今日のセール品を決定（全員共通）
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // 9時間足してJSTにする
        const dateSeed = jst.getFullYear() * 1000 + jst.getMonth() * 100 + jst.getDate();
        const saleId = SALE_CANDIDATES[dateSeed % SALE_CANDIDATES.length];
        const discountRate = 0.8; // 20%引き

        // 💰 価格計算ヘルパー
        const calc = (id: string, qty: number, basePrice: number) => {
            const isSale = id === saleId;
            const price = isSale ? Math.floor(basePrice * qty * discountRate) : basePrice * qty;
            return {
                price,
                labelSuffix: isSale ? ` 【SALE!!】` : '',
                priceText: isSale ? `~~${basePrice * qty}~~ ➔ **${price}**` : `${price}`
            };
        };
        // 💰 本家（最新作）完全準拠のベース価格
        const p = { 
            mb: 200,      // モンスターボール（本家一致）
            sb: 600,      // スーパーボール（本家一致）
            hb: 1200,     // ハイパーボール（本家一致）
            pb: 1000,     // ⭐ プレミアムボール（👈 これを追加！）
            pot: 200,     // きずぐすり（本家一致）
            mp: 2500,     // まんたんのくすり（本家一致）
            tm: 10000,    // わざマシン（本家デパート・レート換算）
            
            // ▼ ここから下は本家「非売品」のため独自レート ▼
            rc: 8000,    // 💊 レベルアップアメ（本家売却額の2倍。※安すぎる場合は要調整）
            exp: 50000,   // ⚙️ がくしゅうそうち
            ms: 200000    // 🟣 マスターボール
        };



        const embed = new EmbedBuilder()
            .setTitle('🛒 フレンドリィショップ')
            .setDescription(`現在の所持金: **${money.toLocaleString()} 円**\n\n今日の特売品: **${saleId.replace('_', ' ').toUpperCase()}** 20% OFF!!`)
            .setColor(0x0000FF)
            .setFooter({ text: '※10個セットもセール対象です！' });

        // セレクトメニューの選択肢を動的に生成
        const options = [
            // モンスターボール系
            { id: 'monster_ball', q: 1, bp: p.mb, label: '🔴 モンスターボール', desc: 'ポケモンを捕まえるためのボール' },
            { id: 'monster_ball', q: 10, bp: p.mb, label: '📦 モンスターボール 10個セット', desc: 'まとめ買い用' },
            { id: 'super_ball', q: 1, bp: p.sb, label: '🔵 スーパーボール', desc: 'モンスターボールより捕まえやすい' },
            { id: 'super_ball', q: 10, bp: p.sb, label: '📦 スーパーボール 10個セット', desc: 'まとめ買い用' },
            { id: 'hyper_ball', q: 1, bp: p.hb, label: '🟡 ハイパーボール', desc: '非常に捕まえやすい最高性能のボール' },
            { id: 'hyper_ball', q: 10, bp: p.hb, label: '📦 ハイパーボール 10個セット', desc: 'まとめ買い用' },
            { id: 'premier_ball', q: 1, bp: p.pb, label: '⭐ プレミアムボール', desc: '捕獲率1.5倍＋見た目が豪華なボール' },
            
            // 回復・育成
            { id: 'potion', q: 1, bp: p.pot, label: '🩹 きずぐすり', desc: 'HPを50回復する' },
            { id: 'max_potion', q: 1, bp: p.mp, label: '💊 まんたんのくすり', desc: 'HPと状態異常を全回復する' },
            { id: 'rare_candy', q: 1, bp: p.rc, label: '💊 レベルアップアメ', desc: 'ポケモンを1レベル上げる' },
            
            // 特殊・わざマシン
            { id: 'exp_share', q: 1, bp: p.exp, label: '⚙️ がくしゅうそうち', desc: '控えのポケモンも経験値をもらえる' },
            { id: 'tm_fire', q: 1, bp: p.tm, label: '📀 わざマシン【ほのお】', desc: 'かえんほうしゃを習得' },
            { id: 'tm_water', q: 1, bp: p.tm, label: '📀 わざマシン【みず】', desc: 'なみのりを習得' },
            { id: 'tm_electric', q: 1, bp: p.tm, label: '📀 わざマシン【でんき】', desc: '10まんボルトを習得' },
            
            // VIPアイテム
            { id: 'master_ball', q: 1, bp: p.ms, label: '🟣 マスターボール', desc: '必ず捕まえられる究極のボール' },
        ].map(item => {
            const info = calc(item.id, item.q, item.bp);
            return {
                label: `${item.label}${info.labelSuffix} (${info.price}円)`,
                value: `${item.id}_${item.q}_${info.price}`,
                description: item.desc
            };
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop_buy_select')
            .setPlaceholder('アイテムを選択してください')
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};
