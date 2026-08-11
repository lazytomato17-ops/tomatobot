import { describe, expect, it } from "vitest";
import { getWinner } from "./roles";
import {
  assignGameRoles,
  assignSoloPuzzleRoles,
  buildSoloRoles,
  chooseNpcVoteTarget,
  SOLO_PLAYER_COUNT,
} from "./solo";
import type { Player } from "./types";

function soloPlayers(): Player[] {
  return [
    { id: "human", name: "Human", user: null, isNpc: false, alive: true },
    ...Array.from({ length: SOLO_PLAYER_COUNT - 1 }, (_, index) => ({
      id: `npc-${index}`,
      name: `NPC${index}`,
      user: null,
      isNpc: true,
      alive: true,
    })),
  ];
}

describe("1人プレイの編成", () => {
  it("1000回生成しても人間が人狼にならず、人狼は1人だけ", () => {
    for (let trial = 0; trial < 1000; trial += 1) {
      const assignments = assignGameRoles(soloPlayers());
      expect(["占い師", "騎士"]).toContain(assignments.get("human"));
      expect(
        [...assignments.values()].filter((role) => role === "人狼"),
      ).toHaveLength(1);
    }
  });

  it("4〜15人のどの人数でも役職数が一致する", () => {
    for (let count = 4; count <= 15; count += 1) {
      expect(buildSoloRoles(count)).toHaveLength(count);
    }
  });

  it("カスタム配役でも人間は村人陣営になる", () => {
    const assignments = assignGameRoles(soloPlayers(), () => 0, [
      "人狼",
      "人狼",
      "占い師",
      "騎士",
      "村人",
      "村人",
      "村人",
    ]);
    expect(assignments.get("human")).not.toBe("人狼");
    expect(
      [...assignments.values()].filter((role) => role === "人狼"),
    ).toHaveLength(2);
  });

  it("推理モードでは人間を村人に固定し、配役数を保つ", () => {
    const roles = [
      "人狼",
      "人狼",
      "占い師",
      "騎士",
      "村人",
      "村人",
      "村人",
    ] as const;
    const assignments = assignSoloPuzzleRoles(
      soloPlayers(),
      [...roles],
      () => 0,
    );
    expect(assignments.get("human")).toBe("村人");
    expect([...assignments.values()].sort()).toEqual([...roles].sort());
  });

  it("推理モードに村人がいない配役は開始できない", () => {
    expect(() =>
      assignSoloPuzzleRoles(soloPlayers(), [
        "人狼",
        "人狼",
        "占い師",
        "騎士",
        "霊能者",
        "占い師",
        "騎士",
      ]),
    ).toThrow("村人を1人以上");
  });

  it("村側が処刑・襲撃で2人減っても即終了しない", () => {
    const players = soloPlayers();
    const assignments = assignGameRoles(players, () => 0.25);
    players.forEach((player) => {
      player.role = assignments.get(player.id);
    });
    players
      .filter((player) => player.role !== "人狼")
      .slice(0, 2)
      .forEach((player) => {
        player.alive = false;
      });
    expect(getWinner(players)).toBeNull();
  });
});

describe("NPC投票", () => {
  it("占いで黒判定された対象を優先する", () => {
    const target = chooseNpcVoteTarget(
      { id: "npc-a", role: "村人" },
      [
        { id: "npc-a", role: "村人" },
        { id: "wolf", role: "人狼" },
        { id: "other", role: "村人" },
      ],
      new Map([
        ["wolf", 5],
        ["other", 0],
      ]),
      () => 0,
    );
    expect(target).toBe("wolf");
  });

  it("自分自身には投票しない", () => {
    const target = chooseNpcVoteTarget(
      { id: "npc-a", role: "村人" },
      [
        { id: "npc-a", role: "村人" },
        { id: "npc-b", role: "村人" },
      ],
      new Map([["npc-a", 100]]),
      () => 0,
    );
    expect(target).toBe("npc-b");
  });
});
