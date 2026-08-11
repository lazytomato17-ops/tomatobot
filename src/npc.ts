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
