
// src/messages.ts
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { ROLE_MAP, ROLE_CATALOG, ROLE_SELECT_OPTIONS, translateRoles, getRoleDescription, isWolfTeam, isActualWolf } from './roles';
import * as DB from './db';
import { GameState, Player } from './types';
import * as TextData from './textData';

export const COLORS = {
    MAIN: 0x2B2D31,
    VILLAGER: 0x2ECC71,
    WOLF: 0xE74C3C,
    THIRD: 0x9B59B6,
    SYSTEM: 0x3498DB
};

export async function getLobbyPayload(game: GameState, userId: string, member?: any) {
    const isPremium = await DB.isPremiumUser(userId);
    const total = game.players.length + game.npcCount;
    const playerNames = game.players.length > 0 
        ? "```\n" + game.players.map((p: Player) => `▪ ${p.name}`).join('\n') + "\n```" 
        : '```\n待機中...\n```';

    const roleCounts: Record<string, number> = {};
    game.settings.roles.forEach((r: string) => { 
        const name = ROLE_MAP[r] || r;
        roleCounts[name] = (roleCounts[name] || 0) + 1;
        if (r === 'freemason') roleCounts[name] += 1;
    });

    // ★変更: 「カジュアルマッチ」→「練習試合」、
    const matchTypeText = game.settings.matchType === 'ranked'
        ? '🏆 ランクマッチ (戦績・レート変動あり)'
        : '🔰 練習試合 (レート変動なし)';
    const roleText = Object.entries(roleCounts).map(([name, count]) => count > 1 ? `${name}x${count}` : name).join(' / ') || '基本役職のみ';
    let wolfText = game.settings.wolfMode === 'auto' ? '自動調整' : `${game.settings.wolfMode}名`;
    
    let detailedRules = [];
    detailedRules.push(game.settings.voteTransparency === 'public' ? '記名投票' : '無記名投票');
    if (game.settings.tieVoteHandling === 'peace') detailedRules.push('同票時: 処刑なし');
    else if (game.settings.tieVoteHandling === 'random') detailedRules.push('同票時: ランダム処刑');
    else detailedRules.push('同票時: 決選投票');
    detailedRules.push(game.settings.continuousGuard ? '連続護衛: あり' : '連続護衛: なし');
    detailedRules.push(game.settings.firstNightPeace ? '初日襲撃: なし(平和)' : '初日襲撃: あり');
    if (game.settings.autoFinishVoting) detailedRules.push('時短投票');
    if (game.settings.gayaMode) detailedRules.push('NPCガヤ');
    if (game.settings.willMode) detailedRules.push('遺言あり');
    if (game.settings.loquaciousMode) detailedRules.push('饒舌モード');
    const optionText = detailedRules.join(' / ');

    // ★追加: 現在のプリセット名を表示
    const presetName = (game as any).currentPresetName;
    const presetLine = presetName ? `\n**構成**: **${presetName}**` : '';

    const embed = new EmbedBuilder()
        .setTitle('🌕 汝は人狼なりや？ - RECRUITING')
        .setDescription(`夜の帳が下りようとしています。\n生き残りを懸けたゲームへの参加者を募集します。\n\n**現在: ${total}名** (最低4名)${presetLine}`)
        .addFields(
            { name: '👥 参加者', value: playerNames, inline: false },
            { 
                name: '⚙️ ゲーム設定', 
                value: `> **マッチ**: ${matchTypeText}\n> **議論時間**: ${game.settings.discussionTime}秒\n> **人狼の数**: ${wolfText}\n> **特殊役職**: ${roleText}`, 
                inline: false 
            },
            { 
                name: '📋 詳細ルール', 
                value: `> ${optionText}`, 
                inline: false 
            }
        )
        .setColor(COLORS.MAIN)
        .setThumbnail('https://cdn-icons-png.flaticon.com/512/1792/1792131.png');

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('join_leave').setLabel('参加 / 退出').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('npc_add').setLabel('NPC 追加').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('npc_remove').setLabel('NPC 削除').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('open_settings').setLabel('設定変更').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('game_start').setLabel('ゲーム開始').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('lobby_cancel').setLabel('解散').setStyle(ButtonStyle.Danger),
    );

    // ★変更: ランクマッチと練習試合に整理。カオス役職プリセットは削除
    const rankedOptions = [
        { label: '🔰 標準モード (設定リセット)', value: 'preset_standard', description: 'デフォルトの配役・設定に戻します' },
        { label: '🥈【9人村】ランクマッチ標準', value: 'preset_ranked_9', description: '占1/霊1/騎1/狂1/狼2/村3 (最もバランスの取れた定番構成)' },
        { label: '👑【13人村】アルティメット', value: 'preset_ultimate', description: '占1/霊1/騎1/狂1/狼3/村6 (公式ルールの頂点。長期戦)' },
        { label: '👥【11人村】狂信者と共有者', value: 'preset_freemason_11', description: '占1/霊1/騎1/共2/狂信1/狼2/村3 (共有者を軸にした高度な頭脳戦)' },
        { label: '🔍【10人村】検死官の論理', value: 'preset_coroner_10', description: '占1/霊1/騎1/検1/狂1/狼2/村3 (検死官の情報を活かした推理戦)' },
    ];

    // ★変更: 練習試合メニューはランクマッチより上に表示
    const casualOptions = [
        { label: '🔰 標準モード・練習 (設定リセット)', value: 'preset_standard_casual', description: 'デフォルトの配役で練習試合' },
    ];

    const allPresets = await DB.getPresets(userId);
    // ★修正: __profile__ を除外してUIに表示しない
    const filteredPresets = allPresets.filter((p: any) => p.name !== '__profile__');
    const customOptions: any[] = [];
    filteredPresets.forEach((p: any) => {
        const roles = p.settings.roles?.map((r: string) => ROLE_MAP[r] || r).join(',') || 'なし';
        customOptions.push({
            label: `📂 ${p.name}`,
            value: `load_preset_${p.name}`,
            description: `役職: ${roles.substring(0, 40)}`
        });
    });

    const componentsList: any[] = [row1, row2];
    // ★変更: 練習試合→ランクマッチの順で表示
    componentsList.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId('lobby_preset_casual').setPlaceholder('🔰 練習試合の編成を選ぶ [ホスト専用]').addOptions(casualOptions)
    ));
    componentsList.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId('lobby_preset_ranked').setPlaceholder('🏆 ランクマッチの編成を選ぶ [ホスト専用]').addOptions(rankedOptions)
    ));
    if (customOptions.length > 0) {
        componentsList.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('lobby_preset_custom').setPlaceholder('📂 保存済みのオリジナル編成を選ぶ [ホスト専用]').addOptions(customOptions)
        ));
    }

    return { embeds: [embed], components: componentsList };
}

