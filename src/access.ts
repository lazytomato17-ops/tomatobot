const DEFAULT_BETA_TESTER_IDS = [
  "1010400040797360218",
  "1439620582504402964",
] as const;

export function betaTesterIds(
  configuredIds: string | undefined = process.env.BETA_TESTER_IDS,
): Set<string> {
  const source =
    configuredIds === undefined
      ? DEFAULT_BETA_TESTER_IDS
      : configuredIds.split(",");
  return new Set(source.map((id) => id.trim()).filter(Boolean));
}

export function isBetaTester(userId: string, configuredIds?: string): boolean {
  return betaTesterIds(configuredIds).has(userId);
}
