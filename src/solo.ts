import { buildRoles } from "./roles";
import type { Player, RoleName } from "./types";

export const SOLO_PLAYER_COUNT = 7;

export function buildSoloRoles(playerCount: number): RoleName[] {
  if (playerCount < 4 || playerCount > 15) {
    throw new Error("プレイヤー数は4〜15人にしてください。");
  }

  const wolfCount = playerCount >= 10 ? 2 : 1;
  const roles: RoleName[] = [
    ...Array<RoleName>(wolfCount).fill("人狼"),
    "占い師",
    "騎士",
  ];
  if (playerCount >= 5) roles.push("霊能者");
  while (roles.length < playerCount) roles.push("村人");
  return roles;
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function assignGameRoles(
  players: Player[],
  random: () => number = Math.random,
  configuredRoles?: RoleName[],
): Map<string, RoleName> {
  const humans = players.filter((player) => !player.isNpc);
  const assignments = new Map<string, RoleName>();
  const rolePool =
    configuredRoles ??
    (humans.length === 1
      ? buildSoloRoles(players.length)
      : buildRoles(players.length));

  if (rolePool.length !== players.length) {
    throw new Error("役職数とプレイヤー数が一致していません。");
  }

  if (humans.length === 1) {
    const villageRoles = rolePool.filter((role) => role !== "人狼");
    const abilityRoles = villageRoles.filter((role) => role !== "村人");
    const activeRoles = villageRoles.filter(
      (role) => role === "占い師" || role === "騎士",
    );
    const candidates = activeRoles.length
      ? activeRoles
      : abilityRoles.length
        ? abilityRoles
        : villageRoles;
    const humanRole = candidates[Math.floor(random() * candidates.length)];
    if (!humanRole) throw new Error("1人プレイ用の村人陣営がありません。");
    assignments.set(humans[0].id, humanRole);

    const roles = [...rolePool];
    roles.splice(roles.indexOf(humanRole), 1);
    const npcRoles = shuffled(roles, random);
    players
      .filter((player) => player.isNpc)
      .forEach((player, index) => assignments.set(player.id, npcRoles[index]));
    return assignments;
  }

  const roles = shuffled(rolePool, random);
  players.forEach((player, index) => assignments.set(player.id, roles[index]));
  return assignments;
}

export function chooseNpcVoteTarget(
  actor: Pick<Player, "id" | "role">,
  candidates: Array<Pick<Player, "id" | "role">>,
  suspicion: ReadonlyMap<string, number>,
  random: () => number = Math.random,
): string {
  let valid = candidates.filter((candidate) => candidate.id !== actor.id);
  if (actor.role === "人狼") {
    const nonWolves = valid.filter((candidate) => candidate.role !== "人狼");
    if (nonWolves.length) valid = nonWolves;
  }
  if (!valid.length) throw new Error("NPCの投票対象がいません。");

  return valid
    .map((candidate) => ({
      id: candidate.id,
      score: (suspicion.get(candidate.id) ?? 0) + random() * 1.5,
    }))
    .sort((left, right) => right.score - left.score)[0].id;
}