export function getSettingsComponents(settings: any, currentTab: string = 'basic', isPremium: boolean = false) {
    const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('tab_basic').setLabel('基本設定').setStyle(currentTab === 'basic' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tab_rule').setLabel('ルール設定').setStyle(currentTab === 'rule' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tab_advanced').setLabel('詳細・特殊').setStyle(currentTab === 'advanced' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setting_back').setLabel('完了').setStyle(ButtonStyle.Primary)
    );
    const rows: any[] = [tabRow];

    if (currentTab === 'basic') {
        // ★変更: 練習試合を先頭に
        const matchOptions = [
            { label: '🔰 練習試合 (レート変動なし / 気軽に遊ぶ)', value: 'casual', default: settings.matchType === 'casual' },
            { label: '🏆 ランクマッチ (レート変動あり / 人間2人以上必須)', value: 'ranked', default: settings.matchType === 'ranked' }
        ];
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_match_type').setPlaceholder('マッチタイプ').addOptions(matchOptions)
        ));

        const wolfOptions = [
            { label: '自動 (人数に合わせて調整)', value: 'auto', default: settings.wolfMode === 'auto' },
            { label: '1人', value: '1', default: settings.wolfMode === 1 },
            { label: '2人', value: '2', default: settings.wolfMode === 2 },
            { label: '3人', value: '3', default: settings.wolfMode === 3 },
        ];
        // ★変更: 45秒オプションを追加
        const timeOptions = [
            { label: '30秒', value: '30', default: settings.discussionTime === 30 },
            { label: '45秒', value: '45', default: settings.discussionTime === 45 },
            { label: '60秒', value: '60', default: settings.discussionTime === 60 },
            { label: '90秒', value: '90', default: settings.discussionTime === 90 },
            { label: '120秒', value: '120', default: settings.discussionTime === 120 },
            { label: '180秒', value: '180', default: settings.discussionTime === 180 },
        ];
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_roles').setPlaceholder('役職を選択 (複数可)').setMinValues(1).setMaxValues(ROLE_SELECT_OPTIONS.length).addOptions(ROLE_SELECT_OPTIONS)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_wolves').setPlaceholder('人狼の数').addOptions(wolfOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_time').setPlaceholder('議論時間').addOptions(timeOptions)
        ));

    } else if (currentTab === 'rule') {
        const voteOptions = [
            { label: '投票先を公開する (記名)', value: 'public', default: settings.voteTransparency === 'public' },
            { label: '投票先を隠す (無記名)', value: 'anonymous', default: settings.voteTransparency === 'anonymous' }
        ];
        const tieOptions = [
            { label: '同票時は処刑なし (平和村)', value: 'peace', default: settings.tieVoteHandling === 'peace' },
            { label: '同票時は決選投票 (再同票はランダム)', value: 'revote', default: settings.tieVoteHandling === 'revote' },
            { label: '同票時は即ランダム処刑', value: 'random', default: settings.tieVoteHandling === 'random' }
        ];
        const guardOptions = [
            { label: '連続護衛 あり', value: 'true', default: settings.continuousGuard === true },
            { label: '連続護衛 なし', value: 'false', default: settings.continuousGuard === false }
        ];
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_vote_transparency').setPlaceholder('投票の公開設定').addOptions(voteOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_tie_vote').setPlaceholder('同票時の処理').addOptions(tieOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_continuous_guard').setPlaceholder('騎士の連続護衛').addOptions(guardOptions)
        ));

    } else if (currentTab === 'advanced') {
        const nightOptions = [
            { label: '初日の夜の襲撃 あり (通常)', value: 'false', default: settings.firstNightPeace === false },
            { label: '初日の夜の襲撃 なし (平和)', value: 'true', default: settings.firstNightPeace === true }
        ];
        const advancedOptions = [
            { label: '投票全員完了で即終了', value: 'autofinish', default: settings.autoFinishVoting },
            { label: 'NPCのガヤ発言を有効化', value: 'gaya', default: settings.gayaMode },
            { label: '処刑時の遺言を有効化', value: 'will', default: settings.willMode },
            { label: '饒舌モード (人狼にお題付与)', value: 'loquacious', default: settings.loquaciousMode }, // ★追加
        ];
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_first_night').setPlaceholder('初日襲撃の設定').addOptions(nightOptions)
        ));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId('setting_advanced').setPlaceholder('その他の詳細ルール').setMinValues(0).setMaxValues(advancedOptions.length).addOptions(advancedOptions)
        ));
        // ★削除: AIトーン設定は廃止
    }

    return rows;
}

