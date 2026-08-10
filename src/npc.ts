import type { NpcPersonality, RoleClaim, VoteRecord } from "./types";

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
  const sharedWeight = personality === "同調" ? 1.5 : 1;
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

  for (const claim of [...visibleClaims].reverse()) {
    const conflict = visibleClaims.find(
      (other) =>
        other.day === claim.day &&
        other.targetId === claim.targetId &&
        other.result !== claim.result,
    );
    if (conflict) {
      return {
        suspectId: claim.speakerId,
        reason: "同じ相手への判定が食い違っている",
      };
    }
  }

  const seerClaimants = new Set(
    visibleClaims
      .filter((claim) => claim.claimedRole === "占い師")
      .map((claim) => claim.speakerId),
  );
  if (seerClaimants.size > 1) {
    const suspectId = [...seerClaimants].find((id) => id !== observerId);
    if (suspectId) {
      return {
        suspectId,
        reason: "占い師を名乗る人が複数いる",
      };
    }
  }

  return null;
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
