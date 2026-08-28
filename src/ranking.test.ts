import { describe, expect, it } from "vitest";
import {
  buildPublicRankingPayload,
  isRankingButton,
  rankingSettingsRow,
  RANKING_SITE_URL,
} from "./ranking";

describe("公開ランキング", () => {
  it("ソロと友達戦を分けて公開用データへ変換する", () => {
    const payload = buildPublicRankingPayload(
      [
        {
          mode: "friends",
          rank_position: 1,
          public_name: "ステイブ",
          games: "8",
          wins: "5",
          losses: "3",
          win_rate: 63,
        },
        {
          mode: "solo",
          rank_position: 1,
          public_name: "現カス2号",
          games: 9,
          wins: 6,
          losses: 3,
          win_rate: 67,
        },
        {
          mode: "unknown",
          rank_position: 1,
          public_name: "表示しない",
          games: 99,
          wins: 99,
          losses: 0,
          win_rate: 100,
        },
      ],
      new Date("2026-08-28T00:00:00.000Z"),
    );

    expect(payload.season).toBe("2026-08");
    expect(payload.minimumGames).toBe(5);
    expect(payload.rankings.friends).toEqual([
      {
        rank: 1,
        name: "ステイブ",
        games: 8,
        wins: 5,
        losses: 3,
        rate: 63,
      },
    ]);
    expect(payload.rankings.solo).toEqual([
      {
        rank: 1,
        name: "現カス2号",
        games: 9,
        wins: 6,
        losses: 3,
        rate: 67,
      },
    ]);
  });

  it("参加・非公開・サイト表示を1行から選べる", () => {
    const row = rankingSettingsRow().toJSON();
    expect(row.components).toHaveLength(3);
    expect(row.components.map((component) => component.label)).toEqual([
      "ランキングに参加",
      "非公開にする",
      "ランキングを見る",
    ]);
    expect(row.components[2]?.url).toBe(RANKING_SITE_URL);
    expect(isRankingButton("tomatobot-ranking-join")).toBe(true);
    expect(isRankingButton("tomatobot-ranking-leave")).toBe(true);
    expect(isRankingButton("unrelated-button")).toBe(false);
  });
});
