import { describe, expect, it } from "vitest";
import {
  adminAnalyticsEmbed,
  analyticsRange,
  buildAdminAnalyticsReport,
  buildPlayerAnalyticsSummary,
} from "./admin-analytics";

describe("運営レポート", () => {
  it("JSTの直近7日と前週を分ける", () => {
    expect(analyticsRange(new Date("2026-08-30T03:00:00.000Z"))).toEqual({
      previousStart: "2026-08-17",
      previousEnd: "2026-08-23",
      currentStart: "2026-08-24",
      currentEnd: "2026-08-30",
      currentEndExclusive: "2026-08-31",
    });
  });

  it("日次データを加重平均してDiscord表示へ変換する", () => {
    const report = buildAdminAnalyticsReport(
      [
        {
          day_jst: "2026-08-23",
          started: 4,
          completed: 2,
          started_chains: 2,
          average_matches_per_chain: 1.5,
          first_to_second_match_rate_percent: 50,
        },
        {
          day_jst: "2026-08-24",
          started: "5",
          completed: "4",
          abandoned: 1,
          started_chains: 2,
          solo_starts: 3,
          multiplayer_starts: 2,
          average_matches_per_chain: 2,
          first_to_second_match_rate_percent: 50,
          average_completed_seconds: 240,
          abandoned_voting: 1,
          feedback_again: 2,
          feedback_issue: 1,
          reason_npc: 1,
        },
        {
          day_jst: "2026-08-30",
          started: 3,
          completed: 2,
          started_chains: 1,
          solo_starts: 1,
          multiplayer_starts: 2,
          average_matches_per_chain: 1,
          first_to_second_match_rate_percent: 0,
          average_completed_seconds: 300,
          feedback_neutral: 1,
        },
      ],
      [
        {
          day_jst: "2026-08-24",
          abandoned: 1,
          answered: 1,
          controls: 1,
        },
      ],
      [
        {
          app_version: "2.2.0+abcdef123456",
          started_at: "2026-08-24T00:00:00Z",
        },
        {
          app_version: "2.2.0+abcdef123456",
          started_at: "2026-08-25T00:00:00Z",
        },
        { app_version: "2.1.0", started_at: "2026-08-24T00:00:00Z" },
      ],
      {
        active: 3,
        newPlayers: 1,
        returning: 2,
        previousActive: 2,
      },
      new Date("2026-08-30T03:00:00.000Z"),
    );

    expect(report.current.started).toBe(8);
    expect(report.current.completed).toBe(6);
    expect(report.current.completionRate).toBe(75);
    expect(report.current.averageMatchesPerChain).toBeCloseTo(5 / 3);
    expect(report.current.secondMatchRate).toBeCloseTo(100 / 3);
    expect(report.current.averageCompletedSeconds).toBe(260);
    expect(report.previous.started).toBe(4);
    expect(report.abandonReasons.controls).toBe(1);
    expect(report.versions[0]).toEqual({
      version: "2.2.0+abcdef123456",
      starts: 2,
    });

    const json = adminAnalyticsEmbed(report).toJSON();
    const content = JSON.stringify(json);
    expect(content).toContain("開始 **8**｜完走 **6**（75.0%）");
    expect(content).toContain("利用者 **3人**｜新規 **1**｜再訪 **2**");
    expect(content).toContain("友達戦 **4**（50.0%）");
    expect(content).toContain("開始前 **0**｜試合中 **1**｜不明 **0**");
    expect(content).toContain("投票 1");
    expect(content).toContain("NPC 1");
    expect(content).toContain("2.2.0（abcdef1）｜2試合");
    expect(content).not.toContain("1010400040797360218");
  });

  it("データがない期間もゼロとして表示する", () => {
    const report = buildAdminAnalyticsReport(
      [],
      [],
      [],
      { active: 0, newPlayers: 0, returning: 0, previousActive: 0 },
      new Date("2026-08-30T03:00:00.000Z"),
    );
    const content = JSON.stringify(adminAnalyticsEmbed(report).toJSON());
    expect(report.current.started).toBe(0);
    expect(content).toContain("完走 **0**（—）");
    expect(content).toContain("報告なし");
    expect(content).toContain("前週の試合データなし");
  });

  it("匿名参加者を期間ごとに重複なく数える", () => {
    const range = analyticsRange(new Date("2026-08-30T03:00:00.000Z"));
    const players = buildPlayerAnalyticsSummary(
      [
        { id: "previous", started_at: "2026-08-23T03:00:00Z" },
        { id: "current-a", started_at: "2026-08-24T03:00:00Z" },
        { id: "current-b", started_at: "2026-08-30T03:00:00Z" },
      ],
      [
        { session_id: "previous", participant_hash: "same-player" },
        { session_id: "previous", participant_hash: "previous-only" },
        { session_id: "current-a", participant_hash: "same-player" },
        { session_id: "current-a", participant_hash: "new-player" },
        { session_id: "current-b", participant_hash: "new-player" },
      ],
      [{ cohort_day_jst: "2026-08-24", new_players: 1 }],
      range,
    );

    expect(players).toEqual({
      active: 2,
      newPlayers: 1,
      returning: 1,
      previousActive: 2,
    });
  });
});
