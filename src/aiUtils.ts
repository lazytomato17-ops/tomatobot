import { GoogleGenerativeAI } from '@google/generative-ai';
import { GameState, Player } from './types';
import * as Roles from './roles';

// 環境変数からAPIキーを取得
const apiKey = process.env.GEMINI_API_KEY;

const mvpComments: Record<string, string[]> = {
    normal: [
        "見事な活躍でした！{reason}が村を勝利へ導きましたね！",
        "素晴らしいプレイング！{reason}のおかげで勝利できました！",
        "まさにMVP級の働き！{reason}が決定打になりました！"
    ],
    toxic: [
        "は？{reason}程度でMVP？まぁ、運が良かっただけだろ。",
        "お前が勝てたのは{reason}というより、敵が自滅しただけだ。調子乗るなよ？",
        "MVPねぇ…。まぁ{reason}くらいはやって当然だけどな。次はもっとマシな試合を見せろよな。"
    ],
    passionate: [
        "熱い！熱すぎる！！{reason}が勝負を完全に決定づけましたぁぁぁ！！🔥",
        "eSports史に残る神プレイ！{reason}、まさに伝説の誕生だぁぁぁ！！🏆",
        "最高のエキサイトメント！！{reason}からの勝利、実況席も大興奮です！！🎙️🔥"
    ],
    logical: [
        "勝因分析: {reason}。極めて最適解に近いプレイングでした。",
        "ログ解析の結果、{reason}が勝利の決定的要因と推測されます。",
        "感情を排除して評価します。{reason}は論理的に一切の無駄がない行動でした。"
    ]
};

const summaryEvaluations: Record<string, string[]> = {
    normal: ["両陣営ともベストを尽くした、素晴らしい試合でした！", "最後まで読めない、ハラハラする展開でしたね！"],
    toxic: ["いやー、見ているこっちが恥ずかしくなるような泥仕合だったな。", "敗北した陣営は、今回の反省を次に活かしてくれよな。"],
    passionate: ["GG！！全員に拍手を送りたい、魂のぶつかり合いでした！！", "この熱戦、絶対に後世に語り継がれるべき神試合です！！"],
    logical: ["規定ターン数で終了。確率論に基づいた妥当な結末と言えます。", "行動ログの矛盾が勝敗を分けたポイントでした。"]
};

export function generateGameSummary(players: Player[], winnerTeam: string, tone: string = 'normal'): string {
    const rolesInfo = players.map(p => `- ${p.name}: ${p.role} (${p.alive ? '生存' : '💀死亡'})`).join('\n');
    const evaluationList = summaryEvaluations[tone] || summaryEvaluations['normal'];
    const randomEval = evaluationList[Math.floor(Math.random() * evaluationList.length)];

    return `🤖 **【システム戦況サマリー】**

📊 **試合データ**

* **勝利陣営:** 🎉 ${winnerTeam}
* **プレイヤーの最終生存状況:**
${rolesInfo}

💡 **システム総評**
${randomEval}`;
}

export async function generateMvpComment(mvpData: { name: string, role: string, reason: string }, tone: string = 'normal'): Promise<string> {
    if (!apiKey) {
        return `見事な活躍でした！${mvpData.reason}が決定打になりましたね！(通信エラー)`;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
あなたは人狼ゲームの冷酷かつ機知に富んだ「AI実況者」です。
試合が終了し、MVPが決定しました。以下の情報をもとに、MVPプレイヤーに向けた短い賛辞（または皮肉交じりの称賛）を生成してください。

【MVP情報】
・プレイヤー名: ${mvpData.name}
・役職: ${mvpData.role}
・選出理由: ${mvpData.reason}

【指示】
・長く語らず、80文字〜120文字程度でキレのある言葉で締めてください。
・「${mvpData.role}」という役職名と、「${mvpData.reason}」という理由を、演劇的で小粋な文章に織り交ぜてください。
・「〇〇陣営の勝利」などの全体的なメタ情報は不要です。純粋にこのプレイヤー個人のみを評価（あるいは小馬鹿にしながら称賛）してください。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("Gemini API Error (MVP):", e);
        return `${mvpData.name}、見事な采配でした。あなたの働きはシステムにも記録されましたよ。（通信エラー）`;
    }
}

export async function generateWolfBriefing(game: GameState): Promise<string> {
    if (!apiKey) {
        return "（通信エラー：AI軍師との接続に失敗しました。APIキーが設定されていません。今夜は己の牙と直感だけを頼りにしなさい……）";
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        // レスポンスの速さとコストパフォーマンスに優れた flash モデルを使用
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // 盤面情報の抽出
        const wolves = game.players.filter(p => Roles.isActualWolf(p.role as string) || p.role === '分断者').map(p => p.name).join(', ');
        
        // 村に存在する可能性のある「役職一覧」（誰が何の役職かは狼にはわからないため、設定から抽出）
        const rolesInGame = game.settings.roles.map(r => Roles.ROLE_MAP[r] || r).join(', ');
        
        const prompt = `
あなたは人狼陣営を勝利に導く、冷酷で機知に富んだ「AI軍師」です。
現在、第1日目の夜です。人狼たちの専用チャットに、今夜の戦術ブリーフィングを提供してください。

【現在の村の状況】
・味方の陣営（人狼・分断者）: ${wolves}
・この村に存在する可能性のある厄介な役職: ${rolesInGame}

【指示】
以下の要素を含め、250文字程度で簡潔かつ演劇的なトーンでアドバイスしてください。
1. 冒頭で、愛すべき人狼たちへの邪悪な挨拶（例：「ようこそ、美しき反逆者たちよ」など）。
2. この村の設定（存在する役職）に基づいた、具体的な警戒対象と戦術の提案。
3. もし「分断者」や「独裁者」など特殊な役職が含まれているなら、それをどう利用するか（あるいはどう避けるか）のアイデア。
4. 結びの言葉で、今夜の「早い者勝ちの襲撃」を煽る。
※注意: 人間側の具体的なプレイヤー名（誰が占い師か等）は、あなたにもわかっていないという前提で話してください。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text();

    } catch (error) {
        console.error("Gemini API Error:", error);
        return "（軍師の思考回路がショートしました……。細かい策は捨て、今夜は一番美味そうな村人の喉を掻き切ってください）";
    }
}
