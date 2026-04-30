// src/commands/moves.ts
import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const movesCommand = {
    data: new SlashCommandBuilder()
        .setName('moves')
        .setDescription('ポケモンの技を自由に入れ替える（思い出す）'),

    async execute(interaction: ChatInputCommandInteraction) {
        // 他の人に見えないようにephemeralで返信
        await interaction.deferReply({ ephemeral: true });

        // 自分の手持ちポケモンを取得
        const { data: party } = await supabase.from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true)
            .order('party_order', { ascending: true });

        if (!party || party.length === 0) return interaction.editReply('手持ちにポケモンがいません。');

        const pokeOptions = party.map(p => ({ label: `${p.nickname} (Lv.${p.level})`, value: p.id }));
        const pokeSelect = new StringSelectMenuBuilder()
            .setCustomId('moves_poke_select')
            .setPlaceholder('技を変えたいポケモンを選択')
            .addOptions(pokeOptions);

        const response = await interaction.editReply({ 
            content: '👇 技を入れ替えたいポケモンを選んでください！',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pokeSelect)] 
        });

        try {
            // ポケモン選択を待つ
            const pokeConf = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
            const selectedPokeId = pokeConf.values[0];
            const poke = party.find(p => p.id === selectedPokeId);
            await pokeConf.deferUpdate();

            await interaction.editReply({ content: '🔍 覚えられる技のデータをAPIから取得中…（数秒かかります）', components: [] });

            // 本家APIから技データを取得
            const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${poke.pokedex_id}`);
            const pokeData = await res.json();
            
            // そのレベルまでにレベルアップで覚える技をすべて抽出（レベルが高い順）
            const levelUpMoves = pokeData.moves
                .map((m: any) => {
                    const detail = m.version_group_details.find((v: any) => v.move_learn_method.name === 'level-up');
                    return detail ? { name: m.move.name, url: m.move.url, level: detail.level_learned_at } : null;
                })
                .filter((m: any) => m && m.level <= poke.level)
                .sort((a: any, b: any) => b.level - a.level);

            // 重複を排除
            const uniqueMoves: any[] = [];
            const seen = new Set();
            for (const m of levelUpMoves) {
                if (!seen.has(m.name)) {
                    seen.add(m.name);
                    uniqueMoves.push(m);
                }
            }

            // Discordのメニュー上限(25個)に合わせて、最新の25個の技を取得
            const targetMoves = uniqueMoves.slice(0, 25);
            const moveDataList = await Promise.all(targetMoves.map(m => fetch(m.url).then(r => r.json())));
            
            const availableMoves: any[] = [];
            for (const m of moveDataList) {
                const nameObj = m.names.find((n: any) => n.language.name === 'ja-Hrkt' || n.language.name === 'ja');
                const name = nameObj ? nameObj.name : m.name;
                const accuracy = m.accuracy || 100;
                const power = m.power || 0; 
                const damageClass = m.damage_class.name;
                const pp = m.pp || 10;
                const ailment = m.meta?.ailment?.name !== 'none' ? m.meta?.ailment?.name : null;
                const statChanges = m.stat_changes?.map((sc: any) => ({ stat: sc.stat.name, change: sc.change })) || [];
                const healing = m.meta?.healing || 0;
                const target = m.target?.name || 'selected-pokemon'; 

                // 技の説明文を作る
                let desc = power > 0 ? `威力:${power} ` : `変化技 `;
                desc += `命中:${accuracy} PP:${pp}`;
                if (ailment) desc += ` 異常:${ailment}`;
                if (healing > 0) desc += ` 回復:${healing}%`;

                availableMoves.push({
                    name, power, type: m.type.name, damageClass, accuracy, pp, maxPp: pp, ailment, statChanges, healing, target, desc
                });
            }

            if (availableMoves.length === 0) {
                return interaction.editReply({ content: '覚えられる技が見つかりませんでした。', components: [] });
            }

            const moveOptions = availableMoves.map((m, i) => ({
                label: m.name,
                description: m.desc.substring(0, 100),
                value: i.toString()
            }));

            const moveSelect = new StringSelectMenuBuilder()
                .setCustomId('moves_select')
                .setPlaceholder('覚えさせたい技を「最大4つまで」選んでください')
                .setMinValues(1)
                .setMaxValues(Math.min(4, moveOptions.length)) // 1〜4個選べる
                .addOptions(moveOptions);

            const mResponse = await interaction.editReply({
                content: `**${poke.nickname}** (Lv.${poke.level}) の技を再設定します。\n下から好きな技を選んでください！`,
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(moveSelect)]
            });

            // 技の選択を待つ
            const mConf = await mResponse.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
            await mConf.deferUpdate();

            // 選ばれた技を保存
            const selectedIndices = mConf.values.map(v => parseInt(v));
            const newMoves = selectedIndices.map(i => availableMoves[i]);

            await supabase.from('poke_caught_pokemons').update({ moves: newMoves }).eq('id', poke.id);

            await interaction.editReply({ 
                content: `✅ **${poke.nickname}** の技を新しくセットしました！\n【 ${newMoves.map(m => m.name).join(' / ')} 】`, 
                components: [] 
            });

        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしたか、エラーが発生しました。', components: [] });
        }
    }
};
