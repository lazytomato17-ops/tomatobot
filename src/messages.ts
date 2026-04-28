// src/messages.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { ROLE_CATALOG, ROLE_SELECT_OPTIONS, getRoleDescription, getShortRoleName, getWinCondition } from './roles';
import * as DB from './db';
import { GameState, Player } from './types';
import { COLORS, UI, MSG, fill, PERSONALITY_TONES, GAYA_DICTIONARY } from './gameConfig';

// ============================================================
// ロビー表示用の「絵文字＋略称」マップ
// ============================================================
const SHORT_ROLE_MAP: Record<string, string> = {
    'seer':        '🔮占い師',
    'medium':      '👻霊能者',
    'guard':       '🛡️騎士',
    'madman':      '🎭狂人',
    'fanatic':     '🕯️狂信者',
    'freemason':   '🔗共有者',
    'coroner':     '🔍検死官',
    'mayor':       '👑市長',
    'tough_guy':   '❤️‍🩹タフガイ',
    'fox':         '🦊妖狐',
    'fugitive':    '💨逃亡者',
    'teruteru':    '☔テルテル',
    'cupid':       '🏹キューピッド',
    'sorcerer':    '👁️妖術師',
    'cat':         '🐈‍⬛猫又',
    'thief':       '🎩怪盗',
    'loquacious':  '🐺饒舌狼',
    'devotee':     '❤️‍🔥純愛者',
    'dictator':    '🗡️独裁者',
    'god':         '🕊️神',
    'divider':     '🌀分断者',
    'necromancer': '💀死霊術師',
    'assassin':    '🌒暗殺者',
};

// 役職ごとの勝利条件テキスト
const WIN_CONDITION: Record<string, string> = {
    '村人':       '人狼を全員処刑すると村人陣営の勝利',
    '占い師':     '人狼を全員処刑すると村人陣営の勝利',
    '霊能者':     '人狼を全員処刑すると村人陣営の勝利',
    '騎士':       '人狼を全員処刑すると村人陣営の勝利',
    '共有者':     '人狼を全員処刑すると村人陣営の勝利',
    '市長':       '人狼を全員処刑すると村人陣営の勝利',
    'タフガイ':   '人狼を全員処刑すると村人陣営の勝利',
    '逃亡者':     '人狼を全員処刑すると村人陣営の勝利',
    '検死官':     '人狼を全員処刑すると村人陣営の勝利',
    '人狼':       '村人と同数以上になると人狼陣営の勝利',
    '饒舌な人狼': '村人と同数以上になると人狼陣営の勝利',
    '忍者':       '村人と同数以上になると人狼陣営の勝利',
    '分断者':     '村人と同数以上になると人狼陣営の勝利',
    '狂人':       '人狼陣営が勝利すると狂人も勝利',
    '狂信者':     '人狼陣営が勝利すると狂信者も勝利',
    '妖術師':     '人狼陣営が勝利すると妖術師も勝利',
    '妖狐':       '処刑されずにゲームが終わると妖狐の勝利',
    'テルテル':   '処刑されると雨が降り、テルテルボウズの負け',
    'キューピッド': '恋人2人が最後まで生き残ると恋人勝利',
    '猫又':       '処刑時に道連れ発動。村人陣営が勝利すると勝利',
    '怪盗':       '怪盗は盗んだ役職に応じて勝利条件が変わる',
    '純愛者':     '指定した相手が生存している間は生き続ける',
    '独裁者':     '一度だけ投票を無効化して即処刑できる',
    '神':         '一度だけ死者を蘇生できる。村人陣営が勝利すると勝利',
    '死霊術師':   '一度だけ死者を蘇生できる。人狼陣営が勝利すると勝利',
    '暗殺者':     '一度だけ任意の相手を暗殺できる。第三陣営として単独で勝利を目指す',
};

