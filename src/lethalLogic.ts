// src/lethalLogic.ts
import { CommandInteraction, EmbedBuilder, TextChannel } from 'discord.js';

// ── 状態管理（簡易版） ──
// 本格運用時は src/state.ts に移動させることを推奨します
interface LethalPlayer {
    id: string;
    name: string;
    isAlive: boolean;
    inventoryValue: number;
}

interface LethalGame {
    quota: number;
    collected: number;
    players: Map<string, LethalPlayer>;
}

const activeGames = new Map<string, LethalGame>();

// ── 確率テーブル（自由に追加・修正してください） ──
const SCRAP_LIST = [
    { name: "V型エンジン", value: 50 },
    { name: "誰かの左靴", value: 5 },
    { name: "ラジカセ", value: 60 },
    { name: "トマティー40Station", value: 40 }, 
    { name: "孫の手", value: 15 },
    { name: "カップ焼きそば", value: 10 },
    { name: "赤い色の何か（アンラッキーカラー）", value: 5 }
];

const DEATH_LIST = [
    "地雷を踏んで木っ端微塵に吹き飛んだ！💥",
    "ブラッケンに背後から首をへし折られた…💀",
    "スネアフリーに頭を丸呑みされて窒息死した…",
    "穴振り魔族に召喚されて異次元へ消え去った🌀",
    "自転車で歩道を走って6000円没収され、ショック死した💸",
    "マるでだめなとまとｵと一緒に強盗容疑で逮捕され、会社から見捨てられた🚓",
    "ジャンプに失敗して奈落へ落ちていった。「さよーならまたいつか！」👋"
];

const NOTHING_LIST = [
    "暗闇から不気味な足音が聞こえる…が、何も見つからなかった。",
    "ただのガラクタの山だ。換金できそうなものはない。",
    "遠くで誰かの叫び声が聞こえた気がする…。",
    "「退屈」の対義語について考えていたら時間が過ぎた。"
];

// ── コマンド処理 ──
export async function handleExplore(interaction: CommandInteraction) {
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const userName = interaction.member?.user.username || interaction.user.username;

    // ゲーム状態の初期化（チャンネルごとに1ゲーム）
    if (!activeGames.has(channelId)) {
        activeGames.set(channelId, { quota: 1000, collected: 0, players: new Map() });
    }
    const game = activeGames.get(channelId)!;

    // プレイヤーの初期化
    if (!game.players.has(userId)) {
        game.players.set(userId, { id: userId, name: userName, isAlive: true, inventoryValue: 0 });
    }
    const player = game.players.get(userId)!;

    if (!player.isAlive) {
        return interaction.reply({ content: '👻 あなたは既に死んでいます。観測カメラから仲間を見守りましょう。', ephemeral: true });
    }

    // 乱数生成 (1〜100)
    const roll = Math.floor(Math.random() * 100) + 1;
    let embed = new EmbedBuilder().setTimestamp();

    if (roll <= 55) {
        // 55%の確率でアイテム発見
        const scrap = SCRAP_LIST[Math.floor(Math.random() * SCRAP_LIST.length)];
        player.inventoryValue += scrap.value;
        game.collected += scrap.value;

        embed.setTitle('📦 スクラップを発見！')
             .setDescription(`**${scrap.name}** を見つけた！ (価値: ${scrap.value}円)`)
             .setColor(0x00FF00)
             .addFields({ name: 'あなたの所持品合計', value: `${player.inventoryValue}円`, inline: true })
             .addFields({ name: '船の合計スクラップ', value: `${game.collected} / ${game.quota}円`, inline: true });

    } else if (roll <= 80) {
        // 25%の確率で空振り（何もなし）
        const nothingText = NOTHING_LIST[Math.floor(Math.random() * NOTHING_LIST.length)];
        embed.setTitle('🔦 探索を続けたが…')
             .setDescription(nothingText)
             .setColor(0x888888);

    } else {
        // 20%の確率で死亡
        const deathText = DEATH_LIST[Math.floor(Math.random() * DEATH_LIST.length)];
        player.isAlive = false;
        
        embed.setTitle('☠️ 従業員死亡通知')
             .setDescription(`**${player.name}** は${deathText}\n\n集めたスクラップ（${player.inventoryValue}円分）は失われました。`)
             .setColor(0xFF0000);
             
        game.collected -= player.inventoryValue; // 死んだら所持分ロスト
        player.inventoryValue = 0;
    }

    await interaction.reply({ embeds: [embed] });
}
