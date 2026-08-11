import type { RoleConfig, RoleName, Winner } from "./types";

export const ROLE_NAMES: RoleName[] = [
  "村人",
  "人狼",
  "狂人",
  "占い師",
  "騎士",
  "霊能者",
];

export const ROLE_INFO: Record<
  RoleName,
  { icon: string; team: Winner; description: string }
> = {
  村人: {
    icon: "🧑‍🌾",
    team: "villager",
    description: "能力はありません。会話と投票で人狼を見つけてください。",
  },
  人狼: {
    icon: "🐺",
    team: "wolf",
    description: "夜に村人陣営を1人襲撃します。",
  },
  狂人: {
    icon: "🃏",
    team: "wolf",
    description:
      "人狼陣営ですが、人狼が誰かは分かりません。占い・霊能では人間と判定されます。",
  },
  占い師: {
    icon: "🔮",
    team: "villager",
    description: "夜に1人を占い、人狼かどうかを確認できます。",
  },
  騎士: {
    icon: "🛡️",
    team: "villager",
    description:
      "夜に1人を人狼の襲撃から守れます。同じ相手は連続で守れません。",
  },
  霊能者: {
    icon: "👻",
    team: "villager",
    description: "夜に、その日に処刑された人が人狼だったか確認できます。",
  },
};

export function buildRoles(playerCount: number): RoleName[] {
  if (playerCount < 4 || playerCount > 15) {
    throw new Error("プレイヤー数は4〜15人にしてください。");
  }

  const wolfCount = playerCount >= 11 ? 3 : playerCount >= 7 ? 2 : 1;
  const roles: RoleName[] = Array<RoleName>(wolfCount).fill("人狼");

  roles.push("占い師");
  if (playerCount >= 5) roles.push("騎士");
  if (playerCount >= 6) roles.push("霊能者");
  while (roles.length < playerCount) roles.push("村人");

  return roles;
}

export function roleConfigFromRoles(roles: RoleName[]): RoleConfig {
  const config: RoleConfig = {
    村人: 0,
    人狼: 0,
    狂人: 0,
    占い師: 0,
    騎士: 0,
    霊能者: 0,
  };
  for (const role of roles) config[role] += 1;
  return config;
}

export function buildCustomRoles(
  playerCount: number,
  counts: Omit<RoleConfig, "村人">,
): RoleName[] {
  if (playerCount < 4 || playerCount > 15) {
    throw new Error("プレイヤー数は4〜15人にしてください。");
  }

  const values = Object.values(counts);
  if (!values.every((count) => Number.isInteger(count) && count >= 0)) {
    throw new Error("役職人数は0以上の整数で入力してください。");
  }
  if (counts.人狼 < 1) throw new Error("人狼は1人以上必要です。");
  if (
    counts.狂人 > 1 ||
    counts.占い師 > 1 ||
    counts.騎士 > 1 ||
    counts.霊能者 > 1
  ) {
    throw new Error("狂人・占い師・騎士・霊能者は各1人までです。");
  }

  const specialCount = values.reduce((sum, count) => sum + count, 0);
  if (specialCount > playerCount) {
    throw new Error("役職の合計がプレイ人数を超えています。");
  }
  const wolfTeamCount = counts.人狼 + counts.狂人;
  const villagerTeamCount = playerCount - wolfTeamCount;
  if (wolfTeamCount >= villagerTeamCount) {
    throw new Error("人狼陣営が多すぎます。村人陣営より少なくしてください。");
  }

  return [
    ...Array<RoleName>(counts.人狼).fill("人狼"),
    ...Array<RoleName>(counts.狂人).fill("狂人"),
    ...Array<RoleName>(counts.占い師).fill("占い師"),
    ...Array<RoleName>(counts.騎士).fill("騎士"),
    ...Array<RoleName>(counts.霊能者).fill("霊能者"),
    ...Array<RoleName>(playerCount - specialCount).fill("村人"),
  ];
}

export function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function getWinner(
  roles: Array<{ role?: RoleName; alive: boolean }>,
): Winner | null {
  const alive = roles.filter((player) => player.alive);
  const wolves = alive.filter((player) => player.role === "人狼").length;
  const humans = alive.length - wolves;

  if (wolves === 0) return "villager";
  if (wolves >= humans) return "wolf";
  return null;
}
