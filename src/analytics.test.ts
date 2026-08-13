import { describe, expect, it } from "vitest";
import {
  recordGameAbandoned,
  recordGameCompleted,
  recordGameStarted,
  recordLobbyOpened,
  recordMatchFeedback,
  recordRematchRequested,
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
      recordMatchFeedback({
        sessionId: session.sessionId,
        userId: "user",
        rating: "issue",
        comment: "もう少し分かりやすくしてほしい",
      }),
    ).resolves.toEqual({ status: "disabled" });
  });
});
