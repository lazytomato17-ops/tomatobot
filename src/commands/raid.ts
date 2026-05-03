// src/commands/raid.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, ComponentType } from 'discord.js';
import { supabase } from '../pokeDb';
import { buildBattlePokemon, getTypeMultiplier } from '../battleLogic'; // 👈 getTypeMultiplier を追加！

// 🌟 テラスタイプ用のリストを追加
const POKE_TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
const TYPE_JP: Record<string, string> = { normal: 'ノーマル', fire: 'ほのお', water: 'みず', electric: 'でんき', grass: 'くさ', ice: 'こおり', fighting: 'かくとう', poison: 'どく', ground: 'じめん', flying: 'ひこう', psychic: 'エスパー', bug: 'むし', rock: 'いわ', ghost: 'ゴースト', dragon: 'ドラゴン', dark: 'あく', steel: 'はがね', fairy: 'フェアリー' };

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
        await interaction.deferUpdate();

        const raidData = activeRaids.get(raidId);
        if (!raidData) {
            return interaction.followUp({ content: '❌ レイドのデータが見つかりません。', ephemeral: true });
        }

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

        const teraType = POKE_TYPES[Math.floor(Math.random() * POKE_TYPES.length)];

        const battleState = {
            id: raidId,
            boss: { ...raidData.boss, teraType: teraType },
            players: players,
            turn: 1,
            isProcessing: false, // 🌟 同時押しバグ防止用のロック
            mainMessage: null as any, // 🌟 メインメッセージを保存する箱
            log: `🌟 **レイドバトル 開始！**\n巨大な **${raidData.boss.name}** が 立ちはだかる！\n💎 **テラスタイプ：${TYPE_JP[teraType]}**`
        };
        
        const actualHp = battleState.boss.level * 40; 
        battleState.boss.hp = actualHp;
        battleState.boss.maxHp = actualHp;

        raidBattles.set(raidId, battleState);
        activeRaids.delete(raidId);

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

        // 🌟 ここが超重要！返ってきたメッセージオブジェクトを保存して、以降はこれを直接書き換える
        const msg = await interaction.editReply({ content: '', embeds: [embed], components: [row] });
        battleState.mainMessage = msg;

    } catch (e: any) {
        console.error('レイドバトル開始エラー:', e);
        await interaction.followUp({ content: `❌ バトル開始中にエラーが起きました: ${e.message}`, ephemeral: true }).catch(()=>{});
    }
}

// 🌟 interactionを引数から削除し、保存したmainMessageを直接編集する
export async function updateRaidUI(battle: any, isFinished: boolean) {
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
            { name: '😈 ボス', value: `**${battle.boss.name}** Lv.${battle.boss.level}\n💎 テラスタイプ: **${TYPE_JP[battle.boss.teraType]}**\nHP: [ **${Math.max(0, battle.boss.hp)}** / ${battle.boss.maxHp} ]`, inline: false },
            { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
        );

    if (battle.boss.imageUrl) embed.setImage(battle.boss.imageUrl);

    const components = [];
    if (!isFinished) {
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`raid_act_${battle.id}`).setLabel('技を選ぶ！').setStyle(ButtonStyle.Success).setEmoji('⚔️')
            )
        );
    }
    
    // 🌟 エフェメラルメッセージとの混線を防ぐため、メインのメッセージを直接指定してeditする
    await battle.mainMessage.edit({ embeds: [embed], components });
}

// 🌟 演出進行関数
export async function processRaidTurn(raidId: string) {
    const battle = raidBattles.get(raidId);
    if (!battle) return;

    let log = `🌟 **ターン ${battle.turn}** ────────\n\n`;
    battle.log = log;

    await updateRaidUI(battle, true); 
    await sleep(1000);

    for (const p of battle.players) {
        if (p.poke.hp <= 0 || !p.selectedMove) continue;

        p.selectedMove.pp--; 
        log += `▶ **${p.poke.nickname}** の **${p.selectedMove.name}**！\n`;

        const mult = getTypeMultiplier(p.selectedMove.type, [battle.boss.teraType]);
        if (mult === 0) {
            log += `❌ 効果がないみたいだ…\n\n`;
        } else {
            const baseDamage = Math.floor((p.selectedMove.power || 0) * (p.poke.level / 50) * 1.5) + 5; 
            const finalDamage = Math.floor(baseDamage * mult * (0.85 + Math.random() * 0.3));
            battle.boss.hp -= finalDamage;
            if (mult > 1.5) log += `🌟 **ばつぐん！** `;
            log += `💥 **${finalDamage}** ダメージ！\n\n`;
        }
        
        p.actionReady = false; 
        p.selectedMove = null;

        battle.log = log;
        await updateRaidUI(battle, true);
        await sleep(1500);
        if (battle.boss.hp <= 0) break;
    }

    if (battle.boss.hp > 0) {
        log += `😈 **巨大 ${battle.boss.name} の 反撃！**\n`;
        const alivePlayers = battle.players.filter((p: any) => p.poke.hp > 0);
        if (alivePlayers.length > 0) {
            const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            const bossDamage = Math.floor(battle.boss.level * 1.5 * (0.85 + Math.random() * 0.3));
            target.poke.hp -= bossDamage;
            log += `💥 **${target.poke.nickname}** に **${bossDamage}** の大ダメージ！\n`;
        }
        battle.log = log;
        await updateRaidUI(battle, true); 
        await sleep(1500);
    }

    battle.turn++;

    const allDead = battle.players.every((p: any) => p.poke.hp <= 0);
    if (battle.boss.hp <= 0 || allDead) {
        if (battle.boss.hp <= 0) {
            battle.log += `\n🎉 **討伐成功！** 報酬 10000円 を獲得！`;
            // （ここに報酬を付与する処理を追加可能）
        } else {
            battle.log += `\n💀 全滅した……`;
        }
        raidBattles.delete(raidId);
        await updateRaidUI(battle, true);
    } else {
        await updateRaidUI(battle, false);
    }
}

// 🌟 プレイヤーアクション処理
export async function handleRaidAction(interaction: any, raidId: string, action: string, args: string[]) {
    const battle = raidBattles.get(raidId);
    if (!battle) return interaction.reply({ content: '❌ レイドが見つかりません。', ephemeral: true });

    const player = battle.players.find((p: any) => p.id === interaction.user.id);
    if (!player) return interaction.reply({ content: '❌ あなたはこのレイドの参加者ではありません！', ephemeral: true });

    if (player.poke.hp <= 0) {
        return interaction.reply({ content: '💀 あなたのポケモンはひんし状態です。仲間を応援しましょう！', ephemeral: true });
    }

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

    if (action === 'usemove') {
        if (player.actionReady || battle.isProcessing) {
            return interaction.reply({ content: '✅ すでに技を選択済み、または処理中です。', ephemeral: true });
        }

        const moveIdx = parseInt(args[0]);
        player.selectedMove = player.poke.moves[moveIdx];
        player.actionReady = true;

        await interaction.update({ content: `✅ **${player.selectedMove.name}** を準備しました！他のプレイヤーを待っています...`, components: [] });

        const allReady = battle.players.every((p: any) => p.poke.hp <= 0 || p.actionReady);
        // 🌟 isProcessingフラグで、複数人が同時に押した際の重複実行をガード！
        if (allReady && !battle.isProcessing) {
            battle.isProcessing = true;
            await processRaidTurn(raidId);
            if (raidBattles.has(raidId)) {
                battle.isProcessing = false;
            }
        }
    }
}
