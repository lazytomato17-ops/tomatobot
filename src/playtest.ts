import { getWinner } from "./roles";
import {
  assignGameRoles,
  chooseNpcVoteTarget,
  SOLO_PLAYER_COUNT,
} from "./solo";
import { combinedSuspicion, personalityForSerial } from "./npc";
import { resolveVoteOutcome, topVotedIds } from "./presentation";
import type { Player, RoleName, Winner } from "./types";

const TRIALS = Number(process.env.TOMATOBOT_PLAYTEST_TRIALS ?? 10_000);
const PUBLIC_BLACK_SCORE = 1.25;
const PUBLIC_WHITE_SCORE = -0.4;
const MAX_SHARED_SCORE = 2.5;

function pick<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function addResult(
  results: Map<string, Array<{ targetId: string; isWolf: boolean }>>,
  seer: Player,
  target: Player,
): void {
  const known = results.get(seer.id) ?? [];
  if (!known.some((result) => result.targetId === target.id)) {
    known.push({ targetId: target.id, isWolf: target.role === "人狼" });
  }
  results.set(seer.id, known);
}

function addScore(
  scores: Map<string, number>,
  targetId: string,
  amount: number,
  limit = Number.POSITIVE_INFINITY,
): void {
  scores.set(
    targetId,
    Math.max(-limit, Math.min(limit, (scores.get(targetId) ?? 0) + amount)),
  );
}

