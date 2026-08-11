import type {
  GameState,
  NpcPersonality,
  Player,
  RoleClaim,
  VoteRecord,
} from "./types";

export const NPC_PERSONALITIES: NpcPersonality[] = [
  "慎重",
  "直感",
  "追及",
  "同調",
];

export interface NpcInsight {
  suspectId: string;
  reason: string;
}

export interface NpcQuestionAnswer {
  targetId: string;
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