// 役職カードを作る関数（カタログのおかげで超スッキリ！）
export function createRoleCard(player: Player, alliesNames: string[], partnerName: string | null) {
    // カタログから役職データを取得（見つからなければ村人扱い）
    const roleData = ROLE_CATALOG[player.role || ''] || { icon: '❓', team: 'villager' };
    
    let cardColor = COLORS.VILLAGER;
    let teamName = "村人陣営";

    // 陣営に応じた色と名前のセット
    if (roleData.team === 'wolf') {
        cardColor = COLORS.WOLF;
        teamName = "人狼陣営";
    } else if (roleData.team === 'third') {
        cardColor = COLORS.THIRD;
        teamName = "第三陣営";
    }

    let desc = `> ${getRoleDescription(player.role || '')}`;
    
    // 特定の役職用の追加メッセージ
    if (['人狼', '饒舌な人狼', '忍者'].includes(player.role || '')) {
        desc += `\n\n🩸 **仲間の人狼**: ${alliesNames.length ? alliesNames.join(', ') : 'なし'}`;
    } else if (player.role === '狂信者') {
        desc += `\n\n📿 **知っている人狼**: ${alliesNames.length ? alliesNames.join(', ') : 'なし'}`;
    }
    
    if (partnerName) {
        desc += `\n\n💘 **【運命の恋人】**\nあなたの相手は **${partnerName}** です。\n相方が死ぬとあなたも後追い自殺します。`;
    }

    return new EmbedBuilder()
        .setTitle(`${roleData.icon} あなたの役職: ${player.role}`)
        .setDescription(`**所属: ${teamName}**\n\n${desc}`)
        .setColor(cardColor);
}

