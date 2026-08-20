import { describe, expect, it } from "vitest";
import {
  anonymizeAnalyticsUserId,
  recordGameAbandoned,
  recordGameCompleted,
  recordGameStarted,
  recordLobbyOpened,
  recordMatchFeedback,
  recordRematchRequested,
  recordSessionParticipants,
  type PlaySessionSnapshot,
} from "./analytics";

const session: PlaySessionSnapshot = {
  sessionId: "0190cf7d-2f0d-7cb3-b815-f59fb6adc95a",
  guildId: "guild",
  channelId: "channel",
  targetPlayerCount: 7,
  humanCount: 1,
  npcCount: 6,
  roleConfig: { 人狼: 1, 占い師: 1, 騎士: 1, 霊能者: 1, 狂人: 0, 村人: 3 },
};

describe("プレイ記録", () => {
  it("Supabase未設定でも全イベントがゲームを止めない", async () => {
    await expect(recordLobbyOpened(session)).resolves.toEqual({
      status: "disabled",
    });
    await expect(
      recordGameStarted({ ...session, startedAt: new Date(0).toISOString() }),
    ).resolves.toEqual({ status: "disabled" });
    await expect(
      recordGameCompleted({
        ...session,
        winner: "villager",
        dayCount: 3,
        durationSeconds: 240,
      }),
    ).resolves.toEqual({ status: "disabled" });
    await expect(
      recordGameAbandoned({
        ...session,
        status: "reset",
        dayCount: 1,
        durationSeconds: 30,
      }),
    ).resolves.toEqual({ status: "disabled" });
    await expect(recordRematchRequested(session.sessionId)).resolves.toEqual({
      status: "disabled",
    });
    await expect(
      recordSessionParticipants({
        sessionId: session.sessionId,
        participants: [{ userId: "user", isHost: true }],
      }),
    ).resolves.toEqual({ status: "disabled" });
    await expect(
      recordMatchFeedback({
        sessionId: session.sessionId,
        userId: "user",
        rating: "issue",
        comment: "もう少し分かりやすくしてほしい",
      }),
    ).resolves.toEqual({ status: "disabled" });
  });

  it("参加者IDを秘密値つきで安定して匿名化する", () => {
    const previous = process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET;
    process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET = "analytics-test-secret";
    try {
      const first = anonymizeAnalyticsUserId("1010400040797360218");
      const same = anonymizeAnalyticsUserId("1010400040797360218");
      const other = anonymizeAnalyticsUserId("1439620582504402964");
      expect(first).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(first).toBe(same);
      expect(first).not.toBe(other);
      expect(first).not.toContain("1010400040797360218");
    } finally {
      if (previous === undefined)
        delete process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET;
      else process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET = previous;
    }
  });
});
