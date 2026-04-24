// src/lethalLogic.ts
import { CommandInteraction, EmbedBuilder } from 'discord.js';
import Groq from 'groq-sdk';

// ── 環境設定 ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";

// ── 状態管理インターフェース ──
interface PlayerState {
    name: string;
    isAlive: boolean;
    inventory: number; // 現在持っているスクラップ
    items: { flashlight: boolean; shovel: boolean };
}

interface Corpse {
    userId: string;
    name: string;
    value: number; // 死体回収時のボーナス額
}

interface GameState {
    day: number;
    quota: number;
    funds: number; // 船の共有資金
    corpses: Corpse[];
    players: Map<string, PlayerState>;
}

// チャンネルIDごとにゲームを管理
const activeGames = new Map<string, GameState>();

// ── AI描写ジェネレーター ──
async function generateDescription(eventType: string, context: string = "") {
    const prompt = `
    Role: You are the cold, corporate AI of a space scavenging company.
    Event: ${eventType}. ${context}
    Instruction: Write a short, bleak, and professional atmospheric description in Japanese (1-2 sentences). 
    Focus on industrial horror and corporate coldness. Do not use friendly language.
    `;
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama3-8b-8192',
        });
        return chatCompletion.choices[0]?.message?.content || "通信エラー。状況を確認できません。";
    } catch (e) {
        return "システムエラー。視界がぼやけている…。";
    }
}

function getGame(channelId: string): GameState {
    if (!activeGames.has(channelId)) {
        activeGames.set(channelId, { day: 1, quota: 500, funds: 0, corpses: [], players: new Map() });
    }
    return activeGames.get(channelId)!;
}

function getPlayer(game: GameState, user: any): PlayerState {
    if (!game.players.has(user.id)) {
        game.players.set(user.id, { name: user.username, isAlive: true, inventory: 0, items: { flashlight: false, shovel: false } });
    }
    return game.players.get(user.id)!;
}

// ============================================================
// 1. 探索コマンド (/explore)
// ============================================================
export async function handleExplore(interaction: CommandInteraction) {
    await interaction.deferReply();
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply('❌ **[警告]** 死亡した従業員は探索に参加できません。');

    // アイテムによる確率変動
    let successChance = player.items.shovel ? 80 : 50; // プロのシャベルで成功率UP
    let deathChance = player.items.flashlight ? 5 : 20; // フラッシュライトで死亡率DOWN

    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (roll <= successChance) {
        // 成功
        const val = Math.floor(Math.random() * 100) + 20;
        player.inventory += val;
        const desc = await generateDescription('Scrap Found', `価値${val}円のスクラップを発見。`);
        embed.setTitle('🟢 資産回収').setDescription(desc).setColor(0x2ecc71)
             .addFields({ name: '所持スクラップ', value: `${player.inventory}円`, inline: true });
    } else if (roll > (100 - deathChance)) {
        // 死亡
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: Math.floor(Math.random() * 50) + 50 });
        const desc = await generateDescription('Employee Death', '未知の生物による致命傷。');
        embed.setTitle('🔴 従業員ロスト').setDescription(desc).setColor(0xe74c3c)
             .setFooter({ text: "回収物は全て失われました。死体を回収すれば僅かな保険金が下ります。" });
        player.inventory = 0;
    } else {
        // 何もなし
        const desc = await generateDescription('Empty Room', '不気味な物音のみ。');
        embed.setTitle('🟡 異常なし').setDescription(desc).setColor(0xf1c40f);
    }
    await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// 2. 帰還＆納品コマンド (/return) - 日数を進める
