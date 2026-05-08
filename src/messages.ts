// src/messages.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { ROLE_CATALOG, ROLE_SELECT_OPTIONS, getRoleDescription, getShortRoleName, getWinCondition } from './roles';
import * as DB from './db';
import { GameState, Player } from './types';
import { COLORS, UI, MSG, fill, PERSONALITY_TONES, GAYA_DICTIONARY } from './gameConfig';

// ============================================================
// 役職の略称マップ（絵文字は雰囲気に合わせて厳選・トーンダウン）
// ============================================================
const SHORT_ROLE_MAP: Record<string, string> = {
    'seer':        '👁️ 占い師',
    'medium':      '🕯️ 霊能者',
    'guard':       '🛡️ 騎士',
    'madman':      '🎭 狂人',
    'fanatic':     '🩸 狂信者',
    'freemason':   '🔗 共有者',
    'coroner':     '🔍 検死官',
    'mayor':       '👑 市長',
    'tough_guy':   '🩹 タフガイ',
    'fox':         '🦊 妖狐',
    'fugitive':    '💨 逃亡者',
    'teruteru':    '☔ テルテル',
    'cupid':       '🏹 キューピッド',
    'sorcerer':    '👁️‍🗨️ 妖術師',
    'cat':         '🐈‍⬛ 猫又',
    'thief':       '🎩 怪盗',
    'loquacious':  '🐺 饒舌な人狼',
    'devotee':     '誓 純愛者',
    'dictator':    '🗡️ 独裁者',
    'god':         '🕊️ 神',
    'divider':     '🌀 分断者',
    'necromancer': '💀 死霊術師',
    'assassin':    '刺 暗殺者',
};

// ============================================================
// 勝利条件テキスト（少し重厚な表現に）
// ============================================================
const WIN_CONDITION: Record<string, string> = {
    '村人':       '全ての人狼を処刑し、村に平穏を取り戻す',
    '占い師':     '全ての人狼を処刑し、村に平穏を取り戻す',
    '霊能者':     '全ての人狼を処刑し、村に平穏を取り戻す',
    '騎士':       '全ての人狼を処刑し、村に平穏を取り戻す',
    '共有者':     '全ての人狼を処刑し、村に平穏を取り戻す',
    '市長':       '全ての人狼を処刑し、村に平穏を取り戻す',
    'タフガイ':   '全ての人狼を処刑し、村に平穏を取り戻す',
    '逃亡者':     '全ての人狼を処刑し、村に平穏を取り戻す',
    '検死官':     '全ての人狼を処刑し、村に平穏を取り戻す',
    '人狼':       '村人を喰らい尽くし、生存数を人狼と同数以下にする',
    '饒舌な人狼': '村人を喰らい尽くし、生存数を人狼と同数以下にする',
    '忍者':       '村人を喰らい尽くし、生存数を人狼と同数以下にする',
    '分断者':     '村人を喰らい尽くし、生存数を人狼と同数以下にする',
    '狂人':       '自らの命を投げ打ってでも、人狼陣営を勝利に導く',
    '狂信者':     '自らの命を投げ打ってでも、人狼陣営を勝利に導く',
    '妖術師':     '自らの命を投げ打ってでも、人狼陣営を勝利に導く',
    '妖狐':       '人狼にも村人にも与せず、最後まで生き延びる',
    'テルテル':   '村人たちに疑われ、自らが処刑の対象となる',
    'キューピッド': '結ばれた2人が、最後まで共に生き残る',
    '猫又':       '処刑時に道連れを発動しつつ、村人陣営の勝利を目指す',
    '怪盗':       '盗んだ役職の運命に従い、勝利を掴み取る',
    '純愛者':     '己の命を賭して、指定した相手を最後まで生き延びさせる',
    '独裁者':     '強権を発動し処刑を下す。村人陣営の勝利を目指す',
    '神':         '死者を蘇らせ、村人陣営を勝利に導く',
    '死霊術師':   '死者を蘇らせ、人狼陣営を勝利に導く',
    '暗殺者':     '宵闇に紛れて標的を暗殺し、単独での勝利を目指す',
};

