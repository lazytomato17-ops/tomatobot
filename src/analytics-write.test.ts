import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  inStatus: vi.fn(),
  isNull: vi.fn(),
  select: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

describe("中断理由の保存", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-secret";
    mocks.createClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
    mocks.from.mockReturnValue({ update: mocks.update });
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ in: mocks.inStatus });
    mocks.inStatus.mockReturnValue({ is: mocks.isNull });
    mocks.isNull.mockReturnValue({ select: mocks.select });
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET;
    vi.restoreAllMocks();
  });

  it("終了済みかつ未回答のセッションへ1回だけ保存する", async () => {
    mocks.select.mockResolvedValue({ data: [{ id: "session" }], error: null });
    const { recordAbandonReason } = await import("./analytics");

    await expect(
      recordAbandonReason({
        sessionId: "session",
        reason: "testing_config",
      }),
    ).resolves.toEqual({ status: "saved" });
    expect(mocks.from).toHaveBeenCalledWith("tomatobot_play_sessions");
    expect(mocks.update).toHaveBeenCalledWith({
      abandon_reason: "testing_config",
    });
    expect(mocks.eq).toHaveBeenCalledWith("id", "session");
    expect(mocks.inStatus).toHaveBeenCalledWith("status", [
      "cancelled",
      "reset",
    ]);
    expect(mocks.isNull).toHaveBeenCalledWith("abandon_reason", null);
  });

  it("対象行がない場合は保存済みと誤認しない", async () => {
    mocks.select.mockResolvedValue({ data: [], error: null });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordAbandonReason } = await import("./analytics");

    await expect(
      recordAbandonReason({ sessionId: "missing", reason: "other" }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("DBエラーをゲーム本体へ投げず失敗として返す", async () => {
    mocks.select.mockResolvedValue({
      data: null,
      error: new Error("database unavailable"),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordAbandonReason } = await import("./analytics");

    await expect(
      recordAbandonReason({ sessionId: "session", reason: "controls" }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("導入イベントは匿名サーバーIDだけをRPCへ送る", async () => {
    process.env.TOMATOBOT_ANALYTICS_HMAC_SECRET = "analytics-test-secret";
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const { recordGuildFunnelEvent } = await import("./analytics");
    const occurredAt = new Date("2026-08-30T01:02:03.000Z");

    await expect(
      recordGuildFunnelEvent("1503293657250529433", "installed", occurredAt),
    ).resolves.toEqual({ status: "saved" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "tomatobot_record_guild_funnel_event",
      expect.objectContaining({
        p_guild_hash: expect.stringMatching(/^g1:[0-9a-f]{64}$/),
        p_event: "installed",
        p_occurred_at: "2026-08-30T01:02:03.000Z",
      }),
    );
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(
      "1503293657250529433",
    );
  });
});
