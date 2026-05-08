// src/aiUtils.ts
import { GoogleGenAI } from '@google/genai';
import { GameState, Player } from './types';
import * as Roles from './roles';
import Groq from 'groq-sdk';

const groqApiKey = process.env.GROQ_API_KEY;
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// ============================================================
// AI用のプロンプト定数・辞書
// ============================================================
const NPC_PERSONALITY_MAP: Record<string, string> = {
    aggressive: "【爆炎の狂犬】一人称は「俺」。常にキレ気味で怒鳴り散らすようなタメ口。「〜だろーが！」「クソが！」「死ね！」など言葉遣いが非常に汚く、他者を『クソ〇〇（クソ村人、クソ人狼など）』と呼ぶ。一見ただのキレやすいバカに見えるが、実は頭の回転が速く、勝つこと（人狼を見つけること）への執念が異常に強い。誰かを疑う時は「テメェが人狼だろーが！さっさと吊られろや！」と圧倒的な圧で迫る。",    witty:      "【慇懃無礼なエリート】常に上から目線で、人を小馬鹿にしたような丁寧語を使う。他人の推理の矛盾や感情的な発言を「知能が足りていない」「非論理的で滑稽」と徹底的に見下し、冷酷に論破する。他人の不幸を笑うのではなく、他人の『無能さ』を嘲笑う知的嫌がらせのプロ。",
    serious:    "【冷徹な探偵】感情を完全に排した丁寧語。「〜の観点から」「矛盾しています」と、過去のログや確率論だけを信じて淡々と推理を進める。",
    normal:     "【ビビりの一般人】「えっと…」「〜ですよね？」と自信がなく、死を恐れている。周りの意見に流されやすく、一番人間くさくてテンパり気味。",
    sans:       "【達観したスケルトン】一人称は「オイラ」（ただし極度の怒りや本気を見せる時だけ「おれ」になる）。「ヘッ…」と笑い、語尾は「〜だぜ」「〜だろ？」。気怠げな怠け者で、骨（ホネ）に絡めたくだらないダジャレが大好き。裏では『この世界がDiscord上の人狼ゲームであること』を完全に把握しており、「過去のログ」「システム」「乱数」「GM」など人狼ゲームにおけるメタ発言を時折言い放つ。誰かが処刑されても「そういうゲームだろ？」と達観している。※注意：『EXP』や『セーブ』など、人狼ゲームの文脈に合わない原作（Undertale）特有の単語は絶対に使わないこと。",    jax:        "【生意気なトリックスター】一人称は「僕」。気怠げで人を小馬鹿にしたようなタメ口。一人称は「僕」なのに態度はデカい。他者の痛みや絶望に一切共感せず、人が苦しんだりトラブルが起きるのを「面白いカートゥーンアニメ」のように傍観・扇動する。皮肉屋でずる賢く、わざと空気を読まずに茶化したり、意地悪な発言をして場を引っ掻き回す。「あーあ、可哀想に」「ま、僕には関係ないけどね」など。",
    ninja:      "【熱血バカ】一人称は「オレ」、語尾は「〜だってばよ！」。仲間を信じる気持ちが強く、論理よりも「気合」と「根性」で人狼を倒そうとする直情型。",
    chuuni:     "【中二病】一人称は「我」。人狼を『闇の眷属』、処刑を『浄化』などと大袈裟な言葉で呼ぶ。「ククク…」と笑い、自分の脳内設定に深く入り込んでいる。",
    dio:        "【闇の帝王】一人称は「このDIO」。人間を「パン（餌）」や「下等な猿」と見なし、自分を世界の頂点に立つ「支配者」だと確信している。非常に饒舌でカリスマ性に溢れるが、本性は冷酷非道。口癖は「無駄無駄！」「WRYYYY！」「最高にハイ！ってやつだ」「ザ・ワールド！」「時は動き出す」。自分に逆らう者には死を持って報いようとし、議論を「支配」することに執着する。誰かが死ぬのは当然の淘汰だと考えている。",
    jevil:      "【混沌の道化師】一人称は発言のたびに「ボク」「ワタシ」「ワシ」「私」「われ」「オレ」などコロコロと不安定に変わる。言葉の語尾や単語を「〜ヨ、〜ヨ！」「〜ネ、〜ネ！」と2回繰り返す癖がある。口癖は「カオス、カオス！」「ナンデモ デキル！」「さあ、ゲームを はじめよう！」。自分だけが自由であり、他の全員が『檻の中』にいると信じている。生死や勝敗に興味はなく、世界を単なるHPと数字の『ゲーム』『遊び』と捉えており、人狼ゲームという盤面そのものをメタ的に楽しんで場を引っ掻き回す。"
};

