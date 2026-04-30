// src/tradeLogic.ts
import { ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, Message } from 'discord.js';
import { supabase } from './pokeDb';

// 通信進化するポケモンの図鑑番号リスト（ユンゲラー→フーディン, ゴースト→ゲンガー, ゴローン→ゴローニャ, ゴーリキー→カイリキー）
const TRADE_EVOLUTIONS: Record<number, number> = { 64: 65, 93: 94, 75: 76, 67: 68 };

interface TradePlayer {
    id: string;
    pokeId: string | null;
    pokeData: any | null;
    confirmed: boolean;
}

interface TradeState {
    id: string;
    message: Message;
    p1: TradePlayer;
    p2: TradePlayer;
    status: 'selecting' | 'confirming';
}

export const activeTrades = new Map<string, TradeState>();

export async function startTrade(interaction: ChatInputCommandInteraction) {
    const target = interaction.options.getUser('target');
    if (!target) return interaction.reply({ content: '相手が見つかりません。', ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ content: '自分自身とは交換できません！', ephemeral: true });
    if (target.bot) return interaction.reply({ content: 'Botとは交換できません！', ephemeral: true });

    await interaction.deferReply();

    const tradeId = `trade_${Date.now()}`;
    
    const embed = new EmbedBuilder()
        .setTitle('🔄 ポケモン通信交換')
        .setDescription(`<@${interaction.user.id}> が <@${target.id}> に トレードを 申し込んだ！\n\nお互いに **[交換するポケモンを選ぶ]** ボタンを押して、出すポケモンを決定してください。`)
        .addFields(
            { name: `<@${interaction.user.id}> の出すポケモン`, value: '⏳ 選択中...' },
            { name: `<@${target.id}> の出すポケモン`, value: '⏳ 選択中...' }
        )
        .setColor(0x00BFFF);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`tradebtn_select_${tradeId}`).setLabel('交換するポケモンを選ぶ').setStyle(ButtonStyle.Primary).setEmoji('📦'),
        new ButtonBuilder().setCustomId(`tradebtn_cancel_${tradeId}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger)
    );

    const message = await interaction.editReply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });

    activeTrades.set(tradeId, {
        id: tradeId, message, status: 'selecting',
        p1: { id: interaction.user.id, pokeId: null, pokeData: null, confirmed: false },
        p2: { id: target.id, pokeId: null, pokeData: null, confirmed: false }
    });
}

export async function handleTradeButton(interaction: ButtonInteraction, tradeId: string, action: string) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return interaction.reply({ content: 'この交換セッションは既に終了しているか、無効です。', ephemeral: true });
    
    const isP1 = interaction.user.id === trade.p1.id;
    const isP2 = interaction.user.id === trade.p2.id;
    if (!isP1 && !isP2) return interaction.reply({ content: 'あなたはこのトレードの参加者ではありません！', ephemeral: true });

    const player = isP1 ? trade.p1 : trade.p2;

    if (action === 'cancel') {
        activeTrades.delete(tradeId);
        await trade.message.edit({ content: `🚫 トレードは キャンセル されました。`, embeds: [], components: [] });
        return interaction.reply({ content: 'トレードをキャンセルしました。', ephemeral: true });
    }

    if (action === 'select') {
        await interaction.deferReply({ ephemeral: true });
        
        // 自分の手持ちとボックスから上位25匹を取得
        const { data: pokes } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).order('is_party', { ascending: false }).limit(25);
        if (!pokes || pokes.length === 0) return interaction.editReply('交換に出せるポケモンを持っていません。');

        const options = pokes.map(p => ({
            label: `${p.is_party ? '🏕️' : '📦'} ${p.nickname} (Lv.${p.level})`,
            description: `HP:${p.current_hp} / 性格:${p.nature}`,
            value: p.id
        }));

        const selectMenu = new StringSelectMenuBuilder().setCustomId(`tradesel_poke_${tradeId}`).setPlaceholder('交換に出すポケモンを選択').addOptions(options);
        await interaction.editReply({
            content: '👇 交換に出すポケモンを選んでください（※相手に送られます！）',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });
    }

    if (action === 'confirm') {
        player.confirmed = true;
        await updateTradeMessage(trade);
        await interaction.reply({ content: '✅ 準備完了しました！相手を待っています...', ephemeral: true });

        // 両方確定したら交換成立！
        if (trade.p1.confirmed && trade.p2.confirmed) {
            await executeTradeSwap(trade);
        }
    }
}

export async function handleTradeSelect(interaction: StringSelectMenuInteraction, tradeId: string) {
    const trade = activeTrades.get(tradeId);
    if (!trade) return interaction.reply({ content: 'この交換セッションは無効です。', ephemeral: true });
    
    const isP1 = interaction.user.id === trade.p1.id;
    const isP2 = interaction.user.id === trade.p2.id;
    const player = isP1 ? trade.p1 : trade.p2;

    await interaction.deferUpdate();
    
    const pokeId = interaction.values[0];
    const { data: poke } = await supabase.from('poke_caught_pokemons').select('*').eq('id', pokeId).single();
    if (!poke) return interaction.followUp({ content: 'エラー：ポケモンが見つかりません。', ephemeral: true });

    player.pokeId = poke.id;
    player.pokeData = poke;
    player.confirmed = false; // 選び直したら確定解除

    // 両方が選んだら確認フェーズへ
    if (trade.p1.pokeId && trade.p2.pokeId) trade.status = 'confirming';

    await updateTradeMessage(trade);
    await interaction.editReply({ content: `✅ **${poke.nickname}** を交換に出す準備をしました！`, components: [] });
}

async function updateTradeMessage(trade: TradeState) {
    const embed = EmbedBuilder.from(trade.message.embeds[0]);
    
    const getPokeText = (p: TradePlayer) => {
        if (!p.pokeId) return '⏳ 選択中...';
        if (trade.status === 'selecting') return '✅ 準備OK (中身はまだヒミツ)';
        return `**${p.pokeData.nickname}** (Lv.${p.pokeData.level})\n${p.confirmed ? '✅ 確定済' : '⏳ 確認中...'}`;
    };

    embed.setFields(
        { name: `<@${trade.p1.id}> の出すポケモン`, value: getPokeText(trade.p1), inline: true },
        { name: `↔️`, value: '\u200B', inline: true },
        { name: `<@${trade.p2.id}> の出すポケモン`, value: getPokeText(trade.p2), inline: true }
    );

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    
    if (trade.status === 'selecting') {
        embed.setDescription('お互いに **[交換するポケモンを選ぶ]** ボタンを押して、出すポケモンを決定してください。');
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`tradebtn_select_${trade.id}`).setLabel('交換するポケモンを選ぶ').setStyle(ButtonStyle.Primary).setEmoji('📦'),
            new ButtonBuilder().setCustomId(`tradebtn_cancel_${trade.id}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger)
        ));
    } else if (trade.status === 'confirming') {
        embed.setDescription('お互いの ポケモンが 決定しました！\nこの内容で トレードしますか？ よければ **[確定する]** を押してください！');
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`tradebtn_confirm_${trade.id}`).setLabel('確定する (トレード実行)').setStyle(ButtonStyle.Success).setEmoji('🤝'),
            new ButtonBuilder().setCustomId(`tradebtn_cancel_${trade.id}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger)
        ));
    }

    await trade.message.edit({ embeds: [embed], components });
}

async function executeTradeSwap(trade: TradeState) {
    activeTrades.delete(trade.id);
    await trade.message.edit({ content: '⏳ トレード実行中…… ケーブルをつないでいます……', embeds: [], components: [] });

    try {
        // 🌟 交換処理：持ち主を入れ替え、パーティから外してボックス(is_party: false)に送る
        await supabase.from('poke_caught_pokemons').update({ owner_id: trade.p2.id, is_party: false, party_order: null }).eq('id', trade.p1.pokeId);
        await supabase.from('poke_caught_pokemons').update({ owner_id: trade.p1.id, is_party: false, party_order: null }).eq('id', trade.p2.pokeId);

        let resultLog = `🎊 **トレード成立！！** 🎊\n\n<@${trade.p1.id}> は **${trade.p2.pokeData.nickname}** を 手に入れた！\n<@${trade.p2.id}> は **${trade.p1.pokeData.nickname}** を 手に入れた！\n*(※交換したポケモンは ボックス に送られました)*`;

        // 🌟 隠しギミック：通信進化チェック！
        const checkEvolution = async (pokeData: any, newOwnerId: string) => {
            if (TRADE_EVOLUTIONS[pokeData.pokedex_id]) {
                const nextId = TRADE_EVOLUTIONS[pokeData.pokedex_id];
                const nextPokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${nextId}`).then(r => r.json());
                const speciesRes = await fetch(nextPokeRes.species.url).then(r => r.json());
                const jaName = speciesRes.names.find((n: any) => n.language.name === 'ja')?.name || nextPokeRes.name;
                
                await supabase.from('poke_caught_pokemons').update({ pokedex_id: nextId, nickname: jaName, types: nextPokeRes.types.map((t:any) => t.type.name) }).eq('id', pokeData.id);
                return `\n\n✨✨ おや…！？ 送られてきた **${pokeData.nickname}** の 様子が……！\n🎊 おめでとう！ **${jaName}** に 進化した！`;
            }
            return '';
        };

        resultLog += await checkEvolution(trade.p1.pokeData, trade.p2.id);
        resultLog += await checkEvolution(trade.p2.pokeData, trade.p1.id);

        await trade.message.edit({ content: resultLog });
    } catch (e) {
        console.error('Trade Error:', e);
        await trade.message.edit({ content: '❌ トレード中にエラーが発生しました。' });
    }
}
