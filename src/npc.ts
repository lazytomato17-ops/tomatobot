import type {
  GameState,
  NpcPersonality,
  Player,
  PublicResult,
  RoleClaim,
  VoteRecord,
} from "./types";

export const NPC_PERSONALITIES: NpcPersonality[] = [
  "慎重",
  "直感",
  "追及",
  "同調",
];

export const WOLF_FAKE_CLAIM_CHANCE = 0.25;
export const LONE_WOLF_FAKE_CLAIM_CHANCE = 0.4;
export const MADMAN_FAKE_CLAIM_CHANCE = 0.55;
export const MADMAN_WHITE_CLAIM_CHANCE = 0.45;

const MADMAN_COUNTER_WEIGHT = 0.35;
const PUBLIC_BLACK_CLAIM_SCORE = 1.25;
const PUBLIC_WHITE_CLAIM_SCORE = -0.4;
const LONE_SEER_BLACK_BONUS = 2.5;
const OWN_BLACK_CLAIM_BONUS = 8;
const OWN_WHITE_CLAIM_PENALTY = -8;
const SOLO_HUMAN_OPINION_SCORE = 0.75;
const MULTIPLAYER_HUMAN_OPINION_SCORE = 0.4;
const MAX_HUMAN_OPINION_SCORE = 1.2;
const MAX_SHARED_WITH_HUMAN_OPINION = 1.5;
const MAX_SHARED_SUSPICION = 2.5;
const DISPROVED_BLACK_CLAIM_SCORE = 1;
const CALLED_OUT_DISPROVED_CLAIM_SCORE = 4;

export interface NpcInsight {
  suspectId: string;
  reason: string;
}

export interface NpcQuestionAnswer {
  targetId?: string;
  reason: string;
}

type NpcQuestionContext = Pick<
  GameState,
  | "day"
  | "players"
  | "npcSuspicion"
  | "humanSuspicions"
  | "npcClaims"
  | "voteHistory"
>;

type NpcDecisionContext = Pick<
  GameState,
  | "players"
  | "roleConfig"
  | "npcSuspicion"
  | "npcMemory"
  | "npcClaims"
  | "humanSuspicions"
  | "executionHistory"
>;

function logicallyDisprovedSeerIds(
  game: NpcDecisionContext,
): Set<string> {
  const blackTargetsByClaimant = new Map<string, Set<string>>();
  for (const claim of game.npcClaims) {
    if (claim.claimedRole !== "占い師" || claim.result !== "人狼") continue;
    const targets = blackTargetsByClaimant.get(claim.speakerId) ?? new Set();
    targets.add(claim.targetId);
    blackTargetsByClaimant.set(claim.speakerId, targets);
  }

  const executedIds = new Set(
    game.executionHistory.map((player) => player.id),
  );
  const disproved = new Set<string>();
  for (const [claimantId, blackTargetIds] of blackTargetsByClaimant) {
    const tooManyBlackResults = blackTargetIds.size > game.roleConfig.人狼;
    const executedBlackDidNotEndGame =
      game.roleConfig.人狼 === 1 &&
      [...blackTargetIds].some((targetId) => executedIds.has(targetId));
    if (tooManyBlackResults || executedBlackDidNotEndGame) {
      disproved.add(claimantId);
    }
  }
  return disproved;
}

export function addPublicClaimSuspicion(
  suspicion: Map<string, number>,
  targetId: string,
  result: PublicResult,
): void {
  const amount =
    result === "人狼" ? PUBLIC_BLACK_CLAIM_SCORE : PUBLIC_WHITE_CLAIM_SCORE;
  suspicion.set(
    targetId,
    Math.max(
      -MAX_SHARED_SUSPICION,
      Math.min(MAX_SHARED_SUSPICION, (suspicion.get(targetId) ?? 0) + amount),
    ),
  );
}

