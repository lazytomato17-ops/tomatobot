// src/commands/raid.ts
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../pokeDb';
// 🌟 技の効果や状態異常の処理を battleLogic から呼び出す！
import { buildBattlePokemon, executeMoveEffects, checkStatusBeforeMove, getTypeMultiplier } from '../battleLogic';

const POKE_TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
const TYPE_JP: Record<string, string> = { normal: 'ノーマル', fire: 'ほのお', water: 'みず', electric: 'でんき', grass: 'くさ', ice: 'こおり', fighting: 'かくとう', poison: 'どく', ground: 'じめん', flying: 'ひこう', psychic: 'エスパー', bug: 'むし', rock: 'いわ', ghost: 'ゴースト', dragon: 'ドラゴン', dark: 'あく', steel: 'はがね', fairy: 'フェアリー' };

export const activeRaids = new Map<string, any>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const raidBattles = new Map<string, any>();

function generateHpBar(current: number, max: number): string {
    const percent = Math.max(0, current) / max;
    const filled = Math.round(percent * 10);
    const empty = 10 - filled;
    return (percent <= 0.2 ? '🟥' : percent <= 0.5 ? '🟨' : '🟩').repeat(Math.max(0, filled)) + '⬛'.repeat(Math.max(0, empty));
}

export const raidCommand = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('みんなで協力して強力なボスに挑むレイドバトルを開催します！'),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const bossId = Math.floor(Math.random() * 151) + 1;
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${bossId}`);
        const data = await res.json();
        const speciesRes = await fetch(data.species.url);
        const speciesData = await speciesRes.json();
        const jaName = speciesData.names.find((n: any) => n.language.name === 'ja')?.name || data.name.toUpperCase();

        const bossLevel = 50; 
        const raidId = interaction.id;
        
        const raidData = {
            id: raidId,
            hostId: interaction.user.id,
            // 🌟 pokedexId を保存しておく（後でボスを正確に生成するため）
            boss: { pokedexId: bossId, name: jaName, level: bossLevel, imageUrl: data.sprites.other['official-artwork'].front_default },
            participants: new Set<string>([interaction.user.id])
        };
        
        activeRaids.set(raidId, raidData);

        const embed = new EmbedBuilder()
            .setTitle(`🔴 巨大な ${jaName} の巣穴を発見！`)
            .setDescription(`強力なテラレイドボスが出現しました！みんなで協力して討伐しよう！\n\n**【参加者】**\n<@${interaction.user.id}>`)
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

export async function startRaidBattle(interaction: any, raidId: string) {
    try {
        await interaction.deferUpdate();

        const raidData = activeRaids.get(raidId);
        if (!raidData) return interaction.followUp({ content: '❌ レイドのデータが見つかりません。', ephemeral: true });

        const players = [];
        for (const userId of raidData.participants) {
            const { data } = await supabase.from('poke_caught_pokemons')
                .select('*').eq('owner_id', userId).eq('is_party', true).order('party_order', { ascending: true }).limit(1).single();
            if (data) {
                const poke = await buildBattlePokemon(data);
                players.push({ id: userId, poke: poke, actionReady: false, selectedMove: null, selectedCheer: null });
            }
        }
        if (players.length === 0) return interaction.followUp({ content: '❌ 参加者の先頭のポケモンが読み込めませんでした。', ephemeral: true });

        const teraType = POKE_TYPES[Math.floor(Math.random() * POKE_TYPES.length)];

        // 🌟 ボスを本編と同じ「完全なポケモン」として生成する！
        const mockDb = {
            id: `raid_boss`, pokedex_id: raidData.boss.pokedexId, nickname: raidData.boss.name, level: raidData.boss.level,
            nature: 'いじっぱり', iv_hp: 31, iv_attack: 31, iv_defense: 31, iv_sp_atk: 31, iv_sp_def: 31, iv_speed: 31,
            ev_hp: 252, ev_attack: 252, ev_defense: 252, ev_sp_atk: 252, ev_sp_def: 252, ev_speed: 252,
            types: '[]', moves: '[]', exp: 999999, current_hp: 9999 // 空配列を渡すと自動で技を学習してくれる
        };
        const bossPoke = await buildBattlePokemon(mockDb, raidData.boss.level);
        
        // テラスタイプで防御相性を上書きし、HPをレイド級（15倍）に引き上げる
        bossPoke.types = [teraType]; 
        bossPoke.maxHp *= 15;
        bossPoke.hp = bossPoke.maxHp;

        const battleState = {
            id: raidId,
            boss: bossPoke,
            teraType: teraType,
            players: players,
            turn: 1,
            isProcessing: false,
            mainMessage: null as any,
            log: `🌟 **テラレイドバトル 開始！**\n巨大な **${bossPoke.nickname}** が 立ちはだかる！\n💎 **テラスタイプ：${TYPE_JP[teraType]}**\n\n技か「おうえん」を選んでください！`
        };

        raidBattles.set(raidId, battleState);
        activeRaids.delete(raidId);

        let playersStatus = '';
        for (const p of players) {
            playersStatus += `<@${p.id}>: **${p.poke.nickname}**\n${generateHpBar(p.poke.hp, p.poke.maxHp)} [${p.poke.hp}/${p.poke.maxHp}]\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ VS 巨大 ${battleState.boss.nickname} (ターン ${battleState.turn})`)
            .setDescription(battleState.log)
            .setColor(0xFF4500)
            .addFields(
                { name: `😈 テラレイドボス (💎${TYPE_JP[teraType]})`, value: `**${battleState.boss.nickname}** Lv.${battleState.boss.level}\n${generateHpBar(battleState.boss.hp, battleState.boss.maxHp)} [ **${battleState.boss.hp}** / ${battleState.boss.maxHp} ]`, inline: false },
                { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
            )
            .setImage(bossPoke.imageUrl);

        // 🌟 「おうえん」ボタンを追加！
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`raid_act_${raidId}`).setLabel('たたかう').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`raid_cheer_${raidId}`).setLabel('おうえん').setStyle(ButtonStyle.Primary).setEmoji('📣')
        );

        const msg = await interaction.editReply({ content: '', embeds: [embed], components: [row] });
        battleState.mainMessage = msg;

    } catch (e: any) {
        console.error('レイドバトル開始エラー:', e);
        await interaction.followUp({ content: `❌ バトル開始中にエラーが起きました: ${e.message}`, ephemeral: true }).catch(()=>{});
    }
}

export async function updateRaidUI(battle: any, isFinished: boolean) {
    let playersStatus = '';
    for (const p of battle.players) {
        const statusIcon = p.poke.hp > 0 ? '🟢' : '💀';
        playersStatus += `${statusIcon} <@${p.id}>: **${p.poke.nickname}**\n${generateHpBar(p.poke.hp, p.poke.maxHp)} [${Math.max(0, p.poke.hp)}/${p.poke.maxHp}]\n`;
    }

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ VS 巨大 ${battle.boss.nickname} ${isFinished ? '(終了)' : `(ターン ${battle.turn})`}`)
        .setDescription(battle.log)
        .setColor(isFinished && battle.boss.hp <= 0 ? 0x00FF00 : (isFinished ? 0x36393F : 0xFF4500))
        .addFields(
            { name: `😈 テラレイドボス (💎${TYPE_JP[battle.teraType]})`, value: `**${battle.boss.nickname}** Lv.${battle.boss.level}\n${generateHpBar(battle.boss.hp, battle.boss.maxHp)} [ **${Math.max(0, battle.boss.hp)}** / ${battle.boss.maxHp} ]`, inline: false },
            { name: '🛡️ 味方チーム', value: playersStatus, inline: false }
        )
        .setImage(battle.boss.imageUrl);

    const components = [];
    if (!isFinished) {
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`raid_act_${battle.id}`).setLabel('たたかう').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
                new ButtonBuilder().setCustomId(`raid_cheer_${battle.id}`).setLabel('おうえん').setStyle(ButtonStyle.Primary).setEmoji('📣')
            )
        );
    }
    
    await battle.mainMessage.edit({ embeds: [embed], components });
}