function castVotes(
  living: Player[],
  candidates: Player[],
  suspicion: ReadonlyMap<string, number>,
  memories: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string[] {
  return living.map((player) => {
    const valid = candidates.filter((candidate) => candidate.id !== player.id);
    const choices = valid.length ? valid : candidates;
    if (player.isNpc) {
      const adjusted = combinedSuspicion(
        suspicion,
        memories.get(player.id) ?? new Map(),
        player.npcPersonality ?? "慎重",
      );
      return chooseNpcVoteTarget(player, choices, adjusted);
    }
    const privateMemory = memories.get(player.id) ?? new Map();
    const ranked = choices
      .map((candidate) => ({
        id: candidate.id,
        score:
          (suspicion.get(candidate.id) ?? 0) +
          (privateMemory.get(candidate.id) ?? 0),
      }))
      .sort((left, right) => right.score - left.score);
    return ranked[0].score > 0 ? ranked[0].id : pick(choices).id;
  });
}

function simulate(configuredRoles?: RoleName[]): {
  winner: Winner;
  days: number;
  humanRole: string;
  humanAlive: boolean;
} {
  const playerCount = configuredRoles?.length ?? SOLO_PLAYER_COUNT;
  const players: Player[] = [
    { id: "human", name: "Human", user: null, isNpc: false, alive: true },
    ...Array.from({ length: playerCount - 1 }, (_, index) => ({
      id: `npc-${index}`,
      name: `NPC${index}`,
      user: null,
      isNpc: true,
      npcPersonality: personalityForSerial(index + 1),
      alive: true,
    })),
  ];
  const assignments = assignGameRoles(players, Math.random, configuredRoles);
  players.forEach((player) => {
    player.role = assignments.get(player.id);
  });
  const humanRole = assignments.get("human") as string;
  const results = new Map<
    string,
    Array<{ targetId: string; isWolf: boolean }>
  >();
  const memories = new Map<string, Map<string, number>>();
  let lastGuardedId: string | undefined;
  const startingWolfCount = players.filter(
    (player) => player.role === "人狼",
  ).length;
  players
    .filter((player) => player.role === "占い師")
    .forEach((seer) => {
      addResult(
        results,
        seer,
        pick(players.filter((target) => target.id !== seer.id)),
      );
    });

  for (let day = 1; day <= 10; day += 1) {
    const living = players.filter((player) => player.alive);
    const suspicion = new Map<string, number>();
    const claimedSeerIds = new Set<string>();
    if (day > 1) {
      for (const memory of memories.values()) {
        for (const [targetId, score] of memory) {
          memory.set(targetId, score * 0.75);
        }
      }
    }
    for (const seer of living.filter((player) => player.role === "占い師")) {
      const latest = [...(results.get(seer.id) ?? [])]
        .reverse()
        .find((result) =>
          living.some((target) => target.id === result.targetId),
        );
      if (!latest) continue;
      claimedSeerIds.add(seer.id);
      addScore(
        suspicion,
        latest.targetId,
        latest.isWolf ? PUBLIC_BLACK_SCORE : PUBLIC_WHITE_SCORE,
        MAX_SHARED_SCORE,
      );
      const memory = memories.get(seer.id) ?? new Map<string, number>();
      addScore(memory, latest.targetId, latest.isWolf ? 6 : -3);
      memories.set(seer.id, memory);
    }
    for (const liar of living.filter(
      (player) => player.role === "人狼" || player.role === "狂人",
    )) {
      const claimChance =
        liar.role === "狂人" ? 0.55 : startingWolfCount === 1 ? 0.4 : 0.25;
      if (Math.random() >= claimChance) continue;
      const candidates = living.filter(
        (player) =>
          player.id !== liar.id &&
          (liar.role !== "人狼" || player.role !== "人狼"),
      );
      if (!candidates.length) continue;
      const fakeTarget = pick(candidates);
      const fakeHuman = liar.role === "狂人" && Math.random() < 0.45;
      claimedSeerIds.add(liar.id);
      addScore(
        suspicion,
        fakeTarget.id,
        fakeHuman ? PUBLIC_WHITE_SCORE : PUBLIC_BLACK_SCORE,
        MAX_SHARED_SCORE,
      );
      const memory = memories.get(liar.id) ?? new Map<string, number>();
      addScore(memory, fakeTarget.id, fakeHuman ? -1 : 2);
      memories.set(liar.id, memory);
    }

    const human = living.find((player) => !player.isNpc);
    if (human) {
      const knownWolf = (results.get(human.id) ?? []).find(
        (result) =>
          result.isWolf &&
          living.some((player) => player.id === result.targetId),
      );
      const leadingPublicTarget = [...suspicion]
        .filter(([targetId, score]) => targetId !== human.id && score > 0)
        .sort((left, right) => right[1] - left[1])[0]?.[0];
      const suspectId = knownWolf?.targetId ?? leadingPublicTarget;
      if (suspectId) {
        addScore(suspicion, suspectId, PUBLIC_BLACK_SCORE, MAX_SHARED_SCORE);
      }
    }

    const firstVotes = castVotes(living, living, suspicion, memories);
    let finalVotes = firstVotes;
    let outcome = resolveVoteOutcome(firstVotes, 1);
    if (outcome.kind === "revote") {
      const candidateIds = outcome.candidateIds;
      const tied = living.filter((player) => candidateIds.includes(player.id));
      finalVotes = castVotes(living, tied, suspicion, memories);
      outcome = resolveVoteOutcome(finalVotes, 2);
    }

    const topIds = topVotedIds(finalVotes);
    living.forEach((player, index) => {
      if (!player.isNpc) return;
      const memory = memories.get(player.id) ?? new Map<string, number>();
      const targetId = finalVotes[index];
      memory.set(targetId, (memory.get(targetId) ?? 0) + 0.5);
      if (player.npcPersonality === "同調") {
        for (const topId of topIds) {
          if (topId !== player.id)
            memory.set(topId, (memory.get(topId) ?? 0) + 1);
        }
      }
      memories.set(player.id, memory);
    });

    if (outcome.kind === "execute") {
      const executed = players.find((player) => player.id === outcome.targetId);
      if (!executed) {
        throw new Error(
          `処刑対象が見つかりません: ${JSON.stringify({ day, outcome, living: living.map((player) => player.id) })}`,
        );
      }
      executed.alive = false;
    }
    const afterVote = getWinner(players);
    if (afterVote)
      return {
        winner: afterVote,
        days: day,
        humanRole,
        humanAlive: players[0].alive,
      };

    const nightLiving = players.filter((player) => player.alive);
    const livingWolf = nightLiving.find((player) => player.role === "人狼");
    if (!livingWolf)
      return {
        winner: "villager",
        days: day,
        humanRole,
        humanAlive: players[0].alive,
      };
    const possibleVictims = nightLiving.filter(
      (player) => player.role !== "人狼",
    );
    const claimedSeers = possibleVictims.filter((player) =>
      claimedSeerIds.has(player.id),
    );
    const victim =
      claimedSeers.length && Math.random() < 0.65
        ? pick(claimedSeers)
        : pick(possibleVictims);
    const guard = nightLiving.find((player) => player.role === "騎士");
    const guardTargets = guard
      ? nightLiving.filter(
          (player) => player.id !== guard.id && player.id !== lastGuardedId,
        )
      : [];
    const claimedGuardTargets = guardTargets.filter((player) =>
      claimedSeerIds.has(player.id),
    );
    const guarded = guard
      ? claimedGuardTargets.length && Math.random() < 0.7
        ? pick(claimedGuardTargets)
        : pick(guardTargets)
      : undefined;
    lastGuardedId = guarded?.id;
    if (victim.id !== guarded?.id) victim.alive = false;

    const afterNight = getWinner(players);
    if (afterNight)
      return {
        winner: afterNight,
        days: day,
        humanRole,
        humanAlive: players[0].alive,
      };

    players
      .filter((player) => player.alive && player.role === "占い師")
      .forEach((seer) => {
        const uninspected = players.filter(
          (target) =>
            target.alive &&
            target.id !== seer.id &&
            !(results.get(seer.id) ?? []).some(
              (result) => result.targetId === target.id,
            ),
        );
        if (uninspected.length) addResult(results, seer, pick(uninspected));
      });
  }
  throw new Error("10日以内にゲームが終了しませんでした。");
}

const summaries = Array.from({ length: TRIALS }, () => simulate());
const villageWins = summaries.filter(
  (summary) => summary.winner === "villager",
).length;
const averageDays =
  summaries.reduce((sum, summary) => sum + summary.days, 0) / TRIALS;
const dayOneWolfWins = summaries.filter(
  (summary) => summary.winner === "wolf" && summary.days === 1,
).length;
const humanSurvival = summaries.filter((summary) => summary.humanAlive).length;

console.log(`Solo playtest: ${TRIALS.toLocaleString()} games`);
console.log(`Village win rate: ${((villageWins / TRIALS) * 100).toFixed(1)}%`);
console.log(`Average length: ${averageDays.toFixed(2)} days`);
console.log(`Day-one wolf wins: ${dayOneWolfWins}`);
console.log(
  `Human survival rate: ${((humanSurvival / TRIALS) * 100).toFixed(1)}%`,
);

const madmanRoles: RoleName[] = [
  "人狼",
  "人狼",
  "狂人",
  "占い師",
  "騎士",
  "霊能者",
  "村人",
];
const madmanSummaries = Array.from({ length: TRIALS }, () =>
  simulate(madmanRoles),
);
const madmanVillageWins = madmanSummaries.filter(
  (summary) => summary.winner === "villager",
).length;
const madmanVillageWinRate = madmanVillageWins / TRIALS;
const madmanAverageDays =
  madmanSummaries.reduce((sum, summary) => sum + summary.days, 0) / TRIALS;

console.log(`Madman playtest: ${TRIALS.toLocaleString()} games`);
console.log(`Village win rate: ${(madmanVillageWinRate * 100).toFixed(1)}%`);
console.log(`Average length: ${madmanAverageDays.toFixed(2)} days`);

if (madmanVillageWinRate < 0.25 || madmanVillageWinRate > 0.7) {
  throw new Error("狂人入り編成の勝率が許容範囲を外れました。");
}
