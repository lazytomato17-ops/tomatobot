import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const releaseCommand = {
    data: new SlashCommandBuilder()
        .setName('release')
        .setDescription('不要なポケモンを博士に送って 100円 をもらう'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // 🌟 追加: バグで手持ちが7匹以上になっている場合、先頭の6匹だけを残して強制的にボックスへ戻す（自己修復パッチ）
        const { data: currentParty } = await supabase
            .from('poke_caught_pokemons')
            .select('id')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true)
            .order('party_order', { ascending: true });

        if (currentParty && currentParty.length > 6) {
            // 7匹目以降のIDを抽出
            const overflowIds = currentParty.slice(6).map(p => p.id);
            // それらを「ボックス(is_party: false)」に戻す
            await supabase.from('poke_caught_pokemons').update({ is_party: false, party_order: null }).in('id', overflowIds);
        }

        // 手持ちに入っていない＆ロックされていないポケモンを取得
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', false) // 👈 これでボックスのポケモンだけになるはず
            .eq('is_locked', false)
            .order('caught_at', { ascending: false });

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ボックスに送れるポケモンがいません。（手持ちのポケモンは送れません）');
        }

        const options = pokemons.slice(0, 25).map(poke => ({
            label: `${poke.nickname} (Lv.${poke.level})`,
            description: `個体値合計: ${poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed}`,
            value: poke.id
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('release_select')
            .setPlaceholder('博士に送るポケモンを選択 (複数可)')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

        const response = await interaction.editReply({
            content: '⚠️ **注意**: 博士に送ったポケモンは二度と戻ってきません！',
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
        });

        try {
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60000,
                componentType: ComponentType.StringSelect
            });

            const selectedIds = confirmation.values;

            // DBから削除
            await supabase.from('poke_caught_pokemons').delete().in('id', selectedIds);

            // お金を増やす (1匹あたり 100円)
            const earn = selectedIds.length * 100;
            const { data: user } = await supabase.from('poke_users').select('money').eq('discord_id', interaction.user.id).single();
            await supabase.from('poke_users').update({ money: (user?.money || 0) + earn }).eq('discord_id', interaction.user.id);

            await confirmation.update({ content: `👋 **${selectedIds.length}匹** のポケモンを博士に送りました。\n💰 お礼として **${earn} 円** を受け取った！`, components: [] });
        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。', components: [] });
        }
    }
};