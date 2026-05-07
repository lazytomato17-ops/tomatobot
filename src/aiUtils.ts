import { GoogleGenAI } from '@google/genai';
import { GameState, Player } from './types';
import * as Roles from './roles';

import Groq from 'groq-sdk';
const groqApiKey = process.env.GROQ_API_KEY;
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

// 環境変数からAPIキーを取得
const apiKey = process.env.GEMINI_API_KEY;

// APIキーがある場合のみ、新しいSDKを初期化
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// 💡 Gemini APIの呼び出しを自動でリトライする関数
async function fetchGeminiWithRetry(prompt: string, maxRetries = 3): Promise<string | null> {
    if (!ai) return null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt
            });
            return response.text ? response.text.trim() : null;
        } catch (error: any) {
            // 503(混雑) または 429(制限) の場合は待機してリトライ
            if ((error.status === 503 || error.status === 429) && i < maxRetries - 1) {
                const waitTime = Math.pow(2, i) * 2000; // 1回目2秒、2回目4秒
                console.log(`[Gemini API] サーバー混雑中。${waitTime / 1000}秒後にリトライします...(${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error; // その他のエラーや最大回数を超えた場合は投げる
            }
        }
    }
    return null;
}


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
        "熱い！熱すぎる！！{reason}が勝負を完全に決定づけましたぁぁぁ！！",
        "eSports史に残る神プレイ！{reason}、まさに伝説の誕生だぁぁぁ！！",
        "最高のエキサイトメント！！{reason}からの勝利、実況席も大興奮です！！"
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
 * 🏆 MVP寸評生成（性格反映・ログ分析強化版）
 */
export async function generateMvpComment(mvpData: { name: string, role: string, reason: string }, gameHistory: string[], tone: string = 'passionate'): Promise<string> {
    
    const getFallbackComment = () => {
        const commentList = mvpComments[tone] || mvpComments['passionate'];
        const template = commentList[Math.floor(Math.random() * commentList.length)];
        return template.replace('{reason}', mvpData.reason) + " (※通信エラーによる自動出力)";
    };

    if (!ai) return getFallbackComment();

    try {
        const historyText = gameHistory.join('\n');

        // 性格に応じたペルソナを設定
        let personaPrompt = "";
        switch (tone) {
            case 'toxic': personaPrompt = "口が悪く、上から目線でプレイヤーを小馬鹿にする毒舌な解説者"; break;
            case 'logical': personaPrompt = "感情を完全に排除し、論理とデータのみで勝因を分析する冷徹なAIアナリスト"; break;
            case 'passionate': personaPrompt = "喉が枯れるほど絶叫する、超熱血eSports実況キャスター"; break;
            default: personaPrompt = "落ち着いたトーンで的確に試合を振り返る、プロのゲーム解説者"; break;
        }

        const prompt = `
あなたは人狼ゲームの「${personaPrompt}」です。
試合が終了し、MVPが決定しました。以下の【試合の全ログ】と【MVP情報】を読み込み、MVPの具体的な活躍を実況・解説してください。

【試合の全ログ（時系列）】
${historyText}

【MVP情報】
・プレイヤー名: ${mvpData.name}
・役職: ${mvpData.role}

【厳格なルール】
1. ログから、MVP（${mvpData.name}）の「決定的な発言」「正確な占い・護衛」「見事な潜伏や騙り」など、具体的なアクションを1つ必ず抜き出して評価に組み込むこと。
2. キャラクター（${personaPrompt}）の口調を完璧に再現すること。
3. だらだらと長く話さず、Discordのチャットで読みやすい【50〜100文字程度】で、キレのあるコメントにまとめること。
        `;

        const responseText = await fetchGeminiWithRetry(prompt);
        return responseText || getFallbackComment();


    } catch (e: any) {
        console.error("[SafeCatch] Gemini API Error (MVP):", e.message || e);
        return getFallbackComment();
    }
}

/**
 * 🐺 初夜ブリーフィング生成（AI軍師の知能向上版）
 */
export async function generateWolfBriefing(game: GameState, speakerName: string = "AI軍師", isNpc: boolean = false, personality: string = 'normal'): Promise<string> {
    
    const getFallbackBriefing = () => "（通信エラー：今夜は己の牙と直感だけを頼りにしなさい……）";
    
    if (!ai) return getFallbackBriefing();

    try {
        const wolves = game.players.filter(p => Roles.isActualWolf(p.role as string) || p.role === '分断者').map(p => p.name).join(', ');
        const rolesInGame = game.settings.roles.map(r => Roles.ROLE_MAP[r] || r).join(', ');

        let toneInstruction = "相棒に話しかけるような、不敵で頼もしいトーン";
        if (isNpc) {
            switch (personality) {
                case 'aggressive': toneInstruction = "血の気の多い、好戦的で野蛮な口調（「ぶっ殺そうぜ」「俺が噛みちぎる」等）"; break;
                case 'witty': toneInstruction = "皮肉屋で余裕ぶった口調（「せいぜい足掻いてもらおうか」「愚かな村人どもだ」等）"; break;
                case 'serious': toneInstruction = "軍人のように真面目で堅物な口調（「我々の使命は〜だ」「油断せず行こう」等）"; break;
                case 'sans': toneInstruction = "気怠げで面倒くさがりな口調。一人称は「オイラ」（「ヤレヤレ」「面倒だな…」等）"; break;
                case 'jax': toneInstruction = "陽気で豪快、少し狂気を感じる口調（「はーっはっは！」「やっちゃおうぜ！」等）"; break;
                case 'normal': 
                default: toneInstruction = "相棒に話しかけるような、不敵で頼もしいトーン"; break;
            }
        }


        const prompt = isNpc ? `
あなたは人狼ゲームの参加者「${speakerName}」です。陣営は人狼側です。
1日目の夜、専用チャットで仲間のプレイヤーに向けて作戦を提案してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 「俺が占い師を騙る」「俺は霊能に出る」「俺は身を潜める」など、自分（${speakerName}）の役回りを必ず1つ宣言すること。
2. 存在しない役職を語らないこと。必ず【この村に存在する役職】を利用した作戦を立てること。
3. 箇条書きは禁止。Discordのチャットらしい、生々しいセリフ（2〜3文）にすること。
4. 口調は、【${toneInstruction}】を厳守すること。
5. 【超重要】システムの都合上、文章の一番最後に、自分の行動を示す以下のタグを必ず1つだけ出力すること。
  ・占い騙りの場合: [SEER]
  ・霊能騙りの場合: [MEDIUM]
  ・潜伏の場合: [HIDE]
        ` : `
あなたは人狼陣営を勝利に導く「冷徹で邪悪な天才軍師」です。
1日目の夜、人狼たちへ向けて【高度な盤面操作と心理戦術】を指示してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 役職のルール説明は一切不要。
2. 「どの役職を騙って場を荒らすか」「分断や死霊術など、存在する役職をどう逆利用するか」という、実用的で狡猾な戦術を1つ具体的に提案すること。
3. 箇条書きは禁止。短いセリフ（3文程度）として語ること。
4. 諸葛亮孔明のような、知的で静かなる狂気を孕んだ口調で語ること。
        `;

        const responseText = await fetchGeminiWithRetry(prompt);
        return responseText || getFallbackBriefing();


    } catch (e: any) {
        console.error("[SafeCatch] Gemini API Error (Briefing):", e.message || e);
        return getFallbackBriefing();
    }
}

// ============================================================
// 🤖 NPCガヤ発言の動的生成（Groq: Llama-3.1-70B）
// ============================================================
export async function generateNpcGaya(
    speakerName: string,
    personality: string,
    category: string,
    targetName: string | null,
    reasonType: string,
    chatLog: string[]
): Promise<string> {
    if (!groq) return ""; 

    const pMap: Record<string, string> = {
        aggressive: "短気で攻撃的。タメ口。「～だろ」「～じゃん」「～してよ」",
        witty: "皮肉屋でユーモアがある。丁寧語。「～ですね」「～でしょうか」「～やれやれ」",
        serious: "真面目で論理的。丁寧語。「～です」「～と推測します」「～説明してください」",
        normal: "普通の村人。です・ます調。",
        sans: "面倒くさがり。一人称は「オイラ」、語尾は「～だぜ」「～だな」。直接攻撃は避ける。",
        jax: "陽気で豪快で自信満々。タメ口。「はーっはっは！」「～だぜ！」「～だな！」"
    };
    const pDesc = pMap[personality] || pMap['normal'];

    // 🌟 修正：AIに与える「思考」の整理
    let thoughts = "";
    if (category === 'attacking' && targetName) {
        const reasonMap: Record<string, string> = {
            liar: "発言が過去の確定情報と矛盾して完全に破綻しているから",
            black: "占いで黒（人狼）と判定されたから",
            trusted_black: "真の占い師だと思われる人から黒出しされたから",
            doubtful_black: "占い師の対抗がいて真偽不明だが、黒出しされたから",
            roller: "占い師の対抗がいて真偽不明だから、とりあえず全員吊る（ローラーする）べきだから",
            seer_co_suspect: "占い師COが多くて怪しいから、ローラーで処理したいから",
            line_defense: "昨日の投票先が怪しい（人狼を庇っている）から",
            revenge: "昨日自分に投票してきたから",
            coroner_truth: "自分の検死結果と相手の発言が違うから",
            hostile_seer: "自分や仲間に黒出ししてきた偽占い師だから",
            my_black_result: "自分が占い/霊能結果で黒を出した相手だから",
            gray: "なんとなく怪しいから（消去法）"
        };
        const rDesc = reasonMap[reasonType] || "なんとなく怪しいから";
        thoughts = `あなたは今、【${targetName}】を怪しいと疑っています。（理由：${rDesc}）`;
    } else if (category === 'defensive') {
        thoughts = `あなたは今、他の人から疑われてピンチです。無実を主張して弁明するか、反論してください。`;
    } else if (category === 'day1') {
        thoughts = `今はゲーム開始直後（初日）です。`;
    } else {
        thoughts = `今は特に強く疑っている人はいません。`;
    }

    const recentChatText = chatLog.length > 0 
        ? `【直近の会話ログ】\n${chatLog.join('\n')}` 
        : "【直近の会話ログ】\nまだ誰も発言していません。";

    // 🌟 修正：リアクションを「最優先」させつつ、捏造と絵文字を絶対に許さない強烈なプロンプト
    const prompt = `あなたはDiscord上のテキスト人狼ゲームの参加者です。
名前: ${speakerName}
性格・口調: ${pDesc}

【現在のあなたの思考】
${thoughts}

【発言の優先ルール】
直近の会話ログを読み、以下の順に発言内容を決めてください。
1. 【最優先】直近のログに「占い結果」「霊能結果」「誰かの役職CO」があれば、絶対にそれに反応してください。（例:「〇〇が黒!?」「本物か？」等）
2. なければ、「現在のあなたの思考」に従って誰かを疑うか、前の人の発言に相槌を打ってください。

${recentChatText}

【🚨絶対厳守ルール（破るとシステムが破損します）🚨】
- 直近の会話ログにない事実（「〇〇が白だった」「結果が変わった」など）を絶対に捏造しないでください。事実のみを話してください。
- 1〜2文で、Discordのチャットらしく短く発言すること（最大40文字程度）。
- 挨拶、自己紹介、メタ発言（「AIとして」等）は禁止。
- 絵文字（😐や🐺など）や記号での顔文字は一切使用しないでください。日本語のテキストのみ出力してください。`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'system', content: prompt }],
            // 🌟 今度こそ確実！現在Groqで稼働中の最新軽量モデル
            model: 'llama-3.1-8b-instant', 
            temperature: 0.8,
            max_tokens: 150,
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "";
    } catch (e) {
        console.error("Groq Gaya Error:", e);
        return ""; 
    }
}