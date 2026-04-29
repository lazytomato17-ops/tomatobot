// src/commands/box.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../pokeDb';

const TYPE_MAP: Record<string, string> = {
    normal: '⚪', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿', ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🕊️', psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉', dark: '🕶️', steel: '⚙️', fairy: '✨'
};

export const boxCommand = {
    data: new SlashCommandBuilder()
        .setName('box')
        .setDescription('ボックスのポケモンを確認する（全員に見えます）'),

    async execute(interaction: ChatInputCommandInteraction | ButtonInteraction, page: number = 0) {
        // 🌟 ボタンから押されたか、コマンドから打たれたかで処理を分ける（ボタンエラーの修正）
        if (interaction.isButton()) {
            await interaction.deferUpdate();
        } else {
            // 🌟 ephemeralを削除（他の人にも見えるように）
            await interaction.deferReply(); 
        }

        const limit = 6;
        const offset = page * limit;

        // 🌟 次のページがあるか判定するため、limit + 1件（7件）取得する
        const { data: pokemons, error } = await supabase
            .from('poke_caught_pokemons')
            .select('*')
            .eq('owner_id', interaction.user.id)
            .order('caught_at', { ascending: false })
            .range(offset, offset + limit);

        if (error || !pokemons || pokemons.length === 0) {
            const msg = 'ボックスには 何も いないようだ……';
            return interaction.editReply({ content: msg, embeds: [], components: [] });
        }

        // 7件取れていれば「次へ」ボタンを有効にする
        const hasNext = pokemons.length > limit;
        const displayPokemons = pokemons.slice(0, limit);

        const embed = new EmbedBuilder()
            .setTitle(`📦 ${interaction.user.username} のボックス (ページ ${page + 1})`)
            .setColor(0x00BFFF);

        let descriptionText = '';
        displayPokemons.forEach((poke, index) => {
            // 🌟 タイプ表示のバグ修正（文字列になっている場合を安全に処理）
            let typeArray = poke.types;
            if (typeof typeArray === 'string') {
                try { typeArray = JSON.parse(typeArray); } catch (e) { typeArray = []; }
            }
            const typeIcons = Array.isArray(typeArray) ? typeArray.map((t: string) => TYPE_MAP[t] || t).join('') : '';
            
            const partyIcon = poke.is_party ? ' 🎈手持ち' : '';
            const totalIv = poke.iv_hp + poke.iv_attack + poke.iv_defense + poke.iv_sp_atk + poke.iv_sp_def + poke.iv_speed;

            // 🌟 個体値を常に2桁（05など）に揃えて、見栄えを完璧に整列させる
            const ivH = poke.iv_hp.toString().padStart(2, '0');
            const ivA = poke.iv_attack.toString().padStart(2, '0');
            const ivB = poke.iv_defense.toString().padStart(2, '0');
            const ivC = poke.iv_sp_atk.toString().padStart(2, '0');
            const ivD = poke.iv_sp_def.toString().padStart(2, '0');
            const ivS = poke.iv_speed.toString().padStart(2, '0');

            descriptionText += `**${offset + index + 1}. ${poke.nickname}** (Lv.${poke.level}) ${typeIcons}${partyIcon}\n`;
            descriptionText += `\`[ H${ivH} A${ivA} B${ivB} C${ivC} D${ivD} S${ivS} ]\` 計:${totalIv}\n\n`;
        });

        embed.setDescription(descriptionText);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`box_page_${page - 1}`)
                .setLabel('◀ 前へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`box_page_${page + 1}`)
                .setLabel('次へ ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!hasNext) // 次のページがなければ無効化
        );

        await interaction.editReply({ 
            content: '', 
            embeds: [embed], 
            components: [row] 
        });
    }
};