// ============================================================
// 参加者プログレスバーを生成するヘルパー
// ============================================================
function buildProgressBar(humanCount: number, npcCount: number, max = 15): string {
    const filled  = '█';
    const npc     = '▒';
    const empty   = '░';
    const total   = humanCount + npcCount;
    let bar = '';
    for (let i = 0; i < max; i++) {
        if (i < humanCount)             bar += filled;
        else if (i < humanCount + npcCount) bar += npc;
        else                            bar += empty;
    }
    return `\`${bar}\` **${total} / ${max}名**`;
}

// ============================================================
// 設定のサマリーテキストを生成するヘルパー
// ============================================================
function buildSettingsSummary(settings: any): string {
    const lines: string[] = [];

    // 行1: 基本
    const wolfText   = settings.wolfMode === 'auto' ? '🐺 自動' : `🐺 ${settings.wolfMode}名`;
    const timeText   = `⏱ ${settings.discussionTime}秒`;
    const matchText  = settings.matchType === 'ranked' ? '🏆 ランク' : '🔰 練習';
    lines.push(`${matchText}　${timeText}　${wolfText}`);

    // 行2: 役職
    const roles = settings.roles.map((r: string) => getShortRoleName(r)).join('  ');
    lines.push(roles || '役職なし');

    // 行3: ルール詳細（非デフォルト設定のみ）
    const ruleChips: string[] = [];
    if (settings.voteTransparency === 'public')   ruleChips.push('📝 記名投票');
    if (settings.tieVoteHandling  === 'peace')    ruleChips.push('🕊️ 同票平和');
    if (settings.tieVoteHandling  === 'revote')   ruleChips.push('🔁 決選投票');
    if (settings.continuousGuard)                  ruleChips.push('🛡️ 連続護衛');
    if (settings.firstNightPeace)                  ruleChips.push('🌙 初日平和');
    if (!settings.autoFinishVoting)                ruleChips.push('⏳ 時間制投票');
    if (settings.gayaMode)                         ruleChips.push('💬 ガヤあり');
    if (settings.willMode)                         ruleChips.push('📜 遺言あり');
    if (settings.loquaciousMode)                   ruleChips.push('🎯 饒舌モード');
    if (ruleChips.length) lines.push(ruleChips.join('  '));

    return lines.join('\n');
}

