// src/roles.ts
// 🎭 役職のデータと、陣営判定などのヘルパー関数を管理するファイル

export const ROLE_MAP: Record<string, string> = { 
    'seer': '占い師', 'medium': '霊能者', 'guard': '騎士', 'madman': '狂人', 
    'fanatic': '狂信者', 'freemason': '共有者', 'coroner': '検死官', 'mayor': '市長', 
    'tough_guy': 'タフガイ', 'fox': '妖狐', 'fugitive': '逃亡者', 'teruteru': 'テルテル', 
    'cupid': 'キューピッド', 'sorcerer': '妖術師', 'cat': '猫又', 'thief': '怪盗', 
    'baker': 'パン屋', 'loquacious': '饒舌な人狼',
    'devotee': '純愛者', 'dictator': '独裁者', 'god': '神' // 👈 追加！
};

export function translateRoles(roles: string[]): string {
    return roles.map(r => ROLE_MAP[r] || r).join(', ');
}

export const ROLE_CATALOG: Record<string, { icon: string; team: 'villager' | 'wolf' | 'third'; isWolfCount?: boolean; description: string }> = {
    // 🧑‍🌾 村人陣営
    '村人': { icon: '🧑‍🌾', team: 'villager', description: '特殊能力はないけど、推理とトークで村を救おう！' },
    '占い師': { icon: '🔮', team: 'villager', description: '毎晩1人を占い、人狼か人間かを知ることができます。\n村のリーダー的存在です。' },
    '霊能者': { icon: '👻', team: 'villager', description: '処刑された人が「人狼」だったかどうか分かります。\n嘘つきを見抜くのに重要です。' },
    '騎士': { icon: '🛡️', team: 'villager', description: '毎晩自分以外の人を1人守れます。\n人狼の襲撃から守れる。自分は守れないので注意。' },
    '共有者': { icon: '👥', team: 'villager', description: '絶対に村人陣営だと分かっている相方がいます。\n初日の夜に顔合わせをして、協力して村を導きましょう。' },
    '検死官': { icon: '🔍', team: 'villager', description: '毎朝、昨晩死んだ人の「本当の役職」を知ることができます。\n無惨な死体から情報を引き出しましょう。' },
    '逃亡者': { icon: '🏃‍♂️', team: 'villager', description: '毎晩誰かの家に逃げ込みます。\n逃げ込んだ相手が人狼だったり、相手が人狼に襲撃されたりすると巻き添えで死んでしまいます。' },
    '怪盗': { icon: '🕵️', team: 'villager', description: '初日の夜に、他の誰かの役職を盗むことができます。\n盗まれた人は「村人」になります。' },
    '市長': { icon: '🎩', team: 'villager', description: 'あなたの投票は「2票分」としてカウントされます。\nここぞという時の決断が村の運命を左右します。' },
    'タフガイ': { icon: '🦾', team: 'villager', description: '人狼に襲撃されても、その夜は耐え抜くことができます。\nしかし、負った致命傷により次の日の夜に必ず死んでしまいます。' },
    '猫又': { icon: '🐈', team: 'villager', description: '処刑されるとランダムな1人を、人狼に襲撃されると人狼の1人を道連れにして死にます。' },
    '独裁者': { icon: '​⚖️', team: 'villager', description: 'ゲーム中に一度だけ、昼の議論・投票を強制終了させて自分が選んだ相手を確実に処刑できます。' },
    '神': { icon: '✨', team: 'villager', description: 'ゲーム中に一度だけ、夜に死者の中から1人を選んで蘇生させることができます。' },

    // 🐺 人狼陣営 (本物の狼にだけ isWolfCount: true を付与)
    '人狼': { icon: '🐺', team: 'wolf', isWolfCount: true, description: '夜にプレイヤーを1人襲撃できます。\n市民を騙して生き残りましょう。' },
    '饒舌な人狼': { icon: '🐺', team: 'wolf', isWolfCount: true, description: '人狼陣営です。\n毎日、昼の議論中に「指定されたお題ワード」を発言しないと突然死してしまいます！' },
    '狂人': { icon: '🎭', team: 'wolf', description: '人間だけど人狼の味方。\n夜に「偽占い」を行えます（CO/潜伏 選択可）。' },
    '狂信者': { icon: '📿', team: 'wolf', description: '人間ですが、誰が人狼か知っています。\n人狼を勝利させるために嘘をつきましょう。' },
    '妖術師': { icon: '👁️', team: 'wolf', description: '毎晩1人を占い、その人の「本当の役職」を知ることができます。\n人狼のサポートをしましょう。' },
    // 🃏 第三陣営の最後の方に追加
    '妖狐': { icon: '🦊', team: 'third', description: '襲撃されても死にませんが、占われると死にます。\n最後まで生き残れば単独勝利！' },
    'テルテル': { icon: '🃏', team: 'third', description: '処刑されることが勝利条件です。\n怪しまれるように行動しましょう。' },
    'キューピッド': { icon: '💘', team: 'third', description: '初日の夜に2人を「恋人」にします。\n恋人陣営として最後まで生き残れば勝利！' },
    '純愛者': { icon: '❤️‍🔥', team: 'third', description: '初日の夜に1人を選び「愛する人」にします。\nその人が勝利することがあなたの勝利条件です。' } // 👈 追加！
};