function latestSeerResults(
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

export function npcDecisionSuspicion(
  game: NpcDecisionContext,
  npc: Player,
): ReadonlyMap<string, number> {
  const sharedSignals = new Map(game.npcSuspicion);
  const disprovedSeerIds = new Set<string>();
  const humanCalledOutIds = new Set(game.humanSuspicions.values());

  for (const claimantId of logicallyDisprovedSeerIds(game)) {
    const claimant = game.players.find((player) => player.id === claimantId);
    if (!claimant?.alive) continue;
    const noticed =
      npc.npcPersonality === "追及" || humanCalledOutIds.has(claimant.id);
    if (!noticed) continue;
    disprovedSeerIds.add(claimant.id);
    sharedSignals.set(
      claimant.id,
      Math.max(
        sharedSignals.get(claimant.id) ?? 0,
        DISPROVED_BLACK_CLAIM_SCORE,
      ),
    );
  }

  const opinionScores = new Map<string, number>();
  const aliveHumanCount = game.players.filter(
    (player) => player.alive && !player.isNpc,
  ).length;
  const opinionScore =
    aliveHumanCount === 1
      ? SOLO_HUMAN_OPINION_SCORE
      : MULTIPLAYER_HUMAN_OPINION_SCORE;
  for (const targetId of game.humanSuspicions.values()) {
    opinionScores.set(
      targetId,
      Math.min(
        MAX_HUMAN_OPINION_SCORE,
        (opinionScores.get(targetId) ?? 0) + opinionScore,
      ),
    );
  }
  for (const [targetId, score] of opinionScores) {
    const publicScore = sharedSignals.get(targetId) ?? 0;
    sharedSignals.set(
      targetId,
      Math.max(
        publicScore,
        Math.min(MAX_SHARED_WITH_HUMAN_OPINION, publicScore + score),
      ),
    );
  }
  for (const claimantId of disprovedSeerIds) {
    if (!humanCalledOutIds.has(claimantId)) continue;
    sharedSignals.set(
      claimantId,
      Math.max(
        sharedSignals.get(claimantId) ?? 0,
        CALLED_OUT_DISPROVED_CLAIM_SCORE,
      ),
    );
  }

  const seerClaimants = new Set(
    game.npcClaims
      .filter(
        (claim) =>
          claim.claimedRole === "占い師" &&
          !disprovedSeerIds.has(claim.speakerId),
      )
      .map((claim) => claim.speakerId),
  );
  if (seerClaimants.size === 1) {
    const loneSeerId = [...seerClaimants][0];
    for (const [targetId, result] of latestSeerResults(
      game.npcClaims,
      loneSeerId,
    )) {
      if (result !== "人狼") continue;
      const target = game.players.find((player) => player.id === targetId);
      if (!target?.alive) continue;
      sharedSignals.set(
        targetId,
        (sharedSignals.get(targetId) ?? 0) + LONE_SEER_BLACK_BONUS,
      );
    }
  }

  const publicSuspicion =
    npc.role === "狂人" && game.roleConfig.人狼 === 1
      ? new Map(
          [...sharedSignals].map(([targetId, score]) => [
            targetId,
            -score * MADMAN_COUNTER_WEIGHT,
          ]),
        )
      : sharedSignals;
  const result = combinedSuspicion(
    publicSuspicion,
    game.npcMemory.get(npc.id) ?? new Map(),
    npc.npcPersonality ?? "慎重",
  );

  const ownResults = latestSeerResults(game.npcClaims, npc.id);
  const ownBlackIds = new Set<string>();
  const ownWhiteIds = new Set<string>();
  for (const [targetId, claimResult] of ownResults) {
    const target = game.players.find((player) => player.id === targetId);
    if (!target?.alive) continue;
    if (claimResult === "人狼") ownBlackIds.add(targetId);
    else ownWhiteIds.add(targetId);
    result.set(
      targetId,
      (result.get(targetId) ?? 0) +
        (claimResult === "人狼"
          ? OWN_BLACK_CLAIM_BONUS
          : OWN_WHITE_CLAIM_PENALTY),
    );
  }
  if (ownBlackIds.size > 0) {
    const strongestOther = Math.max(
      0,
      ...[...result]
        .filter(([targetId]) => !ownBlackIds.has(targetId))
        .map(([, score]) => score),
    );
    for (const targetId of ownBlackIds) {
      result.set(
        targetId,
        Math.max(result.get(targetId) ?? 0, strongestOther + 4),
      );
    }
  } else if (ownWhiteIds.size > 0) {
    const strongestAlternative = Math.max(
      ...[...result]
        .filter(([targetId]) => !ownWhiteIds.has(targetId))
        .map(([, score]) => score),
    );
    if (Number.isFinite(strongestAlternative)) {
      for (const targetId of ownWhiteIds) {
        result.set(
          targetId,
          Math.min(result.get(targetId) ?? 0, strongestAlternative - 4),
        );
      }
    }
  }
  return result;
}

export function chooseStrategicNightTarget(
  action: "kill" | "guard",
  targets: Player[],
  claimedRoleFor: (
    playerId: string,
  ) => "占い師" | "霊能者" | "騎士" | undefined,
  random: () => number = Math.random,
): Player | undefined {
  return [...targets]
    .map((target) => {
      const claimedRole = claimedRoleFor(target.id);
      const roleScore =
        claimedRole === "占い師"
          ? 3
          : claimedRole === "霊能者"
            ? 2
            : claimedRole === "騎士"
              ? 1.25
              : 0;
      const humanScore = target.isNpc ? 0 : 0.25;
      const score =
        action === "kill"
          ? roleScore * 0.65 + humanScore + random() * 2.5
          : roleScore * 0.85 + random() * 2;
      return { target, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.target;
}

export function personalityForSerial(serial: number): NpcPersonality {
  return NPC_PERSONALITIES[
    (Math.max(1, serial) - 1) % NPC_PERSONALITIES.length
  ];
}

export function combinedSuspicion(
  shared: ReadonlyMap<string, number>,
  memory: ReadonlyMap<string, number>,
  personality: NpcPersonality,
): Map<string, number> {
  const result = new Map<string, number>();
  const sharedWeight =
    personality === "慎重"
      ? 0.45
      : personality === "直感"
        ? 0.65
        : personality === "追及"
          ? 0.8
          : 1.2;
  const memoryWeight = personality === "追及" ? 1.5 : 1;
  for (const [id, score] of shared) result.set(id, score * sharedWeight);
  for (const [id, score] of memory) {
    result.set(id, (result.get(id) ?? 0) + score * memoryWeight);
  }
  return result;
}

function latestBallot(
  history: VoteRecord[],
  day: number,
  voterId: string,
): { voterId: string; targetId: string } | undefined {
  return [...history]
    .filter((record) => record.day === day)
    .sort((left, right) => right.round - left.round)
    .flatMap((record) => record.ballots)
    .find((ballot) => ballot.voterId === voterId);
}

export function findNpcInsight(
  claims: RoleClaim[],
  voteHistory: VoteRecord[],
  observerId: string,
  aliveIds: ReadonlySet<string>,
): NpcInsight | null {
  const visibleClaims = claims.filter(
    (claim) => claim.speakerId !== observerId && aliveIds.has(claim.speakerId),
  );

  for (const claim of [...visibleClaims].reverse()) {
    if (claim.claimedRole !== "占い師") continue;
    const ballot = latestBallot(voteHistory, claim.day, claim.speakerId);
    if (!ballot) continue;
    if (claim.result === "人狼" && ballot.targetId !== claim.targetId) {
      return {
        suspectId: claim.speakerId,
        reason: "人狼判定を出した相手とは別の人へ投票していた",
      };
    }
    if (claim.result === "人間" && ballot.targetId === claim.targetId) {
      return {
        suspectId: claim.speakerId,
        reason: "人間判定を出した相手へ投票していた",
      };
    }
  }

  // 判定の食い違いや対抗COだけでは、どちらが偽物かは決められない。
  // 発言順だけで後から出た側を疑うことを避け、投票との矛盾など
  // 本人の行動に根拠がある場合だけ疑いへ変換する。

  return null;
}

function addQuestionScore(
  scores: Map<string, number>,
  targetId: string,
  amount: number,
): void {
  if (!scores.has(targetId)) return;
  scores.set(targetId, (scores.get(targetId) ?? 0) + amount);
}

function latestVoteRound(
  history: VoteRecord[],
  day: number,
): VoteRecord | undefined {
  return history
    .filter((record) => record.day === day)
    .sort((left, right) => right.round - left.round)[0];
}

function stableNpcHash(npcId: string, day: number): number {
  let hash = day * 31;
  for (const character of npcId) hash = hash * 33 + character.charCodeAt(0);
  return Math.abs(hash);
}

function stableCandidateIndex(
  npcId: string,
  day: number,
  length: number,
): number {
  return stableNpcHash(npcId, day) % length;
}

function genericQuestionReason(personality: NpcPersonality): string {
  if (personality === "慎重")
    return "まだ決め手はないが、今日は発言をよく見たい";
  if (personality === "直感")
    return "根拠は薄いが、今のところ一番気になっている";
  if (personality === "追及") return "まだ説明が足りないと感じている";
  return "みんなの意見が割れているので、もう少し見たい";
}

function questionReasonForTarget(
  game: NpcQuestionContext,
  npc: Player,
  target: Player,
  insight: NpcInsight | null,
): string {
  if (insight?.suspectId === target.id) return insight.reason;

  const blackClaim = [...game.npcClaims]
    .reverse()
    .find(
      (claim) =>
        claim.claimedRole === "占い師" &&
        claim.targetId === target.id &&
        claim.result === "人狼",
    );
  if (blackClaim) return "占い師COから人狼判定が出ている";

  const opinionCount = [...game.humanSuspicions.values()].filter(
    (targetId) => targetId === target.id,
  ).length;
  if (opinionCount > 0) return `疑う意見が${opinionCount}人から出ている`;

  const previousVotes = latestVoteRound(game.voteHistory, game.day - 1);
  const voteCount = previousVotes?.ballots.filter(
    (ballot) => ballot.targetId === target.id,
  ).length;
  if (voteCount && voteCount >= 2)
    return `昨日の投票で${voteCount}票集まっていた`;

  const claimedRoles = game.npcClaims
    .filter((claim) => claim.speakerId === target.id)
    .map((claim) => claim.claimedRole);
  const contestedRole = claimedRoles.find(
    (role) =>
      new Set(
        game.npcClaims
          .filter((claim) => claim.claimedRole === role)
          .map((claim) => claim.speakerId),
      ).size >= 2,
  );
  if (contestedRole) return `${contestedRole}COが複数いて真偽を見極めたい`;

  return genericQuestionReason(npc.npcPersonality ?? "慎重");
}

export function chooseNpcQuestionAnswer(
  game: NpcQuestionContext,
  npc: Player,
): NpcQuestionAnswer | null {
  let candidates = game.players.filter(
    (player) => player.alive && player.id !== npc.id,
  );
  if (npc.role === "人狼") {
    const nonWolves = candidates.filter((player) => player.role !== "人狼");
    if (nonWolves.length > 0) candidates = nonWolves;
  }
  if (candidates.length === 0) return null;

  const ownSeerClaims = game.npcClaims.filter(
    (claim) => claim.speakerId === npc.id && claim.claimedRole === "占い師",
  );
  const ownBlackClaim = [...ownSeerClaims]
    .reverse()
    .find(
      (claim) =>
        claim.result === "人狼" &&
        candidates.some((candidate) => candidate.id === claim.targetId),
    );
  if (ownBlackClaim) {
    return {
      targetId: ownBlackClaim.targetId,
      reason: "自分の占い師COで人狼判定を出している",
    };
  }

  const ownWhiteTargetIds = new Set(
    ownSeerClaims
      .filter((claim) => claim.result === "人間")
      .map((claim) => claim.targetId),
  );
  candidates = candidates.filter(
    (candidate) => !ownWhiteTargetIds.has(candidate.id),
  );
  if (candidates.length === 0) {
    return {
      reason: "自分の占い師COでは、生存者を人間と判定している",
    };
  }

  const scores = new Map(candidates.map((candidate) => [candidate.id, 0]));
  for (const [targetId, score] of game.npcSuspicion)
    addQuestionScore(scores, targetId, score);

  const opinionWeight =
    game.players.filter((player) => player.alive && !player.isNpc).length === 1
      ? 0.75
      : 0.4;
  for (const targetId of game.humanSuspicions.values())
    addQuestionScore(scores, targetId, opinionWeight);

  const aliveIds = new Set(
    game.players.filter((player) => player.alive).map((player) => player.id),
  );
  const insight = findNpcInsight(
    game.npcClaims,
    game.voteHistory,
    npc.id,
    aliveIds,
  );
  if (insight) addQuestionScore(scores, insight.suspectId, 4);

  const previousVotes = latestVoteRound(game.voteHistory, game.day - 1);
  for (const ballot of previousVotes?.ballots ?? [])
    addQuestionScore(scores, ballot.targetId, 0.2);

  const claimantsByRole = new Map<string, Set<string>>();
  for (const claim of game.npcClaims) {
    const claimants = claimantsByRole.get(claim.claimedRole) ?? new Set();
    claimants.add(claim.speakerId);
    claimantsByRole.set(claim.claimedRole, claimants);
  }
  for (const claimants of claimantsByRole.values()) {
    if (claimants.size < 2) continue;
    for (const claimantId of claimants)
      addQuestionScore(scores, claimantId, 0.3);
  }

  // 狂人は人狼を知らない。日によって公開情報への逆張りで場を乱す。
  const madmanDistorts =
    npc.role === "狂人" && stableNpcHash(npc.id, game.day) % 100 < 55;
  if (madmanDistorts) {
    for (const [targetId, score] of scores) scores.set(targetId, -score * 0.35);
  }

  const highestScore = Math.max(...scores.values());
  const topCandidates = candidates.filter(
    (candidate) => scores.get(candidate.id) === highestScore,
  );
  const target =
    topCandidates[stableCandidateIndex(npc.id, game.day, topCandidates.length)];
  return {
    targetId: target.id,
    reason: questionReasonForTarget(game, npc, target, insight),
  };
}

export function npcOpinionLine(
  personality: NpcPersonality,
  targetName: string,
  reason?: string,
): string {
  const detail = reason ? `。${reason}` : "";
  if (personality === "慎重") {
    return `まだ断定はしないけど、**${targetName}** が気になる${detail}。`;
  }
  if (personality === "直感") {
    return `今は **${targetName}** を疑ってる${detail}。`;
  }
  if (personality === "追及") {
    return `**${targetName}**、説明してほしい${detail}。`;
  }
  return `みんなの動きを見ると、**${targetName}** が気になる${detail}。`;
}