// ============================================================
// 🏠 ロビー
// ============================================================
export async function getLobbyPayload(game: GameState, userId: string, member?: any) {
    const humanPlayers = game.players.filter((p: Player) => !p.isNpc);
    const npcCount     = game.npcCount;
    const total        = humanPlayers.length + npcCount;

    // ── 参加者表示 ──
    let playerDisplay: string;
    if (humanPlayers.length === 0 && npcCount === 0) {
        playerDisplay = UI.lobby.waitingMessage;
    } else {
        const humanLines = humanPlayers.map((p: Player) => {
            const icon = p.id === game.hostId ? '👑' : '👤';
            return `${icon} **${p.name}**`;
        });

        // --- ここから変更 ---
        // NPCが邪魔にならないよう、1つの要素にまとめて表示します
        const all = [...humanLines];
        if (npcCount > 0) {
            all.push(`🤖 **NPC: ${npcCount}名**`);
        }

        // 6名以下はインライン、7名以上は2列グリッド
        if (all.length <= 6) {
            playerDisplay = all.join('　');
        } else {
            // 2列に並べる
            const rows: string[] = [];
            for (let i = 0; i < all.length; i += 2) {
                rows.push(all[i] + (all[i + 1] ? '　' + all[i + 1] : ''));
            }
            playerDisplay = rows.join('\n');
        }
    }

    // ── 進捗バー ──
    const progressBar = buildProgressBar(humanPlayers.length, npcCount);

    // ── ランクマッチ警告 ──
    const warnings: string[] = [];
    if (game.settings.matchType === 'ranked') {
        const bannedForRanked = ['teruteru', 'cupid', 'cat', 'thief', 'sorcerer', 'baker', 'psycho', 'ninja', 'fox'];
        if (humanPlayers.length < 2)
            warnings.push('⚠️ 人間が2人未満のため、開始時に自動で「練習試合」になります');
        if (game.settings.roles.some((r: string) => bannedForRanked.includes(r)))
            warnings.push('⚠️ ランク不可の役職が含まれています');
    }

    // ── Embed 構築 ──
    const embed = new EmbedBuilder()
        .setTitle('🐺 人狼ゲーム — 招集中')
        .setColor(COLORS.LOBBY)
        .setDescription(
            `${progressBar}\n\n${playerDisplay}`
        )
        .addFields({
            name: '⚙️ ルール設定',
            value: buildSettingsSummary(game.settings) + (warnings.length ? `\n\n${warnings.join('\n')}` : ''),
            inline: false,
        })
        .setFooter({ text: '参加ボタンで参加・退出 ｜ 最低4名でゲーム開始可能' });

    // ── ボタン行 ──
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('join_leave').setLabel('🚪 参加 / 退出').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('npc_add').setLabel('🤖 NPC+').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('npc_remove').setLabel('🤖 NPC-').setStyle(ButtonStyle.Secondary)
            .setDisabled(npcCount === 0),
        new ButtonBuilder().setCustomId('open_settings').setLabel('⚙️ 詳細設定').setStyle(ButtonStyle.Secondary),
    );

    const canStart = total >= 4;
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('game_start').setLabel('▶️ ゲーム開始').setStyle(ButtonStyle.Success)
            .setDisabled(!canStart),
        new ButtonBuilder().setCustomId('lobby_cancel').setLabel('🗑️ 解散').setStyle(ButtonStyle.Danger),
    );

    // ── プリセット選択ドロップダウン（ホスト向け） ──
    const isPremium = await DB.isPremiumUser(userId);
    const userPresets = await DB.getPresets(userId).catch(() => []);

    const presetOptions: any[] = [
        { label: '📋 スタンダード（標準設定）',              value: 'preset_standard',  description: '役職: 占い師のみ / 自動人狼 / カジュアル' },
        { label: '⚔️ 5人村 ランクマッチ',                    value: 'preset_ranked_5',  description: '占い師+狂人 / 狼1名 / 初日平和' },
        { label: '🔥 7人村 ランクマッチ',                    value: 'preset_ranked_7',  description: '占い師+騎士 / 狼2名 / 初日平和' },
        { label: '🏆 9人村 ランクマッチ（標準）',             value: 'preset_ranked_9',  description: '占い師+霊能+騎士+狂人 / 狼2名 / 初日平和' },
        { label: '👑 13人村 ランクマッチ',                   value: 'preset_ranked_13', description: '上記 + 共有者 / 狼3名 / 初日平和' },
    ];

    // ユーザー保存プリセットも最大5件まで追加
    userPresets.slice(0, 5).forEach((p: any) => {
        presetOptions.push({
            label: `💾 ${p.name}`,
            value: `load_preset_${p.name}`,
            description: `保存済みプリセット: ${p.settings.roles?.slice(0, 3).map((r: string) => getShortRoleName(r)).join(' / ') || 'なし'}`,
        });
    });

    const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('lobby_preset')
            .setPlaceholder('📦 プリセットを呼び出す（ホスト専用）')
            .addOptions(presetOptions)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