// ============================================================
// 参加者プログレスバー（スタイリッシュかつサバイバル感のあるデザイン）
// ============================================================
function buildProgressBar(humanCount: number, npcCount: number, max = 15): string {
    const filled  = '■';
    const npc     = '▨';
    const empty   = '□';
    const total   = humanCount + npcCount;
    
    let bar = '';
    for (let i = 0; i < max; i++) {
        if (i < humanCount)             bar += filled;
        else if (i < humanCount + npcCount) bar += npc;
        else                            bar += empty;
    }
    return `\`${bar.split('').join(' ')}\`\n**集結: ${total} / ${max} 名**`;
}

// ============================================================
// 設定のサマリーテキスト（罫線と余白で読みやすく洗練）
// ============================================================
function buildSettingsSummary(settings: any): string {
    const lines: string[] = [];

    const matchText  = settings.matchType === 'ranked' ? '🏆 ランクマッチ (命懸け)' : '🔰 カジュアル (練習)';
    const wolfText   = settings.wolfMode === 'auto' ? '自動調整' : `${settings.wolfMode} 匹`;
    
    lines.push(`**【 規程 】**`);
    lines.push(`種別　 | ${matchText}`);
    lines.push(`時間　 | ${settings.discussionTime} 秒`);
    lines.push(`人狼　 | ${wolfText}`);

    const roles = settings.roles.map((r: string) => getShortRoleName(r)).join(' / ');
    lines.push(`\n**【 役職 】**\n${roles || '未設定'}`);

    const ruleChips: string[] = [];
    if (settings.voteTransparency === 'public') ruleChips.push('記名投票');
    if (settings.tieVoteHandling  === 'peace')  ruleChips.push('同票平和');
    if (settings.tieVoteHandling  === 'revote') ruleChips.push('決選投票');
    if (settings.continuousGuard)                ruleChips.push('連続護衛可');
    if (settings.firstNightPeace)                ruleChips.push('初日襲撃なし');
    
    if (ruleChips.length) {
        lines.push(`\n**【 特殊法 】**\n${ruleChips.join(' ・ ')}`);
    }

    return lines.join('\n');
}

