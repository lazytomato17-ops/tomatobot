// src/phase/utils.ts
//
// フェーズ進行に関する共通ユーティリティ関数群。
// 他のフェーズロジック（core.ts）から呼び出される、副作用が局所的な小さな関数を集約しています。
import * as Messages from '../messages';
import { GameState, Player } from '../types';
import * as Roles from '../roles';
import { MSG, GAYA_DICTIONARY, fill } from '../gameConfig';

export async function kickFromWolfChannel(game: GameState, deadPlayerId: string) {
    if (game.wolfChannel && !deadPlayerId.startsWith('npc_')) {
        try {
            await game.wolfChannel.permissionOverwrites.delete(deadPlayerId);
            await Messages.safeSend(game.wolfChannel, fill(MSG.wolfChat.kicked, { name: game.players.find((p: Player) => p.id === deadPlayerId)?.name || '不明' }));
        } catch (e) {
            console.error("追放エラー:", e);
        }
    }
}

export function setSafeTimeout(game: GameState, callback: () => void, ms: number) {
    if (!game.timers) game.timers = [];
    const timer = setTimeout(() => {
        game.timers = game.timers.filter((t: any) => t !== timer);
        if (game.state === 'idle') return;
        try {
            callback();
        } catch (e) {
            console.error('[setSafeTimeout] コールバック内でエラーが発生しました:', e);
        }
    }, ms);
    game.timers.push(timer);
}

export function trackCollector(game: GameState, collector: { stop: () => void } & { once?: (event: string, fn: () => void) => void }): void {
    if (!game.collectors) game.collectors = [];
    game.collectors.push(collector);
    if (typeof collector.once === 'function') {
        collector.once('end', () => {
            if (game.collectors) {
                game.collectors = game.collectors.filter(c => c !== collector);
            }
        });
    }
}

export function decideRoles(game: GameState, total: number) {
    let wolfCount = game.settings.wolfMode === 'auto' ? (total >= 11 ? 3 : (total >= 6 ? 2 : 1)) : game.settings.wolfMode;
    if (wolfCount >= total / 2) wolfCount = Math.floor((total - 1) / 2) || 1;
    
    const roles = [];
    const wolfRoleName = game.settings.loquaciousMode ? '饒舌な人狼' : '人狼';
    for (let i = 0; i < wolfCount; i++) roles.push(wolfRoleName);
    
    game.settings.roles.forEach((k: string) => { 
        if (Roles.ROLE_MAP[k] && k !== 'loquacious') {
            roles.push(Roles.ROLE_MAP[k]);
            if (k === 'freemason') roles.push(Roles.ROLE_MAP[k]);
        } 
    });
    while (roles.length < total) roles.push('村人');
    return roles;
}

export function setupSpecialRoles(game: GameState, total: number) {
    const naturalLiars = game.players.filter((p: Player) => p.isNpc && ['狂人', '妖狐', '狂信者', 'テルテル', '妖術師'].includes(p.role as string));
    const wolves = game.players.filter((p: Player) => p.isNpc && Roles.isActualWolf(p.role as string));

    if (game.settings.roles.includes('seer')) {
        if (naturalLiars.length > 0 && Math.random() < 0.6) { 
            const faker = naturalLiars[Math.floor(Math.random() * naturalLiars.length)];
            faker.isFakeSeer = true;
            if (Math.random() < 0.4) faker.isHiding = true; 
        } else if (wolves.length > 0 && Math.random() < 0.2) { 
            const wolfFaker = wolves[Math.floor(Math.random() * wolves.length)];
            wolfFaker.isFakeSeer = true;
            if (Math.random() < 0.3) wolfFaker.isHiding = true; 
        }
    }

    const isMediumInSettings = game.settings.roles.includes('medium');
    const madmenForMedium = game.players.filter((p: Player) => p.isNpc && !p.isFakeSeer && ['狂人', '狂信者'].includes(p.role as string));
    const wolvesForMedium = game.players.filter((p: Player) => p.isNpc && !p.isFakeSeer && Roles.isActualWolf(p.role as string));

    if (isMediumInSettings) {
        if (madmenForMedium.length > 0 && Math.random() < 0.3) { 
            const fM = madmenForMedium[Math.floor(Math.random() * madmenForMedium.length)];
            fM.isFakeMedium = true;
            if (Math.random() < 0.3) fM.isHiding = true;
        } else if (wolvesForMedium.length > 0 && Math.random() < 0.1) { 
            const fM = wolvesForMedium[Math.floor(Math.random() * wolvesForMedium.length)];
            fM.isFakeMedium = true;
            if (Math.random() < 0.2) fM.isHiding = true; 
        }
    }

    const trueMediums = game.players.filter((p: Player) => p.isNpc && p.role === '霊能者');
    trueMediums.forEach((tm: any) => {
        const pTone = tm.personality || 'normal';
        const hideChance = 0.0;
        if (Math.random() < hideChance) tm.isHiding = true;
    });

    // ★修正: ここにあったNPCキューピッドの処理を startNightPhase に移動しました

    const trueSeer = game.players.find((p: Player) => p.isNpc && p.role === '占い師');
    if (trueSeer) {
        const pTone = trueSeer.personality || 'normal';
        let hideChance = 0.3;
        if (pTone === 'cautious') hideChance = 0.8;
        if (pTone === 'logical') hideChance = 0.5;
        if (pTone === 'aggressive' || pTone === 'joker') hideChance = 0.1;
        if (Math.random() < hideChance) {
            trueSeer.isHiding = true;
        }
    }
}

export function generateDeepReasonPhrase(speaker: any, targetName: string, reason: string) {
    const p = speaker.personality || 'normal';
    
    // 🌟 追加：npcLogicの新しい詳細な理由を、GAYA辞書のキーにマッピングする
    let dictKey = reason;
    if (['trusted_black', 'doubtful_black', 'my_black_result'].includes(reason)) {
        dictKey = 'black'; // 黒出し・黒吊り系
    } else if (reason === 'seer_co_suspect') {
        dictKey = 'roller'; // 占い師ローラー系
    } else if (reason === 'hostile_seer') {
        dictKey = 'revenge'; // 自分（仲間）に黒出ししてきた占い師への反撃
    }

    if (GAYA_DICTIONARY[dictKey] && GAYA_DICTIONARY[dictKey][p]) {
        const list = GAYA_DICTIONARY[dictKey][p];
        const template = list[Math.floor(Math.random() * list.length)];
        return template.replace('TARGET', targetName);
    }
    return Messages.getDynamicGayaPhrase('attacking', p, targetName);
}
