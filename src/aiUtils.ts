// src/aiUtils.ts
import { GoogleGenAI } from '@google/genai';
import { GameState, Player } from './types';
import * as Roles from './roles';
import Groq from 'groq-sdk';

const groqApiKey = process.env.GROQ_API_KEY;
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

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
3. だらだらと長く話さず、Discordのチャットで読みやすい【50〜100文字程度】で、キレのあるコメントにまとめること。
4. 【重要】もしMVP情報に「特筆すべき護衛成功なし」と記載がある場合、絶対に「味方を守った」「護衛が素晴らしかった」などの嘘の事実を捏造して褒めないでください。「最後まで生き残って勝利に貢献した」など別の観点で評価してください。`;

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
// 🤖 NPC性格設定マップ（軽量化＆個別最適化版）
// ============================================================
const NPC_PERSONALITY_MAP: Record<string, string> = {
    aggressive: `一人称は「俺」のタメ口。気が短く、納得できない意見には少し語気が強くなる。
ただし毎回怒鳴るわけではなく、普段は普通に議論に参加する。
疑われたり追い詰められた場面で初めて感情が出る程度。`,

    witty: `丁寧語だが、どこか余裕ぶった口調。論理的な指摘は得意だが、それも自然な会話の流れで出てくる程度。
常に見下しているわけではなく、普通に話せるときは普通に話す。`,

    serious: `丁寧語で落ち着いたトーン。感情より根拠を重視するタイプ。
ただし確率論を延々語るのではなく、端的に自分の意見を述べる普通の参加者。`,

    normal: `タメ口と丁寧語が混じった普通の話し方。特定のキャラ付けはなく、普通に推理して会話する一般参加者。
やや慎重な性格で、確信がないことは「〜かな？」「どうだろう」と曖昧に言う程度。`,

    sans: `一人称は「オイラ」、語尾は「〜だぜ」「〜だな」。気怠げでマイペース。
ゲームをどこか俯瞰しているが、普通に推理も参加する。特に盛り上がったときだけメタな発言が漏れる程度。`,

    jax: `一人称は「僕」のタメ口。ちょっと軽薄で掴みどころがないが、普通に会話はできる。
場が荒れたときに茶化したくなるが、基本は普通の参加者として振る舞う。`,

    ninja: `一人称は「オレ」。元気でやや直感的なタイプ。「〜だってばよ！」は特に熱くなったときだけ出る。
普段は普通に意見を言い、たまに勢いで外れた推理をする程度。`,

    chuuni: `一人称は「我」。少し大袈裟な言い回しをしがちだが、普通の推理もできる。
盛り上がったときや処刑のタイミングでたまに厨二っぽい言葉が出る程度。`,

    dio: `一人称は「このDIO」または「私」。尊大な物言いをすることがあるが、普段は普通に会話する。
意見を否定されたときや局面が動いたときに少し高圧的な口調になる程度。`,

    ryu: `一人称は「俺」のタメ口。人狼ゲームに慣れた普通の参加者。
表面的な発言より「発言のタイミングや矛盾」を気にするタイプで、自分の直感を自然に言葉にする。
同意するだけでなく別の視点をさりげなく出すことがある。`
}

// src/aiUtils.ts (抜粋・修正)

// ============================================================
// 🤖 NPCガヤ発言の動的生成（役職騙り対応版）
// ============================================================
export async function generateNpcGaya(
    speakerName: string,
    personality: string,
    category: string,
    targetName: string | null,
    reasonType: string,
    chatLog: string[],
    myRole: string = '不明',
    claimedRole: string = '潜伏', // 👈 これを追加
    rolesInGame: string = '不明'
): Promise<string> {
    if (!groq) return "";
    const pDesc = NPC_PERSONALITY_MAP[personality] || NPC_PERSONALITY_MAP['normal'];
    const logText = chatLog.length > 0 ? chatLog.join('\n') : "(まだ誰も発言していない)";

    const messages = [
        { 
            role: 'system' as const, 
            content: `あなたはDiscord上の人狼ゲーム参加者「${speakerName}」です。

【あなたの設定】
${pDesc}

【あなた自身の真の役職】
${myRole}

【あなたが周りに主張している（騙っている）役職】
${claimedRole !== '潜伏' ? claimedRole : 'まだ何も役職を公表していない（村人や潜伏役職のフリ）'}

【絶対ルール】
1. セリフのみ出力（括弧や地の文は厳禁）。1〜2文、最大60文字程度で短く。
2. 直前の【会話ログ】を読み取り、誰が何を言ったか、誰が疑われているかを踏まえて返信すること。
3. 特に人間プレイヤーの発言に対しては、肯定・否定・ツッコミなどを行い、積極的に「会話」を成立させること。独り言は禁止。
4. システム上の自分の本当の役職は絶対に発言しないこと。
5. 自分が持っていない能力（占い・霊能・護衛など）を使ったかのような発言は絶対にしないこと。他のプレイヤーの能力結果に対しては、あくまで一般参加者として反応すること。` 
        },
        { 
            role: 'user' as const, 
            content: `【この村の役職構成】
${rolesInGame}

【これまでの会話ログ】
${logText}

【今回の発言の動機（システム指示）】
・行動: ${category}
・対象者: ${targetName || '特になし'}
・理由: ${reasonType}

上記の「会話ログ」と「システム指示」を元に、あなたの個性と騙っている役職全開でチャットを1つ発言してください。` 
        }
    ];

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7, 
            max_tokens: 80,
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "";
    } catch (e: any) {
        return ""; 
    }
}

// ============================================================
// 🐺 AI機能: 人狼の隠れ家での作戦会議チャット
// ============================================================
export async function generateWolfChatReply(
    speakerName: string,
    personality: string,
    chatLog: string[],
    rolesInGame: string
): Promise<string> {
    if (!groq) return "（無言で頷く）";
    const pDesc = NPC_PERSONALITY_MAP[personality] || NPC_PERSONALITY_MAP['normal'];
    const logText = chatLog.join('\n');

    const messages = [
        { 
            role: 'system' as const, 
            content: `あなたはDiscord上の人狼ゲーム参加者「${speakerName}」です。陣営は人狼陣営です。
ここは仲間の人狼（人間プレイヤー）との秘密の作戦会議チャットです。

【あなたの設定】
${pDesc}

【絶対ルール】
1. セリフのみ出力。1〜3文で短く的確に返すこと。
2. 仲間（人間）の提案や質問に対して、あなたなりの意見や作戦の返事をすること。
3. あなたの性格設定の口調を完璧に守ること。` 
        },
        { 
            role: 'user' as const, 
            content: `【この村の役職構成】
${rolesInGame}

【直近の会話】
${logText}

上記の会話に対して、人間への返答を発言してください。` 
        }
    ];

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages, model: 'llama-3.3-70b-versatile', temperature: 0.8, max_tokens: 100,
        });
        return chatCompletion.choices[0]?.message?.content?.trim() || "（ニヤリと笑う）";
    } catch (e: any) {
        return "（静かに頷く）"; 
    }
}