export function getDynamicGayaPhrase(situation: string, personality = 'normal', targetName: string | null = null) {
    const t = targetName || "あの人";
    const toneData = TextData.PERSONALITY_TONES[personality] || TextData.PERSONALITY_TONES['normal'];
    const phrases = toneData[situation] || toneData['neutral'];
    const rawPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    return rawPhrase.replace('${t}', t);
}

export function createButtonRows(players: any[], actionType: string, style = ButtonStyle.Primary) {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    players.forEach((p, i) => {
        currentRow.addComponents(new ButtonBuilder().setCustomId(`${actionType}_${p.id}`).setLabel(p.name).setStyle(style));
        if ((i + 1) % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder<ButtonBuilder>(); }
    });
    if (currentRow.components.length > 0) rows.push(currentRow);
    return rows;
}

export function createNightActionRows(players: any[], actionType: string, roleName: string) {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (roleName === '占い師' || roleName === '偽占い') {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('strategy_co').setLabel('📢 即COする').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('strategy_hide').setLabel('🕶️ 潜伏する').setStyle(ButtonStyle.Secondary)
        ));
    }
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
    players.forEach((p, i) => {
        currentRow.addComponents(new ButtonBuilder().setCustomId(`${actionType}_${p.id}`).setLabel(p.name).setStyle(ButtonStyle.Secondary));
        if ((i + 1) % 5 === 0) { rows.push(currentRow); currentRow = new ActionRowBuilder<ButtonBuilder>(); }
    });
    if (currentRow.components.length > 0) rows.push(currentRow);
    return rows;
}

export function createFakeResultRows(targetId: string, targetName: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`fakeresult_white_${targetId}`).setLabel(`${targetName} を人間(白)に`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fakeresult_black_${targetId}`).setLabel(`${targetName} を人狼(黒)に`).setStyle(ButtonStyle.Danger)
    )];
}

export function createMediumPublishRow(targetId: string, targetName: string, executedRole: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`medium_publish_${targetId}_${executedRole}`).setLabel(`📢 【${targetName}】の結果を公表`).setStyle(ButtonStyle.Success)
    )];
}

export function getCupidSelection(players: any[]) {
    const options = players.map(p => ({ label: p.name, value: p.id }));
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId('cupid_select').setPlaceholder('恋人を2人選んでください').setMinValues(2).setMaxValues(2).addOptions(options)
    )];
}

// ==========================================
// 🛡️ 通信ラッパー（絶対にクラッシュさせない安全機構 + 負荷対策）
// ==========================================
export async function safeDM(user: any, content: any): Promise<boolean> {
    if (!user || typeof user.send !== 'function') return false; 
    try {
        await user.send(content);
        return true;
    } catch (e: any) {
        console.log(`[SafeDM] DM送信スキップ: ${user.username} - ${e.message}`);
        return false;
    }
}

export async function safeSend(channel: any, content: any): Promise<any> {
    if (!channel || typeof channel.send !== 'function') return null;
    try {
        return await channel.send(content);
    } catch (e: any) {
        console.error(`[SafeSend] チャンネル送信エラー: ${e.message}`);
        return null;
    }
}

