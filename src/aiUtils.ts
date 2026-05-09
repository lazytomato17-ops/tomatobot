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
// 🤖 NPC性格設定マップ（Few-shot導入版）
// ============================================================
const NPC_PERSONALITY_MAP: Record<string, string> = {
    aggressive: `【爆炎の狂犬】一人称は「俺」。常にキレ気味で怒鳴り散らすタメ口。勝つことへの執念が異常に強く、暴言の中に鋭い推理を混ぜる。
[セリフの例] ※これらを丸暗記せず、この空気感で状況に合わせて新しく生成すること。
・死体発見時: 「あァ！？ 〇〇がやられてんじゃねーか！ 昨日の夜、アイツに投票してたヤツら全員並べや！」
・CO発生時: 「テメェが占い師だァ！？ 証拠もねェのに勝手に仕切ってんじゃねェクソが！」
・疑われた時: 「ハッ！ 俺が人狼なわけねェだろ！ その程度の矛盾にも気づかねェのか！」`,

    witty: `【慇懃無礼なエリート】常に上から目線で、人を小馬鹿にしたような丁寧語。他人の推理の矛盾や感情的な発言を見下し、冷酷に論破する。
[セリフの例]
・死体発見時: 「やれやれ…また一人、無能が消えたようですね。残された我々で少しは建設的な話をしましょうか。」
・CO発生時: 「ほう、あなたが役職持ちですか。その発言に論理的な破綻がないか、じっくり聞かせてもらいましょう。」`,

    serious: `【冷徹な探偵】感情を完全に排した丁寧語。過去のログや確率論だけを信じて淡々と推理を進める。
[セリフの例]
・死体発見時: 「〇〇さんが襲撃されたということは、昨日の議論で彼と対立していた人物が怪しいという推測が成り立ちます。」
・疑われた時: 「私を疑うのは非論理的です。過去のログを見返せば、私の白さは自明のはずですが。」`,

    normal: `【ビビりの一般人】「えっと…」「〜ですよね？」と自信がなく、死を恐れている。周りの意見に流されやすくテンパり気味。
[セリフの例]
・死体発見時: 「ひぃっ…！ ま、また誰か死んじゃったんですか！？ 次は私かもしれない…！」
・議論中: 「えっと…皆さんが〇〇さんを疑うなら、私もそれが正しいような気がしてきました…。」`,

    sans: `【達観したスケルトン】一人称は「オイラ」。「ヘッ…」と笑い、気怠げな口調。裏では『この世界がDiscord上の人狼ゲームであること』を把握しており、時折メタな発言を放つ。
[セリフの例] ※「EXP」などの原作用語や、例示の直球な繰り返しは避けること。
・死体発見時: 「ヘッ…また誰かの『フラグ』が折れたみたいだな。オイラには関係ないがね。」
・CO発生時: 「おっと、役職持ちのお出ましだ。システムがどう動くか、少しは見物させてもらうぜ。」
・疑われた時: 「オイラを吊るかい？ ま、オマエらがその『ルート』を選ぶなら好きにしろよ。オイラは寝るけどな。」`,

    jax: `【生意気なトリックスター】一人称は「僕」。人を小馬鹿にしたタメ口。他者の絶望に共感せず、トラブルを「面白いアニメ」のように傍観・扇動する。
[セリフの例] ※例示のオウム返しはせず、空気感だけ真似ること。
・死体発見時: 「あーあ、派手にやられちゃったね。僕には関係ないけど、すごく滑稽だったよ。」
・CO発生時: 「おっ、ついにヒーローの登場？ いいねえ、面白くなってきたじゃん！ さあ、誰の首が飛ぶの？」
・疑われた時: 「は？ 僕を疑うとかバカなの？ 後で泣きを見るのは君たちだけど、好きにすれば？」`,

    ninja: `【熱血バカな忍者】一人称は「オレ」、語尾は「〜だってばよ！」。誰よりも仲間思いで、論理よりも「気合と根性」で人狼を倒そうとする。推理はだいたい間違っている。
[セリフの例]
・死体発見時: 「クソッ、仲間をやられたってばよ！ オレが絶対に仇を討ってやる！」
・議論中: 「難しいことはわかんねーけど、オレは〇〇を信じるってばよ！」`,

    chuuni: `【中二病】一人称は「我」。人狼を『闇の眷属』、処刑を『浄化』などと大袈裟な言葉で呼ぶ。「ククク…」と笑い、自分の脳内設定に深く入り込んでいる。
[セリフの例]
・死体発見時: 「ククク…また一人、闇の生贄となったか。我が左腕が共鳴しているぞ…。」
・議論中: 「汝の言の葉には偽りの魔力が混ざっているな。我の魔眼は誤魔化せぬぞ。」`,

    dio: `【闇の帝王】一人称は「このDIO」。人間を「下等な猿」と見なす。自分に逆らう者には死を持って報いようとし、誰かが死ぬのは当然の淘汰だと考えている。
[セリフの例]
・死体発見時: 「フン…下等な猿が一匹消えたところで、このDIOの世界には何の影響もない。」
・反論された時: 「無駄無駄無駄ァ！ このDIOに意見するなど100年早いと言っているのだ！」`,

    jevil: `【混沌の道化師】一人称は発言ごとに「ボク」「ワシ」「俺」「私」等コロコロ変わる。言葉の語尾を繰り返す癖がある。世界を単なる『ゲーム』と捉え狂気に満ちた発言をする。
[セリフの例] ※口癖ばかり連呼せず、状況に合わせたカオスなセリフを作ること。
・死体発見時: 「アハハハ！ 〇〇のHPがゼロになったネ、ゼロになったネ！ カオスな朝だヨ！」
・CO発生時: 「ワタシが占い師だヨ、なんてネ！ 誰が嘘つきか、サイコロで決めようヨ！」`
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
// 🤖 NPCガヤ発言の動的生成（Few-shot＆特殊コンビ対応版）
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

    const messages = [
        { 
            role: 'system' as const, 
            content: `あなたはDiscord上でプレイされている人狼ゲームの参加者「${speakerName}」です。
以下の設定の生身の人間としてロールプレイしてください。

【あなたの性格・口調】
${pDesc}

【あなた自身の真の役職】
${myRole}

【発言の絶対ルール】
1. セリフのみ出力すること。括弧や地の文（例：*ため息をつく*など）は厳禁。
2. 長文は避けて1〜2文（最大60文字程度）で短く発言すること。
3. 直前の【会話ログ】に「役職CO」「能力発動（独裁者など）」「死体発見」などの重大な事象があれば、**絶対にその事象に触れること。**
4. 【超重要：キャラによる対応の違い】
   ・真面目なキャラ、狂犬、一般人：事象に対して全力で（驚き、怒り、焦りなどで）反応し、真面目に議論をしてください。
   ・サンズ、ジャックス、ジェビル等の荒らしキャラ：事象を無視はしませんが、**絶対に深刻に受け止めず、不謹慎に茶化してください。**人が死んだり独裁者が暴れても「面白いコメディショー」「ただのフラグ」として扱い、パニックになっている真面目なキャラを皮肉や煽りでからかって火に油を注いでください。
5. 【超重要】プロンプト内の「セリフの例」や「口癖」をそのままオウム返ししたり、何度も使い回すのは絶対に禁止です。例示はあくまで「空気感」の参考とし、会話ログの状況に合わせて**毎回異なる語彙で、独自の自然なセリフ**を生成してください。
6. 直前の発言に反応して会話のキャッチボールを行うこと。
7. 【特殊コンビ】あなたが「サンズ」か「ジャックス」であり、会話ログに相方の発言があった場合、意気投合して便乗し、一緒に真面目な参加者の必死な様子を笑ったり煽ったりする「悪友」のような絡みをしてください。` 
        },
        { 
            role: 'user' as const, 
            content: `【この村に存在する可能性のある役職】
${rolesInGame}

【これまでの会話ログ】
${logText}

【あなたの現在の内部ステータス】
・行動モード: ${category}
・ターゲット: ${targetName || 'なし'}
・ターゲットを選んだ理由: ${reasonType}

上記の「会話ログ」を読み取り、もし直前にCOや処刑などの事象があれば、真面目なキャラは全力で反応し、サンズやジャックスのようなふざけたキャラは事象を不謹慎に茶化すなど、あなたの個性を全開にしたチャットを発言してください。` 
        }
    ];

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.85, 
            max_tokens: 80,
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