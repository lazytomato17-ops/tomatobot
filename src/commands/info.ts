// src/commands/info.ts
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪ ノーマル', fire: '🔥 ほのお', water: '💧 みず', electric: '⚡ でんき', grass: '🌿 くさ', ice: '❄️ こおり', fighting: '🥊 かくとう', poison: '☠️ どく', ground: '🌍 じめん', flying: '🕊️ ひこう', psychic: '🔮 エスパー', bug: '🐛 むし', rock: '🪨 いわ', ghost: '👻 ゴースト', dragon: '🐉 ドラゴン', dark: '🕶️ あく', steel: '⚙️ はがね', fairy: '✨ フェアリー'
};

export const infoCommand = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('現在手持ちの先頭ポケモンの詳細なステータスを見る'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        const { data: party, error } = await supabase.from('poke_caught_pokemons').select('*').eq('owner_id', interaction.user.id).eq('is_party', true).order('party_order', { ascending: true });
        
        if (error || !party || party.length === 0) return interaction.editReply('手持ちにポケモンがいません。`/party` で設定してください！');

        const poke = party[0];
        try {
            const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${poke.pokedex_id}`);
            const data = await pokeRes.json();
            
            const baseStats: Record<string, number> = {};
            data.stats.forEach((s: any) => { baseStats[s.stat.name] = s.base_stat; });

            const types = data.types.map((t: any) => TYPE_MAP[t.type.name] || t.type.name).join(' / ');
            const lv = poke.level;

            const realHp = Math.floor(((2 * baseStats['hp'] + poke.iv_hp) * lv) / 100) + lv + 10;
            const realAtk = Math.floor(((2 * baseStats['attack'] + poke.iv_attack) * lv) / 100) + 5;
            const realDef = Math.floor(((2 * baseStats['defense'] + poke.iv_defense) * lv) / 100) + 5;
            const realSpa = Math.floor(((2 * baseStats['special-attack'] + poke.iv_sp_atk) * lv) / 100) + 5;
            const realSpd = Math.floor(((2 * baseStats['special-defense'] + poke.iv_sp_def) * lv) / 100) + 5;
            const realSpe = Math.floor(((2 * baseStats['speed'] + poke.iv_speed) * lv) / 100) + 5;

            // ✅ 修正：現在HPが最大HP（realHp）を超えないようにフタをする
            const displayHp = Math.min(poke.current_hp, realHp);

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${poke.nickname} (Lv.${lv})`)
                .setImage(data.sprites.other['official-artwork'].front_default)
                .setColor(0xFFA500)
                .setDescription(`**タイプ**: ${types}\n**性格**: ${poke.nature}`)
                .addFields(
                    { name: '❤️ HP', value: `${displayHp} / ${realHp} \`(個体値: ${poke.iv_hp})\``, inline: false },
                    { name: '⚔️ こうげき', value: `${realAtk} \`(${poke.iv_attack})\``, inline: true },
                    { name: '🛡️ ぼうぎょ', value: `${realDef} \`(${poke.iv_defense})\``, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: '🔮 とくこう', value: `${realSpa} \`(${poke.iv_sp_atk})\``, inline: true },
                    { name: '🔰 とくぼう', value: `${realSpd} \`(${poke.iv_sp_def})\``, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: '💨 すばやさ', value: `${realSpe} \`(${poke.iv_speed})\``, inline: true }
                );
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply('通信エラーが発生しました。');
        }
    }
};
