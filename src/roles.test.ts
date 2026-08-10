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
});

describe("buildCustomRoles", () => {
  it("特殊役職を指定し、残りを村人で埋める", () => {
    const roles = buildCustomRoles(6, {
      人狼: 1,
      占い師: 1,
      騎士: 0,
      霊能者: 1,
    });
    expect(roles.filter((role) => role === "村人")).toHaveLength(3);
    expect(roles).toHaveLength(6);
  });

  it("開始時点で人狼勝利になる構成は拒否する", () => {
    expect(() =>
      buildCustomRoles(6, {
        人狼: 3,
        占い師: 1,
        騎士: 0,
        霊能者: 0,
      }),
    ).toThrow("人狼が多すぎます");
  });
});
