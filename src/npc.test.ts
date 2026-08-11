import { describe, expect, it } from "vitest";
import {
  chooseNpcQuestionAnswer,
  combinedSuspicion,
  findNpcInsight,
  npcOpinionLine,
  personalityForSerial,
} from "./npc";
import type { GameState, Player } from "./types";

type QuestionGame = Pick<
  GameState,
  | "day"
  | "players"
  | "npcSuspicion"
  | "humanSuspicions"
  | "npcClaims"
  | "voteHistory"
>;

function questionPlayer(
  id: string,
  role: Player["role"],
  isNpc = true,
): Player {
  return {
    id,
    name: id,
    user: null,
    isNpc,
    role,
    alive: true,
    npcPersonality: isNpc ? "慎重" : undefined,
  };
}

function questionGame(players: Player[]): QuestionGame {
  return {
    day: 1,
    players,
    npcSuspicion: new Map(),
    humanSuspicions: new Map(),
    npcClaims: [],
    voteHistory: [],
  };
}

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
    expect(combinedSuspicion(shared, memory, "同調").get("a")).toBe(2.4);
    expect(combinedSuspicion(shared, memory, "慎重").get("a")).toBe(0.9);
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

  it("対抗COの発言順だけでは片方を偽物扱いしない", () => {
    const insight = findNpcInsight(
      [
        {
          day: 1,
          speakerId: "first",
          claimedRole: "占い師",
          targetId: "target",
          result: "人狼",
        },
        {
          day: 1,
          speakerId: "second",
          claimedRole: "占い師",
          targetId: "target",
          result: "人間",
        },
      ],
      [],
      "observer",
      new Set(["first", "second", "target", "observer"]),
    );
    expect(insight).toBeNull();
  });

  it("質問には公開された人狼判定を理由として答える", () => {
    const observer = questionPlayer("レン", "村人");
    const seer = questionPlayer("ミオ", "占い師");
    const target = questionPlayer("アカネ", "村人");
    const game = questionGame([observer, seer, target]);
    game.npcSuspicion.set(target.id, 1.25);
    game.npcClaims.push({
      day: 1,
      speakerId: seer.id,
      claimedRole: "占い師",
      targetId: target.id,
      result: "人狼",
    });

    expect(chooseNpcQuestionAnswer(game, observer)).toEqual({
      targetId: target.id,
      reason: "占い師COから人狼判定が出ている",
    });
  });

  it("質問では占いCOと投票の矛盾を優先して説明する", () => {
    const observer = questionPlayer("レン", "村人");
    const claimant = questionPlayer("ミオ", "村人");
    const blackTarget = questionPlayer("アカネ", "村人");
    const other = questionPlayer("ユズ", "村人");
    const game = questionGame([observer, claimant, blackTarget, other]);
    game.day = 2;
    game.npcClaims.push({
      day: 1,
      speakerId: claimant.id,
      claimedRole: "占い師",
      targetId: blackTarget.id,
      result: "人狼",
    });
    game.voteHistory.push({
      day: 1,
      round: 1,
      ballots: [{ voterId: claimant.id, targetId: other.id }],
    });

    expect(chooseNpcQuestionAnswer(game, observer)).toEqual({
      targetId: claimant.id,
      reason: "人狼判定を出した相手とは別の人へ投票していた",
    });
  });

  it("人狼NPCは質問で仲間の人狼を告発しない", () => {
    const wolf = questionPlayer("レン", "人狼");
    const ally = questionPlayer("アカネ", "人狼");
    const villager = questionPlayer("ミオ", "村人", false);
    const game = questionGame([wolf, ally, villager]);
    game.npcSuspicion.set(ally.id, 2.5);
    game.npcSuspicion.set(villager.id, 0.1);

    expect(chooseNpcQuestionAnswer(game, wolf)?.targetId).toBe(villager.id);
  });

  it("狂人NPCは人狼を知らず、公開情報への逆張りで人狼も疑える", () => {
    const madman = questionPlayer("a", "狂人");
    const wolf = questionPlayer("アカネ", "人狼");
    const villager = questionPlayer("ミオ", "村人", false);
    const game = questionGame([madman, wolf, villager]);
    game.npcSuspicion.set(villager.id, 2);

    expect(chooseNpcQuestionAnswer(game, madman)?.targetId).toBe(wolf.id);
  });
});