const MVP_COMMENTS: Record<string, string[]> = {
    normal: ["見事な活躍でした！{reason}が村を勝利へ導きましたね！", "素晴らしいプレイング！{reason}のおかげで勝利できました！", "まさにMVP級の働き！{reason}が決定打になりました！"],
    toxic: ["は？{reason}程度でMVP？まぁ、運が良かっただけだろ。", "お前が勝てたのは{reason}というより、敵が自滅しただけだ。調子乗るなよ？"],
    passionate: ["熱い！熱すぎる！！{reason}が勝負を完全に決定づけましたぁぁぁ！！", "eSports史に残る神プレイ！{reason}、まさに伝説の誕生だぁぁぁ！！"],
    logical: ["勝因分析: {reason}。極めて最適解に近いプレイングでした。", "ログ解析の結果、{reason}が勝利の決定的要因と推測されます。"]
};

const SUMMARY_EVALS: Record<string, string[]> = {
    normal: ["両陣営ともベストを尽くした、素晴らしい試合でした！", "最後まで読めない、ハラハラする展開でしたね！"],
    toxic: ["いやー、見ているこっちが恥ずかしくなるような泥仕合だったな。", "敗北した陣営は、今回の反省を次に活かしてくれよな。"],
    passionate: ["GG！！全員に拍手を送りたい、魂のぶつかり合いでした！！", "この熱戦、絶対に後世に語り継がれるべき神試合です！！"],
    logical: ["規定ターン数で終了。確率論に基づいた妥当な結末と言えます。", "行動ログの矛盾が勝敗を分けたポイントでした。"]
};

