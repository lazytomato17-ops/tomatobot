// src/battleLogic.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageComponentInteraction } from 'discord.js';
import { supabase } from './pokeDb';

/**
 * 勝負が承諾された時の「バトル開始UI」を構築する関数
 */
export async function startBattle(interaction: MessageComponentInteraction, challengerId: string, targetId: string) {
    // 少し時間がかかるので「考え中」にする
    await interaction.deferUpdate();

    try {
        // 1. 挑戦者（P1）の手持ちを取得
        const { data: p1Party } = await supabase.from('poke_caught_pokemons')
            .select('*').eq('owner_id', challengerId).eq('is_party', true).order('caught_at', { ascending: true });
            
        // 2. 相手（P2）の手持ちを取得
        const { data: p2Party } = await supabase.from('poke_caught_pokemons')
            .select('*').eq('owner_id', targetId).eq('is_party', true).order('caught_at', { ascending: true });

        if (!p1Party || !p2Party || p1Party.length === 0 || p2Party.length === 0) {
            return interaction.followUp({ content: '手持ちの取得に失敗しました。バトルを中止します。', ephemeral: true });
        }

        // お互いの先頭（1匹目）のポケモン
        const p1Lead = p1Party[0];
        const p2Lead = p2Party[0];

        // PokeAPIから画像URLを取得（表示用）
        const [p1Res, p2Res] = await Promise.all([
            fetch(`https://pokeapi.co/api/v2/pokemon/${p1Lead.pokedex_id}`),
            fetch(`https://pokeapi.co/api/v2/pokemon/${p2Lead.pokedex_id}`)
        ]);
        const p1Data = await p1Res.json();
        const p2Data = await p2Res.json();
        const p1Image = p1Data.sprites.front_default; // ドット絵を使用
        const p2Image = p2Data.sprites.front_default;

        // 3. バトル画面（Embed）の作成
        const embed = new EmbedBuilder()
            .setTitle('⚔️ ポケモンバトル 開始！ ⚔️')
            .setColor(0xFF4500)
            .setDescription(`<@${challengerId}> VS <@${targetId}>`)
            .addFields(
                { 
                    name: `🔵 ${interaction.user.username} (相手)`, 
                    value: `**${p2Lead.nickname}** Lv.${p2Lead.level}\nHP: ❤️ ${p2Lead.current_hp} (残り5匹)`, 
                    inline: false 
                },
                { 
                    name: `🔴 挑戦者`, 
                    value: `**${p1Lead.nickname}** Lv.${p1Lead.level}\nHP: ❤️ ${p1Lead.current_hp} (残り5匹)`, 
                    inline: false 
                }
            )
            // 先頭のポケモンの画像をサムネイル表示（簡易的）
            .setThumbnail(p2Image)
            .setImage(p1Image); 

        // 4. バトル操作コマンド（ボタン）の作成
        // ※「たたかう」などのボタンは、今のターンがどちらのプレイヤーか判別できるようにIDを仕込みます
        const battleId = interaction.message.id; // このメッセージのIDをバトルの固有IDとする

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`btl_attack_${battleId}_${challengerId}`)
                .setLabel('たたかう')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⚔️'),
            new ButtonBuilder()
                .setCustomId(`btl_switch_${battleId}_${challengerId}`)
                .setLabel('ポケモン')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔄'),
            new ButtonBuilder()
                .setCustomId(`btl_run_${battleId}_${challengerId}`)
                .setLabel('にげる')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('💨')
        );

        // 5. 画面を更新！
        await interaction.editReply({ content: ' ', embeds: [embed], components: [row] });

    } catch (error) {
        console.error('バトル開始エラー:', error);
        await interaction.followUp({ content: 'エラーが発生しました。', ephemeral: true });
    }
}