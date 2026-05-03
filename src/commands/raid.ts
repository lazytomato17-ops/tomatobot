// src/commands/raid.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType } from 'discord.js';
import { supabase } from '../pokeDb';
import { buildBattlePokemon } from '../battleLogic';

// 現在募集中のレイドを保存しておく場所
export const activeRaids = new Map<string, any>();

// 🌟 間を作るためのスリープ関数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 進行中のレイドバトルの状態を保存する場所
export const raidBattles = new Map<string, any>();

export const raidCommand = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('みんなで協力して強力なボスに挑むレイドバトルを開催します！'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        // ボスになるポケモンをランダムに決定（とりあえず1〜151の中から）
        const bossId = Math.floor(Math.random() * 151) + 1;
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${bossId}`);
        const data = await res.json();
        const speciesRes = await fetch(data.species.url);
        const speciesData = await speciesRes.json();
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        // ボスのレベル（参加者が2〜3人なので、少し高めに設定）
        const bossLevel = 50; 
        const bossHp = bossLevel * 30; // 通常のHPの何倍もタフにする！

        const raidId = interaction.id;
        const raidData = {
            id: raidId,
            hostId: interaction.user.id,
            boss: { name: jaName, level: bossLevel, hp: bossHp, maxHp: bossHp, imageUrl: data.sprites.other['official-artwork'].front_default },
            participants: new Set<string>([interaction.user.id]) // ホストは最初から参加
        };
        
        activeRaids.set(raidId, raidData);

        const embed = new EmbedBuilder()
            .setTitle(`🔴 巨大な ${jaName} の巣穴を発見！`)
            .setDescription(`強力なレイドボスが出現しました！みんなで協力して討伐しよう！\n\n**【参加者】**\n<@${interaction.user.id}>`)
            .setImage(raidData.boss.imageUrl)
            .setColor(0xFF00FF)
            .setFooter({ text: 'ホストが出発を押すとバトル開始！' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`raid_join_${raidId}`).setLabel('参加する！').setStyle(ButtonStyle.Primary).setEmoji('✋'),
            new ButtonBuilder().setCustomId(`raid_start_${raidId}`).setLabel('出発する').setStyle(ButtonStyle.Danger).setEmoji('⚔️')
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }
};

// 🌟 タイムアウト対策(3秒の壁)を突破したバージョン！
export async function startRaidBattle(interaction: any, raidId: string) {
    try {
        // 🌟 何よりも先に「考え中…」にしてタイムアウトを防ぐ！！
        await interaction.deferUpdate();

        const raidData = activeRaids.get(raidId);
        if (!raidData) {
            return interaction.followUp({ content: '❌ レイドのデータが見つかりません。', ephemeral: true });
        }

        // 参加者全員の「先頭のポケモン」をデータベースから取得！
        const players = [];
        for (const userId of raidData.participants) {
            const { data } = await supabase.from('poke_caught_pokemons')
                .select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true }).limit(1).single();
            
            if (data) {
                const poke = await buildBattlePokemon(data);
                players.push({ id: userId, poke: poke, actionReady: false });
            }
        }

        if (players.length === 0) {
            return interaction.followUp({ content: '❌ 参加者の先頭のポケモンが読み込めませんでした。', ephemeral: true });
        }

        // 🌟 修正：レイドらしく、人数に関わらず固定の絶望的なHPにする！
        // （例：ボスのレベル×40。Lv50ならHP2000のバケモノになります）
        const actualHp = battleState.boss.level * 40; 
        battleState.boss.hp = actualHp;
        battleState.boss.maxHp = actualHp;

        // レイドバトルの状態を保存
        const battleState = {
            id: raidId,
            boss: raidData.boss, 
            players: players,
            turn: 1,
            log: `🌟 **レイドバトル 開始！**\n巨大な **${raidData.boss.name}** が 立ちはだかる！`
        };
        
        // 🌟 準備が完全に終わってから、ロビーデータを消す（やり直し対策）
        raidBattles.set(raidId, battleState);
        activeRaids.delete(raidId); 

        // バトル画面のUI構築
        let playersStatus = '';
        for (const p of players) {
            playersStatus += `<@${p.id}>: **${p.poke.nickname}** (HP: ${p.poke.hp}/${p.poke.maxHp})\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ VS 巨大 ${battleState.boss.name} (ターン ${battleState.turn})`)
            .setDescription(battleState.log)
            .setColor(0xFF4500)
            .addFields(
                { name: '😈 ボス', value: `**${battleState.boss.name}** Lv.${battleState.boss.level}\nHP: [ **${battleState.boss.hp}** / ${battleState.boss.maxHp} ]`, inline: false },
                { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
            );

        if (battleState.boss.imageUrl) {
            embed.setImage(battleState.boss.imageUrl);
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`raid_act_${raidId}`).setLabel('技を選ぶ！').setStyle(ButtonStyle.Success).setEmoji('⚔️')
        );

        // 🌟 deferUpdate を使ったあとは、update ではなく editReply で画面を書き換える
        await interaction.editReply({ content: '', embeds: [embed], components: [row] });

    } catch (e: any) {
        console.error('レイドバトル開始エラー:', e);
        await interaction.followUp({ content: `❌ バトル開始中にエラーが起きました: ${e.message}`, ephemeral: true }).catch(()=>{});
    }
}

// 🌟 UIを更新する関数（targetMessage を渡すと、新しいメッセージを送らずに上書き編集する）
export async function updateRaidUI(interaction: any, battle: any, isFinished: boolean, targetMessage: any = null) {
    let playersStatus = '';
    for (const p of battle.players) {
        const statusIcon = p.poke.hp > 0 ? '🟢' : '💀';
        playersStatus += `${statusIcon} <@${p.id}>: **${p.poke.nickname}** (HP: ${Math.max(0, p.poke.hp)}/${p.poke.maxHp})\n`;
    }

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ VS 巨大 ${battle.boss.name} ${isFinished ? '(終了)' : `(ターン ${battle.turn})`}`)
        .setDescription(battle.log)
        .setColor(isFinished && battle.boss.hp <= 0 ? 0x00FF00 : (isFinished ? 0x36393F : 0xFF4500))
        .addFields(
            { name: '😈 ボス', value: `**${battle.boss.name}** Lv.${battle.boss.level}\nHP: [ **${Math.max(0, battle.boss.hp)}** / ${battle.boss.maxHp} ]`, inline: false },
            { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
        );

    if (battle.boss.imageUrl) embed.setImage(battle.boss.imageUrl);

    const components = [];
    // 進行中、かつ待機中じゃない（入力可能）時だけボタンを出す
    if (!isFinished) {
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`raid_act_${battle.id}`).setLabel('技を選ぶ！').setStyle(ButtonStyle.Success).setEmoji('⚔️')
            )
        );
    }
    
    if (targetMessage) {
        await targetMessage.edit({ embeds: [embed], components });
        return targetMessage;
    } else {
        return await interaction.channel.send({ embeds: [embed], components });
    }
}

