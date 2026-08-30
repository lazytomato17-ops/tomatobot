import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isOwner } from "./access";

const REQUEST_TIMEOUT_MS = 5000;
const REPORT_DAYS = 7;
const VERSION_PAGE_SIZE = 1000;

type NumericValue = number | string | null | undefined;

export interface DailyAnalyticsRow {
  day_jst: string;
  started?: NumericValue;
  completed?: NumericValue;
  abandoned?: NumericValue;
  started_chains?: NumericValue;
  solo_starts?: NumericValue;
  multiplayer_starts?: NumericValue;
  average_matches_per_chain?: NumericValue;
  first_to_second_match_rate_percent?: NumericValue;
  average_completed_seconds?: NumericValue;
  abandoned_lobby?: NumericValue;
  abandoned_role_setup?: NumericValue;
  abandoned_discussion?: NumericValue;
  abandoned_voting?: NumericValue;
  abandoned_night?: NumericValue;
  feedback_again?: NumericValue;
  feedback_neutral?: NumericValue;
  feedback_issue?: NumericValue;
  reason_npc?: NumericValue;
  reason_tempo?: NumericValue;
  reason_controls?: NumericValue;
  reason_roles?: NumericValue;
  reason_bug?: NumericValue;
  reason_other?: NumericValue;
}

export interface AbandonAnalyticsRow {
  day_jst: string;
  abandoned?: NumericValue;
  answered?: NumericValue;
  reroll_role?: NumericValue;
  testing_config?: NumericValue;
  controls?: NumericValue;
  too_long?: NumericValue;
  other?: NumericValue;
}

export interface VersionAnalyticsRow {
  app_version?: string | null;
  started_at?: string | null;
}

export interface AnalyticsRange {
  previousStart: string;
  previousEnd: string;
  currentStart: string;
  currentEnd: string;
  currentEndExclusive: string;
}

export interface AnalyticsPeriodTotals {
  started: number;
  completed: number;
  abandoned: number;
  soloStarts: number;
  multiplayerStarts: number;
  completionRate: number | null;
  averageMatchesPerChain: number | null;
  secondMatchRate: number | null;
  averageCompletedSeconds: number | null;
  abandonedLobby: number;
  abandonedRoleSetup: number;
  abandonedDiscussion: number;
  abandonedVoting: number;
  abandonedNight: number;
  feedbackAgain: number;
  feedbackNeutral: number;
  feedbackIssue: number;
  reasonNpc: number;
  reasonTempo: number;
  reasonControls: number;
  reasonRoles: number;
  reasonBug: number;
  reasonOther: number;
}

export interface AdminAnalyticsReport {
  range: AnalyticsRange;
  current: AnalyticsPeriodTotals;
  previous: AnalyticsPeriodTotals;
  abandonReasons: {
    abandoned: number;
    answered: number;
    rerollRole: number;
    testingConfig: number;
    controls: number;
    tooLong: number;
    other: number;
  };
  versions: Array<{ version: string; starts: number }>;
}

export type AdminAnalyticsResult =
  | { status: "found"; report: AdminAnalyticsReport }
  | { status: "disabled" }
  | { status: "failed" };

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

function adminAnalyticsClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_KEY?.trim();

  if (!url || !key) {
    if (!warnedAboutMissingConfig && process.env.NODE_ENV !== "test") {
      console.warn(
        "Admin analytics are disabled: SUPABASE_URL and a Supabase secret key are required.",
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

function numberValue(value: NumericValue): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jstDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftJstDate(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T00:00:00+09:00`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return jstDateKey(shifted);
}

export function analyticsRange(now = new Date()): AnalyticsRange {
  const currentEnd = jstDateKey(now);
  return {
    previousStart: shiftJstDate(currentEnd, -(REPORT_DAYS * 2 - 1)),
    previousEnd: shiftJstDate(currentEnd, -REPORT_DAYS),
    currentStart: shiftJstDate(currentEnd, -(REPORT_DAYS - 1)),
    currentEnd,
    currentEndExclusive: shiftJstDate(currentEnd, 1),
  };
}

function inRange(day: string, start: string, end: string): boolean {
  return day >= start && day <= end;
}

function weightedAverage(
  rows: DailyAnalyticsRow[],
  value: (row: DailyAnalyticsRow) => NumericValue,
  weight: (row: DailyAnalyticsRow) => NumericValue,
): number | null {
  let total = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const rowWeight = numberValue(weight(row));
    const rowValue = Number(value(row));
    if (rowWeight <= 0 || !Number.isFinite(rowValue)) continue;
    total += rowValue * rowWeight;
    totalWeight += rowWeight;
  }
  return totalWeight ? total / totalWeight : null;
}

function periodTotals(rows: DailyAnalyticsRow[]): AnalyticsPeriodTotals {
  const sum = (value: (row: DailyAnalyticsRow) => NumericValue) =>
    rows.reduce((total, row) => total + numberValue(value(row)), 0);
  const started = sum((row) => row.started);
  const completed = sum((row) => row.completed);

  return {
    started,
    completed,
    abandoned: sum((row) => row.abandoned),
    soloStarts: sum((row) => row.solo_starts),
    multiplayerStarts: sum((row) => row.multiplayer_starts),
    completionRate: started ? (completed / started) * 100 : null,
    averageMatchesPerChain: weightedAverage(
      rows,
      (row) => row.average_matches_per_chain,
      (row) => row.started_chains,
    ),
    secondMatchRate: weightedAverage(
      rows,
      (row) => row.first_to_second_match_rate_percent,
      (row) => row.started_chains,
    ),
    averageCompletedSeconds: weightedAverage(
      rows,
      (row) => row.average_completed_seconds,
      (row) => row.completed,
    ),
    abandonedLobby: sum((row) => row.abandoned_lobby),
    abandonedRoleSetup: sum((row) => row.abandoned_role_setup),
    abandonedDiscussion: sum((row) => row.abandoned_discussion),
    abandonedVoting: sum((row) => row.abandoned_voting),
    abandonedNight: sum((row) => row.abandoned_night),
    feedbackAgain: sum((row) => row.feedback_again),
    feedbackNeutral: sum((row) => row.feedback_neutral),
    feedbackIssue: sum((row) => row.feedback_issue),
    reasonNpc: sum((row) => row.reason_npc),
    reasonTempo: sum((row) => row.reason_tempo),
    reasonControls: sum((row) => row.reason_controls),
    reasonRoles: sum((row) => row.reason_roles),
    reasonBug: sum((row) => row.reason_bug),
    reasonOther: sum((row) => row.reason_other),
  };
}

export function buildAdminAnalyticsReport(
  dailyRows: DailyAnalyticsRow[],
  abandonRows: AbandonAnalyticsRow[],
  versionRows: VersionAnalyticsRow[],
  now = new Date(),
): AdminAnalyticsReport {
  const range = analyticsRange(now);
  const currentRows = dailyRows.filter((row) =>
    inRange(row.day_jst, range.currentStart, range.currentEnd),
  );
  const previousRows = dailyRows.filter((row) =>
    inRange(row.day_jst, range.previousStart, range.previousEnd),
  );
  const currentAbandons = abandonRows.filter((row) =>
    inRange(row.day_jst, range.currentStart, range.currentEnd),
  );
  const sumAbandon = (value: (row: AbandonAnalyticsRow) => NumericValue) =>
    currentAbandons.reduce((total, row) => total + numberValue(value(row)), 0);
  const versionCounts = new Map<string, number>();
  for (const row of versionRows) {
    const version = row.app_version?.trim() || "unknown";
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
  }

  return {
    range,
    current: periodTotals(currentRows),
    previous: periodTotals(previousRows),
    abandonReasons: {
      abandoned: sumAbandon((row) => row.abandoned),
      answered: sumAbandon((row) => row.answered),
      rerollRole: sumAbandon((row) => row.reroll_role),
      testingConfig: sumAbandon((row) => row.testing_config),
      controls: sumAbandon((row) => row.controls),
      tooLong: sumAbandon((row) => row.too_long),
      other: sumAbandon((row) => row.other),
    },
    versions: [...versionCounts]
      .map(([version, starts]) => ({ version, starts }))
      .sort((left, right) => right.starts - left.starts),
  };
}

async function loadVersionRows(
  client: SupabaseClient,
  startIso: string,
  endIso: string,
): Promise<VersionAnalyticsRow[]> {
  const rows: VersionAnalyticsRow[] = [];
  for (let offset = 0; ; offset += VERSION_PAGE_SIZE) {
    const { data, error } = await client
      .from("tomatobot_play_sessions")
      .select("app_version")
      .not("started_at", "is", null)
      .gte("opened_at", startIso)
      .lt("opened_at", endIso)
      .order("opened_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + VERSION_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as VersionAnalyticsRow[];
    rows.push(...page);
    if (page.length < VERSION_PAGE_SIZE) return rows;
  }
}

export async function getAdminAnalytics(
  now = new Date(),
): Promise<AdminAnalyticsResult> {
  try {
    const client = adminAnalyticsClient();
    if (!client) return { status: "disabled" };
    const range = analyticsRange(now);
    const currentStartIso = new Date(
      `${range.currentStart}T00:00:00+09:00`,
    ).toISOString();
    const currentEndIso = new Date(
      `${range.currentEndExclusive}T00:00:00+09:00`,
    ).toISOString();

    const [daily, abandons, versions] = await Promise.all([
      client
        .from("tomatobot_play_daily_summary_v2")
        .select("*")
        .gte("day_jst", range.previousStart)
        .lte("day_jst", range.currentEnd)
        .order("day_jst", { ascending: true }),
      client
        .from("tomatobot_abandon_reason_summary")
        .select("*")
        .gte("day_jst", range.currentStart)
        .lte("day_jst", range.currentEnd),
      loadVersionRows(client, currentStartIso, currentEndIso),
    ]);

    if (daily.error) throw daily.error;
    if (abandons.error) throw abandons.error;

    return {
      status: "found",
      report: buildAdminAnalyticsReport(
        (daily.data ?? []) as DailyAnalyticsRow[],
        (abandons.data ?? []) as AbandonAnalyticsRow[],
        versions,
        now,
      ),
    };
  } catch (error) {
    console.error(`Admin analytics read failed: ${errorMessage(error)}`);
    return { status: "failed" };
  }
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function decimal(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function signed(value: number, suffix = ""): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(suffix ? 1 : 0)}${suffix}`;
}

function comparisonLine(
  current: AnalyticsPeriodTotals,
  previous: AnalyticsPeriodTotals,
): string {
  if (!previous.started) return "前週データなし";
  const completionDifference =
    current.completionRate === null || previous.completionRate === null
      ? null
      : current.completionRate - previous.completionRate;
  const secondMatchDifference =
    current.secondMatchRate === null || previous.secondMatchRate === null
      ? null
      : current.secondMatchRate - previous.secondMatchRate;
  return [
    `開始 ${signed(current.started - previous.started)}`,
    `完走率 ${completionDifference === null ? "—" : signed(completionDifference, "pt")}`,
    `連戦率 ${secondMatchDifference === null ? "—" : signed(secondMatchDifference, "pt")}`,
  ].join("｜");
}

export function adminAnalyticsEmbed(
  report: AdminAnalyticsReport,
): EmbedBuilder {
  const current = report.current;
  const reasons = report.abandonReasons;
  const feedbackTotal =
    current.feedbackAgain + current.feedbackNeutral + current.feedbackIssue;
  const versionText = report.versions.length
    ? report.versions
        .slice(0, 4)
        .map((item) => `${item.version}｜${item.starts}試合`)
        .join("\n")
    : "開始データなし";

  return new EmbedBuilder()
    .setColor(0x7b83ff)
    .setTitle("📊 運営レポート｜直近7日")
    .setDescription(
      `**${shortDate(report.range.currentStart)}〜${shortDate(report.range.currentEnd)}（JST）**`,
    )
    .addFields(
      {
        name: "プレイ状況",
        value: [
          `開始 **${current.started}**｜完走 **${current.completed}**（${percent(current.completionRate)}）`,
          `ソロ **${current.soloStarts}**｜友達戦 **${current.multiplayerStarts}**`,
          `連戦率 **${percent(current.secondMatchRate)}**｜平均 **${decimal(current.averageMatchesPerChain)}戦**`,
        ].join("\n"),
      },
      {
        name: "テンポ・中断",
        value: [
          `平均試合時間 **${duration(current.averageCompletedSeconds)}**｜中断 **${current.abandoned}**`,
          `ロビー ${current.abandonedLobby}｜配役 ${current.abandonedRoleSetup}｜議論 ${current.abandonedDiscussion}｜投票 ${current.abandonedVoting}｜夜 ${current.abandonedNight}`,
          `終了理由回答 ${reasons.answered}/${reasons.abandoned}｜役職引き直し ${reasons.rerollRole}｜テスト ${reasons.testingConfig}｜操作 ${reasons.controls}｜長い ${reasons.tooLong}｜その他 ${reasons.other}`,
        ].join("\n"),
      },
      {
        name: "試合後の感想",
        value: feedbackTotal
          ? [
              `また遊びたい **${current.feedbackAgain}**｜ふつう **${current.feedbackNeutral}**｜問題あり **${current.feedbackIssue}**`,
              `NPC ${current.reasonNpc}｜テンポ ${current.reasonTempo}｜操作 ${current.reasonControls}｜配役 ${current.reasonRoles}｜バグ ${current.reasonBug}｜その他 ${current.reasonOther}`,
            ].join("\n")
          : "回答なし",
      },
      {
        name: "前週比",
        value: comparisonLine(current, report.previous),
      },
      {
        name: "Bot版",
        value: versionText,
      },
    )
    .setFooter({
      text: "個人名・Discord ID・会話内容・役職・投票先は表示していません",
    });
}

export async function handleAdminAnalyticsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: "このコマンドは運営者専用です。",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await getAdminAnalytics();
  if (result.status === "disabled") {
    await interaction.editReply(
      "分析機能は現在無効です。Supabaseの設定を確認してください。",
    );
    return;
  }
  if (result.status === "failed") {
    await interaction.editReply(
      "分析データを取得できませんでした。少し待ってから再実行してください。",
    );
    return;
  }

  await interaction.editReply({ embeds: [adminAnalyticsEmbed(result.report)] });
}
