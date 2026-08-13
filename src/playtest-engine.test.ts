import { describe, expect, it } from "vitest";
import {
  buildPlaytestScenarios,
  runScenario,
  simulateGame,
} from "./playtest-engine";
import { buildSoloRoles } from "./solo";

describe("自動品質テスト", () => {
  it("4〜15人を標準・通常・狂人入り・占い2人で検証対象にする", () => {
    const scenarios = buildPlaytestScenarios();
    for (let count = 4; count <= 15; count += 1) {
      expect(
        scenarios.some(
          (scenario) =>
            scenario.profile === "ソロ標準" && scenario.roles.length === count,
        ),
      ).toBe(true);
      expect(
        scenarios.some(
          (scenario) =>
            scenario.profile === "通常配役" && scenario.roles.length === count,
        ),
      ).toBe(true);
    }
    expect(
      scenarios.some(
        (scenario) =>
          scenario.profile === "狂人入り" && scenario.roles.length === 4,
      ),
    ).toBe(false);
    for (let count = 5; count <= 15; count += 1) {
      const doubleSeer = scenarios.find(
        (scenario) =>
          scenario.profile === "占い2人" && scenario.roles.length === count,
      );
      expect(doubleSeer).toBeDefined();
      expect(
        doubleSeer?.roles.filter((role) => role === "占い師"),
      ).toHaveLength(2);
      expect(
        doubleSeer?.roles.filter((role) => role === "人狼").length,
      ).toBeGreaterThanOrEqual(2);
    }
    for (let count = 7; count <= 15; count += 1) {
      expect(
        scenarios.some(
          (scenario) =>
            scenario.name === `占い2狂-${count}人` &&
            scenario.roles.filter((role) => role === "占い師").length === 2 &&
            scenario.roles.includes("狂人"),
        ),
      ).toBe(true);
    }
  });

  it("同じシードなら同じ試合結果を再現する", () => {
    const roles = buildSoloRoles(7);
    expect(simulateGame(roles, 123_456)).toEqual(simulateGame(roles, 123_456));
  });

  it("7人の標準試合で唯一COを参考にしつつ矛盾を起こさない", () => {
    const summary = runScenario(
      { name: "テスト7人", profile: "ソロ標準", roles: buildSoloRoles(7) },
      120,
      700_000,
    );
    expect(summary.timeoutRate).toBe(0);
    expect(summary.ownClaimContradictionRate ?? 0).toBeLessThanOrEqual(0.01);
    expect(summary.loneBlackVoteRate ?? 0).toBeGreaterThan(0.6);
    expect(summary.loneBlackVoteRate ?? 1).toBeLessThan(0.95);
    expect(summary.villageWinRate).toBeGreaterThan(0.25);
    expect(summary.villageWinRate).toBeLessThan(0.75);
  });

  it("占い師2人の自由配役でも夜行動と進行が止まらない", () => {
    const summary = runScenario(
      {
        name: "占い師2人",
        profile: "占い2人",
        roles: ["人狼", "人狼", "占い師", "占い師", "騎士", "霊能者", "村人"],
      },
      80,
      900_000,
    );
    expect(summary.timeoutRate).toBe(0);
    expect(summary.ownClaimContradictionRate ?? 0).toBeLessThanOrEqual(0.01);
    expect(summary.villageWinRate).toBeGreaterThan(0.3);
    expect(summary.villageWinRate).toBeLessThan(0.7);
  });
});