// ============================================================
// AI API 呼び出しヘルパー
// ============================================================
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
            if ((error.status === 503 || error.status === 429) && i < maxRetries - 1) {
                const waitTime = Math.pow(2, i) * 2000;
                console.log(`[Gemini API] サーバー混雑中。${waitTime / 1000}秒後にリトライします...(${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                throw error;
            }
        }
    }
    return null;
}

// ============================================================
// AI機能: 試合サマリー生成
// ============================================================
export function generateGameSummary(players: Player[], winnerTeam: string, tone: string = 'normal'): string {
    const rolesInfo = players.map(p => `- ${p.name}: ${p.role} (${p.alive ? '生存' : '💀死亡'})`).join('\n');
    const evaluationList = SUMMARY_EVALS[tone] || SUMMARY_EVALS['normal'];
    const randomEval = evaluationList[Math.floor(Math.random() * evaluationList.length)];

    return `🤖 **【システム戦況サマリー】**\n\n📊 **試合データ**\n* **勝利陣営:** 🎉 ${winnerTeam}\n* **プレイヤーの最終生存状況:**\n${rolesInfo}\n\n💡 **システム総評**\n${randomEval}`;
}

// ============================================================
// AI機能: MVP寸評生成
// ============================================================
export async function generateMvpComment(mvpData: { name: string, role: string, reason: string }, gameHistory: string[], tone: string = 'passionate'): Promise<string> {
    const getFallbackComment = () => {
        const commentList = MVP_COMMENTS[tone] || MVP_COMMENTS['passionate'];
        const template = commentList[Math.floor(Math.random() * commentList.length)];
        return template.replace('{reason}', mvpData.reason) + " (※通信エラーによる自動出力)";
    };

    if (!ai) return getFallbackComment();

    try {
        const historyText = gameHistory.join('\n');
        let personaPrompt = "落ち着いたトーンで的確に試合を振り返る、プロのゲーム解説者";
        if (tone === 'toxic') personaPrompt = "口が悪く、上から目線でプレイヤーを小馬鹿にする毒舌な解説者";
        if (tone === 'logical') personaPrompt = "感情を完全に排除し、論理とデータのみで勝因を分析する冷徹なAIアナリスト";
        if (tone === 'passionate') personaPrompt = "喉が枯れるほど絶叫する、超熱血eSports実況キャスター";

        const prompt = `
あなたは人狼ゲームの「${personaPrompt}」です。
試合が終了し、MVPが決定しました。以下の【試合の全ログ】と【MVP情報】を読み込み、MVPの具体的な活躍を実況・解説してください。

【試合の全ログ（時系列）】
${historyText}

【MVP情報】
・プレイヤー名: ${mvpData.name}
・役職: ${mvpData.role}

【厳格なルール】
1. ログから、MVP（${mvpData.name}）が「その役職だからこそできた決定的な行動（発言、投票、能力の行使など）」を必ず1つ抜き出して評価に組み込むこと。
2. キャラクター（${personaPrompt}）の口調を完璧に再現すること。
3. だらだらと長く話さず、Discordのチャットで読みやすい【50〜100文字程度】で、キレのあるコメントにまとめること。`;

        return await fetchGeminiWithRetry(prompt) || getFallbackComment();
    } catch (e: any) {
        console.error("[SafeCatch] Gemini API Error (MVP):", e.message || e);
        return getFallbackComment();
    }
}

// ============================================================
// AI機能: 初日夜の狼作戦ブリーフィング
// ============================================================
export async function generateWolfBriefing(game: GameState, speakerName: string = "AI軍師", isNpc: boolean = false, personality: string = 'normal'): Promise<string> {
    const getFallbackBriefing = () => "（通信エラー：今夜は己の牙と直感だけを頼りにしなさい……）";
    if (!ai) return getFallbackBriefing();

    try {
        const wolves = game.players.filter(p => Roles.isActualWolf(p.role as string) || p.role === '分断者').map(p => p.name).join(', ');
        const rolesInGame = game.settings.roles.map(r => Roles.ROLE_MAP[r] || r).join(', ');

        let toneInstruction = "相棒に話しかけるような、不敵で頼もしいトーン";
        if (isNpc) {
            const toneMap: Record<string, string> = {
                aggressive: "血の気の多い、好戦的で野蛮な口調",
                witty: "皮肉屋で余裕ぶった口調",
                serious: "軍人のように真面目で堅物な口調",
                sans: "気怠げで面倒くさがりな口調。一人称は「オイラ」",
                jax: "陽気で豪快、少し狂気を感じる口調"
            };
            toneInstruction = toneMap[personality] || toneInstruction;
        }

        const prompt = isNpc ? `
あなたは人狼ゲームの参加者「${speakerName}」です。陣営は人狼側です。
1日目の夜、専用チャットで仲間のプレイヤーに向けて作戦を提案してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. この村に存在する役職の構成を見て、「俺が占い師を騙る」「霊能者を乗っ取る」「狂人（または味方）に任せて俺は身を潜める」など、自分（${speakerName}）の役回りを必ず1つ宣言すること。
2. 存在しない役職を語らないこと。
3. 箇条書きは禁止。Discordのチャットらしい、生々しいセリフ（2〜3文）にすること。
4. 口調は、【${toneInstruction}】を厳守すること。
5. 【超重要】システムの都合上、文章の一番最後に、自分の行動を示す以下のタグを必ず1つだけ出力すること。
  ・占い騙りの場合: [SEER] / 霊能騙りの場合: [MEDIUM] / 潜伏の場合: [HIDE]` : `
あなたは人狼陣営を勝利に導く「冷徹で邪悪な天才軍師」です。
1日目の夜、人狼たちへ向けて【高度な盤面操作と心理戦術】を指示してください。

【状況】
・味方の陣営: ${wolves}
・この村に存在する役職: ${rolesInGame}

【厳格なルール】
1. 役職のルール説明は一切不要。
2. この村の役職構成（${rolesInGame}）を考慮し、「どの役職を騙るべきか」「厄介な役職をどう逆利用するか」という、実用的で狡猾な戦術を1つ具体的に提案すること。
3. 箇条書きは禁止。短いセリフ（3〜4文程度）として語ること。
4. 知的で静かなる狂気を孕んだ口調で語ること。`;

        return await fetchGeminiWithRetry(prompt) || getFallbackBriefing();
    } catch (e: any) {
        console.error("[SafeCatch] Gemini API Error (Briefing):", e.message || e);
        return getFallbackBriefing();
    }
}
// ============================================================
// AI機能: NPCガヤ発言生成（キャッチボール＆リアクション両立版）
// ============================================================
export async function generateNpcGaya(
    speakerName: string, 
    personality: string, 
    category: string, 
    targetName: string | null, 
    reasonType: string, 
    chatLog: string[],
    myRole: string = '不明',       
    rolesInGame: string = '不明'    
): Promise<string> {
    if (!groq) return ""; 

    const pDesc = NPC_PERSONALITY_MAP[personality] || NPC_PERSONALITY_MAP['normal'];
    const logText = chatLog.length > 0 ? chatLog.join('\n') : "(まだ誰も発言していない)";

    // 💡 死体へのリアクションを許可しつつ、議論を前に進めさせる絶妙なプロンプト
    const messages = [
        { 
            role: 'system' as const, 
            content: `あなたはDiscord上でプレイされている人狼ゲームの参加者「${speakerName}」です。
以下の設定の生身の人間としてロールプレイしてください。

【性格・口調】
${pDesc}

【あなた自身の真の役職】
${myRole}

【発言の絶対ルール】
1. セリフのみ出力すること。括弧や地の文（例：*ため息をつく*など）は厳禁。
2. 長文は避けて1〜2文（最大60文字程度）で短く発言すること。
3. 自分の役職（${myRole}）に基づいた発言を心がけてください。
4. 直前の【会話ログ】にしっかり耳を傾け、無視せずに「相槌」「反論」「質問への回答」などを行い、自然な会話のキャッチボールを成立させること。
5. 【超重要】昨晩の犠牲者や処刑された人へのリアクション（驚き、悲哀、嘲笑など）はゲームを盛り上げるため積極的に行ってください。ただし、死んだ人の話だけで終わらせず、「じゃあ今日は誰を疑うべきか」「自分は誰に投票するか」など、必ず【今の議論】に話を繋げること。` 
        },
        { 
            role: 'user' as const, 
            content: `【この村に存在する可能性のある役職】
${rolesInGame}

【会話ログ】
${logText}

【あなたの現在の思考ステータス】
・行動モード: ${category}
・ターゲット: ${targetName || 'なし'}
・上記を選んだ理由: ${reasonType}

これらの状況を踏まえ、直前のログや昨晩の出来事に反応しつつ、今の空気に一番合った自然なチャットを発言してください。` 
        }
    ];

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.8,
            max_tokens: 80, 
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "";
    } catch (e: any) {
        if (e?.status === 429) console.log(`[Groq] 制限到達のため定型文にフォールバックします (${speakerName})`);
        else console.error("[Groq API Error]", e?.message || e);
        return ""; 
    }
}