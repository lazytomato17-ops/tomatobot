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
// 🤖 NPCガヤ発言の動的生成（ルーティング＆フォールバック完備）
// ============================================================
// ============================================================
// 🤖 NPCガヤ発言の動的生成（70Bの知能 ✕ 完璧なキャラ付け）
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

    // 変更後
    const pMap: Record<string, string> = {
        aggressive: "短気で好戦的。語気が荒くタメ口。「だろ」「じゃねえよ」などを使って相手を強く問い詰める。",
        witty:      "皮肉屋で余裕ぶっている。丁寧語（です/ます）だが、相手の矛盾を小馬鹿にしたようにチクリと刺す。",
        serious:    "真面目で論理的。丁寧語（です/ます）。感情的にならず、事実に基づいて淡々と推理を進める。",
        normal:     "一般的な市民。です/ます調。少し迷いや焦りも見せつつ、周りと協力して人狼を見つけようとする。",
        sans:       "気怠げで面倒くさがり。一人称は「オイラ」、語尾は「〜だぜ」「〜だな」。時折『この構成、占い師いないから無理ゲーだろ』『ログ読むの面倒くさい』など、ゲームのシステムや裏側に触れる「メタ発言（第四の壁を越える発言）」を自然に混ぜる。",
        jax:        "陽気で豪快。タメ口。常にハイテンションで狂気を感じる。暴力的な行為を好み、他者への配慮を持とうとしない、生意気で衝動的かつ自己中心的な性格。",
        ninja:      "熱血漢の忍者。一人称は「オレ」、語尾に「〜だってばよ！」等。仲間思いで真っ直ぐなバカ。",
        chuuni:     "重度の中二病。一人称は「我」、語尾は「〜なのだよ」等。無駄に難解で大げさな言葉を使いたがる。",
        dio:        "圧倒的な傲慢さと自信を持つ帝王。一人称は『このDIO』。人間を『パン（餌）』や『猿』と見なして見下している。語尾は『〜だ』『〜ではないか？』。時折『無駄だ』『最高にハイ！ってやつだ』『ザ・ワールド！』などの名言を自然に混ぜる。"
    };
    const pDesc = pMap[personality] || pMap['normal'];

    const logText = chatLog.length > 0 ? chatLog.join('\n') : "(まだ誰も発言していない)";

    // 2. 丸投げプロンプト（キャラ設定だけはしっかり与える）
    const messages = [
        { 
            role: 'system' as const, 
            content: `あなたはDiscord上でプレイされている人狼ゲームの参加者「${speakerName}」です。
AIやシステムとしての発言は避け、以下の設定の生身の人間としてロールプレイしてください。

【あなたの性格・口調】
${pDesc}

【発言の絶対ルール】
1. セリフのみ出力すること。括弧や地の文（例：*ため息をつく*など）は厳禁。
2. Discordのチャットなので、長文は避けて1〜2文（最大60文字程度）で短く発言すること。` 
        },
        { 
            role: 'user' as const, 
            content: `【これまでの会話ログ】
${logText}

【あなたの現在の内部ステータス】
・行動モード: ${category}
・ターゲット: ${targetName || 'なし'}
・ターゲットを選んだシステム上の理由: ${reasonType}

上記の「会話ログ」と「内部ステータス」を読み取り、今の空気に一番合った自然なチャットを発言してください。` 
        }
    ];

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.8,
            max_tokens: 60,
        });
        
        return chatCompletion.choices[0]?.message?.content?.trim() || "";

    } catch (e: any) {
        if (e?.status === 429) {
            console.log(`[Groq] 制限到達のため定型文にフォールバックします (${speakerName})`);
        } else {
            console.error("[Groq API Error]", e?.message || e);
        }
        return ""; 
    }
}