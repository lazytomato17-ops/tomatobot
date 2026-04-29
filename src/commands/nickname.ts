// src/commands/nickname.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType
} from 'discord.js';
import { supabase } from '../pokeDb';

export const nicknameCommand = {
    data: new SlashCommandBuilder()
        .setName('nickname')
        .setDescription('手持ち・ボックスのポケモンのニックネームを変更する'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        // 自分の全ポケモンを取得（手持ち優先で表示）
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('id, nickname, level, is_party')
            .eq('owner_id', interaction.user.id)
            .order('is_party', { ascending: false }) // 手持ちを先に
            .order('caught_at', { ascending: false });

        if (error || !pokemons || pokemons.length === 0) {
            return interaction.editReply('ポケモンがいません。まずは `/wild` で捕まえましょう！');
        }

        // セレクトメニューの選択肢を作成（最大25匹）
        const options = pokemons.slice(0, 25).map(poke => ({
            label: `${poke.nickname} (Lv.${poke.level})`,
            description: poke.is_party ? '手持ち' : 'ボックス',
            value: poke.id,
            emoji: poke.is_party ? '🎒' : '📦'
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('nickname_rename_select')
            .setPlaceholder('ニックネームを変えるポケモンを選んでください')
            .addOptions(options);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const response = await interaction.editReply({
            content: '👇 ニックネームを変更したいポケモンを選んでください',
            components: [row]
        });

        // ユーザーの選択を待機（60秒でタイムアウト）
        try {
            const selection = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 60_000,
                componentType: ComponentType.StringSelect
            });

            const dbId = selection.values[0];
            const selectedPoke = pokemons.find(p => p.id === dbId);

            // セレクトメニューを無効化
            selectMenu.setDisabled(true);
            await interaction.editReply({
                content: `**${selectedPoke?.nickname}** のニックネームを変更します...`,
                components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)]
            });

            // モーダル（入力ダイアログ）を表示
            const modal = new ModalBuilder()
                .setCustomId(`modal_nick_${dbId}`)
                .setTitle('ニックネームを変更する');

            const nickInput = new TextInputBuilder()
                .setCustomId('nickname_input')
                .setLabel(`新しいニックネーム（最大12文字）`)
                .setStyle(TextInputStyle.Short)
                .setMaxLength(12)
                .setPlaceholder(selectedPoke?.nickname ?? 'ニックネームを入力...')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<any>().addComponents(nickInput));
            await selection.showModal(modal);

        } catch (e) {
            await interaction.editReply({ content: '⏳ タイムアウトしました。もう一度 `/nickname` を実行してください。', components: [] });
        }
    }
};
