// src/roles.test.ts
import { describe, it, expect } from 'vitest';
import {
    ROLE_MAP,
    translateRoles,
    getRoleDescription,
    isWolfTeam,
    isActualWolf,
    getShortRoleName,
    getWinCondition,
} from './roles';

describe('translateRoles', () => {
    it('役職キーの配列を日本語名のカンマ区切りに変換する', () => {
        expect(translateRoles(['seer', 'medium', 'guard'])).toBe('占い師, 霊能者, 騎士');
    });

    it('ROLE_MAP に存在しないキーはそのまま返す（フォールバック）', () => {
        expect(translateRoles(['unknown_role'])).toBe('unknown_role');
    });

    it('空配列を渡すと空文字を返す', () => {
        expect(translateRoles([])).toBe('');
    });
});

describe('getRoleDescription', () => {
    it('既知の役職（日本語名）の説明文を返す', () => {
        expect(getRoleDescription('占い師')).toContain('占い');
    });

    it('未知の役職には「役職情報なし」を返す', () => {
        expect(getRoleDescription('存在しない役職')).toBe('役職情報なし');
    });
});

describe('isWolfTeam', () => {
    it('人狼陣営の役職には true を返す', () => {
        expect(isWolfTeam('人狼')).toBe(true);
        expect(isWolfTeam('狂人')).toBe(true);
        expect(isWolfTeam('妖術師')).toBe(true);
    });

    it('村人陣営・第三陣営の役職には false を返す', () => {
        expect(isWolfTeam('村人')).toBe(false);
        expect(isWolfTeam('占い師')).toBe(false);
        expect(isWolfTeam('妖狐')).toBe(false);
    });

    it('未知の役職には false を返す', () => {
        expect(isWolfTeam('存在しない役職')).toBe(false);
    });
});

describe('isActualWolf', () => {
    it('人狼カウントに数えられる役職には true を返す（人狼・饒舌な人狼・白狼）', () => {
        expect(isActualWolf('人狼')).toBe(true);
        expect(isActualWolf('饒舌な人狼')).toBe(true);
        expect(isActualWolf('白狼')).toBe(true);
    });

    it('人狼陣営でも襲撃カウントに含まれない役職には false を返す（狂人など）', () => {
        expect(isActualWolf('狂人')).toBe(false);
        expect(isActualWolf('狂信者')).toBe(false);
        expect(isActualWolf('妖術師')).toBe(false);
    });

    it('村人陣営の役職には false を返す', () => {
        expect(isActualWolf('村人')).toBe(false);
    });
});

describe('getShortRoleName', () => {
    it('shortName が定義されている役職は短縮名を使う（饒舌な人狼 → 饒舌狼）', () => {
        expect(getShortRoleName('loquacious')).toBe('🐺 饒舌狼');
    });

    it('shortName が無い役職はフルネームを使う', () => {
        expect(getShortRoleName('seer')).toBe('🔮 占い師');
    });

    it('ROLE_MAP / ROLE_CATALOG どちらにも無いキーは ❓ 付きで返す', () => {
        expect(getShortRoleName('totally_unknown')).toBe('❓ totally_unknown');
    });
});

describe('getWinCondition', () => {
    it('既知の役職（日本語名）の勝利条件を返す', () => {
        expect(getWinCondition('村人')).toBe('人狼を全員処刑する');
        expect(getWinCondition('妖狐')).toBe('処刑されず、ゲーム終了まで生き残る');
    });

    it('未知の役職には「不明な勝利条件です」を返す', () => {
        expect(getWinCondition('存在しない役職')).toBe('不明な勝利条件です');
    });
});

describe('ROLE_MAP の整合性', () => {
    it('すべてのキーが空でない日本語名にマッピングされている', () => {
        for (const [key, value] of Object.entries(ROLE_MAP)) {
            expect(value.length).toBeGreaterThan(0);
            expect(typeof key).toBe('string');
        }
    });
});