export async function processRaidTurn(raidId: string) {
    const battle = raidBattles.get(raidId);
    if (!battle) return;

    let log = `🌟 **ターン ${battle.turn}** ────────\n\n`;
    battle.log = log;
    await updateRaidUI(battle, true); 
    await sleep(1000);

    // ① おうえんフェーズ（最優先で発動）
    for (const p of battle.players) {
        if (!p.selectedCheer) continue;
        
        if (p.selectedCheer === 'atk') {
            log += `📣 <@${p.id}> の **いけいけドンドン！**\n味方全員の 攻撃と 特攻が 上がった！\n\n`;
            for (const ally of battle.players) {
                ally.poke.statStages.atk = Math.min(6, ally.poke.statStages.atk + 1);
                ally.poke.statStages.spa = Math.min(6, ally.poke.statStages.spa + 1);
            }
        } else if (p.selectedCheer === 'def') {
            log += `📣 <@${p.id}> の **がっちりぼうぎょ！**\n味方全員の 防御と 特防が 上がった！\n\n`;
            for (const ally of battle.players) {
                ally.poke.statStages.def = Math.min(6, ally.poke.statStages.def + 1);
                ally.poke.statStages.spd = Math.min(6, ally.poke.statStages.spd + 1);
            }
        } else if (p.selectedCheer === 'heal') {
            log += `📣 <@${p.id}> の **いやしのエール！**\n味方全員の 体力が 回復した！\n\n`;
            for (const ally of battle.players) {
                if (ally.poke.hp <= 0) continue;
                const healAmt = Math.floor(ally.poke.maxHp * (0.2 + Math.random() * 0.4)); // 20~60%回復
                ally.poke.hp = Math.min(ally.poke.maxHp, ally.poke.hp + healAmt);
                ally.poke.status = null; // 状態異常も治す
            }
        }
        p.selectedCheer = null;
        p.actionReady = false;
        battle.log = log;
        await updateRaidUI(battle, true);
        await sleep(1000);
    }

    // ② 味方の攻撃フェーズ（変化技・状態異常・バフデバフ完全対応）
    for (const p of battle.players) {
        if (p.poke.hp <= 0 || !p.selectedMove) { p.actionReady = false; continue; }

        const statusCheck = checkStatusBeforeMove(p.poke);
        if (!statusCheck.canMove) {
            log += statusCheck.log;
            if (statusCheck.selfDamage > 0) {
                p.poke.hp = Math.max(0, p.poke.hp - statusCheck.selfDamage);
                log += `💥 **${statusCheck.selfDamage}** ダメージ！\n`;
            }
        } else {
            log += `▶ **${p.poke.nickname}** の **${p.selectedMove.name}**！\n`;
            log += await executeMoveEffects(p.poke, battle.boss, p.selectedMove);
        }
        
        p.selectedMove.pp--;
        p.selectedMove = null;
        p.actionReady = false;

        battle.log = log;
        await updateRaidUI(battle, true);
        await sleep(1500);
        if (battle.boss.hp <= 0) break;
    }

    // ③ ボスの反撃フェーズ
    if (battle.boss.hp > 0) {
        log += `\n😈 **巨大 ${battle.boss.nickname} の 行動！**\n`;
        const statusCheck = checkStatusBeforeMove(battle.boss);
        
        if (!statusCheck.canMove) {
            log += statusCheck.log;
        } else {
            const alivePlayers = battle.players.filter((p: any) => p.poke.hp > 0);
            if (alivePlayers.length > 0) {
                const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                
                // ボスの技選択（変化技も使ってくる！）
                const usableMoves = battle.boss.moves.filter((m: any) => m.power > 0 || m.statChanges || m.ailment);
                const bossMove = usableMoves.length > 0 ? usableMoves[Math.floor(Math.random() * usableMoves.length)] : battle.boss.moves[0];

                log += `▶ **${battle.boss.nickname}** の **${bossMove.name}**！\n`;
                log += await executeMoveEffects(battle.boss, target.poke, bossMove);
            }
        }
        battle.log = log;
        await updateRaidUI(battle, true); 
        await sleep(1500);

        // 🌟 テラレイド特有の理不尽行動！（一定確率でバフ・デバフ消し）
        if (battle.boss.hp > 0) {
            if (Math.random() < 0.15) {
                log += `\n🌪️ ボスは 周りを 吹き飛ばし、味方の ステータス変化を かき消した！\n`;
                for (const p of battle.players) { p.poke.statStages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }; }
                battle.log = log; await updateRaidUI(battle, true); await sleep(1500);
            } else if (Math.random() < 0.10) {
                log += `\n✨ ボスは 自身の ステータスダウンを 解除した！\n`;
                for (const key in battle.boss.statStages) { if (battle.boss.statStages[key] < 0) battle.boss.statStages[key] = 0; }
                battle.log = log; await updateRaidUI(battle, true); await sleep(1500);
            }
        }
    }

    battle.turn++;

    // ④ 勝敗判定
    const allDead = battle.players.every((p: any) => p.poke.hp <= 0);
    if (battle.boss.hp <= 0 || allDead) {
        if (battle.boss.hp <= 0) {
            battle.log += `\n🎉 **討伐成功！**\n（※報酬配布処理などをここに実装可能です）`;
        } else {
            battle.log += `\n💀 巣穴から 吹き飛ばされてしまった……\n（全滅しました）`;
        }
        raidBattles.delete(raidId);
        await updateRaidUI(battle, true);
    } else {
        battle.log += `\n🔄 技か「おうえん」を選んでください！`;
        await updateRaidUI(battle, false);
    }
}

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
        for (let i = 0; i < moveButtons.length; i += 4) { rows.push(new ActionRowBuilder().addComponents(moveButtons.slice(i, i + 4))); }
        return interaction.reply({ content: '技を選択してください！', components: rows, ephemeral: true });
    }

    if (action === 'cheer') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`raid_usecheer_${raidId}_atk`).setLabel('いけいけドンドン(攻↑)').setStyle(ButtonStyle.Danger).setEmoji('⚔️'),
            new ButtonBuilder().setCustomId(`raid_usecheer_${raidId}_def`).setLabel('がっちりぼうぎょ(防↑)').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
            new ButtonBuilder().setCustomId(`raid_usecheer_${raidId}_heal`).setLabel('いやしのエール(回復)').setStyle(ButtonStyle.Success).setEmoji('✨')
        );
        return interaction.reply({ content: 'どのおうえんをする？', components: [row], ephemeral: true });
    }

    if (action === 'usemove' || action === 'usecheer') {
        if (player.actionReady || battle.isProcessing) return interaction.reply({ content: '✅ すでに準備済み、または処理中です。', ephemeral: true });

        if (action === 'usemove') {
            player.selectedMove = player.poke.moves[parseInt(args[0])];
            await interaction.update({ content: `✅ **${player.selectedMove.name}** を準備しました！`, components: [] });
        } else {
            player.selectedCheer = args[0];
            const cheerName = args[0] === 'atk' ? 'いけいけドンドン' : args[0] === 'def' ? 'がっちりぼうぎょ' : 'いやしのエール';
            await interaction.update({ content: `📣 **${cheerName}** を準備しました！`, components: [] });
        }
        
        player.actionReady = true;

        const allReady = battle.players.every((p: any) => p.poke.hp <= 0 || p.actionReady);
        if (allReady && !battle.isProcessing) {
            battle.isProcessing = true;
            await processRaidTurn(raidId);
            if (raidBattles.has(raidId)) {
                battle.isProcessing = false;
            }
        }
    }
}
