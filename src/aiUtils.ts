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

export async function generateMvpComment(mvpData: { name: string, role: string, reason: string }, tone: string = 'passionate'): Promise<string> {
    
    // ▼ 通信エラー時の安全装置（定型文ジェネレーター）
    const getFallbackComment = () => {
        const commentList = mvpComments[tone] || mvpComments['passionate'];
        const template = commentList[Math.floor(Math.random() * commentList.length)];
        return template.replace('{reason}', mvpData.reason) + " (※通信エラーによる自動出力)";
    };

    if (!apiKey) {
        return getFallbackComment();
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
あなたは人狼ゲームの「超熱血なeSports実況キャスター」です。
試合が終了し、MVPが決定しました。以下の情報をもとに、最高にテンションが高く、大興奮の実況コメントを生成してください。

【MVP情報】
・プレイヤー名: ${mvpData.name}
・役職: ${mvpData.role}
・選出理由: ${mvpData.reason}

【指示】
・叫ぶような熱いトーンでMVP「${mvpData.name}」を褒め称えてください
・「${mvpData.role}」という役職名と、「${mvpData.reason}」という理由を必ず盛り込み、伝説のプレイヤーのようにベタ褒めしてください。
・文字数は80文字〜120文字程度で、とにかく勢いよく言い切ってください。
・メタ的なゲームの解説や陣営の勝敗には触れず、ひたすらMVPプレイヤーへの熱狂的な実況のみを出力してください。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("Gemini API Error (MVP):", e);
        // APIエラーが起きたら、用意した定型文リストからランダムに返す
        return getFallbackComment();
    }
}
export async function generateWolfBriefing(game: GameState): Promise<string> {
    if (!apiKey) {
        return "（通信エラー：AI軍師との接続に失敗しました。APIキーが設定されていません。今夜は己の牙と直感だけを頼りにしなさい……）";
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        // レスポンスの速さとコストパフォーマンスに優れた flash モデルを使用
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // 盤面情報の抽出
        const wolves = game.players.filter(p => Roles.isActualWolf(p.role as string) || p.role === '分断者').map(p => p.name).join(', ');
        
        // 村に存在する可能性のある「役職一覧」（誰が何の役職かは狼にはわからないため、設定から抽出）
        const rolesInGame = game.settings.roles.map(r => Roles.ROLE_MAP[r] || r).join(', ');
        
        const prompt = `
あなたは人狼陣営に仕える、三国志の諸葛亮孔明のような「稀代の天才軍師（ただし邪悪）」です。
第1日目の夜、人狼たちへ向けて【高度な盤面操作と心理戦術】を指示してください。

「〇〇に気をつけろ」といった浅い役職の解説は一切禁止です。村を操る具体的な騙り方や、特定の役職を同士討ちさせるような「極めて賢い戦略」を提案してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 役職の単なる説明は絶対にしないこと（例：「占い師は脅威です」等はNG）。
2. 「誰がどの役を騙るべきか」「分断や死霊術をどう逆利用するか」など、高度な戦術（計略）を1つ提示する。
3. 全体で【3行の箇条書き】【合計120文字以内】に収めること。ゲームのテンポを崩してはならない。
4. 諸葛亮のような、冷静沈着かつ知的な口調（「〜の計を用いましょう」「〜と推察します」など）で語ること。

【出力フォーマット例】
・【離間の計】分断者が自ら「霊能者」を騙り、本物を隔離して村の視界を奪うのです。
・【同士討ち】死霊術師が蘇生した者に疑いの矛先を向けさせ、処刑で2人まとめて葬りましょう。
・さあ、ボタンを制した者が、今夜の布石となる血祭りを決行してください。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text();

    } catch (error) {
        console.error("Gemini API Error:", error);
        return "（軍師の思考回路がショートしました……。細かい策は捨て、今夜は一番美味そうな村人の喉を掻き切ってください）";
    }
}
