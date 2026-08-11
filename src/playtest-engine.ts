import {
  addPublicClaimSuspicion,
  chooseStrategicNightTarget,
  findNpcInsight,
  LONE_WOLF_FAKE_CLAIM_CHANCE,
  MADMAN_FAKE_CLAIM_CHANCE,
  MADMAN_WHITE_CLAIM_CHANCE,
  npcDecisionSuspicion,
  personalityForSerial,
  WOLF_FAKE_CLAIM_CHANCE,
} from "./npc";
import { resolveVoteOutcome, topVotedIds } from "./presentation";
import { buildRoles, getWinner, roleConfigFromRoles } from "./roles";
import { assignGameRoles, buildSoloRoles, chooseNpcVoteTarget } from "./solo";
import type {
  Player,
  PublicResult,
  RoleClaim,
  RoleName,
  VoteRecord,
  Winner,
} from "./types";

export interface PlaytestScenario {
  name: string;
  profile: "ソロ標準" | "通常配役" | "狂人入り";
  roles: RoleName[];
}

export interface SimulationResult {
  winner: Winner;
  days: number;
  humanAlive: boolean;
  humanRole: RoleName;
  timedOut: boolean;
  loneBlackSituations: number;
  loneBlackExecutions: number;
  loneBlackVotes: number;
  loneBlackBallots: number;
  loneFalseBlackSituations: number;
  loneFalseBlackExecutions: number;
  contestedBlackSituations: number;
  contestedBlackVotes: number;
  contestedBlackBallots: number;
  dayOneExecutions: number;
  dayOneExecutionsWithoutBlackClaim: number;
  ownClaimBallots: number;
  ownClaimContradictions: number;
  discussionBallots: number;
  discussionVoteMatches: number;
  roleAlive: Map<RoleName, number>;
  roleAssigned: Map<RoleName, number>;
}

export interface ScenarioSummary {
  scenario: PlaytestScenario;
  trials: number;
  villageWinRate: number;
  averageDays: number;
  humanSurvivalRate: number;
  timeoutRate: number;
  loneBlackExecutionRate: number | null;
  loneBlackVoteRate: number | null;
  loneFalseBlackExecutionRate: number | null;
  contestedBlackVoteRate: number | null;
  dayOneNoBlackClaimExecutionRate: number | null;
  ownClaimContradictionRate: number | null;
  discussionVoteMatchRate: number | null;
  roleSurvivalRates: Map<RoleName, number>;
}

interface SimulationState {
  players: Player[];
  roleConfig: ReturnType<typeof roleConfigFromRoles>;
  npcSuspicion: Map<string, number>;
  npcMemory: Map<string, Map<string, number>>;
  npcClaims: RoleClaim[];
  humanSuspicions: Map<string, string>;
  voteHistory: VoteRecord[];
}

