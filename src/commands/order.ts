import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

export const orderCommand = {
    data: new SlashCommandBuilder()
        .setName('order')
        .setDescription('手持ちポケモンの出す順番（先頭など）を並び替える'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { data: party, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .eq('is_party', true)
            .order('party_order', { ascending: true });

        if (error || !party || party.length === 0) {
            return interaction.editReply('手持ちにポケモンがいません。先に `/party` で設定してください！');
        }

        if (party.length === 1) return interaction.editReply('手持ちが1匹のみなので、並び替えの必要はありません。');

        let remaining = [...party];
        let newOrder: any[] = [];

        for (let i = 0; i < party.length; i++) {
            if (remaining.length === 1) {
                newOrder.push(remaining[0]);
                break;
            }

            const options = remaining.map(p => ({ label: `${p.nickname} (Lv.${p.level})`, value: p.id }));
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('order_select')
                .setPlaceholder(`${i + 1}番目に配置するポケモンを選択`)
                .addOptions(options);

            const msg = await interaction.editReply({
                content: `🔃 **${i + 1}番目** に出すポケモンを選んでください。\n現在の設定: ${newOrder.map(p => p.nickname).join(' ➡ ') || '未設定'}`,
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
            });

            try {
                const conf = await msg.awaitMessageComponent({
                    filter: u => u.user.id === interaction.user.id,
                    time: 60000,
                    componentType: ComponentType.StringSelect
                });
                const selected = remaining.find(p => p.id === conf.values[0])!;
                newOrder.push(selected);
                remaining = remaining.filter(p => p.id !== selected.id);
                await conf.deferUpdate();
            } catch (e) {
                return interaction.editReply({ content: '⏳ タイムアウトしました。再度実行してください。', components: [] });
            }
        }

        // DB一括更新
        for (let i = 0; i < newOrder.length; i++) {
            await supabase.from('poke_caught_pokemons').update({ party_order: i + 1 }).eq('id', newOrder[i].id);
        }

        await interaction.editReply({
            content: `✅ パーティ順を更新しました！\n${newOrder.map((p, i) => `**${i + 1}.** ${p.nickname}`).join('\n')}`,
            components: []
        });
    }
};