// ============================================================
// 🏠 ロビー（静寂と緊張感を演出するデザイン）
// ============================================================
export async function getLobbyPayload(game: GameState, userId: string, member?: any) {
    const humanPlayers = game.players.filter((p: Player) => !p.isNpc);
    const npcCount     = game.npcCount;
    const total        = humanPlayers.length + npcCount;

    let playerDisplay: string;
    if (humanPlayers.length === 0 && npcCount === 0) {
        playerDisplay = '*静寂が包んでいる。生贄の到着を待っている……*';
    } else {
        const humanLines = humanPlayers.map((p: Player) => {
            const isHost = p.id === game.hostId;
            return isHost ? `**${p.name}** \`主宰\`` : `**${p.name}**`;
        });

        const all = [...humanLines];
        if (npcCount > 0) all.push(`*NPC (人形) x${npcCount}*`);

        // 2列に綺麗に並べて高級感を出す
        if (all.length <= 6) {
            playerDisplay = all.join('　|　');
        } else {
            const rows: string[] = [];
            for (let i = 0; i < all.length; i += 2) {
                rows.push(all[i] + (all[i + 1] ? '　|　' + all[i + 1] : ''));
            }
            playerDisplay = rows.join('\n');
        }
    }

    const progressBar = buildProgressBar(humanPlayers.length, npcCount);

    const warnings: string[] = [];
    if (game.settings.matchType === 'ranked') {
        const bannedForRanked = ['teruteru', 'cupid', 'cat', 'thief', 'sorcerer', 'baker', 'psycho', 'ninja', 'fox'];
        if (humanPlayers.length < 2)
            warnings.push('⚠️ 人間が2人未満のため、開始時に自動で「練習試合」に切り替わります');
        if (game.settings.roles.some((r: string) => bannedForRanked.includes(r)))
            warnings.push('⚠️ 現在の役職には、ランクマッチで禁じられたものが含まれています');
    }

    const embed = new EmbedBuilder()
        .setTitle('W E R E W O L F   — 宵闇の村 —')
        .setColor(COLORS.LOBBY) // Dark gray or deep red is recommended in gameConfig
        .setDescription(`${progressBar}\n\n―――\n\n${playerDisplay}\n\n―――`)
        .addFields({
            name: '◆ 村の掟',
            value: buildSettingsSummary(game.settings) + (warnings.length ? `\n\n${warnings.join('\n')}` : ''),
            inline: false,
        })
        .setFooter({ text: '血の儀式を始めるには、最低4名の生贄が必要です。' });

    // アクションボタンをスタイリッシュに整理
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('join_leave').setLabel('参加 / 辞退').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('npc_add').setLabel('NPC 追加').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('npc_remove').setLabel('NPC 削除').setStyle(ButtonStyle.Secondary).setDisabled(npcCount === 0),
        new ButtonBuilder().setCustomId('open_settings').setLabel('掟の設定').setStyle(ButtonStyle.Secondary),
    );

    const canStart = total >= 4;
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('game_start').setLabel('▶ 惨劇の幕開け (開始)').setStyle(ButtonStyle.Success).setDisabled(!canStart),
        new ButtonBuilder().setCustomId('lobby_cancel').setLabel('✖ 村の解散').setStyle(ButtonStyle.Danger),
    );

    const isPremium = await DB.isPremiumUser(userId);
    const userPresets = await DB.getPresets(userId).catch(() => []);

    const presetOptions: any[] = [
        { label: '📋 スタンダード',          value: 'preset_standard',  description: '占い師のみ / 遊びやすい標準的な村' },
        { label: '🎲 混沌の渦 (ランダム)',   value: 'preset_random',    description: 'ランダムな役職が入り乱れる予測不能の村' },
        { label: '⚔️ 5人村 ランク',          value: 'preset_ranked_5',  description: '占・狂 / 狼1 / 初日平和 (命懸け)' },
        { label: '🔥 7人村 ランク',          value: 'preset_ranked_7',  description: '占・騎 / 狼2 / 初日平和 (命懸け)' },
        { label: '🏆 9人村 ランク',          value: 'preset_ranked_9',  description: '占・霊・騎・狂 / 狼2 / 初日平和 (標準)' },
        { label: '👑 13人村 ランク',         value: 'preset_ranked_13', description: '上記＋共有者 / 狼3 / 初日平和 (熟練者向け)' },
    ];

    userPresets.slice(0, 5).forEach((p: any) => {
        presetOptions.push({
            label: `💾 記録された村: ${p.name}`,
            value: `load_preset_${p.name}`,
            description: `役職: ${p.settings.roles?.slice(0, 3).map((r: string) => getShortRoleName(r)).join(' / ') || 'なし'}`,
        });
    });

    const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('lobby_preset')
            .setPlaceholder('📦 過去の掟 (プリセット) を呼び出す')
            .addOptions(presetOptions)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

