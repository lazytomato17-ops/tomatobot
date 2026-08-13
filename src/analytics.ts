import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Winner } from "./types";

const REQUEST_TIMEOUT_MS = 5000;

export type FeedbackRating = "again" | "neutral" | "issue";
export type PlaySessionStatus =
  | "lobby"
  | "started"
  | "completed"
  | "cancelled"
  | "reset";

export interface PlaySessionSnapshot {
  sessionId: string;
  sourceSessionId?: string;
  guildId: string;
  channelId: string;
  targetPlayerCount: number;
  humanCount: number;
  npcCount: number;
  roleConfig: Record<string, number>;
}

export type AnalyticsResult = { status: "saved" | "disabled" | "failed" };

let cachedClient: SupabaseClient | null | undefined;
let warnedAboutMissingConfig = false;

const timedFetch: typeof fetch = async (input, init = {}) => {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
};

function analyticsClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_KEY?.trim();

  if (!url || !key) {
    if (!warnedAboutMissingConfig && process.env.NODE_ENV !== "test") {
      console.warn(
        "Play analytics are disabled: SUPABASE_URL and a Supabase secret key are required.",
      );
      warnedAboutMissingConfig = true;
    }
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { fetch: timedFetch },
  });
  return cachedClient;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

async function save(
  action: string,
  operation: (client: SupabaseClient) => PromiseLike<{ error: unknown }>,
): Promise<AnalyticsResult> {
  try {
    const client = analyticsClient();
    if (!client) return { status: "disabled" };
    const { error } = await operation(client);
    if (error) throw error;
    return { status: "saved" };
  } catch (error) {
    console.error(`Play analytics ${action} failed: ${errorMessage(error)}`);
    return { status: "failed" };
  }
}

function sessionRow(
  input: PlaySessionSnapshot,
  status: PlaySessionStatus,
): Record<string, unknown> {
  return {
    id: input.sessionId,
    source_session_id: input.sourceSessionId ?? null,
    guild_id: input.guildId,
    channel_id: input.channelId,
    status,
    target_player_count: input.targetPlayerCount,
    human_count: input.humanCount,
    npc_count: input.npcCount,
    role_config: input.roleConfig,
  };
}

export async function recordLobbyOpened(
  input: PlaySessionSnapshot,
): Promise<AnalyticsResult> {
  return save("lobby", (client) =>
    client
      .from("tomatobot_play_sessions")
      .upsert(sessionRow(input, "lobby"), { onConflict: "id" }),
  );
}

export async function recordGameStarted(
  input: PlaySessionSnapshot & { startedAt: string },
): Promise<AnalyticsResult> {
  return save("start", (client) =>
    client.from("tomatobot_play_sessions").upsert(
      {
        ...sessionRow(input, "started"),
        started_at: input.startedAt,
      },
      { onConflict: "id" },
    ),
  );
}

export async function recordGameCompleted(
  input: PlaySessionSnapshot & {
    winner: Winner;
    dayCount: number;
    durationSeconds: number;
    startedAt?: string;
  },
): Promise<AnalyticsResult> {
  return save("complete", (client) =>
    client.from("tomatobot_play_sessions").upsert(
      {
        ...sessionRow(input, "completed"),
        winner: input.winner,
        day_count: input.dayCount,
        duration_seconds: input.durationSeconds,
        started_at: input.startedAt,
        finished_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    ),
  );
}

export async function recordGameAbandoned(
  input: PlaySessionSnapshot & {
    status: "cancelled" | "reset";
    dayCount: number;
    durationSeconds?: number;
    startedAt?: string;
  },
): Promise<AnalyticsResult> {
  return save("abandon", (client) =>
    client.from("tomatobot_play_sessions").upsert(
      {
        ...sessionRow(input, input.status),
        day_count: input.dayCount,
        duration_seconds: input.durationSeconds,
        started_at: input.startedAt,
        finished_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    ),
  );
}

export async function recordRematchRequested(
  sessionId: string,
): Promise<AnalyticsResult> {
  return save("rematch", (client) =>
    client
      .from("tomatobot_play_sessions")
      .update({ rematch_requested_at: new Date().toISOString() })
      .eq("id", sessionId),
  );
}

export async function recordMatchFeedback(input: {
  sessionId: string;
  userId: string;
  rating: FeedbackRating;
  comment?: string;
}): Promise<AnalyticsResult> {
  const comment = input.comment?.trim().slice(0, 1000) || null;
  return save("feedback", (client) =>
    client.from("tomatobot_match_feedback").upsert(
      {
        session_id: input.sessionId,
        user_id: input.userId,
        rating: input.rating,
        comment,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,user_id" },
    ),
  );
}
