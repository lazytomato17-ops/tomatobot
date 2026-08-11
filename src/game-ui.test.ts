import type { TextChannel } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  applyPublicClaimSuspicion,
  autoSelectHumanSeer,
  availableTrueSeerClaims,
  claimedRoleForPlayer,
  claimListEmbed,
  dayEmbed,
  finishedDayEmbed,
  gameStartEmbed,
  humanOpinionLine,
  lobbyPayload,
  nightEmbed,
  nextNpcSeerTarget,
  npcDecisionSuspicion,
  npcDiscussionSpeakers,
  npcQuestionLine,
  publicResultForRole,
  recordCurrentVoteRound,
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
    expect(componentJson).toContain("狂人 0人");
    expect(componentJson).toContain("role-increase");
    expect(componentJson).not.toContain("role-config-submit");
    expect(payload.embeds[0].toJSON().fields?.[0].value).toContain(
      "村人 **1**",
    );
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

  it("公開意見は一人プレイより複数人で弱くNPCへ伝わる", () => {
    const soloGame = makeGame();
    soloGame.players[1].npcPersonality = "慎重";
    soloGame.humanSuspicions.set("0", "2");
    expect(
      npcDecisionSuspicion(soloGame, soloGame.players[1]).get("2"),
    ).toBeCloseTo(0.3375);

    const multiplayerGame = makeGame();
    multiplayerGame.players[3].isNpc = false;
    multiplayerGame.players[1].npcPersonality = "慎重";
    multiplayerGame.humanSuspicions.set("0", "2");
    expect(
      npcDecisionSuspicion(multiplayerGame, multiplayerGame.players[1]).get(
        "2",
      ),
    ).toBeCloseTo(0.18);
  });

  it("黒判定と公開意見が重なってもNPCへの共有疑いを急増させない", () => {
    const game = makeGame();
    game.players[1].npcPersonality = "慎重";
    game.humanSuspicions.set("0", "2");
    applyPublicClaimSuspicion(game, game.players[2], "人狼");

    expect(npcDecisionSuspicion(game, game.players[1]).get("2")).toBeCloseTo(
      0.675,
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
    game.humanSuspicions.set("human", claimant.id);

    expect(npcDecisionSuspicion(game, observer).get(claimant.id)).toBe(1.8);
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
    expect(humanOpinionLine(game.players[0], game.players[1])).toBe(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）　👀 **プレイヤー1**を疑っています。",
    );
    expect(
      humanOpinionLine(game.players[0], game.players[2], game.players[1]),
    ).toBe(
      "**とてもとてもとても長いプレイヤー名**（プレイヤー）　👀 意見変更：**プレイヤー1** → **プレイヤー2**",
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
        ({ target, result }) => [target.id, result],
      ),
    ).toEqual([
      ["1", "人狼"],
      ["2", "人間"],
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
        ({ target, result }) => [target.id, result],
      ),
    ).toEqual([["2", "人間"]]);
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

  it("公開済みのCOと判定を役職ごとに整理する", () => {
    const game = makeGame();
    game.day = 2;
    game.npcClaims = [
      {
        day: 1,
        speakerId: "1",
        claimedRole: "占い師",
        targetId: "0",
        result: "人間",
      },
      {
        day: 2,
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
