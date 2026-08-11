import type { TextChannel } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  dayEmbed,
  finishedDayEmbed,
  gameStartEmbed,
  lobbyPayload,
  nightEmbed,
  recordCurrentVoteRound,
  roleClaimLine,
  roleConfigPanel,
  roleDeclarationLine,
  roleDmEmbed,
  voteBallotFields,
  voteEmbed,
  voteTallyRows,
} from "./game";
import { roleConfigFromRoles } from "./roles";
import type { GameState, Player, RoleName } from "./types";

function makeGame(
  roles: RoleName[] = ["人狼", "占い師", "騎士", "村人"],
): GameState {
  const players: Player[] = roles.map((role, index) => ({
    id: String(index),
    name:
      index === 0 ? "とてもとてもとても長いプレイヤー名" : `プレイヤー${index}`,
    user: null,
    isNpc: index > 0,
    role,
    alive: true,
  }));
  return {
    channelId: "channel",
    channel: {} as TextChannel,
    hostId: "0",
    phase: "day",
    players,
    targetPlayerCount: players.length,
    roleConfig: roleConfigFromRoles(roles),
    roleDmSent: new Set(),
    roleDmFailures: new Set(),
    day: 1,
    voteRound: 1,
    voteCandidateIds: players.map((player) => player.id),
    phaseEndsAt: 1_750_000_000_000,
    votes: new Map(),
    voteHistory: [],
    nightChoices: new Map(),
    npcSuspicion: new Map(),
    npcMemory: new Map(),
    npcClaims: [],
    roleDeclarations: new Set(),
    humanSuspicions: new Map(),
    seerResults: new Map(),
    timers: [],
    resolving: false,
  };
}

describe("ゲーム画面", () => {
  it("議論画面は日本語タイトルと正確な相対時刻を使う", () => {
    const game = makeGame();
    const json = dayEmbed(game).toJSON();
    expect(json.title).toBe("1日目｜議論");
    expect(json.description).toContain("<t:1750000000:R>");
    expect(json.description).not.toContain("残り");
    expect(json.description).not.toContain("｜");
    expect(json.fields?.[0].value).toContain(
      "👤 とてもとてもとても長いプレイヤー名",
    );
    expect(json.fields?.[0].value).toContain("🤖 プレイヤー1");
    expect(finishedDayEmbed(game).toJSON()).toMatchObject({
      title: "1日目｜議論終了",
      description: "議論を終了しました。",
    });
  });

  it("再投票と夜の画面も同じ表記に揃える", () => {
    const game = makeGame();
    game.voteRound = 2;
    expect(voteEmbed(game).toJSON().title).toBe("1日目｜再投票");
    expect(nightEmbed(game).toJSON().title).toBe("1日目｜夜");
  });

  it("好評だった開始画面と役職DMの構成を維持する", () => {
    const game = makeGame();
    game.seerResults.set("1", [{ targetId: "0", isWolf: true }]);
    expect(gameStartEmbed(game).toJSON()).toMatchObject({
      title: "ゲーム開始｜4人",
      fields: [{ name: "配役" }],
    });
    expect(roleDmEmbed(game, game.players[1]).toJSON()).toMatchObject({
      title: "🔮 役職｜占い師",
      fields: [{ name: "勝利条件" }],
    });
  });

  it("ロビーは参加操作とホスト設定を分けて表示する", () => {
    const game = makeGame();
    game.phase = "lobby";
    const payload = lobbyPayload(game);
    expect(payload.embeds[0].toJSON().title).toBe("人狼ゲーム｜参加受付");
    expect(payload.components).toHaveLength(3);
    const componentJson = JSON.stringify(
      payload.components.map((row) => row.toJSON()),
    );
    expect(componentJson).toContain("参加する");
    expect(componentJson).toContain("退出する");
    expect(componentJson).toContain("配役を設定");
    expect(componentJson).toContain("player-count");
    expect(componentJson).not.toContain("プリセット");
    expect(payload.embeds[0].toJSON().description).not.toContain("｜");
  });

  it("配役設定はフォームではなく増減ボタンを使う", () => {
    const game = makeGame();
    game.phase = "lobby";
    const payload = roleConfigPanel(game);
    expect(payload.embeds[0].toJSON().title).toBe("配役設定｜4人");
    expect(payload.components).toHaveLength(5);
    const componentJson = JSON.stringify(
      payload.components.map((row) => row.toJSON()),
    );
    expect(componentJson).toContain("人狼 1人");
    expect(componentJson).toContain("村人 1人（自動）");
    expect(componentJson).toContain("role-increase");
    expect(componentJson).not.toContain("role-config-submit");
  });

  it("NPCとプレイヤーのCOを同じ一行形式で表示する", () => {
    const game = makeGame();
    expect(
      roleClaimLine(game.players[1], "占い師", game.players[0], "人狼"),
    ).toBe(
      "**プレイヤー1**（NPC）　🔮 占い師CO：**とてもとてもとても長いプレイヤー名** は **人狼**",
    );
    expect(
      roleClaimLine(game.players[0], "霊能者", game.players[1], "人間"),
    ).toContain("（プレイヤー）　👻 霊能者CO");
    expect(roleDeclarationLine(game.players[0], "騎士")).toContain(
      "（プレイヤー）　🛡️ 騎士CO",
    );
  });

  it("投票者・投票先・得票数を公開履歴として残す", () => {
    const game = makeGame();
    game.votes.set("0", "1");
    game.votes.set("1", "0");
    game.votes.set("2", "1");
    recordCurrentVoteRound(game);

    expect(game.voteHistory[0]).toMatchObject({ day: 1, round: 1 });
    expect(voteTallyRows(game)).toContain("プレイヤー1：2票");
    expect(voteBallotFields(game)[0].value).toContain(
      "👤 とてもとてもとても長いプレイヤー名 → 🤖 プレイヤー1",
    );
  });
});
