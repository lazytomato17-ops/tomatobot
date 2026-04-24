// src/lethalLogic.ts
import { CommandInteraction, EmbedBuilder } from 'discord.js';
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── 内部システム定数 ──
const COMPANY_NAME = "The Company (トマティー40Station 運営局)";
const SUCCESS_CHANCE = 60; // 成功率
const DEATH_CHANCE = 15;  // 死亡率（残りは「何もなし」）

interface PlayerState {
    health: number;
    inventory: number;
    isAlive: boolean;
}

const pStates = new Map<string, PlayerState>();

/**
 * Groqを使用して、探索の結果描写を生成する
 */
async function generateDescription(rollType: 'success' | 'fail' | 'death', scrapName?: string) {
    const prompt = `
    Role: You are the cold, corporate AI of a space scavenging company.
    Situation: A scavenger is exploring a dark, dangerous industrial facility on an abandoned moon.
    Event Type: ${rollType} ${scrapName ? `(Found: ${scrapName})` : ''}
    Instruction: Write a short, bleak, and professional atmospheric description in Japanese (1-2 sentences). 
    Focus on industrial horror and corporate coldness. Do not use friendly language.
    `;

    const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama3-8b-8192', // 爆速モデル
    });

    return chatCompletion.choices[0]?.message?.content || "通信エラー。状況を確認できません。";
}

export async function handleExplore(interaction: CommandInteraction) {
    await interaction.deferReply(); // AIの生成時間を確保

    const userId = interaction.user.id;
    if (!pStates.has(userId)) {
        pStates.set(userId, { health: 100, inventory: 0, isAlive: true });
    }
    const state = pStates.get(userId)!;

    if (!state.isAlive) {
        return interaction.editReply('❌ **[警告]** 死亡した従業員は探索に参加できません。');
    }

    const roll = Math.floor(Math.random() * 100) + 1;
    const embed = new EmbedBuilder().setAuthor({ name: COMPANY_NAME }).setTimestamp();

    if (roll <= SUCCESS_CHANCE) {
        // 成功：スクラップ発見
        const val = Math.floor(Math.random() * 80) + 10;
        state.inventory += val;
        const description = await generateDescription('success', `価値${val}円のスクラップ`);

        embed.setTitle('🟢 資産回収成功')
             .setDescription(description)
             .setColor(0x2ecc71)
             .addFields(
                 { name: '回収額', value: `${val}円`, inline: true },
                 { name: '累積積載量', value: `${state.inventory}円`, inline: true }
             );

    } else if (roll > (100 - DEATH_CHANCE)) {
        // 失敗：死亡
        state.isAlive = false;
        const description = await generateDescription('death');

        embed.setTitle('🔴 従業員ロスト')
             .setDescription(description)
             .setColor(0xe74c3c)
             .setFooter({ text: "回収されたスクラップはすべて没収されました。新しい従業員を補充してください。" });
        
        state.inventory = 0; // 全ロスト

    } else {
        // 失敗：何もなし
        const description = await generateDescription('fail');
        embed.setTitle('🟡 異常なし')
             .setDescription(description)
             .setColor(0xf1c40f);
    }

    await interaction.editReply({ embeds: [embed] });
}
