// src/commands/info.ts
import {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
    ComponentType, ChatInputCommandInteraction
} from 'discord.js';
import { supabase } from '../pokeDb';

// タイプの日本語化マップ
const TYPE_MAP: Record<string, string> = {
    normal: '⚪ ノーマル', fire: '🔥 ほのお', water: '💧 みず', electric: '⚡ でんき',
    grass: '🌿 くさ', ice: '❄️ こおり', fighting: '🥊 かくとう', poison: '☠️ どく',
    ground: '🌍 じめん', flying: '🕊️ ひこう', psychic: '🔮 エスパー', bug: '🐛 むし',
    rock: '🪨 いわ', ghost: '👻 ゴースト', dragon: '🐉 ドラゴン', dark: '🕶️ あく',
    steel: '⚙️ はがね', fairy: '✨ フェアリー'
};

// タイプ別Embedカラー（第1タイプを使用）
const TYPE_COLOR: Record<string, number> = {
    normal: 0xA8A878, fire: 0xF08030, water: 0x6890F0, electric: 0xF8D030,
    grass: 0x78C850, ice: 0x98D8D8, fighting: 0xC03028, poison: 0xA040A0,
    ground: 0xE0C068, flying: 0xA890F0, psychic: 0xF85888, bug: 0xA8B820,
    rock: 0xB8A038, ghost: 0x705898, dragon: 0x7038F8, dark: 0x705848,
    steel: 0xB8B8D0, fairy: 0xEE99AC
};

// 性格補正データ [上昇, 低下] (1:攻撃, 2:防御, 3:特攻, 4:特防, 5:素早)
const NATURE_EFFECTS: Record<string, [number, number] | null> = {
    'さみしがり': [1, 2], 'いじっぱり': [1, 3], 'やんちゃ': [1, 4], 'ゆうかん': [1, 5],
    'ずぶとい': [2, 1], 'わんぱく': [2, 3], 'のうてんき': [2, 4], 'のんき': [2, 5],
    'ひかえめ': [3, 1], 'おっとり': [3, 2], 'うっかりや': [3, 4], 'れいせい': [3, 5],
    'おだやか': [4, 1], 'おとなしい': [4, 2], 'しんちょう': [4, 3], 'なまいき': [4, 5],
    'おくびょう': [5, 1], 'せっかち': [5, 2], 'ようき': [5, 3], 'むじゃき': [5, 4],
    'てれや': null, 'がんばりや': null, 'すなお': null, 'きまぐれ': null, 'まじめ': null
};

// 状態異常の日本語化
const STATUS_MAP: Record<string, string> = {
    burn: '🔥 やけど', paralysis: '⚡ まひ', poison: '☠️ どく',
    'bad-poison': '☠️☠️ もうどく', sleep: '💤 ねむり', freeze: '❄️ こおり', faint: '💀 ひんし'
};

// 性別表示
const GENDER_MAP: Record<string, string> = { male: '♂', female: '♀', unknown: '' };

// ページあたりの表示数
const PAGE_SIZE = 25;

// IVバーを生成（0〜31 → 6マス）
function ivBar(iv: number): string {
    const filled = Math.round((iv / 31) * 6);
    const color = iv >= 31 ? '🟦' : iv >= 20 ? '🟩' : iv >= 10 ? '🟨' : '🟥';
    return color.repeat(filled) + '⬜'.repeat(6 - filled) + ` \`${iv}\``;
}

// HPゲージを生成
function hpBar(current: number, max: number): string {
    const ratio = max > 0 ? current / max : 0;
    const bars = Math.round(ratio * 10);
    const color = ratio > 0.5 ? '🟩' : ratio > 0.2 ? '🟨' : '🟥';
    return color.repeat(bars) + '⬜'.repeat(10 - bars) + ` \`${current}/${max}\``;
}

// EV合計を計算
function totalEv(poke: any): number {
    return poke.ev_hp + poke.ev_attack + poke.ev_defense + poke.ev_sp_atk + poke.ev_sp_def + poke.ev_speed;
}

