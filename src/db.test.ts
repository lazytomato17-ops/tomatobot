// src/db.test.ts
import { describe, it, expect } from 'vitest';
import { isPlayerWinning, getBaseWinPoints, getBaseLossPoints, getRankInfo } from './db';
import type { Player } from './types';

/** テスト用に最小限のプレイヤーを作るヘルパー */
function makePlayer(overrides: Partial<Player> & { id: string; role: string }): Player {
    return {
        user: null,
        name: overrides.id,
        isNpc: false,
        settings: {},
        alive: true,
        ...overrides,
    };
}

describe('isPlayerWinning', () => {
    it('村人陣営の勝利時、村人ロールのプレイヤーは勝利と判定される', () => {
        const p = makePlayer({ id: 'p1', role: '村人' });
        expect(isPlayerWinning(p, 'villager', [])).toBe(true);
    });

    it('村人陣営の勝利時、人狼ロールのプレイヤーは敗北と判定される', () => {
        const p = makePlayer({ id: 'p1', role: '人狼' });
        expect(isPlayerWinning(p, 'villager', [])).toBe(false);
    });

    it('恋人陣営の勝利時、恋人本人は勝利と判定される（元の役職に関わらず）', () => {
        const p = makePlayer({ id: 'p1', role: '村人' });
        expect(isPlayerWinning(p, 'lovers', ['p1'])).toBe(true);
    });

    it('恋人陣営が負けた場合、恋人本人は自陣営が勝っても便乗勝利できない', () => {
        const p = makePlayer({ id: 'p1', role: '村人' });
        // 恋人(p1)がいるが、勝利陣営は 'villager'（lovers ではない）
        expect(isPlayerWinning(p, 'villager', ['p1'])).toBe(false);
    });

    it('キューピッドは恋人陣営勝利時に勝利と判定される', () => {
        const p = makePlayer({ id: 'p1', role: 'キューピッド' });
        expect(isPlayerWinning(p, 'lovers', ['p2', 'p3'])).toBe(true);
    });

    it('キューピッドは恋人陣営が負けると敗北と判定される（自身が村人でも）', () => {
        const p = makePlayer({ id: 'p1', role: 'キューピッド' });
        expect(isPlayerWinning(p, 'villager', ['p2', 'p3'])).toBe(false);
    });

    it('妖狐は fox 陣営勝利時のみ勝利と判定される', () => {
        const fox = makePlayer({ id: 'p1', role: '妖狐' });
        expect(isPlayerWinning(fox, 'fox', [])).toBe(true);
        expect(isPlayerWinning(fox, 'villager', [])).toBe(false);
    });

    it('妖狐と恋人が両方生存したまま終了した場合、恋人陣営が優先される（妖狐は敗北扱い）', () => {
        // checkWin() 側で winnerTeam が 'lovers' に確定しているケースを想定。
        // isPlayerWinning は winnerTeam を信頼するだけなので、ここでは
        // 「winnerTeam が lovers のとき、妖狐ロールは勝利しない」ことを確認する。
        const fox = makePlayer({ id: 'fox1', role: '妖狐' });
        const lover = makePlayer({ id: 'lover1', role: '村人' });
        expect(isPlayerWinning(fox, 'lovers', ['lover1', 'lover2'])).toBe(false);
        expect(isPlayerWinning(lover, 'lovers', ['lover1', 'lover2'])).toBe(true);
    });

    it('テルテルは teruteru 陣営勝利時のみ勝利と判定される', () => {
        const teruteru = makePlayer({ id: 'p1', role: 'テルテル' });
        expect(isPlayerWinning(teruteru, 'teruteru', [])).toBe(true);
        expect(isPlayerWinning(teruteru, 'wolf', [])).toBe(false);
    });

    it('純愛者は指定した相手の勝敗に連動する', () => {
        const target = makePlayer({ id: 'target', role: '村人' });
        const devotee = makePlayer({ id: 'p1', role: '純愛者' });
        // target（村人）が villager 陣営勝利で勝つので、devotee も勝利
        expect(isPlayerWinning(devotee, 'villager', [], [target, devotee], 'target')).toBe(true);
        // target が負ける陣営なら devotee も敗北
        expect(isPlayerWinning(devotee, 'wolf', [], [target, devotee], 'target')).toBe(false);
    });

    it('人狼陣営の勝利時、狂人ロールも勝利と判定される', () => {
        const madman = makePlayer({ id: 'p1', role: '狂人' });
        expect(isPlayerWinning(madman, 'wolf', [])).toBe(true);
    });
});

describe('getBaseWinPoints（レート帯ごとの勝利時加算ポイント）', () => {
    it('レートが低いほど多くポイントを獲得できる', () => {
        const low = getBaseWinPoints(1200);
        const mid = getBaseWinPoints(1800);
        const high = getBaseWinPoints(2500);
        expect(low).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(high);
    });

    it('常に正の値を返す', () => {
        expect(getBaseWinPoints(0)).toBeGreaterThan(0);
        expect(getBaseWinPoints(3000)).toBeGreaterThan(0);
    });
});

describe('getBaseLossPoints（レート帯ごとの敗北時減算ポイント）', () => {
    it('レートが高いほど多くのペナルティを受ける', () => {
        const low = getBaseLossPoints(1200);
        const mid = getBaseLossPoints(1800);
        const high = getBaseLossPoints(2500);
        expect(low).toBeLessThan(mid);
        expect(mid).toBeLessThan(high);
    });

    it('常に正の値を返す（呼び出し側でマイナスに変換する設計）', () => {
        expect(getBaseLossPoints(0)).toBeGreaterThan(0);
        expect(getBaseLossPoints(3000)).toBeGreaterThan(0);
    });
});

describe('getRankInfo（レート帯に応じたランク表示）', () => {
    it('境界値が正しいランクに分類される', () => {
        expect(getRankInfo(2400).name).toBe('レジェンド');
        expect(getRankInfo(2399).name).toBe('グランドマスター');
        expect(getRankInfo(1500).name).toBe('シルバー');
        expect(getRankInfo(1499).name).toBe('ブロンズ');
        expect(getRankInfo(0).name).toBe('ルーキー');
    });
});
