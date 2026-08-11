import { describe, expect, it } from "vitest";
import {
  gameStatsFields,
  gameStatsRows,
  recordGameStats,
  statsEmbed,
  type PlayerStats,
} from "./stats";

const stats: PlayerStats = {
  userId: "123456789012345678",
  displayName: "スティーブ",
  games: 12,
  wins: 7,
  currentStreak: 2,
  bestStreak: 4,
  roles: [
    { role: "村人", games: 5, wins: 3 },
    { role: "人狼", games: 3, wins: 2 },
    { role: "占い師", games: 4, wins: 2 },
  ],
};

describe("戦績表示", () => {
  it("通算・連勝・遊んだ役職だけを見やすく表示する", () => {
    const embed = statsEmbed(stats).toJSON();
    expect(embed.title).toBe("戦績｜スティーブ");
    expect(embed.fields?.[0].value).toBe("**12戦 7勝 5敗（58%）**");
    expect(embed.fields?.[1].value).toBe("現在 **2**｜最高 **4**");
    expect(embed.fields?.[2].value).toContain(
      "🐺 **人狼**　3戦 2勝 1敗（67%）",
    );
    expect(embed.fields?.[2].value).not.toContain("狂人");
  });

  it("試合終了時は役職・勝敗・通算を一行で表示する", () => {
    const rows = gameStatsRows(
      [
        {
          userId: stats.userId,
          displayName: "スティーブ",
          role: "人狼",
          won: true,
          survived: true,
        },
      ],
      [stats],
    );
    expect(rows).toBe("**スティーブ**｜🐺 人狼で勝利｜通算 7勝5敗｜2連勝");
  });

  it("Supabase未設定でもゲーム結果の保存処理は失敗しない", async () => {
    await expect(
      recordGameStats({
        matchId: "0190cf7d-2f0d-7cb3-b815-f59fb6adc95a",
        guildId: "guild",
        channelId: "channel",
        winner: "wolf",
        dayCount: 2,
        players: [
          {
            userId: stats.userId,
            displayName: stats.displayName,
            role: "人狼",
            won: true,
            survived: true,
          },
        ],
      }),
    ).resolves.toEqual({ status: "disabled", players: [] });
  });

  it("大人数でもDiscordの項目上限を超えないよう分割する", () => {
    const participants = Array.from({ length: 15 }, (_, index) => ({
      userId: String(index),
      displayName: `${"あ".repeat(90)}${index}`,
      role: "村人" as const,
      won: true,
      survived: true,
    }));
    const playerStats = participants.map((participant) => ({
      ...stats,
      userId: participant.userId,
      displayName: participant.displayName,
    }));
    const fields = gameStatsFields(participants, playerStats);
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.every((field) => field.value.length <= 1000)).toBe(true);
  });
});