// ポケモン詳細Embedを生成する関数
async function buildDetailEmbed(poke: any): Promise<{ embed: EmbedBuilder }> {
    const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${poke.pokedex_id}`);
    const data = await pokeRes.json();

    const baseStats: Record<string, number> = {};
    data.stats.forEach((s: any) => { baseStats[s.stat.name] = s.base_stat; });

    const types = data.types.map((t: any) => TYPE_MAP[t.type.name] || t.type.name).join(' / ');
    const primaryType = data.types[0]?.type?.name || 'normal';
    const embedColor = TYPE_COLOR[primaryType] ?? 0xFFA500;

    const lv = poke.level;
    const effect = NATURE_EFFECTS[poke.nature] || null;
    const getMark = (idx: number) => {
        if (!effect) return '';
        if (effect[0] === idx) return ' 🔺';
        if (effect[1] === idx) return ' 🔹';
        return '';
    };
    const applyNature = (stat: number, idx: number) => {
        if (!effect) return stat;
        if (effect[0] === idx) return Math.floor(stat * 1.1);
        if (effect[1] === idx) return Math.floor(stat * 0.9);
        return stat;
    };

    // 実数値計算（個体値 + 努力値）
    const calcStat = (base: number, iv: number, ev: number, lv: number) =>
        Math.floor(((2 * base + iv + Math.floor(ev / 4)) * lv) / 100) + 5;

    const realHp = Math.floor(((2 * baseStats['hp'] + poke.iv_hp + Math.floor(poke.ev_hp / 4)) * lv) / 100) + lv + 10;
    let realAtk = applyNature(calcStat(baseStats['attack'], poke.iv_attack, poke.ev_attack, lv), 1);
    let realDef = applyNature(calcStat(baseStats['defense'], poke.iv_defense, poke.ev_defense, lv), 2);
    let realSpa = applyNature(calcStat(baseStats['special-attack'], poke.iv_sp_atk, poke.ev_sp_atk, lv), 3);
    let realSpd = applyNature(calcStat(baseStats['special-defense'], poke.iv_sp_def, poke.ev_sp_def, lv), 4);
    let realSpe = applyNature(calcStat(baseStats['speed'], poke.iv_speed, poke.ev_speed, lv), 5);

    const displayHp = Math.min(poke.current_hp, realHp);

    // 経験値バー
    const requiredExp = (lv * lv) * 50;
    const currentLevelExp = ((lv - 1) * (lv - 1)) * 50;
    const progress = requiredExp > currentLevelExp
        ? (poke.exp - currentLevelExp) / (requiredExp - currentLevelExp)
        : 1;
    const expBars = Math.min(10, Math.max(0, Math.floor(progress * 10)));
    const expBar = '🟩'.repeat(expBars) + '⬜'.repeat(10 - expBars);

    // 個体値評価
    const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
    let stars = '・'; let flavor = 'まずまずの 能力を 持っているようだ。';
    if (totalIv >= 160) { stars = '⭐⭐⭐'; flavor = 'とびきり すばらしい 能力を 持っている！'; }
    else if (totalIv >= 120) { stars = '⭐⭐'; flavor = 'すばらしい 能力を 持っている！'; }
    else if (totalIv >= 90) { stars = '⭐'; flavor = 'かなりの 能力を 持っている。'; }

    // 技リスト
    const moveList = (poke.moves && poke.moves.length > 0)
        ? poke.moves.map((m: any) => `・${m.name} (威力:${m.power} / ${TYPE_MAP[m.type] || m.type})`).join('\n')
        : 'まだ技を覚えていない';

    // 付加情報（性別・色違い・状態・アイテム）
    const gender = GENDER_MAP[poke.gender] ?? '';
    const shiny = poke.is_shiny ? ' ✨色違い' : '';
    const status = poke.status_condition ? ` / ${STATUS_MAP[poke.status_condition] ?? poke.status_condition}` : '';
    const heldItem = poke.held_item ? `\n**もちもの**: ${poke.held_item}` : '';
    const evTotal = totalEv(poke);

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${poke.nickname}${gender}${shiny} (Lv.${lv}) ${poke.is_party ? '🎈 手持ち' : '📦 ボックス'}`)
        .setImage(data.sprites.other['official-artwork'].front_default || data.sprites.front_default)
        .setColor(embedColor)
        .setDescription(
            `**タイプ**: ${types}\n` +
            `**性格**: ${poke.nature}　**総合評価**: ${stars} *「${flavor}」*${status}\n` +
            `**経験値**: ${expBar} \`(${poke.exp} / ${requiredExp})\`${heldItem}\n\n` +
            `**⚔️ 覚えている技**\n${moveList}`
        )
        // HP
        .addFields({
            name: `❤️ HP${status ? ' ' + (STATUS_MAP[poke.status_condition] ?? '') : ''}`,
            value: hpBar(displayHp, realHp),
            inline: false
        })
        // ステータス（実数値 / 個体値 / 努力値）
        .addFields(
            {
                name: `⚔️ こうげき${getMark(1)}`,
                value: `**${realAtk}**\nIV: ${ivBar(poke.iv_attack)}\nEV: \`${poke.ev_attack}\``,
                inline: true
            },
            {
                name: `🛡️ ぼうぎょ${getMark(2)}`,
                value: `**${realDef}**\nIV: ${ivBar(poke.iv_defense)}\nEV: \`${poke.ev_defense}\``,
                inline: true
            },
            {
                name: `🔮 とくこう${getMark(3)}`,
                value: `**${realSpa}**\nIV: ${ivBar(poke.iv_sp_atk)}\nEV: \`${poke.ev_sp_atk}\``,
                inline: true
            },
            {
                name: `🔰 とくぼう${getMark(4)}`,
                value: `**${realSpd}**\nIV: ${ivBar(poke.iv_sp_def)}\nEV: \`${poke.ev_sp_def}\``,
                inline: true
            },
            {
                name: `💨 すばやさ${getMark(5)}`,
                value: `**${realSpe}**\nIV: ${ivBar(poke.iv_speed)}\nEV: \`${poke.ev_speed}\``,
                inline: true
            }
        )
        // フッター
        .setFooter({ text: `個体値合計: ${totalIv}/186　努力値合計: ${evTotal}/510` });

    return { embed };
}