// Discordの設定メニュー(SelectMenu)用の選択肢データ
export const ROLE_SELECT_OPTIONS = [
    { label: '🔮 占い師', value: 'seer', description: '毎晩、誰か1人の正体を知る' },
    { label: '👻 霊能者', value: 'medium', description: '処刑された人の正体を知る' },
    { label: '🛡️ 騎士', value: 'guard', description: '毎晩、誰か1人を人狼の襲撃から守る' },
    { label: '🤡 狂人', value: 'madman', description: '人間だが、人狼陣営の勝利を目指す' },
    { label: '👿 狂信者', value: 'fanatic', description: '誰が人狼か知っている狂人' },
    { label: '👥 共有者', value: 'freemason', description: '互いに人間であると知っている(2人セット)' },
    { label: '👑 市長', value: 'mayor', description: '自分の投票が常に2票分になる' },
    { label: '💪 タフガイ', value: 'tough_guy', description: '襲撃されても、翌日の夜まで死なない' },
    { label: '💘 キューピッド', value: 'cupid', description: '初日に2人を恋人にする' },
    { label: '🔍 検死官', value: 'coroner', description: '朝、前夜の死者の本当の役職を知る' },
    { label: '🐈 猫又', value: 'cat', description: '死亡時に誰か1人を道連れにする' },
    { label: '🦊 妖狐', value: 'fox', description: '最後まで生き残れば単独勝利（占われると死ぬ）' },
    { label: '🃏 テルテル', value: 'teruteru', description: '昼に処刑されれば単独勝利' },
    { label: '🕵️ 怪盗', value: 'thief', description: '初日の夜に誰かと役職を交換する' },
    { label: '🏃‍♂️ 逃亡者', value: 'fugitive', description: '毎晩誰かの家に逃げる（狼の家や襲撃先だと死ぬ）' },
    { label: '👁️ 妖術師', value: 'sorcerer', description: '毎晩、誰か1人の具体的な役職を見抜く' },
    { label: '​⚖️ 独裁者', value: 'dictator', description: 'ゲーム中に1度だけ、強制的に誰かを処刑できる' },
    { label: '✨ 神', value: 'god', description: 'ゲーム中に1度だけ、死者を1人蘇生できる' },
    { label: '❤️‍🔥 純愛者', value: 'devotee', description: '初日に1人を選び、その人が勝利すれば自分も追加勝利' }
];

export function getRoleDescription(role: string) { return ROLE_CATALOG[role]?.description || '役職情報なし'; }
export function isWolfTeam(role: string) { return ROLE_CATALOG[role]?.team === 'wolf'; }
export function isActualWolf(role: string) { return ROLE_CATALOG[role]?.isWolfCount === true; }
