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

/**
 * 🏆 超熱血eSports実況者によるMVP寸評生成 (ログ全読み分析版)
 */
export async function generateMvpComment(mvpData: { name: string, role: string, reason: string }, gameHistory: string[], tone: string = 'passionate'): Promise<string> {
    
    const getFallbackComment = () => {
        const commentList = mvpComments[tone] || mvpComments['passionate'];
        const template = commentList[Math.floor(Math.random() * commentList.length)];
        return template.replace('{reason}', mvpData.reason) + " (※通信エラーによる自動出力)";
    };

    if (!apiKey) return getFallbackComment();

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

        // ログをAIが読めるテキストに変換
        const historyText = gameHistory.join('\n');

        const prompt = `
あなたは人狼ゲームの「超熱血なeSports実況キャスター」です。
試合が終了し、MVPが決定しました。以下の【試合の全ログ】と【MVP情報】を読み込み、MVPが「試合の中で具体的にどんな戦術で活躍したか」を分析して、大興奮の実況コメントを生成してください。

【試合の全ログ（時系列）】
${historyText}

【MVP情報】
・プレイヤー名: ${mvpData.name}
・役職: ${mvpData.role}
・システムが判定した選出理由: ${mvpData.reason}

【厳格なルール】
1. ログの内容から、MVPプレイヤー（${mvpData.name}）が「誰を処刑に導いたか」「誰を襲撃したか」「いつまで生存したか」など、具体的な戦術的貢献を必ず1つ見つけ出して褒め称えること。
2. 「おおおおおっと！」「神プレイだァァァ！」のような、叫ぶような熱いトーンにすること。
3. 全体で【150文字程度】で、一気に言い切ること。
4. ※重要：もしログからMVPの具体的な活躍が読み取れない場合は、役職の性質（例: 人狼なら最後まで隠れ通したこと等）をこじつけてでも強引に絶賛してください。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("Gemini API Error (MVP):", e);
        return getFallbackComment();
    }
}


/**
 * 🐺 邪悪なAIによる初夜ブリーフィング生成（NPC憑依・性格対応）
 */
export async function generateWolfBriefing(game: GameState, speakerName: string = "AI軍師", isNpc: boolean = false, personality: string = 'normal'): Promise<string> {
    if (!apiKey) return "（通信エラー：今夜は己の牙と直感だけを頼りにしなさい……）";

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

        const wolves = game.players.filter(p => Roles.isActualWolf(p.role as string) || p.role === '分断者').map(p => p.name).join(', ');
        const rolesInGame = game.settings.roles.map(r => Roles.ROLE_MAP[r] || r).join(', ');

        // ★ 性格に応じた口調の指示を定義
        let toneInstruction = "相棒に話しかけるような、不敵で頼もしいトーン（「〜しようぜ」「俺に任せろ」等）";
        if (isNpc) {
            switch (personality) {
                case 'aggressive': toneInstruction = "血の気の多い、好戦的で野蛮な口調（「ぶっ殺そうぜ」「俺が噛みちぎる」等）"; break;
                case 'cautious': toneInstruction = "臆病で慎重な口調（「〜した方が安全じゃないかな」「バレないようにしようよ」等）"; break;
                case 'logical': toneInstruction = "冷徹で論理的な口調（「確率は〜です」「〜が最適解だ」等）"; break;
                case 'witty': toneInstruction = "皮肉屋で機知に富んだ口調（「せいぜい足掻いてもらおうか」「馬鹿な村人どもだ」等）"; break;
                case 'joker': toneInstruction = "お調子者でふざけた口調（「ヒャッハー！」「やっちゃおうぜ〜！」等）"; break;
                case 'gal': toneInstruction = "テンションの高いギャル語（「マジウケるんだけど」「〜っしょ！」「とりま噛む？」等）"; break;
                case 'serious': toneInstruction = "真面目で堅物な口調（「我々の使命は〜だ」「油断せず行こう」等）"; break;
            }
        }

        const prompt = isNpc ? `
あなたは人狼ゲームに参加している「${speakerName}（NPC）」です。陣営は人狼側です。
第1日目の夜、専用チャットで仲間のプレイヤー（人間）に向けて作戦を提案してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 役職の解説は絶対にしないこと。
2. 「俺が占い師を騙るぜ」「俺は霊能に出る」「俺は潜伏しておく」など、自分（${speakerName}）が実行する行動を必ず宣言し、計略を1つ提案する。
3. 箇条書きは絶対に禁止。Discordのチャットで送るような、生々しく短いセリフ（2〜3文程度）にすること。全体で【120文字以内】。
4. 口調は、【${toneInstruction}】で語ること。
5. 【超重要】システムの都合上、文章の一番最後に、自分の行動を示す以下のタグを必ず1つだけ出力すること（例: ...俺に任せな！ [SEER]）。
  ・占い騙りの場合: [SEER]
  ・霊能騙りの場合: [MEDIUM]
  ・潜伏の場合: [HIDE]
        ` : `
あなたは人狼陣営に仕える、三国志の諸葛亮孔明のような「稀代の天才軍師（ただし邪悪）」です。
第1日目の夜、人狼たちへ向けて【高度な盤面操作と心理戦術】を指示してください。

「〇〇に気をつけろ」といった浅い役職の解説は一切禁止です。村を操る具体的な騙り方や、特定の役職を同士討ちさせるような「極めて賢い戦略」を提案してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 役職の単なる説明は絶対にしないこと。
2. 「誰がどの役を騙るべきか」「分断や死霊術をどう逆利用するか」など、高度な戦術（計略）を1つ提示する。
3. 箇条書きは絶対に禁止。短いセリフ（2〜3文程度）として語ること。全体で【120文字以内】。
4. 諸葛亮のような、冷静沈着かつ知的な口調（「〜の計を用いましょう」「〜と推察します」など）で語ること。
        `;

        const result = await model.generateContent(prompt);
        return result.response.text();

    } catch (error) {
        console.error("Gemini API Error:", error);
        return "（思考回路がショートしたぜ……。細かい策は捨て、一番美味そうな奴を噛もう）";
    }
}