export const infoCommand = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('所持しているポケモンの詳細なステータス（個体値や性格など）を確認する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        let page = 0;

        // ポケモン一覧を全件取得（手持ち優先→新しい順）
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('is_party', { ascending: false })
            .order('caught_at', { ascending: false });

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ポケモンがいません。まずは `/wild` で捕まえましょう！');
        }

        const totalPages = Math.ceil(pokemons.length / PAGE_SIZE);

        // 指定ページのセレクトメニューを生成
        const buildSelectMenu = (page: number) => {
            const slice = pokemons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
            const options = slice.map(poke => {
                const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
                let stars = totalIv >= 160 ? '⭐⭐⭐' : totalIv >= 120 ? '⭐⭐' : totalIv >= 90 ? '⭐' : '・';
                const gender = GENDER_MAP[poke.gender] ?? '';
                const shiny = poke.is_shiny ? '✨' : '';
                return {
                    label: `${poke.nickname}${gender} (Lv.${poke.level}) ${poke.is_party ? '🎈' : ''}${poke.is_locked ? '🔒' : ''}${shiny}`,
                    description: `評価: ${stars} | IV合計: ${totalIv} | EV合計: ${totalEv(poke)}`,
                    value: poke.id
                };
            });
            return new StringSelectMenuBuilder()
                .setCustomId('info_select')
                .setPlaceholder(`詳細を見たいポケモンを選択 (${page * PAGE_SIZE + 1}〜${Math.min((page + 1) * PAGE_SIZE, pokemons.length)}匹目)`)
                .addOptions(options);
        };

        // ページングボタンを生成
        const buildPageButtons = (page: number) => {
            return new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('page_prev')
                    .setLabel('◀ 前のページ')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page_next')
                    .setLabel('次のページ ▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= totalPages - 1)
            );
        };

        // 初回メッセージ送信
        const buildListMessage = (page: number) => ({
            content: `📋 ステータスを確認したいポケモンを選んでください！\n（全 **${pokemons.length}** 匹 / ページ ${page + 1}/${totalPages}）`,
            components: totalPages > 1
                ? [
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildSelectMenu(page)),
                    buildPageButtons(page)
                ]
                : [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildSelectMenu(page))]
        });

        const response = await interaction.editReply(buildListMessage(page));

        // コレクター（90秒間、選択とページング両方を受け付ける）
        const collector = response.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 90_000
        });

        collector.on('collect', async i => {
            // ページング
            if (i.customId === 'page_prev') {
                page = Math.max(0, page - 1);
                await i.update(buildListMessage(page));
                return;
            }
            if (i.customId === 'page_next') {
                page = Math.min(totalPages - 1, page + 1);
                await i.update(buildListMessage(page));
                return;
            }

            // 詳細表示（戻るボタン付き）
            if (i.customId === 'info_select' && i.componentType === ComponentType.StringSelect) {
                const selectedId = i.values[0];
                const poke = pokemons.find(p => p.id === selectedId)!;

                await i.deferUpdate();

                try {
                    const { embed } = await buildDetailEmbed(poke);

                    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_list')
                            .setLabel('◀ 一覧に戻る')
                            .setStyle(ButtonStyle.Primary)
                    );

                    await interaction.editReply({
                        content: `✅ **${poke.nickname}** の詳細データです！`,
                        embeds: [embed],
                        components: [backRow]
                    });
                } catch {
                    await interaction.editReply({ content: '❌ データの取得に失敗しました。', embeds: [], components: [] });
                }
                return;
            }

            // 一覧に戻る
            if (i.customId === 'back_to_list') {
                await i.update({ ...buildListMessage(page), embeds: [] });
                return;
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度 `/info` を実行してください。', components: [], embeds: [] });
            }
        });
    }
};