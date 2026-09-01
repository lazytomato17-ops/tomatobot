import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

describe("戦績の保存", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET = "analytics-test-secret";
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET;
    vi.restoreAllMocks();
  });

  it("試合の保存時も生のサーバー・チャンネルIDを送らない", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: new Error("stop after payload inspection"),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordGameStats } = await import("./stats");

    await expect(
      recordGameStats({
        matchId: "0190cf7d-2f0d-7cb3-b815-f59fb6adc95a",
        guildId: "1503293657250529433",
        channelId: "1503293657900515350",
        winner: "villager",
        dayCount: 2,
        players: [
          {
            userId: "1010400040797360218",
            displayName: "プレイヤー",
            role: "村人",
            won: true,
            survived: true,
          },
        ],
      }),
    ).resolves.toEqual({ status: "failed", players: [] });

    const payload = mocks.rpc.mock.calls[0][1];
    expect(payload.p_guild_id).toBe("not-collected");
    expect(payload.p_channel_id).toBe("not-collected");
    expect(JSON.stringify(payload)).not.toContain("1503293657250529433");
    expect(JSON.stringify(payload)).not.toContain("1503293657900515350");
  });
});