// ============================================================
// ⚙️ 設定コンポーネント
// ============================================================
export function getSettingsComponents(settings: any, currentTab: string = 'basic', isPremium: boolean = false) {
    // タブごとに現在値をプレビュー表示
    const basicPreview   = `${settings.matchType === 'ranked' ? '🏆ランク' : '🔰練習'} /${settings.discussionTime}秒 /🐺${settings.wolfMode === 'auto' ? '自動' : settings.wolfMode}`;
    const rulePreview    = `${settings.voteTransparency === 'public' ? '記名' : '無記名'} / ${settings.tieVoteHandling === 'peace' ? '平和' : settings.tieVoteHandling === 'revote' ? '決選' : 'ランダム'}`;
    const advPreview     = [settings.firstNightPeace && '初日平和', settings.gayaMode && 'ガヤ', settings.willMode && '遺言'].filter(Boolean).join('/') || '標準';

    const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('tab_basic')
            .setLabel(`基本 (${basicPreview})`)
            .setStyle(currentTab === 'basic' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('tab_rule')
            .setLabel(`ルール (${rulePreview})`)
            .setStyle(currentTab === 'rule' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('tab_advanced')
            .setLabel(`詳細 (${advPreview})`)
            .setStyle(currentTab === 'advanced' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('setting_back')
            .setLabel('✅ 完了')
            .setStyle(ButtonStyle.Primary),
    );
    const rows: any[] = [tabRow];

    if (currentTab === 'basic') {
        const matchOptions = [
            { label: '🔰 練習試合（レート変動なし）',              value: 'casual',  default: settings.matchType === 'casual',  description: '気軽に楽しめる。人数・役職制限なし' },
            { label: '🏆 ランクマッチ（レート変動あり）',           value: 'ranked',  default: settings.matchType === 'ranked',  description: '人間2名以上必須。一部役職使用不可' },
        ];
        const wolfOptions = [
            { label: '🐺 自動（人数に合わせて調整）',  value: 'auto', default: settings.wolfMode === 'auto',  description: '4名→1匹 / 6名→2匹 / 9名→3匹' },
            { label: '🐺 1名',                          value: '1',    default: settings.wolfMode === 1 },
            { label: '🐺🐺 2名',                        value: '2',    default: settings.wolfMode === 2 },
            { label: '🐺🐺🐺 3名',                      value: '3',    default: settings.wolfMode === 3 },
        ];
        const timeOptions = [
            { label: '⚡ 30秒（スピード戦）',   value: '30',  default: settings.discussionTime === 30 },
            { label: '⏱ 45秒',                  value: '45',  default: settings.discussionTime === 45 },
            { label: '⏱ 60秒（推奨）',          value: '60',  default: settings.discussionTime === 60 },
            { label: '🕐 90秒',                  value: '90',  default: settings.discussionTime === 90 },
            { label: '🕑 120秒（熟考型）',       value: '120', default: settings.discussionTime === 120 },
            { label: '🕒 180秒（じっくり）',     value: '180', default: settings.discussionTime === 180 },
        ];
        const roleOptions = ROLE_SELECT_OPTIONS.map((opt: any) => ({ ...opt, default: settings.roles.includes(opt.value) }));

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_match_type')
                .setPlaceholder(`🎮 マッチ種別: 現在「${settings.matchType === 'ranked' ? '🏆 ランクマッチ' : '🔰 練習試合'}」`)
                .addOptions(matchOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_roles')
                .setPlaceholder(`🃏 役職: 現在「${settings.roles.map((r: string) => getShortRoleName(r)).join(' / ') || 'なし'}」`)
                .setMinValues(1).setMaxValues(roleOptions.length).addOptions(roleOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_wolves')
                .setPlaceholder(`🐺 人狼の数: 現在「${settings.wolfMode === 'auto' ? '自動' : settings.wolfMode + '名'}」`)
                .addOptions(wolfOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_time')
                .setPlaceholder(`⏱ 議論時間: 現在「${settings.discussionTime}秒」`)
                .addOptions(timeOptions)
        ));

    } else if (currentTab === 'rule') {
        const voteOptions = [
            { label: '📢 記名投票（投票先を全員に公開）',           value: 'public',    default: settings.voteTransparency === 'public',    description: '誰が誰に投票したか全員わかる' },
            { label: '🔒 無記名投票（投票先を隠す）',               value: 'anonymous', default: settings.voteTransparency === 'anonymous', description: '集計結果の票数のみ公開される' },
        ];
        const tieOptions = [
            { label: '🕊️ 同票時は処刑なし（平和村）',              value: 'peace',  default: settings.tieVoteHandling === 'peace',  description: '同票の場合は誰も処刑されない' },
            { label: '🔁 同票時は決選投票（再同票はランダム）',     value: 'revote', default: settings.tieVoteHandling === 'revote', description: '同票者だけで再投票。それでも同票ならランダム' },
            { label: '🎲 同票時はランダム処刑',                     value: 'random', default: settings.tieVoteHandling === 'random', description: 'サイコロで同票者の中から1人を処刑' },
        ];
        const guardOptions = [
            { label: '🛡️ 連続護衛あり（同じ人を連続で守れる）',    value: 'true',  default: settings.continuousGuard === true,  description: '前日護衛した人を翌日も護衛できる' },
            { label: '🛡️ 連続護衛なし（毎回異なる人を守る）',      value: 'false', default: settings.continuousGuard === false, description: '前日護衛した人は翌日護衛できない' },
        ];

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_vote_transparency')
                .setPlaceholder(`📋 投票公開設定: 現在「${settings.voteTransparency === 'public' ? '📢 記名投票' : '🔒 無記名投票'}」`)
                .addOptions(voteOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_tie_vote')
                .setPlaceholder(`⚖️ 同票処理: 現在「${settings.tieVoteHandling === 'peace' ? '🕊️ 処刑なし' : settings.tieVoteHandling === 'revote' ? '🔁 決選投票' : '🎲 ランダム'}」`)
                .addOptions(tieOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_continuous_guard')
                .setPlaceholder(`🛡️ 連続護衛: 現在「${settings.continuousGuard ? 'あり' : 'なし'}」`)
                .addOptions(guardOptions)
        ));

    } else if (currentTab === 'advanced') {
        const nightOptions = [
            { label: '🌕 初日の夜の襲撃あり（通常ルール）',        value: 'false', default: settings.firstNightPeace === false, description: '1日目から人狼が襲撃できる' },
            { label: '🌙 初日の夜の襲撃なし（競技ルール推奨）',    value: 'true',  default: settings.firstNightPeace === true,  description: '1日目夜は全員安全。2日目夜から襲撃' },
        ];
        const advancedOptions = [
            { label: '⚡ 全員投票完了で即終了',          value: 'autofinish',  default: settings.autoFinishVoting,   description: '全プレイヤーが投票したら即集計する' },
            { label: '💬 NPCのガヤ発言を有効化',        value: 'gaya',        default: settings.gayaMode,           description: 'NPCが議論中に自然に発言するようになる' },
            { label: '📜 処刑時の遺言を有効化',          value: 'will',        default: settings.willMode,           description: '処刑されたプレイヤーが20秒間最後の言葉を残せる' },
            { label: '🎯 饒舌モード（人狼にお題付与）',  value: 'loquacious',  default: settings.loquaciousMode,     description: '人狼に議論中に発言すべきキーワードが与えられる' },
        ];

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_first_night')
                .setPlaceholder(`🌙 初日襲撃: 現在「${settings.firstNightPeace ? '初日平和' : '初日襲撃あり'}」`)
                .addOptions(nightOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_advanced')
                .setPlaceholder('📦 その他の詳細ルール（複数選択可）')
                .setMinValues(0).setMaxValues(advancedOptions.length)
                .addOptions(advancedOptions)
        ));
    }

    return rows;
}

// ============================================================
// 🎴 役職カード（DM送信用）
// ============================================================
export function createRoleCard(player: Player, alliesNames: string[], partnerName: string | null) {
    const roleData = ROLE_CATALOG[player.role || ''] || { icon: '❓', team: 'villager' };

    let cardColor = COLORS.VILLAGER;
    let teamName  = '🏘️ 村人陣営';
    let teamEmoji = '🔵';
    if (roleData.team === 'wolf')  { cardColor = COLORS.WOLF;  teamName = '🐺 人狼陣営'; teamEmoji = '🔴'; }
    if (roleData.team === 'third') { cardColor = COLORS.THIRD; teamName = '🌀 第三陣営'; teamEmoji = '🟣'; }

    let desc = `> ${getRoleDescription(player.role || '')}\n`;

    if (['人狼', '饒舌な人狼', '忍者'].includes(player.role || '')) {
        const allyStr = alliesNames.length ? alliesNames.join(', ') : 'なし（一匹狼）';
        desc += `\n🩸 **仲間の人狼**: ${allyStr}`;
    } else if (player.role === '狂信者') {
        const allyStr = alliesNames.length ? alliesNames.join(', ') : '不明';
        desc += `\n📿 **知っている人狼**: ${allyStr}`;
    }

    if (partnerName) {
        desc += `\n\n💘 **【運命の恋人】**\nあなたの相手は **${partnerName}** です。\n相方が死ぬとあなたも後追い自殺します。`;
    }

    const winCond = getWinCondition(player.role || '');

    return new EmbedBuilder()
        .setTitle(`${roleData.icon} あなたの役職: **【${player.role}】**`)
        .setDescription(`${teamEmoji} **所属: ${teamName}**\n\n${desc}`)
        .addFields({ name: '🏆 勝利条件', value: winCond, inline: false })
        .setColor(cardColor)
        .setFooter({ text: 'この情報は秘密です。役職を他のプレイヤーに知られないよう注意してください' });
}

// ============================================================
// ゲーム中ガヤ発言ヘルパー
// ============================================================
const FALLBACK_TONE = {
    attacking: ['${t}が怪しいんじゃないか？', '${t}の動き、どうも納得できないな。'],
    defensive: ['俺を疑うなんてどうかしてるぜ！', 'ちょっと待ってくれ、俺じゃない！'],
    neutral:   ['うーん、難しいな…', '誰が人狼なんだろうな。', '慎重に行こうぜ。']
};

export function getDynamicGayaPhrase(situation: string, personality = 'normal', targetName: string | null = null) {
    const t = targetName || 'あの人';
    
    // 修正：配列(PERSONALITY_TONES)ではなく、辞書(GAYA_DICTIONARY)から取得する
    const toneData = GAYA_DICTIONARY[personality] || GAYA_DICTIONARY['normal'] || FALLBACK_TONE as any;
    
    // データが見つからなければ、安全なフォールバックセリフを使用する
    const phrases  = toneData[situation] || toneData['neutral'] || FALLBACK_TONE[situation as keyof typeof FALLBACK_TONE] || FALLBACK_TONE.neutral;
    
    const rawPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    return rawPhrase.replace('${t}', t);
}


// ============================================================
// ボタン・セレクトメニュー生成ヘルパー群
// ============================================================
export function createButtonRows(players: any[], actionType: string, style = ButtonStyle.Primary) {
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
        new ButtonBuilder().setCustomId(`fakeresult_white_${targetId}`).setLabel(fill(UI.night.fakeSeerWhiteBtn, { name: targetName })).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fakeresult_black_${targetId}`).setLabel(fill(UI.night.fakeSeerBlackBtn, { name: targetName })).setStyle(ButtonStyle.Danger),
    )];
}

export function createMediumPublishRow(targetId: string, targetName: string, executedRole: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`medium_publish_${targetId}_${executedRole}`)
            .setLabel(fill(UI.night.mediumPublishBtn, { name: targetName }))
            .setStyle(ButtonStyle.Success),
    )];
}

export function getCupidSelection(players: any[]) {
    const options = players.map(p => ({ label: p.name, value: p.id }));
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cupid_select')
            .setPlaceholder('💘 恋人にする2人を選んでください')
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
    catch (e: any) { console.log(`[SafeDM] スキップ: ${user.username} - ${e.message}`); return false; }
}

export async function safeSend(channel: any, content: any): Promise<any> {
    if (!channel || typeof channel.send !== 'function') return null;
    try { return await channel.send(content); }
    catch (e: any) { console.error(`[SafeSend] エラー: ${e.message}`); return null; }
}
