import { describe, expect, it } from "vitest";
import { buildCustomRoles, buildRoles, getWinner } from "./roles";

describe("buildRoles", () => {
  it("4人村は人狼1・占い師1・村人2になる", () => {
    expect(buildRoles(4).sort()).toEqual(
      ["人狼", "占い師", "村人", "村人"].sort(),
    );
  });

  it("7人以上では人狼が2人になる", () => {
    expect(buildRoles(7).filter((role) => role === "人狼")).toHaveLength(2);
  });

  it("人数外は拒否する", () => {
    expect(() => buildRoles(3)).toThrow();
    expect(() => buildRoles(16)).toThrow();
  });
});

describe("getWinner", () => {
  it("人狼が全滅すると村人勝利になる", () => {
    expect(
      getWinner([
        { role: "人狼", alive: false },
        { role: "村人", alive: true },
      ]),
    ).toBe("villager");
  });

  it("生存人数が同数になると人狼勝利になる", () => {
    expect(
      getWinner([
        { role: "人狼", alive: true },
        { role: "占い師", alive: true },
      ]),
    ).toBe("wolf");
  });

  it("狂人を勝利判定では人間として数える", () => {
    expect(
      getWinner([
        { role: "人狼", alive: true },
        { role: "狂人", alive: true },
        { role: "村人", alive: true },
      ]),
    ).toBeNull();
    expect(
      getWinner([
        { role: "人狼", alive: true },
        { role: "狂人", alive: true },
      ]),
    ).toBe("wolf");
  });

  it("人狼が全滅すれば狂人が生存していても村人勝利になる", () => {
    expect(
      getWinner([
        { role: "人狼", alive: false },
        { role: "狂人", alive: true },
        { role: "村人", alive: true },
      ]),
    ).toBe("villager");
  });
});

describe("buildCustomRoles", () => {
  it("特殊役職を指定し、残りを村人で埋める", () => {
    const roles = buildCustomRoles(6, {
      人狼: 1,
      狂人: 1,
      占い師: 1,
      騎士: 0,
      霊能者: 1,
    });
    expect(roles.filter((role) => role === "村人")).toHaveLength(2);
    expect(roles.filter((role) => role === "狂人")).toHaveLength(1);
    expect(roles).toHaveLength(6);
  });

  it("開始時点で人狼勝利になる構成は拒否する", () => {
    expect(() =>
      buildCustomRoles(6, {
        人狼: 3,
        狂人: 0,
        占い師: 1,
        騎士: 0,
        霊能者: 0,
      }),
    ).toThrow("人狼陣営が多すぎます");
  });

  it("人狼と狂人の合計が村人陣営以上になる構成は拒否する", () => {
    expect(() =>
      buildCustomRoles(6, {
        人狼: 2,
        狂人: 1,
        占い師: 1,
        騎士: 0,
        霊能者: 0,
      }),
    ).toThrow("村人陣営より少なくしてください");
  });

  it("狂人は2人まで設定できる", () => {
    const roles = buildCustomRoles(7, {
      人狼: 1,
      狂人: 2,
      占い師: 1,
      騎士: 1,
      霊能者: 1,
    });
    expect(roles.filter((role) => role === "狂人")).toHaveLength(2);
  });

  it("狂人は3人以上にできない", () => {
    expect(() =>
      buildCustomRoles(9, {
        人狼: 1,
        狂人: 3,
        占い師: 1,
        騎士: 0,
        霊能者: 0,
      }),
    ).toThrow("狂人は2人まで");
  });

  it("占い師は3人まで設定できる", () => {
    const roles = buildCustomRoles(7, {
      人狼: 3,
      狂人: 0,
      占い師: 3,
      騎士: 0,
      霊能者: 0,
    });
    expect(roles.filter((role) => role === "占い師")).toHaveLength(3);
    expect(roles).toHaveLength(7);
  });

  it("人狼数に関係なく占い師を複数設定できる", () => {
    const roles = buildCustomRoles(7, {
      人狼: 1,
      狂人: 0,
      占い師: 3,
      騎士: 1,
      霊能者: 1,
    });
    expect(roles.filter((role) => role === "人狼")).toHaveLength(1);
    expect(roles.filter((role) => role === "占い師")).toHaveLength(3);
  });

  it("占い師は4人以上にできない", () => {
    expect(() =>
      buildCustomRoles(9, {
        人狼: 4,
        狂人: 0,
        占い師: 4,
        騎士: 0,
        霊能者: 0,
      }),
    ).toThrow("占い師は3人まで");
  });

  it("7人なら2人狼と狂人1人を設定できる", () => {
    const roles = buildCustomRoles(7, {
      人狼: 2,
      狂人: 1,
      占い師: 1,
      騎士: 1,
      霊能者: 1,
    });
    expect(roles).toHaveLength(7);
    expect(roles.filter((role) => role === "人狼")).toHaveLength(2);
    expect(roles.filter((role) => role === "狂人")).toHaveLength(1);
  });
});