// ============================================================
export async function handleReturn(interaction: CommandInteraction) {
    const game = getGame(interaction.channelId);
    
    // 生きている全プレイヤーの所持品を共有資金へ
    let totalDeposited = 0;
    game.players.forEach(p => {
        if (p.isAlive) { totalDeposited += p.inventory; p.inventory = 0; }
    });
    game.funds += totalDeposited;
    
    // 日数経過処理
    game.day += 1;
    let embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (game.day > 3) {
        // ノルマ判定
        if (game.funds >= game.quota) {
            embed.setTitle('✅ ノルマ達成').setDescription(`要求額 ${game.quota}円 に対して ${game.funds}円 を納品しました。\n素晴らしい働きです。次のノルマを設定します。`).setColor(0x00FF00);
            game.day = 1;
            game.quota += 500; // 次のノルマ上昇
            game.funds = 0;
            game.corpses = [];
            game.players.forEach(p => { p.isAlive = true; p.items = { flashlight: false, shovel: false }; }); // 全員復活・アイテム没収
        } else {
            embed.setTitle('🚀 船外放出（強制解雇）').setDescription(`ノルマ ${game.quota}円 未達（現在: ${game.funds}円）。\nあなた達は会社にとって不要な存在です。宇宙空間へ放出します。`).setColor(0x000000);
            activeGames.delete(interaction.channelId); // ゲーム完全リセット
        }
    } else {
        embed.setTitle('🌙 軌道上へ帰還').setDescription(`本日分の納品が完了しました。\n現在の共有資金: **${game.funds}円** / ノルマ: **${game.quota}円**\n残り日数: **${4 - game.day}日**`).setColor(0x3498db);
    }
    await interaction.reply({ embeds: [embed] });
}

// ============================================================
// 3. 死体回収コマンド (/retrieve)
// ============================================================
export async function handleRetrieve(interaction: CommandInteraction) {
    await interaction.deferReply();
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);

    if (!player.isAlive) return interaction.editReply('❌ 幽霊が死体を運ぶことはできません。');
    if (game.corpses.length === 0) return interaction.editReply('⚠️ 現在、回収可能な死体はありません。');

    // 二次災害リスク (30%で自分も死ぬ)
    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (roll <= 30) {
        player.isAlive = false;
        game.corpses.push({ userId: interaction.user.id, name: player.name, value: 50 });
        const desc = await generateDescription('Secondary Disaster', '死体を回収しようとして、同じ罠にかかった。');
        embed.setTitle('🔴 二次災害発生').setDescription(desc).setColor(0x8B0000)
             .setFooter({ text: "ミイラ取りがミイラになりました。" });
    } else {
        const corpse = game.corpses.shift()!; // 一番古い死体を回収
        game.funds += corpse.value;
        const desc = await generateDescription('Corpse Retrieved', `${corpse.name}の遺体を回収。`);
        embed.setTitle('📦 遺体回収成功').setDescription(`${desc}\n保険金 **${corpse.value}円** が共有資金に追加されました。`).setColor(0x8A2BE2);
    }
    await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// 4. ストアコマンド (/store)
// ============================================================
export async function handleStore(interaction: CommandInteraction) {
    const game = getGame(interaction.channelId);
    const player = getPlayer(game, interaction.user);
    const item = interaction.options.get('item')?.value as string;

    const STORE_ITEMS: Record<string, { price: number, name: string }> = {
        'flashlight': { price: 100, name: '🔦 フラッシュライト (死亡率大幅減)' },
        'shovel': { price: 200, name: '⛏️ プロのシャベル (成功率大幅増)' }
    };

    if (!item || !STORE_ITEMS[item]) {
        let storeDesc = `現在の共有資金: **${game.funds}円**\n\n`;
        for (const [key, val] of Object.entries(STORE_ITEMS)) storeDesc += `・${val.name} : **${val.price}円** (引数: \`${key}\`)\n`;
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🛒 カンパニー・ストア').setDescription(storeDesc).setColor(0xFFA500)] });
    }

    const selected = STORE_ITEMS[item];
    if (game.funds < selected.price) return interaction.reply({ content: `❌ 共有資金が足りません。(必要: ${selected.price}円 / 現在: ${game.funds}円)`, ephemeral: true });

    game.funds -= selected.price;
    if (item === 'flashlight') player.items.flashlight = true;
    if (item === 'shovel') player.items.shovel = true;

    await interaction.reply({ content: `✅ 共有資金から **${selected.name}** を購入し、${player.name} に装備させました。\n(残り共有資金: ${game.funds}円)` });
}
