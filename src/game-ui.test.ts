import type { TextChannel } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  applyPublicClaimSuspicion,
  autoSelectHumanSeer,
  availableClaimDays,
  availableTrueMediumClaims,
  availableTrueSeerClaims,
  claimedRoleForPlayer,
  canControlDebug,
  claimListEmbed,
  claimPanel,
  dayEmbed,
  debugPanel,
  DEBUG_TIMINGS,
  DEBUG_USER_ID,
  discussionSecondsForGame,
  finishedDayEmbed,
  fillMissingNightAction,
  forceAssignedRole,
  gameStartEmbed,
  hasConflictingSeerClaim,
  humanOpinionLine,
  lobbyPayload,
  nightEmbed,
  nextNpcSeerTarget,
  npcDecisionSuspicion,
  npcDiscussionSpeakers,
  npcQuestionLine,
  publicResultForRole,
  recordCurrentVoteRound,
  retractPlayerClaim,
  remainingNpcQuestions,
  remainingClaimSlots,
  remainingPhaseMinimumMs,
  resolveWolfTarget,
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
    pendingDmMessages: new Map(),
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
    npcQuestionCounts: new Map(),
    seerResults: new Map(),
    executionHistory: [],
    timers: [],
    resolving: false,
    resolutionQueued: false,
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
    game.hostId = DEBUG_USER_ID;
    game.players[0].id = DEBUG_USER_ID;
    const payload = lobbyPayload(game);
    expect(payload.embeds[0].toJSON().title).toBe("人狼ゲーム｜参加受付");
    expect(payload.components).toHaveLength(3);
    const componentJson = JSON.stringify(
      payload.components.map((row) => row.toJSON()),
    );
    expect(componentJson).toContain("参加する");
    expect(componentJson).toContain("退出する");
    expect(componentJson).toContain("配役を設定");
    expect(componentJson).toContain("デバッグ");
    expect(componentJson).toContain("player-count");
    expect(componentJson).not.toContain("プリセット");
    expect(payload.embeds[0].toJSON().description).not.toContain("｜");
  });

  it("デバッグ機能は指定ユーザーがホストのときだけ使える", () => {
    const otherUsersGame = makeGame();
    otherUsersGame.phase = "lobby";
    expect(
      JSON.stringify(lobbyPayload(otherUsersGame).components),
    ).not.toContain("debug-settings");
    expect(canControlDebug(otherUsersGame, DEBUG_USER_ID)).toBe(false);

    const developersGame = makeGame();
    developersGame.phase = "lobby";
    developersGame.hostId = DEBUG_USER_ID;
    developersGame.players[0].id = DEBUG_USER_ID;
    expect(canControlDebug(developersGame, DEBUG_USER_ID)).toBe(true);
    expect(canControlDebug(developersGame, "another-user")).toBe(false);
    expect(JSON.stringify(lobbyPayload(developersGame).components)).toContain(
      "debug-settings",
    );
  });

  it("デバッグモードは試合単位で進行を短縮して戦績対象外と明示する", () => {
    const game = makeGame();
    game.phase = "lobby";
    game.hostId = DEBUG_USER_ID;
    game.players[0].id = DEBUG_USER_ID;
    game.debugMode = true;
    game.debugHostRole = "占い師";

    expect(discussionSecondsForGame(game, 4, 1)).toBe(45);
    expect(DEBUG_TIMINGS).toEqual({
      discussion: 45,
      vote: 30,
      night: 30,
      seerAuto: 20,
      transition: 3,
    });
    const lobby = lobbyPayload(game);
    expect(lobby.embeds[0].toJSON().fields?.[2]).toMatchObject({
      name: "🛠️ デバッグモード",
    });
    expect(lobby.embeds[0].toJSON().fields?.[2].value).toContain(
      "戦績保存なし",
    );
    const panel = debugPanel(game);
    expect(panel.embeds[0].toJSON().fields?.[1].value).toBe("占い師");
    expect(panel.embeds[0].toJSON().fields?.[2].value).toContain(
      "議論45秒／投票30秒／夜30秒",
    );
    expect(panel.embeds[0].toJSON().fields?.[2].value).toContain(
      "全員操作済みでも即終了しない",
    );
    expect(
      JSON.stringify(panel.components.map((row) => row.toJSON())),
    ).toContain("debug-role");
    expect(gameStartEmbed(game).toJSON().fields?.[1].value).toContain(
      "戦績に記録されません",
    );
  });

  it("デバッグ役職指定は配役数を変えずホストと入れ替える", () => {
    const assignments = new Map<string, RoleName>([
      ["host", "村人"],
      ["npc-seer", "占い師"],
      ["npc-wolf", "人狼"],
      ["npc-guard", "騎士"],
    ]);

    forceAssignedRole(assignments, "host", "占い師");

    expect(assignments.get("host")).toBe("占い師");
    expect(assignments.get("npc-seer")).toBe("村人");
    expect([...assignments.values()].sort()).toEqual(
      ["村人", "人狼", "占い師", "騎士"].sort(),
    );
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
    expect(componentJson).toContain("狂人 0人");
    expect(componentJson).toContain("role-increase");
    expect(componentJson).not.toContain("role-config-submit");
    expect(payload.components[2].toJSON().components[2].disabled).toBe(true);
    expect(payload.embeds[0].toJSON().fields?.[0].value).toContain(
      "村人 **1**",
    );

    const twoWolfGame = makeGame(["人狼", "人狼", "占い師", "村人", "村人"]);
    twoWolfGame.phase = "lobby";
    expect(
      roleConfigPanel(twoWolfGame).components[2].toJSON().components[2]
        .disabled,
    ).toBe(false);
  });

  it("狂人は人狼を知らず、占いと霊能では人間になる", () => {
    const game = makeGame(["狂人", "人狼", "占い師", "村人"]);
    const json = roleDmEmbed(game, game.players[0]).toJSON();
    expect(json.title).toBe("🃏 役職｜狂人");
    expect(json.description).toContain("人狼が誰かは分かりません");
    expect(json.description).not.toContain("仲間の人狼");
    expect(json.fields?.[0].value).toBe("人狼陣営を勝利させる");
    expect(publicResultForRole("狂人")).toBe("人間");
    expect(publicResultForRole("人狼")).toBe("人狼");
  });

  it("プレイヤーの占いCOをNPCの疑いへ反映する", () => {
    const game = makeGame();
    applyPublicClaimSuspicion(game, game.players[1], "人狼");
    expect(game.npcSuspicion.get("1")).toBe(1.25);
    applyPublicClaimSuspicion(game, game.players[1], "人間");
    expect(game.npcSuspicion.get("1")).toBe(0.85);
  });

  it("公開情報による疑いは一人へ積み上がりすぎない", () => {
    const game = makeGame();
    for (let index = 0; index < 5; index += 1) {
      applyPublicClaimSuspicion(game, game.players[1], "人狼");
    }
    expect(game.npcSuspicion.get("1")).toBe(2.5);
  });

  it("直感は弱い意見としてNPCへ伝わる", () => {
    const soloGame = makeGame();
    soloGame.players[1].npcPersonality = "慎重";
    soloGame.humanSuspicions.set("0", {
      targetId: "2",
      reason: "intuition",
    });
    expect(
      npcDecisionSuspicion(soloGame, soloGame.players[1]).get("2"),
    ).toBeCloseTo(0.135);
  });

  it("黒判定と公開意見が重なってもNPCへの共有疑いを急増させない", () => {
    const game = makeGame();
    game.players[1].npcPersonality = "慎重";
    game.humanSuspicions.set("0", {
      targetId: "2",
      reason: "black-result",
    });
    game.npcClaims.push({
      day: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "2",
      result: "人狼",
    });
    applyPublicClaimSuspicion(game, game.players[2], "人狼");

    expect(npcDecisionSuspicion(game, game.players[1]).get("2")).toBeCloseTo(
      2.025,
    );
  });

  it("占い師COが一人だけなら黒判定を強く投票判断へ反映する", () => {
    const game = makeGame();
    game.players[1].npcPersonality = "慎重";
    game.npcClaims.push({
      day: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "2",
      result: "人狼",
    });
    applyPublicClaimSuspicion(game, game.players[2], "人狼");

    expect(npcDecisionSuspicion(game, game.players[1]).get("2")).toBeCloseTo(
      1.6875,
    );
  });

  it("占い師COが複数なら黒判定へ一人COの信用補正を付けない", () => {
    const game = makeGame();
    game.players[1].npcPersonality = "慎重";
    game.npcClaims.push(
      {
        day: 1,
        speakerId: "0",
        claimedRole: "占い師",
        targetId: "2",
        result: "人狼",
      },
      {
        day: 1,
        speakerId: "3",
        claimedRole: "占い師",
        targetId: "2",
        result: "人間",
      },
    );
    applyPublicClaimSuspicion(game, game.players[2], "人狼");

    expect(npcDecisionSuspicion(game, game.players[1]).get("2")).toBeCloseTo(
      0.5625,
    );
  });

  it("人狼1人の試合が続いたら処刑済み相手への黒判定を破綻扱いする", () => {
    const game = makeGame(["人狼", "村人", "占い師", "騎士", "霊能者"]);
    const claimant = game.players[0];
    const executed = game.players[1];
    const observer = game.players[2];
    observer.npcPersonality = "追及";
    executed.alive = false;
    game.executionHistory.push(executed);
    game.day = 2;
    game.npcClaims.push({
      day: 1,
      speakerId: claimant.id,
      claimedRole: "占い師",
      targetId: executed.id,
      result: "人狼",
    });

    expect(npcDecisionSuspicion(game, observer).get(claimant.id)).toBe(0.8);
  });

  it("プレイヤーが破綻占いを指摘したらNPCも強い根拠として扱う", () => {
    const game = makeGame(["人狼", "村人", "占い師", "騎士", "霊能者"]);
    const claimant = game.players[0];
    const executed = game.players[1];
    const observer = game.players[2];
    observer.npcPersonality = "慎重";
    executed.alive = false;
    game.executionHistory.push(executed);
    game.day = 2;
    game.npcClaims.push({
      day: 1,
      speakerId: claimant.id,
      claimedRole: "占い師",
      targetId: executed.id,
      result: "人狼",
    });
    game.humanSuspicions.set("human", {
      targetId: claimant.id,
      reason: "broken-claim",
    });

    expect(npcDecisionSuspicion(game, observer).get(claimant.id)).toBe(1.8);
  });

  it("公開情報に合わない断言は発言者への疑いになる", () => {
    const game = makeGame();
    const speaker = game.players[0];
    const observer = game.players[1];
    observer.npcPersonality = "追及";
    game.humanSuspicions.set(speaker.id, {
      targetId: game.players[2].id,
      reason: "broken-claim",
    });

    const suspicion = npcDecisionSuspicion(game, observer);
    expect(suspicion.get(speaker.id)).toBeCloseTo(0.96);
    expect(suspicion.get(game.players[2].id)).toBeUndefined();
  });

  it("破綻した一人占いCOの次の黒判定には信用補正を付けない", () => {
    const game = makeGame(["人狼", "村人", "占い師", "騎士", "霊能者"]);
    const claimant = game.players[0];
    const executed = game.players[1];
    const nextTarget = game.players[3];
    const observer = game.players[2];
    observer.npcPersonality = "追及";
    executed.alive = false;
    game.executionHistory.push(executed);
    game.day = 2;
    game.npcClaims.push(
      {
        day: 1,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: executed.id,
        result: "人狼",
      },
      {
        day: 2,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: nextTarget.id,
        result: "人狼",
      },
    );
    applyPublicClaimSuspicion(game, nextTarget, "人狼");

    const suspicion = npcDecisionSuspicion(game, observer);
    expect(suspicion.get(claimant.id)).toBe(0.8);
    expect(suspicion.get(nextTarget.id)).toBeCloseTo(1);
  });

  it("人狼数を超える別々の黒判定も占いCOの破綻として扱う", () => {
    const game = makeGame(["人狼", "村人", "占い師", "騎士", "霊能者"]);
    const claimant = game.players[0];
    const observer = game.players[2];
    observer.npcPersonality = "追及";
    game.day = 2;
    game.npcClaims.push(
      {
        day: 1,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: "1",
        result: "人狼",
      },
      {
        day: 2,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: "3",
        result: "人狼",
      },
    );

    expect(npcDecisionSuspicion(game, observer).get(claimant.id)).toBe(0.8);
  });

  it("NPCは自分で出した占い判定と投票判断を矛盾させない", () => {
    const game = makeGame(["村人", "狂人", "人狼", "村人"]);
    const claimant = game.players[1];
    claimant.npcPersonality = "直感";
    game.npcClaims.push(
      {
        day: 1,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: "2",
        result: "人狼",
      },
      {
        day: 1,
        speakerId: claimant.id,
        claimedRole: "占い師",
        targetId: "3",
        result: "人間",
      },
    );
    applyPublicClaimSuspicion(game, game.players[2], "人狼");
    applyPublicClaimSuspicion(game, game.players[3], "人間");

    const suspicion = npcDecisionSuspicion(game, claimant);
    expect(suspicion.get("2")).toBeGreaterThan(3);
    expect(suspicion.get("3")).toBeLessThan(-3);
  });

  it("プレイヤーの意見と変更を公開メッセージにする", () => {
    const game = makeGame();
    expect(
      humanOpinionLine(game.players[0], game.players[1], "intuition"),
    ).toBe(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）　👀 **プレイヤー1**を疑う\n根拠：今のところ一番違和感がある",
    );
    expect(
      humanOpinionLine(game.players[0], game.players[2], "black-result", {
        target: game.players[1],
        argument: { targetId: game.players[1].id, reason: "intuition" },
      }),
    ).toBe(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）　👀 意見変更：**プレイヤー1** → **プレイヤー2**\n根拠：占い師COから人狼判定が出ている",
    );
  });

  it("NPCへの質問回数と公開メッセージを分かりやすく表示する", () => {
    const game = makeGame();
    expect(remainingNpcQuestions(game, "0")).toBe(2);
    game.npcQuestionCounts.set("0", 1);
    expect(remainingNpcQuestions(game, "0")).toBe(1);
    game.npcQuestionCounts.set("0", 3);
    expect(remainingNpcQuestions(game, "0")).toBe(0);

    expect(
      npcQuestionLine(
        game.players[0],
        game.players[1],
        game.players[2],
        "昨日の投票で2票集まっていた",
      ),
    ).toBe(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）　❓ **プレイヤー1**に質問\n**プレイヤー1**（NPC）　💬 今は **プレイヤー2** が気になる。昨日の投票で2票集まっていた。",
    );
    expect(
      npcQuestionLine(
        game.players[0],
        game.players[1],
        undefined,
        "生存者を人間と判定している",
      ),
    ).toContain("今は特に疑っている人はいない");
  });

  it("人間の人狼同士で襲撃先が割れたら襲撃を成立させない", () => {
    const game = makeGame(["人狼", "人狼", "占い師", "村人"]);
    game.players[1].isNpc = false;
    expect(
      resolveWolfTarget(
        game.players.slice(0, 2),
        new Map([
          ["kill:0", "2"],
          ["kill:1", "3"],
        ]),
        game.players.slice(2),
      ),
    ).toBeUndefined();
  });

  it("人間とNPCの襲撃先が違う場合は人間の選択を優先する", () => {
    const game = makeGame(["人狼", "人狼", "占い師", "村人"]);
    expect(
      resolveWolfTarget(
        game.players.slice(0, 2),
        new Map([
          ["kill:0", "2"],
          ["kill:1", "3"],
        ]),
        game.players.slice(2),
      ),
    ).toBe("2");
  });

  it("最初に名乗ったCO役職を試合中の役職として扱う", () => {
    const game = makeGame();
    game.npcClaims.push({
      day: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "1",
      result: "人間",
    });
    game.roleDeclarations.add("1:2:騎士");
    expect(claimedRoleForPlayer(game, "0")).toBe("占い師");
    expect(claimedRoleForPlayer(game, "2")).toBe("騎士");
  });

  it("潜伏した占い師は日数分の過去結果をまとめて公開できる", () => {
    const game = makeGame();
    game.day = 3;
    expect(remainingClaimSlots(game, "0", "占い師")).toBe(3);
    game.npcClaims.push(
      {
        day: 3,
        speakerId: "0",
        claimedRole: "占い師",
        targetId: "1",
        result: "人間",
      },
      {
        day: 3,
        speakerId: "0",
        claimedRole: "占い師",
        targetId: "2",
        result: "人狼",
      },
    );
    expect(remainingClaimSlots(game, "0", "占い師")).toBe(1);
  });

  it("真占いは未公開の実結果だけをすぐCOできる", () => {
    const game = makeGame(["占い師", "人狼", "村人", "村人"]);
    game.day = 2;
    game.seerResults.set("0", [
      { targetId: "1", isWolf: true },
      { targetId: "2", isWolf: false },
    ]);

    expect(
      availableTrueSeerClaims(game, game.players[0]).map(
        ({ day, target, result }) => [day, target.id, result],
      ),
    ).toEqual([
      [1, "1", "人狼"],
      [2, "2", "人間"],
    ]);

    game.npcClaims.push({
      day: 2,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "1",
      result: "人間",
    });
    expect(
      availableTrueSeerClaims(game, game.players[0]).map(
        ({ day, target, result }) => [day, target.id, result],
      ),
    ).toEqual([[2, "2", "人間"]]);
  });

  it("通常のCO画面は本当の結果をワンタップ公開できる", () => {
    const game = makeGame(["占い師", "人狼", "村人", "村人"]);
    game.day = 2;
    game.seerResults.set("0", [
      { targetId: "1", isWolf: true },
      { targetId: "2", isWolf: false },
    ]);

    const panel = claimPanel(game, game.players[0]);
    const componentJson = JSON.stringify(
      panel.components?.map((row) => row.toJSON()),
    );
    expect(panel.content).toContain("公開する占い結果");
    expect(componentJson).toContain("claim-quick-seer");
    expect(componentJson).toContain("この結果を公開");
    expect(componentJson).toContain("claim-custom-open");
    expect(componentJson).toContain("別の内容でCO");
    expect(componentJson).not.toContain("claim-role");
  });

  it("本当の公開結果がない人は最初からCO役職を選べる", () => {
    const game = makeGame(["村人", "人狼", "占い師", "村人"]);
    const panel = claimPanel(game, game.players[0]);
    const componentJson = JSON.stringify(
      panel.components?.map((row) => row.toJSON()),
    );

    expect(panel.content).toBe("**COする役職を選んでください。**");
    expect(componentJson).toContain("claim-role");
    expect(componentJson).not.toContain("claim-custom-open");
    expect(componentJson).not.toContain("claim-day-");
  });

  it("CO済みなら日付選択を挟まず次の判定相手を選べる", () => {
    const game = makeGame(["村人", "人狼", "占い師", "村人"]);
    game.day = 3;
    game.npcClaims.push({
      day: 1,
      resultDay: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "1",
      result: "人間",
    });
    const panel = claimPanel(game, game.players[0]);
    const componentJson = JSON.stringify(
      panel.components?.map((row) => row.toJSON()),
    );

    expect(panel.content).toContain("占い師CO｜次の結果");
    expect(componentJson).toContain("claim-target-seer-2");
    expect(componentJson).not.toContain("claim-role");
    expect(componentJson).not.toContain("claim-day-");
  });

  it("真霊能も未公開の本当の結果をワンタップ公開できる", () => {
    const game = makeGame(["霊能者", "人狼", "村人", "村人"]);
    game.day = 3;
    game.executionHistory = [game.players[2], game.players[1]];

    expect(
      availableTrueMediumClaims(game, game.players[0]).map(
        ({ day, target, result }) => [day, target.id, result],
      ),
    ).toEqual([
      [1, "2", "人間"],
      [2, "1", "人狼"],
    ]);
    const componentJson = JSON.stringify(
      claimPanel(game, game.players[0]).components?.map((row) => row.toJSON()),
    );
    expect(componentJson).toContain("claim-quick-medium");
    expect(componentJson).toContain("この結果を公開");
  });

  it("真騎士は役職選択なしでCOできる", () => {
    const game = makeGame(["騎士", "人狼", "占い師", "村人"]);
    const componentJson = JSON.stringify(
      claimPanel(game, game.players[0]).components?.map((row) => row.toJSON()),
    );
    expect(componentJson).toContain("claim-quick-guard");
    expect(componentJson).toContain("騎士COする");
    expect(componentJson).toContain("claim-custom-open");
  });

  it("1日目に偽結果を出しても2日目の真結果を正しく公開候補にする", () => {
    const game = makeGame(["占い師", "村人", "人狼", "村人"]);
    game.day = 2;
    game.seerResults.set("0", [
      { targetId: "1", isWolf: false },
      { targetId: "2", isWolf: true },
    ]);
    game.npcClaims.push({
      day: 1,
      resultDay: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "3",
      result: "人狼",
    });

    expect(availableClaimDays(game, "0", "占い師")).toEqual([2]);
    expect(hasConflictingSeerClaim(game, "0")).toBe(true);
    expect(
      availableTrueSeerClaims(game, game.players[0]).map(
        ({ day, target, result }) => [day, target.id, result],
      ),
    ).toEqual([[2, "2", "人狼"]]);
  });

  it("COを取り消すと偽結果を無効化して全日の真結果を公開し直せる", () => {
    const game = makeGame(["占い師", "村人", "人狼", "村人"]);
    game.day = 2;
    game.seerResults.set("0", [
      { targetId: "1", isWolf: false },
      { targetId: "2", isWolf: true },
    ]);
    game.npcClaims.push({
      day: 1,
      resultDay: 1,
      speakerId: "0",
      claimedRole: "占い師",
      targetId: "3",
      result: "人狼",
    });
    applyPublicClaimSuspicion(game, game.players[3], "人狼");

    expect(retractPlayerClaim(game, "0")).toBe("占い師");
    expect(claimedRoleForPlayer(game, "0")).toBeUndefined();
    expect(hasConflictingSeerClaim(game, "0")).toBe(false);
    expect(game.npcSuspicion.has("3")).toBe(false);
    expect(
      availableTrueSeerClaims(game, game.players[0]).map(
        ({ day, target, result }) => [day, target.id, result],
      ),
    ).toEqual([
      [1, "1", "人間"],
      [2, "2", "人狼"],
    ]);
  });

  it("真占いでも別役職を騙った後は実結果の即時COを出さない", () => {
    const game = makeGame(["占い師", "人狼", "村人", "村人"]);
    game.seerResults.set("0", [{ targetId: "1", isWolf: true }]);
    game.npcClaims.push({
      day: 1,
      speakerId: "0",
      claimedRole: "霊能者",
      targetId: "2",
      result: "人間",
    });

    expect(availableTrueSeerClaims(game, game.players[0])).toEqual([]);
  });

  it("投票と夜の最低時間を正確に計算する", () => {
    expect(remainingPhaseMinimumMs(1_000, 10, 4_000)).toBe(7_000);
    expect(remainingPhaseMinimumMs(1_000, 8, 10_000)).toBe(0);
  });

  it("NPCとプレイヤーのCOを同じ一行形式で表示する", () => {
    const game = makeGame();
    expect(
      roleClaimLine(game.players[1], "占い師", game.players[0], "人狼", 2),
    ).toBe(
      "**プレイヤー1**（NPC）　🔮 占い師CO：**2日目**｜**とてもとてもとても長いプレイヤー名** は **人狼**",
    );
    expect(
      roleClaimLine(game.players[0], "霊能者", game.players[1], "人間"),
    ).toContain("（プレイヤー）　👻 霊能者CO");
    expect(roleDeclarationLine(game.players[0], "騎士")).toContain(
      "（プレイヤー）　🛡️ 騎士CO",
    );
  });

  it("CO済みNPCと本物の占い師を翌日も発言者に含める", () => {
    const game = makeGame(["村人", "占い師", "人狼", "狂人", "村人"]);
    game.day = 2;
    game.npcClaims.push({
      day: 1,
      speakerId: "2",
      claimedRole: "占い師",
      targetId: "0",
      result: "人狼",
    });

    const speakerIds = npcDiscussionSpeakers(game, 1).map(
      (speaker) => speaker.id,
    );
    expect(speakerIds).toContain("1");
    expect(speakerIds).toContain("2");
  });

  it("NPC占い師は未占いの生存者を優先する", () => {
    const game = makeGame();
    game.seerResults.set("1", [
      { targetId: "0", isWolf: true },
      { targetId: "2", isWolf: false },
    ]);
    expect(nextNpcSeerTarget(game, game.players[1])?.id).toBe("3");
  });

  it("真占いが夜に操作しなければ未占いの相手を自動で占う", () => {
    const game = makeGame(["占い師", "人狼", "村人", "村人"]);
    game.phase = "night";
    game.players[0].isNpc = false;
    game.seerResults.set("0", [{ targetId: "2", isWolf: false }]);

    const notice = autoSelectHumanSeer(game, game.players[0]);
    const selectedId = game.nightChoices.get("seer:0");
    expect(selectedId).toBeDefined();
    expect(selectedId).not.toBe("0");
    expect(selectedId).not.toBe("2");
    expect(notice).toContain("自動選択");
    expect(game.seerResults.get("0")).toHaveLength(2);
    expect(autoSelectHumanSeer(game, game.players[0])).toBeUndefined();
    expect(game.seerResults.get("0")).toHaveLength(2);
  });

  it("占い師が2人いても、それぞれ別に夜行動と結果を持てる", () => {
    const game = makeGame(["占い師", "占い師", "人狼", "村人", "村人"]);
    game.phase = "night";
    game.players[0].isNpc = false;
    game.players[1].isNpc = false;

    expect(autoSelectHumanSeer(game, game.players[0])).toContain("自動選択");
    expect(autoSelectHumanSeer(game, game.players[1])).toContain("自動選択");

    expect(game.nightChoices.get("seer:0")).toBeDefined();
    expect(game.nightChoices.get("seer:1")).toBeDefined();
    expect(game.seerResults.get("0")).toHaveLength(1);
    expect(game.seerResults.get("1")).toHaveLength(1);
  });

  it("騎士は前夜と同じ相手も続けて護衛できる", () => {
    const game = makeGame(["騎士", "村人", "人狼", "占い師"]);
    game.phase = "night";
    game.players[2].alive = false;
    game.players[3].alive = false;
    (game as GameState & { lastGuardedId?: string }).lastGuardedId = "1";

    fillMissingNightAction(game, game.players[0], "guard");

    expect(game.nightChoices.get("guard:0")).toBe("1");
  });

  it("公開済みのCOと判定を役職ごとに整理する", () => {
    const game = makeGame();
    game.day = 2;
    game.npcClaims = [
      {
        day: 2,
        resultDay: 1,
        speakerId: "1",
        claimedRole: "占い師",
        targetId: "0",
        result: "人間",
      },
      {
        day: 2,
        resultDay: 2,
        speakerId: "1",
        claimedRole: "占い師",
        targetId: "2",
        result: "人狼",
      },
      {
        day: 2,
        speakerId: "0",
        claimedRole: "霊能者",
        targetId: "3",
        result: "人間",
      },
    ];
    game.roleDeclarations.add("2:0:騎士");

    const json = claimListEmbed(game).toJSON();
    expect(json.title).toBe("CO・判定一覧｜2日目");
    expect(json.description).toContain("本物とは限りません");
    expect(json.fields?.[0].value).toContain(
      "**プレイヤー1**（NPC）　1日目 **とてもとてもとても長いプレイヤー名** ○｜2日目 **プレイヤー2** ●",
    );
    expect(json.fields?.[1].value).toContain(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）",
    );
    expect(json.fields?.[2].value).toContain("2日目");
    expect(json.footer?.text).toBe("● 人狼判定　○ 人間判定（各欄は直近30件）");
  });

  it("COがない役職も空欄だと明示する", () => {
    const json = claimListEmbed(makeGame()).toJSON();
    expect(json.fields?.map((field) => field.value)).toEqual(["—", "—", "—"]);
  });

  it("占い師2人までは正常枠として表示し、一致判定を示す", () => {
    const game = makeGame(["人狼", "人狼", "占い師", "占い師", "村人", "村人"]);
    game.npcClaims.push(
      {
        day: 1,
        speakerId: "2",
        claimedRole: "占い師",
        targetId: "0",
        result: "人狼",
      },
      {
        day: 1,
        speakerId: "3",
        claimedRole: "占い師",
        targetId: "0",
        result: "人狼",
      },
    );

    expect(claimListEmbed(game).toJSON().fields?.[0].name).toBe(
      "🔮 占い師CO｜2/2人・一致判定あり",
    );
  });

  it("占い判定の白黒割れと配役を超えたCOを区別して表示する", () => {
    const game = makeGame(["人狼", "人狼", "占い師", "占い師", "村人", "村人"]);
    game.npcClaims.push(
      {
        day: 1,
        speakerId: "2",
        claimedRole: "占い師",
        targetId: "0",
        result: "人狼",
      },
      {
        day: 1,
        speakerId: "3",
        claimedRole: "占い師",
        targetId: "0",
        result: "人間",
      },
    );
    expect(claimListEmbed(game).toJSON().fields?.[0].name).toContain(
      "2/2人・判定割れ",
    );

    game.npcClaims.push({
      day: 1,
      speakerId: "4",
      claimedRole: "占い師",
      targetId: "1",
      result: "人間",
    });
    expect(claimListEmbed(game).toJSON().fields?.[0].name).toContain(
      "3/2人・配役超過・判定割れ",
    );
  });

  it("投票者・投票先・得票数を公開履歴として残す", () => {
    const game = makeGame();
    game.players[1].npcPersonality = "同調";
    game.players[2].npcPersonality = "同調";
    game.votes.set("0", "1");
    game.votes.set("1", "0");
    game.votes.set("2", "1");
    recordCurrentVoteRound(game);

    expect(game.voteHistory[0]).toMatchObject({ day: 1, round: 1 });
    expect(voteTallyRows(game)).toContain("プレイヤー1：2票");
    expect(voteBallotFields(game)[0].value).toContain(
      "👤 とてもとてもとても長いプレイヤー名 → 🤖 プレイヤー1",
    );
    expect(game.npcMemory.get("1")?.get("0")).toBe(0.5);
    expect(game.npcMemory.get("2")?.get("1")).toBeCloseTo(0.9);
  });
});