// 🌟 ダメージ計算＆演出進行関数（1アクションごとに間をあける！）
export async function processRaidTurn(interaction: any, raidId: string) {
    const battle = raidBattles.get(raidId);
    if (!battle) return;

    let log = `🌟 **ターン ${battle.turn}** ────────\n\n`;
    battle.log = log;

    // 🌟 まず「ボタン無しの状態」でターン開始のメッセージを投げる
    let activeMessage = await updateRaidUI(interaction, battle, true);
    await sleep(1000); // 1秒待機

    // ① 味方の攻撃フェーズ（1人ずつ演出）
    for (const p of battle.players) {
        if (p.poke.hp <= 0 || !p.selectedMove) continue;

        p.selectedMove.pp--; 
        log += `▶ **${p.poke.nickname}** の **${p.selectedMove.name}**！\n`;

        const power = p.selectedMove.power || 0;
        if (power > 0) {
            const baseDamage = Math.floor(power * (p.poke.level / 50) * 1.5) + 5; 
            const finalDamage = Math.floor(baseDamage * (0.85 + Math.random() * 0.3));
            battle.boss.hp -= finalDamage;
            log += `💥 巨大なボスに **${finalDamage}** のダメージ！\n\n`;
        } else if (p.selectedMove.healing) {
            const heal = Math.floor(p.poke.maxHp * (p.selectedMove.healing / 100));
            p.poke.hp = Math.min(p.poke.maxHp, p.poke.hp + heal);
            log += `✨ **${p.poke.nickname}** の体力が回復した！\n\n`;
        } else {
            log += `💨 しかし ボスには 効かなかったようだ！\n\n`; 
        }
        
        p.actionReady = false; 
        p.selectedMove = null;

        // 🌟 画面を更新して 1.5秒 待つ！
        battle.log = log;
        await updateRaidUI(interaction, battle, true, activeMessage);
        await sleep(1500);

        if (battle.boss.hp <= 0) break;
    }

    // ② ボスの攻撃フェーズ（生きていれば）
    if (battle.boss.hp > 0) {
        log += `😈 **巨大 ${battle.boss.name} の じしん！**\n`;
        const alivePlayers = battle.players.filter((p: any) => p.poke.hp > 0);
        if (alivePlayers.length > 0) {
            const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            const bossDamage = Math.floor(battle.boss.level * 1.5 * (0.85 + Math.random() * 0.3));
            target.poke.hp -= bossDamage;
            log += `💥 **${target.poke.nickname}** に **${bossDamage}** の大ダメージ！\n`;
            if (target.poke.hp <= 0) log += `💀 **${target.poke.nickname}** は 吹き飛ばされてしまった！\n`;
        }

        // 🌟 画面を更新して 1.5秒 待つ！
        battle.log = log;
        await updateRaidUI(interaction, battle, true, activeMessage);
        await sleep(1500);
    }

    battle.turn++;

    // ③ 勝敗判定
    const allDead = battle.players.every((p: any) => p.poke.hp <= 0);
    
    if (battle.boss.hp <= 0) {
        battle.log += `\n🎉 **巨大な ${battle.boss.name} を 討伐した！！**\n`;
        battle.log += `💰 参加者全員に **報酬（10000円）** と 大量の経験値が送られました！`;
        
        for(const p of battle.players) {
             const { data: u } = await supabase.from('poke_users').select('money').eq('discord_id', p.id).single();
             await supabase.from('poke_users').update({ money: (u?.money || 0) + 10000 }).eq('discord_id', p.id);
             await supabase.from('poke_caught_pokemons').update({ exp: p.poke.exp + (battle.boss.level * 50) }).eq('id', p.poke.dbId);
        }
        raidBattles.delete(raidId);
        // 終了表示で更新
        await updateRaidUI(interaction, battle, true, activeMessage);

    } else if (allDead) {
        battle.log += `\n💀 仲間が 全滅してしまった……！\n💨 巣穴から 弾き飛ばされた！`;
        raidBattles.delete(raidId);
        // 終了表示で更新
        await updateRaidUI(interaction, battle, true, activeMessage);
    } else {
        // 🌟 まだ続く場合は、falseを渡して「技を選ぶ！」ボタンを復活させる！
        await updateRaidUI(interaction, battle, false, activeMessage);
    }
}

