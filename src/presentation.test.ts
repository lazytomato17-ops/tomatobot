import { describe, expect, it } from "vitest";
import {
  countVotes,
  discussionDuration,
  relativeTime,
  resolveVoteOutcome,
} from "./presentation";

describe("表示用テキスト", () => {
  it("Discordの相対時刻を生成する", () => {
    expect(relativeTime(1_750_000_000_000)).toBe("<t:1750000000:R>");
  });

  it("得票数を多い順に集計する", () => {
    expect(countVotes(["a", "b", "a"])).toEqual([
      { id: "a", count: 2 },
      { id: "b", count: 1 },
    ]);
  });
});

describe("進行ルール", () => {
  it("人数が増えると議論時間も伸びる", () => {
    expect(discussionDuration(4, 1)).toBe(45);
    expect(discussionDuration(7, 1)).toBe(60);
    expect(discussionDuration(12, 2)).toBe(90);
    expect(discussionDuration(7, 0)).toBe(12);
  });

  it("同票なら再投票し、2回目も同票なら処刑しない", () => {
    expect(resolveVoteOutcome(["a", "b"], 1)).toEqual({
      kind: "revote",
      candidateIds: ["a", "b"],
    });
    expect(resolveVoteOutcome(["a", "b"], 2)).toEqual({
      kind: "no-execution",
      candidateIds: ["a", "b"],
    });
  });

  it("最多票が1人なら処刑対象を返す", () => {
    expect(resolveVoteOutcome(["a", "a", "b"], 1)).toEqual({
      kind: "execute",
      targetId: "a",
    });
  });
});