// ============================================================
// ⚙️ 設定コンポーネント
// ============================================================
export function getSettingsComponents(settings: any, currentTab: string = 'basic', isPremium: boolean = false) {
    const basicPreview   = `${settings.matchType === 'ranked' ? 'ランク' : '練習'} / ${settings.discussionTime}秒 / 狼${settings.wolfMode === 'auto' ? '自動' : settings.wolfMode}`;
    const rulePreview    = `${settings.voteTransparency === 'public' ? '記名' : '無記名'} / ${settings.tieVoteHandling === 'peace' ? '平和' : settings.tieVoteHandling === 'revote' ? '決選' : 'ランダム'}`;
    const advPreview     = [settings.firstNightPeace && '初日平和', settings.gayaMode && 'ガヤ', settings.willMode && '遺言'].filter(Boolean).join('・') || '標準';

    const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('tab_basic')
            .setLabel(`基本 (${basicPreview})`)
            .setStyle(currentTab === 'basic' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('tab_rule')
            .setLabel(`規則 (${rulePreview})`)
            .setStyle(currentTab === 'rule' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('tab_advanced')
            .setLabel(`詳細 (${advPreview})`)
            .setStyle(currentTab === 'advanced' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('setting_back')
            .setLabel('✅ 設定完了')
            .setStyle(ButtonStyle.Primary),
    );
    const rows: any[] = [tabRow];

    if (currentTab === 'basic') {
        const matchOptions = [
            { label: '🔰 カジュアル (練習試合)', value: 'casual', default: settings.matchType === 'casual', description: 'レート変動なし。気軽な村' },
            { label: '🏆 ランクマッチ (死闘)', value: 'ranked', default: settings.matchType === 'ranked', description: 'レート変動あり。人間2名以上必須' },
        ];
        const wolfOptions = [
            { label: '🐺 自動調整 (人数依存)', value: 'auto', default: settings.wolfMode === 'auto', description: '4名=1匹 / 6名=2匹 / 11名=3匹' },
            { label: '🐺 1匹の獣', value: '1', default: settings.wolfMode === 1 },
            { label: '🐺🐺 2匹の獣', value: '2', default: settings.wolfMode === 2 },
            { label: '🐺🐺🐺 3匹の獣', value: '3', default: settings.wolfMode === 3 },
        ];
        const timeOptions = [
            { label: '⏳ 30秒 (狂気の沙汰)', value: '30', default: settings.discussionTime === 30 },
            { label: '⏳ 45秒', value: '45', default: settings.discussionTime === 45 },
            { label: '⏳ 60秒 (標準)', value: '60', default: settings.discussionTime === 60 },
            { label: '⏳ 90秒', value: '90', default: settings.discussionTime === 90 },
            { label: '⏳ 120秒 (熟考)', value: '120', default: settings.discussionTime === 120 },
            { label: '⏳ 180秒 (長考)', value: '180', default: settings.discussionTime === 180 },
        ];
        const roleOptions = ROLE_SELECT_OPTIONS.map((opt: any) => ({ ...opt, default: settings.roles.includes(opt.value) }));

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_match_type')
                .setPlaceholder(`🎮 試合種別: 「${settings.matchType === 'ranked' ? 'ランクマッチ' : 'カジュアル'}」`)
                .addOptions(matchOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_roles')
                .setPlaceholder(`🃏 配役: 「${settings.roles.map((r: string) => getShortRoleName(r)).join(', ') || 'なし'}」`)
                .setMinValues(1).setMaxValues(roleOptions.length).addOptions(roleOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_wolves')
                .setPlaceholder(`🐺 人狼数: 「${settings.wolfMode === 'auto' ? '自動' : settings.wolfMode + '匹'}」`)
                .addOptions(wolfOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_time')
                .setPlaceholder(`⏳ 議論時間: 「${settings.discussionTime}秒」`)
                .addOptions(timeOptions)
        ));

    } else if (currentTab === 'rule') {
        const voteOptions = [
            { label: '📢 記名投票 (誰が誰を殺そうとしたか公開)', value: 'public', default: settings.voteTransparency === 'public', description: '投票先が全員に露見する' },
            { label: '🔒 無記名投票 (闇に紛れて投票)', value: 'anonymous', default: settings.voteTransparency === 'anonymous', description: '集計された票数のみが公開される' },
        ];
        const tieOptions = [
            { label: '🕊️ 平和 (同票時は誰も死なない)', value: 'peace', default: settings.tieVoteHandling === 'peace', description: '血は流れない' },
            { label: '🔁 決選投票 (同票者で再投票)', value: 'revote', default: settings.tieVoteHandling === 'revote', description: '決着がつくまでやり直す' },
            { label: '🎲 運命のダイス (ランダムに処刑)', value: 'random', default: settings.tieVoteHandling === 'random', description: '神の気まぐれで誰かの首が飛ぶ' },
        ];
        const guardOptions = [
            { label: '🛡️ 連続護衛あり (同じ命を連続で守れる)', value: 'true', default: settings.continuousGuard === true, description: '前日と同じ対象を守備可能' },
            { label: '🛡️ 連続護衛なし (同じ命は守れない)', value: 'false', default: settings.continuousGuard === false, description: '前日と同じ対象は守れない' },
        ];

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_vote_transparency')
                .setPlaceholder(`📋 投票公開: 「${settings.voteTransparency === 'public' ? '記名' : '無記名'}」`)
                .addOptions(voteOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_tie_vote')
                .setPlaceholder(`⚖️ 同票処理: 「${settings.tieVoteHandling === 'peace' ? '平和' : settings.tieVoteHandling === 'revote' ? '決選' : 'ランダム'}」`)
                .addOptions(tieOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_continuous_guard')
                .setPlaceholder(`🛡️ 連続護衛: 「${settings.continuousGuard ? '許可' : '禁止'}」`)
                .addOptions(guardOptions)
        ));

    } else if (currentTab === 'advanced') {
        const nightOptions = [
            { label: '🌕 初日襲撃あり (開幕から血が流れる)', value: 'false', default: settings.firstNightPeace === false, description: '1日目の夜から容赦なく襲撃可能' },
            { label: '🌙 初日襲撃なし (静かな立ち上がり)', value: 'true', default: settings.firstNightPeace === true, description: '1日目は誰も死なない（競技向け）' },
        ];
        const advancedOptions = [
            { label: '⚡ 全員投票で即時処刑', value: 'autofinish', default: settings.autoFinishVoting, description: '全員の意思が固まれば時間を待たずに処刑' },
            { label: '💬 NPCの自律発言 (ガヤ)', value: 'gaya', default: settings.gayaMode, description: 'NPCが議論中に勝手に喋り出す' },
            { label: '📜 遺言システム', value: 'will', default: settings.willMode, description: '処刑される者が20秒だけ最後に言葉を残せる' },
            { label: '🎯 饒舌モード (人狼に枷)', value: 'loquacious', default: settings.loquaciousMode, description: '人狼は指定されたワードを喋らなければ死ぬ' },
        ];

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_first_night')
                .setPlaceholder(`🌙 初日襲撃: 「${settings.firstNightPeace ? 'なし (平和)' : 'あり'}」`)
                .addOptions(nightOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_advanced')
                .setPlaceholder('📦 その他の特殊な掟 (複数選択可)')
                .setMinValues(0).setMaxValues(advancedOptions.length)
                .addOptions(advancedOptions)
        ));
    }

    return rows;
}

// ============================================================
// 🎴 役職カード（高級感と泥臭さを両立させたDM通知）
// ============================================================
export function createRoleCard(player: Player, alliesNames: string[], partnerName: string | null) {
    const roleData = ROLE_CATALOG[player.role || ''] || { icon: '❓', team: 'villager' };

    let cardColor = COLORS.VILLAGER;
    let teamName  = '村人陣営 (光を求める者)';
    if (roleData.team === 'wolf')  { cardColor = COLORS.WOLF;  teamName = '人狼陣営 (闇に潜む者)'; }
    if (roleData.team === 'third') { cardColor = COLORS.THIRD; teamName = '第三陣営 (孤高の存在)'; }

    let desc = `*${getRoleDescription(player.role || '')}*\n\n`;

    if (['人狼', '饒舌な人狼', '忍者'].includes(player.role || '')) {
        const allyStr = alliesNames.length ? alliesNames.join(' / ') : 'なし (孤独な一匹狼)';
        desc += `**【 血の盟友 】**\n${allyStr}\n\n`;
    } else if (player.role === '狂信者') {
        const allyStr = alliesNames.length ? alliesNames.join(' / ') : '不明';
        desc += `**【 崇拝する主 】**\n${allyStr}\n\n`;
    }

    if (partnerName) {
        desc += `**【 呪われた愛 】**\nあなたの運命の相手は **${partnerName}** です。\n一方が命を落とせば、絶望のあまりあなたも後を追って自害します。\n\n`;
    }

    const winCond = WIN_CONDITION[player.role || ''] || getWinCondition(player.role || '');

    return new EmbedBuilder()
        .setAuthor({ name: `所属: ${teamName}` })
        .setTitle(`【 汝の宿命 : ${player.role} 】`)
        .setDescription(`―― 闇夜に蠢く者たちよ、生き残りを懸けよ ――\n\n${desc}―――`)
        .addFields({ name: '◆ 生き残るための道 (勝利条件)', value: winCond, inline: false })
        .setColor(cardColor)
        .setFooter({ text: '※この情報は決して他言無用。己の内に秘めて戦い抜け。' });
}

// ============================================================
// ゲーム中ガヤ発言ヘルパー（オリジナルを踏襲）
// ============================================================
const FALLBACK_TONE = {
    attacking: ['${t}が怪しいんじゃないか？', '${t}の動き、どうも納得できないな。'],
    defensive: ['俺を疑うなんてどうかしてるぜ！', 'ちょっと待ってくれ、俺じゃない！'],
    neutral:   ['うーん、難しいな…', '誰が人狼なんだろうな。', '慎重に行こうぜ。']
};

export function getDynamicGayaPhrase(situation: string, personality = 'normal', targetName: string | null = null) {
    const t = targetName || 'あの人';
    
    const toneData = GAYA_DICTIONARY[personality] || GAYA_DICTIONARY['normal'] || FALLBACK_TONE as any;
    const phrases  = toneData[situation] || toneData['neutral'] || FALLBACK_TONE[situation as keyof typeof FALLBACK_TONE] || FALLBACK_TONE.neutral;
    
    const rawPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    return rawPhrase.replace('${t}', t);
}

// ============================================================
// ボタン・セレクトメニュー生成ヘルパー群
// ============================================================
export function createButtonRows(players: any[], actionType: string, style = ButtonStyle.Secondary) {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    players.forEach((p, i) => {
        currentRow.addComponents(
            new ButtonBuilder().setCustomId(`${actionType}_${p.id}`).setLabel(p.name).setStyle(style)
        );
        if ((i + 1) % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder<ButtonBuilder>(); }
    });
    if (currentRow.components.length > 0) rows.push(currentRow);
    return rows;
}

export function createNightActionRows(players: any[], actionType: string, roleName: string) {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (roleName === '占い師' || roleName === '偽占い') {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('strategy_co').setLabel(UI.night.coButton).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('strategy_hide').setLabel(UI.night.hideModeButton).setStyle(ButtonStyle.Secondary),
        ));
    }
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    players.forEach((p, i) => {
        currentRow.addComponents(
            new ButtonBuilder().setCustomId(`${actionType}_${p.id}`).setLabel(p.name).setStyle(ButtonStyle.Secondary)
        );
        if ((i + 1) % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder<ButtonBuilder>(); }
    });
    if (currentRow.components.length > 0) rows.push(currentRow);
    return rows;
}

