import { describe, expect, it } from "vitest";
import {
  combinedSuspicion,
  findNpcInsight,
  npcOpinionLine,
  personalityForSerial,
} from "./npc";

describe("NPCの性格", () => {
  it("NPCごとに固定の性格を割り当てる", () => {
    expect([1, 2, 3, 4, 5].map(personalityForSerial)).toEqual([
      "慎重",
      "直感",
      "追及",
      "同調",
      "慎重",
    ]);
  });

  it("性格によって共有情報と記憶の重みが変わる", () => {
    const shared = new Map([["a", 2]]);
    const memory = new Map([["b", 2]]);
    expect(combinedSuspicion(shared, memory, "同調").get("a")).toBe(3);
    expect(combinedSuspicion(shared, memory, "追及").get("b")).toBe(3);
  });

  it("性格ごとに一貫した口調を使う", () => {
    expect(npcOpinionLine("慎重", "レン")).toContain("断定はしない");
    expect(npcOpinionLine("追及", "レン")).toContain("説明してほしい");
  });
});

describe("NPCの推理", () => {
  it("占い結果と投票先の矛盾を翌日に指摘する", () => {
    const insight = findNpcInsight(
      [
        {
          day: 1,
          speakerId: "seer",
          claimedRole: "占い師",
          targetId: "wolf",
          result: "人狼",
        },
      ],
      [
        {
          day: 1,
          round: 1,
          ballots: [{ voterId: "seer", targetId: "other" }],
        },
      ],
      "observer",
      new Set(["seer", "wolf", "other", "observer"]),
    );
    expect(insight).toEqual({
      suspectId: "seer",
      reason: "人狼判定を出した相手とは別の人へ投票していた",
    });
  });

  it("霊能結果と投票先は比較しない", () => {
    const insight = findNpcInsight(
      [
        {
          day: 2,
          speakerId: "medium",
          claimedRole: "霊能者",
          targetId: "dead",
          result: "人狼",
        },
      ],
      [
        {
          day: 2,
          round: 1,
          ballots: [{ voterId: "medium", targetId: "alive" }],
        },
      ],
      "observer",
      new Set(["medium", "alive", "observer"]),
    );
    expect(insight).toBeNull();
  });
});