interface SeerResult {
  targetId: string;
  isWolf: boolean;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomItem<T>(values: T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function remember(
  state: SimulationState,
  observerId: string,
  targetId: string,
  amount: number,
): void {
  const memory = state.npcMemory.get(observerId) ?? new Map<string, number>();
  memory.set(targetId, (memory.get(targetId) ?? 0) + amount);
  state.npcMemory.set(observerId, memory);
}

function recordClaim(
  state: SimulationState,
  day: number,
  speaker: Player,
  target: Player,
  result: PublicResult,
): void {
  const duplicate = state.npcClaims.some(
    (claim) =>
      claim.day === day &&
      claim.speakerId === speaker.id &&
      claim.claimedRole === "占い師" &&
      claim.targetId === target.id,
  );
  if (duplicate) return;
  state.npcClaims.push({
    day,
    speakerId: speaker.id,
    claimedRole: "占い師",
    targetId: target.id,
    result,
  });
  addPublicClaimSuspicion(state.npcSuspicion, target.id, result);
}

function latestResultsByTarget(
  claims: RoleClaim[],
  speakerId: string,
): Map<string, PublicResult> {
  const results = new Map<string, PublicResult>();
  for (const claim of claims) {
    if (claim.claimedRole === "占い師" && claim.speakerId === speakerId) {
      results.set(claim.targetId, claim.result);
    }
  }
  return results;
}

function seerClaimants(claims: RoleClaim[]): Set<string> {
  return new Set(
    claims
      .filter((claim) => claim.claimedRole === "占い師")
      .map((claim) => claim.speakerId),
  );
}

function claimedRoleFor(
  claims: RoleClaim[],
  playerId: string,
): "占い師" | "霊能者" | undefined {
  return claims.find((claim) => claim.speakerId === playerId)?.claimedRole;
}

function addSeerResult(
  results: Map<string, SeerResult[]>,
  seer: Player,
  target: Player,
): void {
  const known = results.get(seer.id) ?? [];
  if (!known.some((result) => result.targetId === target.id)) {
    known.push({ targetId: target.id, isWolf: target.role === "人狼" });
  }
  results.set(seer.id, known);
}

function latestKnownResult(
  state: SimulationState,
  results: Map<string, SeerResult[]>,
  seer: Player,
): SeerResult | undefined {
  const publishedIds = new Set(
    state.npcClaims
      .filter(
        (claim) =>
          claim.speakerId === seer.id && claim.claimedRole === "占い師",
      )
      .map((claim) => claim.targetId),
  );
  const known = [...(results.get(seer.id) ?? [])].reverse();
  return known.find((result) => !publishedIds.has(result.targetId)) ?? known[0];
}

function publishTrueSeerResult(
  state: SimulationState,
  results: Map<string, SeerResult[]>,
  seer: Player,
  day: number,
): void {
  const known = latestKnownResult(state, results, seer);
  if (!known) return;
  const target = state.players.find((player) => player.id === known.targetId);
  if (!target) return;
  const result: PublicResult = known.isWolf ? "人狼" : "人間";
  recordClaim(state, day, seer, target, result);
  remember(state, seer.id, target.id, known.isWolf ? 6 : -3);
}

function publishFakeSeerResult(
  state: SimulationState,
  speaker: Player,
  living: Player[],
  day: number,
  random: () => number,
): void {
  const available =
    speaker.role === "人狼"
      ? living.filter(
          (target) => target.id !== speaker.id && target.role !== "人狼",
        )
      : living.filter((target) => target.id !== speaker.id);
  if (!available.length) return;
  const claimedIds = new Set(
    state.npcClaims
      .filter(
        (claim) =>
          claim.speakerId === speaker.id && claim.claimedRole === "占い師",
      )
      .map((claim) => claim.targetId),
  );
  const fresh = available.filter((target) => !claimedIds.has(target.id));
  const target = randomItem(fresh.length ? fresh : available, random);
  const earlier = state.npcClaims.find(
    (claim) =>
      claim.speakerId === speaker.id &&
      claim.claimedRole === "占い師" &&
      claim.targetId === target.id,
  )?.result;
  const result: PublicResult =
    earlier ??
    (speaker.role === "狂人" && random() < MADMAN_WHITE_CLAIM_CHANCE
      ? "人間"
      : "人狼");
  recordClaim(state, day, speaker, target, result);
  remember(state, speaker.id, target.id, result === "人狼" ? 2 : -1);
}

function chooseNpcSpeakers(
  state: SimulationState,
  living: Player[],
  random: () => number,
): Player[] {
  const npcs = living.filter((player) => player.isNpc);
  const priority = npcs.filter(
    (npc) =>
      npc.role === "占い師" || seerClaimants(state.npcClaims).has(npc.id),
  );
  const priorityIds = new Set(priority.map((npc) => npc.id));
  const others = shuffled(
    npcs.filter((npc) => !priorityIds.has(npc.id)),
    random,
  ).slice(0, Math.max(0, 3 - priority.length));
  return [...priority, ...others];
}

function decayMemory(state: SimulationState): void {
  const livingIds = new Set(
    state.players.filter((player) => player.alive).map((player) => player.id),
  );
  for (const memory of state.npcMemory.values()) {
    for (const [targetId, score] of memory) {
      if (!livingIds.has(targetId)) memory.delete(targetId);
      else if (Math.abs(score) < 0.25) memory.delete(targetId);
      else memory.set(targetId, score * 0.75);
    }
  }
}

function activeBlackTargets(state: SimulationState): {
  claimants: Set<string>;
  targets: Player[];
} {
  const claimants = seerClaimants(state.npcClaims);
  const targetIds = new Set<string>();
  for (const claimantId of claimants) {
    for (const [targetId, result] of latestResultsByTarget(
      state.npcClaims,
      claimantId,
    )) {
      if (result === "人狼") targetIds.add(targetId);
    }
  }
  return {
    claimants,
    targets: state.players.filter(
      (player) => player.alive && targetIds.has(player.id),
    ),
  };
}

function addVoteMemory(
  state: SimulationState,
  ballots: Array<{ voterId: string; targetId: string }>,
): void {
  const topIds = topVotedIds(ballots.map((ballot) => ballot.targetId));
  for (const npc of state.players.filter(
    (player) => player.alive && player.isNpc,
  )) {
    const targetId = ballots.find(
      (ballot) => ballot.voterId === npc.id,
    )?.targetId;
    if (targetId) remember(state, npc.id, targetId, 0.5);
    if (npc.npcPersonality === "同調") {
      for (const topId of topIds) {
        if (topId !== npc.id) remember(state, npc.id, topId, 0.4);
      }
    }
  }
}

function castBallots(
  state: SimulationState,
  living: Player[],
  candidates: Player[],
  random: () => number,
): Array<{ voterId: string; targetId: string }> {
  return living.map((player) => {
    const valid = candidates.filter((candidate) => candidate.id !== player.id);
    const choices = valid.length ? valid : candidates;
    const suspicion = npcDecisionSuspicion(state, player);
    return {
      voterId: player.id,
      targetId: chooseNpcVoteTarget(player, choices, suspicion, random),
    };
  });
}

function emptyResult(
  humanRole: RoleName,
  players: Player[],
): Omit<SimulationResult, "winner" | "days" | "humanAlive" | "timedOut"> {
  const roleAssigned = new Map<RoleName, number>();
  for (const player of players) {
    const role = player.role as RoleName;
    roleAssigned.set(role, (roleAssigned.get(role) ?? 0) + 1);
  }
  return {
    humanRole,
    loneBlackSituations: 0,
    loneBlackExecutions: 0,
    loneBlackVotes: 0,
    loneBlackBallots: 0,
    loneFalseBlackSituations: 0,
    loneFalseBlackExecutions: 0,
    contestedBlackSituations: 0,
    contestedBlackVotes: 0,
    contestedBlackBallots: 0,
    dayOneExecutions: 0,
    dayOneExecutionsWithoutBlackClaim: 0,
    ownClaimBallots: 0,
    ownClaimContradictions: 0,
    discussionBallots: 0,
    discussionVoteMatches: 0,
    roleAlive: new Map(),
    roleAssigned,
  };
}

function finishResult(
  base: Omit<SimulationResult, "winner" | "days" | "humanAlive" | "timedOut">,
  players: Player[],
  winner: Winner,
  days: number,
  timedOut: boolean,
): SimulationResult {
  const roleAlive = new Map<RoleName, number>();
  for (const player of players.filter((candidate) => candidate.alive)) {
    const role = player.role as RoleName;
    roleAlive.set(role, (roleAlive.get(role) ?? 0) + 1);
  }
  return {
    ...base,
    winner,
    days,
    humanAlive: players[0].alive,
    timedOut,
    roleAlive,
  };
}

export function simulateGame(
  roles: RoleName[],
  seed: number,
): SimulationResult {
  const random = seededRandom(seed);
  const players: Player[] = [
    { id: "human", name: "Human", user: null, isNpc: false, alive: true },
    ...Array.from({ length: roles.length - 1 }, (_, index) => ({
      id: `npc-${index}`,
      name: `NPC${index}`,
      user: null,
      isNpc: true,
      npcPersonality: personalityForSerial(index + 1),
      alive: true,
    })),
  ];
  const assignments = assignGameRoles(players, random, roles);
  for (const player of players) player.role = assignments.get(player.id);
  const humanRole = assignments.get("human") as RoleName;
  const result = emptyResult(humanRole, players);
  const state: SimulationState = {
    players,
    roleConfig: roleConfigFromRoles(roles),
    npcSuspicion: new Map(),
    npcMemory: new Map(),
    npcClaims: [],
    humanSuspicions: new Map(),
    voteHistory: [],
  };
  const seerResults = new Map<string, SeerResult[]>();
  let lastGuardedId: string | undefined;
  const seers = players.filter((player) => player.role === "占い師");
  for (const seer of seers) {
    const targets = players.filter((target) => target.id !== seer.id);
    if (targets.length)
      addSeerResult(seerResults, seer, randomItem(targets, random));
  }

  for (let day = 1; day <= 20; day += 1) {
    state.npcSuspicion.clear();
    state.humanSuspicions.clear();
    if (day > 1) decayMemory(state);
    const living = players.filter((player) => player.alive);
    const discussionTargets = new Map<string, string>();

    const human = living.find((player) => !player.isNpc);
    if (human?.role === "占い師") {
      const known = latestKnownResult(state, seerResults, human);
      const hasClaimed = seerClaimants(state.npcClaims).has(human.id);
      const claimChance = known?.isWolf ? 0.9 : hasClaimed ? 0.8 : 0.45;
      if (known && random() < claimChance) {
        publishTrueSeerResult(state, seerResults, human, day);
      }
    }

    for (const speaker of chooseNpcSpeakers(state, living, random)) {
      if (speaker.role === "占い師") {
        publishTrueSeerResult(state, seerResults, speaker, day);
        continue;
      }
      const isContinuing = seerClaimants(state.npcClaims).has(speaker.id);
      const fakeChance =
        speaker.role === "狂人"
          ? MADMAN_FAKE_CLAIM_CHANCE
          : state.roleConfig.人狼 === 1
            ? LONE_WOLF_FAKE_CLAIM_CHANCE
            : WOLF_FAKE_CLAIM_CHANCE;
      if (
        (speaker.role === "人狼" || speaker.role === "狂人") &&
        (isContinuing || random() < fakeChance)
      ) {
        publishFakeSeerResult(state, speaker, living, day, random);
        continue;
      }

      const insight = findNpcInsight(
        state.npcClaims,
        state.voteHistory,
        speaker.id,
        new Set(living.map((player) => player.id)),
      );
      if (insight && living.some((player) => player.id === insight.suspectId)) {
        remember(state, speaker.id, insight.suspectId, 4);
        discussionTargets.set(speaker.id, insight.suspectId);
        continue;
      }
      const choices = living.filter((player) => player.id !== speaker.id);
      if (!choices.length) continue;
      const suspicion = npcDecisionSuspicion(state, speaker);
      const targetId = chooseNpcVoteTarget(speaker, choices, suspicion, random);
      remember(state, speaker.id, targetId, 1);
      discussionTargets.set(speaker.id, targetId);
    }

    if (
      human?.role === "占い師" &&
      !seerClaimants(state.npcClaims).has(human.id) &&
      seerClaimants(state.npcClaims).size > 0 &&
      random() < 0.9
    ) {
      publishTrueSeerResult(state, seerResults, human, day);
    }

    if (human) {
      const knownWolf = (seerResults.get(human.id) ?? []).find(
        (known) =>
          known.isWolf && living.some((player) => player.id === known.targetId),
      );
      const leadingPublic = [...state.npcSuspicion]
        .filter(
          ([targetId, score]) =>
            targetId !== human.id &&
            score > 0 &&
            living.some((player) => player.id === targetId),
        )
        .sort((left, right) => right[1] - left[1])[0]?.[0];
      const targetId = knownWolf?.targetId ?? leadingPublic;
      if (targetId) state.humanSuspicions.set(human.id, targetId);
    }

    const publicBlack = activeBlackTargets(state);
    const firstBallots = castBallots(state, living, living, random);
    for (const ballot of firstBallots) {
      const voter = living.find((player) => player.id === ballot.voterId);
      if (!voter?.isNpc) continue;
      const ownResults = latestResultsByTarget(state.npcClaims, voter.id);
      const ownBlackIds = new Set(
        [...ownResults]
          .filter(
            ([targetId, claimResult]) =>
              claimResult === "人狼" &&
              living.some((player) => player.id === targetId),
          )
          .map(([targetId]) => targetId),
      );
      const ownWhiteIds = new Set(
        [...ownResults]
          .filter(([, claimResult]) => claimResult === "人間")
          .map(([targetId]) => targetId),
      );
      const hasNonWhiteChoice = living.some(
        (candidate) =>
          candidate.id !== voter.id && !ownWhiteIds.has(candidate.id),
      );
      if (
        ownBlackIds.size > 0 ||
        (ownWhiteIds.has(ballot.targetId) && hasNonWhiteChoice)
      ) {
        result.ownClaimBallots += 1;
        if (
          (ownBlackIds.size > 0 && !ownBlackIds.has(ballot.targetId)) ||
          (ownWhiteIds.has(ballot.targetId) && hasNonWhiteChoice)
        ) {
          result.ownClaimContradictions += 1;
        }
      }
      const discussionTarget = discussionTargets.get(voter.id);
      if (discussionTarget) {
        result.discussionBallots += 1;
        if (discussionTarget === ballot.targetId) {
          result.discussionVoteMatches += 1;
        }
      }
    }

    const blackTargetIds = new Set(
      publicBlack.targets.map((target) => target.id),
    );
    const blackVotes = firstBallots.filter((ballot) =>
      blackTargetIds.has(ballot.targetId),
    ).length;
    if (publicBlack.targets.length > 0 && publicBlack.claimants.size === 1) {
      result.loneBlackSituations += 1;
      result.loneBlackVotes += blackVotes;
      result.loneBlackBallots += firstBallots.length;
      if (publicBlack.targets.some((target) => target.role !== "人狼")) {
        result.loneFalseBlackSituations += 1;
      }
    } else if (
      publicBlack.targets.length > 0 &&
      publicBlack.claimants.size >= 2
    ) {
      result.contestedBlackSituations += 1;
      result.contestedBlackVotes += blackVotes;
      result.contestedBlackBallots += firstBallots.length;
    }

    state.voteHistory.push({ day, round: 1, ballots: firstBallots });
    addVoteMemory(state, firstBallots);
    let outcome = resolveVoteOutcome(
      firstBallots.map((ballot) => ballot.targetId),
      1,
    );
    if (outcome.kind === "revote") {
      const tied = living.filter((player) =>
        outcome.kind === "revote"
          ? outcome.candidateIds.includes(player.id)
          : false,
      );
      const secondBallots = castBallots(state, living, tied, random);
      state.voteHistory.push({ day, round: 2, ballots: secondBallots });
      addVoteMemory(state, secondBallots);
      outcome = resolveVoteOutcome(
        secondBallots.map((ballot) => ballot.targetId),
        2,
      );
    }

    let executed: Player | undefined;
    if (outcome.kind === "execute") {
      executed = players.find((player) => player.id === outcome.targetId);
      if (executed) executed.alive = false;
    }
    if (day === 1 && executed) {
      result.dayOneExecutions += 1;
      if (publicBlack.targets.length === 0) {
        result.dayOneExecutionsWithoutBlackClaim += 1;
      }
    }
    if (
      executed &&
      publicBlack.claimants.size === 1 &&
      blackTargetIds.has(executed.id)
    ) {
      result.loneBlackExecutions += 1;
      if (executed.role !== "人狼") result.loneFalseBlackExecutions += 1;
    }

    const afterVote = getWinner(players);
    if (afterVote) {
      return finishResult(result, players, afterVote, day, false);
    }

    const nightLiving = players.filter((player) => player.alive);
    const victimTargets = nightLiving.filter(
      (player) => player.role !== "人狼",
    );
    const victim = chooseStrategicNightTarget(
      "kill",
      victimTargets,
      (playerId) => claimedRoleFor(state.npcClaims, playerId),
      random,
    );
    const guard = nightLiving.find((player) => player.role === "騎士");
    const guardTargets = guard
      ? nightLiving.filter(
          (player) => player.id !== guard.id && player.id !== lastGuardedId,
        )
      : [];
    const guarded = guard
      ? chooseStrategicNightTarget(
          "guard",
          guardTargets,
          (playerId) => claimedRoleFor(state.npcClaims, playerId),
          random,
        )
      : undefined;
    lastGuardedId = guarded?.id;
    if (victim && victim.id !== guarded?.id) victim.alive = false;

    const afterNight = getWinner(players);
    if (afterNight) {
      return finishResult(result, players, afterNight, day, false);
    }

    for (const seer of players.filter(
      (player) => player.alive && player.role === "占い師",
    )) {
      const uninspected = players.filter(
        (target) =>
          target.alive &&
          target.id !== seer.id &&
          !(seerResults.get(seer.id) ?? []).some(
            (known) => known.targetId === target.id,
          ),
      );
      if (uninspected.length) {
        addSeerResult(seerResults, seer, randomItem(uninspected, random));
      }
    }
  }

  const fallbackWinner = getWinner(players) ?? "wolf";
  return finishResult(result, players, fallbackWinner, 20, true);
}

function madmanRoles(playerCount: number): RoleName[] | null {
  const roles = buildSoloRoles(playerCount);
  const villagerIndex = roles.lastIndexOf("村人");
  if (villagerIndex < 0) return null;
  roles[villagerIndex] = "狂人";
  const wolfTeam = roles.filter(
    (role) => role === "人狼" || role === "狂人",
  ).length;
  if (wolfTeam >= roles.length - wolfTeam) return null;
  return roles;
}

export function buildPlaytestScenarios(): PlaytestScenario[] {
  const scenarios: PlaytestScenario[] = [];
  for (let playerCount = 4; playerCount <= 15; playerCount += 1) {
    scenarios.push({
      name: `ソロ${playerCount}人`,
      profile: "ソロ標準",
      roles: buildSoloRoles(playerCount),
    });
    scenarios.push({
      name: `通常${playerCount}人`,
      profile: "通常配役",
      roles: buildRoles(playerCount),
    });
    const withMadman = madmanRoles(playerCount);
    if (withMadman) {
      scenarios.push({
        name: `狂人${playerCount}人`,
        profile: "狂人入り",
        roles: withMadman,
      });
    }
  }
  return scenarios;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function runScenario(
  scenario: PlaytestScenario,
  trials: number,
  seedOffset = 0,
): ScenarioSummary {
  const results = Array.from({ length: trials }, (_, index) =>
    simulateGame(
      scenario.roles,
      seedOffset + index * 97 + scenario.roles.length * 10_007,
    ),
  );
  const sum = (select: (result: SimulationResult) => number): number =>
    results.reduce((total, result) => total + select(result), 0);
  const roleAssigned = new Map<RoleName, number>();
  const roleAlive = new Map<RoleName, number>();
  for (const result of results) {
    for (const [role, count] of result.roleAssigned) {
      roleAssigned.set(role, (roleAssigned.get(role) ?? 0) + count);
    }
    for (const [role, count] of result.roleAlive) {
      roleAlive.set(role, (roleAlive.get(role) ?? 0) + count);
    }
  }
  const roleSurvivalRates = new Map<RoleName, number>();
  for (const [role, assigned] of roleAssigned) {
    roleSurvivalRates.set(role, (roleAlive.get(role) ?? 0) / assigned);
  }
  const dayOneExecutions = sum((result) => result.dayOneExecutions);
  const loneBlackSituations = sum((result) => result.loneBlackSituations);
  const loneFalseBlackSituations = sum(
    (result) => result.loneFalseBlackSituations,
  );
  return {
    scenario,
    trials,
    villageWinRate:
      results.filter((result) => result.winner === "villager").length / trials,
    averageDays: sum((result) => result.days) / trials,
    humanSurvivalRate:
      results.filter((result) => result.humanAlive).length / trials,
    timeoutRate: results.filter((result) => result.timedOut).length / trials,
    loneBlackExecutionRate: ratio(
      sum((result) => result.loneBlackExecutions),
      loneBlackSituations,
    ),
    loneBlackVoteRate: ratio(
      sum((result) => result.loneBlackVotes),
      sum((result) => result.loneBlackBallots),
    ),
    loneFalseBlackExecutionRate: ratio(
      sum((result) => result.loneFalseBlackExecutions),
      loneFalseBlackSituations,
    ),
    contestedBlackVoteRate: ratio(
      sum((result) => result.contestedBlackVotes),
      sum((result) => result.contestedBlackBallots),
    ),
    dayOneNoBlackClaimExecutionRate: ratio(
      sum((result) => result.dayOneExecutionsWithoutBlackClaim),
      dayOneExecutions,
    ),
    ownClaimContradictionRate: ratio(
      sum((result) => result.ownClaimContradictions),
      sum((result) => result.ownClaimBallots),
    ),
    discussionVoteMatchRate: ratio(
      sum((result) => result.discussionVoteMatches),
      sum((result) => result.discussionBallots),
    ),
    roleSurvivalRates,
  };
}