export function createFakeResultRows(targetId: string, targetName: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`fakeresult_white_${targetId}`).setLabel(fill(UI.night.fakeSeerWhiteBtn, { name: targetName })).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`fakeresult_black_${targetId}`).setLabel(fill(UI.night.fakeSeerBlackBtn, { name: targetName })).setStyle(ButtonStyle.Danger),
    )];
}

export function createMediumPublishRow(targetId: string, targetName: string, executedRole: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`medium_publish_${targetId}_${executedRole}`)
            .setLabel(fill(UI.night.mediumPublishBtn, { name: targetName }))
            .setStyle(ButtonStyle.Primary),
    )];
}

export function getCupidSelection(players: any[]) {
    const options = players.map(p => ({ label: p.name, value: p.id }));
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cupid_select')
            .setPlaceholder('💘 結びつける2人の魂を選んでください')
            .setMinValues(2).setMaxValues(2)
            .addOptions(options)
    )];
}

// ============================================================
// 安全送信ヘルパー
// ============================================================
export async function safeDM(user: any, content: any): Promise<boolean> {
    if (!user || typeof user.send !== 'function') return false;
    try { await user.send(content); return true; }
    catch (e: any) { console.log(`[SafeDM] 遮断: ${user.username} - ${e.message}`); return false; }
}

export async function safeSend(channel: any, content: any): Promise<any> {
    if (!channel || typeof channel.send !== 'function') return null;
    try { return await channel.send(content); }
    catch (e: any) { console.error(`[SafeSend] エラー: ${e.message}`); return null; }
}
