// src/commands/info.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

// タイプの日本語化マップ
const TYPE_MAP: Record<string, string> = {
    normal: '⚪ ノーマル', fire: '🔥 ほのお', water: '💧 みず', electric: '⚡ でんき', grass: '🌿 くさ', ice: '❄️ こおり', fighting: '🥊 かくとう', poison: '☠️ どく', ground: '🌍 じめん', flying: '🕊️ ひこう', psychic: '🔮 エスパー', bug: '🐛 むし', rock: '🪨 いわ', ghost: '👻 ゴースト', dragon: '🐉 ドラゴン', dark: '🕶️ あく', steel: '⚙️ はがね', fairy: '✨ フェアリー'
};

export const infoCommand = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('所持しているポケモンの詳細なステータス（個体値や性格など）を確認する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 自分のポケモンを「手持ち優先、次に新しい順」で最大25匹取得
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('is_party', { ascending: false }) 
            .order('caught_at', { ascending: false })
            .limit(25);

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ポケモンがいません。まずは `/wild` で捕まえましょう！');
        }

        // セレクトメニューの選択肢を作成
        const options = pokemons.map(poke => {
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            let stars = '';
            if (totalIv >= 160) stars = '⭐⭐⭐';
            else if (totalIv >= 120) stars = '⭐⭐';
            else if (totalIv >= 90) stars = '⭐';

            return {
                label: `${poke.nickname} (Lv.${poke.level}) ${poke.is_party ? '🎈' : ''}${poke.is_locked ? '🔒' : ''}`,
                description: `評価: ${stars || '・'} / 個体値合計: ${totalIv}`,
                value: poke.id
            };
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('info_select')
            .setPlaceholder('詳細を見たいポケモンを選択してください')
            .addOptions(options);

        const response = await interaction.editReply({
            content: '📊 ステータスを確認したいポケモンを選んでください！\n（手持ちのポケモンと、ボックスの最新のポケモンが表示されています）',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        try {
            // ユーザーの選択を待機 (60秒)
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedId = confirmation.values[0];
            const poke = pokemons.find(p => p.id === selectedId)!;

            // APIから種族値等を取得
            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${poke.pokedex_id}`);
            const data = await pokeRes.json();
            
            const baseStats: Record<string, number> = {};
            data.stats.forEach((s: any) => { baseStats[s.stat.name] = s.base_stat; });

            const types = data.types.map((t: any) => TYPE_MAP[t.type.name] || t.type.name).join(' / ');
            const lv = poke.level;

            // 実数値計算
            const realHp = Math.floor(((2 * baseStats['hp'] + poke.iv_hp) * lv) / 100) + lv + 10;
            const realAtk = Math.floor(((2 * baseStats['attack'] + poke.iv_attack) * lv) / 100) + 5;
            const realDef = Math.floor(((2 * baseStats['defense'] + poke.iv_defense) * lv) / 100) + 5;
            const realSpa = Math.floor(((2 * baseStats['special-attack'] + poke.iv_sp_atk) * lv) / 100) + 5;
            const realSpd = Math.floor(((2 * baseStats['special-defense'] + poke.iv_sp_def) * lv) / 100) + 5;
            const realSpe = Math.floor(((2 * baseStats['speed'] + poke.iv_speed) * lv) / 100) + 5;

            const displayHp = Math.min(poke.current_hp, realHp);

            // 🌟 経験値バーの簡易表示
            const requiredExp = (lv * lv) * 50;
            const currentLevelExp = ((lv - 1) * (lv - 1)) * 50;
            const progress = (poke.exp - currentLevelExp) / (requiredExp - currentLevelExp);
            const bars = Math.min(10, Math.max(0, Math.floor(progress * 10)));
            const expBar = '🟩'.repeat(bars) + '⬜'.repeat(10 - bars);

            // 🌟 個体値のフレーバーテキスト
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;
            let stars = ''; let flavor = '';
            if (totalIv >= 160) { stars = '⭐⭐⭐'; flavor = 'とびきり すばらしい 能力を 持っている！'; }
            else if (totalIv >= 120) { stars = '⭐⭐'; flavor = 'すばらしい 能力を 持っている！'; }
            else if (totalIv >= 90) { stars = '⭐'; flavor = 'かなりの 能力を 持っている。'; }
            else { stars = '・'; flavor = 'まずまずの 能力を 持っているようだ。'; }

            // 🌟 覚えている技の表示
            const moveList = (poke.moves && poke.moves.length > 0) 
                ? poke.moves.map((m: any) => `・${m.name} (威力:${m.power} / タイプ:${TYPE_MAP[m.type] || m.type})`).join('\n')
                : 'まだ技を覚えていない';

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${poke.nickname} (Lv.${lv}) ${poke.is_party ? '🎈(手持ち)' : '📦(ボックス)'}`)
                .setImage(data.sprites.other['official-artwork'].front_default || data.sprites.front_default)
                .setColor(0xFFA500)
                .setDescription(`**タイプ**: ${types}\n**性格**: ${poke.nature}\n**総合評価**: ${stars} *「${flavor}」*\n**経験値**: ${expBar} (${poke.exp} / ${requiredExp})\n\n**⚔️ 覚えている技**\n${moveList}`)
                    .addFields(
        { name: '❤️ HP', value: `${displayHp} / ${realHp}`, inline: true },
        { name: `⚔️ 攻撃 ${getMark(1)}`, value: `${realAtk}`, inline: true },
        { name: `🛡️ 防御 ${getMark(2)}`, value: `${realDef}`, inline: true },
        { name: `🔮 特攻 ${getMark(3)}`, value: `${realSpa}`, inline: true },
        { name: `🔰 特防 ${getMark(4)}`, value: `${realSpd}`, inline: true },
        { name: `💨 素早 ${getMark(5)}`, value: `${realSpe}`, inline: true }
                     );

            await confirmation.update({ content: `✅ **${poke.nickname}** の詳細データです！`, embeds: [embed], components: [] });

        } catch (err) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度 `/info` を実行してください。', components: [] });
        }
    }
};