// 🌟 プレイヤーがボタンを押した時の受付窓口
export async function handleRaidAction(interaction: any, raidId: string, action: string, args: string[]) {
    const battle = raidBattles.get(raidId);
    if (!battle) return interaction.reply({ content: '❌ レイドが見つかりません。', ephemeral: true });

    const player = battle.players.find((p: any) => p.id === interaction.user.id);
    if (!player) return interaction.reply({ content: '❌ あなたはこのレイドの参加者ではありません！', ephemeral: true });

    if (player.poke.hp <= 0) {
        return interaction.reply({ content: '💀 あなたのポケモンはひんし状態です。仲間を応援しましょう！', ephemeral: true });
    }

    // 「技を選ぶ！」ボタンを押した時（自分だけに見える技リストを出す）
    if (action === 'act') {
        const moveButtons = player.poke.moves.map((m: any, i: number) => {
            return new ButtonBuilder()
                .setCustomId(`raid_usemove_${raidId}_${i}`)
                .setLabel(`${m.name} (PP:${m.pp})`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(m.pp <= 0);
        });
        const rows = [];
        for (let i = 0; i < moveButtons.length; i += 4) {
            rows.push(new ActionRowBuilder().addComponents(moveButtons.slice(i, i + 4)));
        }
        return interaction.reply({ content: '技を選択してください！', components: rows, ephemeral: true });
    }

    // 「たいあたり」等の技ボタンを押した時
    if (action === 'usemove') {
        if (player.actionReady) {
            return interaction.reply({ content: '✅ すでに技を選択済みです。他のプレイヤーを待っています...', ephemeral: true });
        }

        const moveIdx = parseInt(args[0]);
        player.selectedMove = player.poke.moves[moveIdx];
        player.actionReady = true;

        // ボタンの画面を「待機中」に書き換える
        await interaction.update({ content: `✅ **${player.selectedMove.name}** を準備しました！他のプレイヤーを待っています...`, components: [] });

        // 🌟 生きている全員が技を選び終わったかチェック！
        const allReady = battle.players.every((p: any) => p.poke.hp <= 0 || p.actionReady);
        if (allReady) {
            // 全員準備OKなら、ターン処理をドカンと実行！
            await processRaidTurn(interaction, raidId);
        }
    }
}