import type { SoloPuzzle, SoloStatement } from "./types";

function combinations(values: string[], count: number): Set<string>[] {
  const result: Set<string>[] = [];
  const visit = (start: number, selected: string[]) => {
    if (selected.length === count) {
      result.push(new Set(selected));
      return;
    }
    for (
      let index = start;
      index <= values.length - (count - selected.length);
      index += 1
    ) {
      selected.push(values[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

export function statementMatches(
  statement: SoloStatement,
  wolves: ReadonlySet<string>,
): boolean {
  const proposition =
    statement.claim === "wolf"
      ? wolves.has(statement.targetId)
      : !wolves.has(statement.targetId);
  return wolves.has(statement.speakerId) ? !proposition : proposition;
}

export function possibleWolfSets(
  npcIds: string[],
  wolfCount: number,
  confirmedHumanId: string,
  statements: SoloStatement[],
): Set<string>[] {
  return combinations(
    npcIds.filter((id) => id !== confirmedHumanId),
    wolfCount,
  ).filter((wolves) =>
    statements.every((statement) => statementMatches(statement, wolves)),
  );
}

function validStatement(
  speakerId: string,
  targetId: string,
  actualWolves: ReadonlySet<string>,
): SoloStatement {
  const targetIsWolf = actualWolves.has(targetId);
  const speakerIsWolf = actualWolves.has(speakerId);
  const claimIsWolf = speakerIsWolf ? !targetIsWolf : targetIsWolf;
  return {
    speakerId,
    targetId,
    claim: claimIsWolf ? "wolf" : "human",
  };
}

export function generateSoloPuzzle(
  npcIds: string[],
  actualWolves: ReadonlySet<string>,
): SoloPuzzle {
  if (actualWolves.size < 1 || actualWolves.size * 2 >= npcIds.length + 1) {
    throw new Error("一人用の人狼数が不正です。");
  }
  if (![...actualWolves].every((id) => npcIds.includes(id))) {
    throw new Error("NPC以外が人狼に含まれています。");
  }
  const confirmedHumanId = npcIds.find((id) => !actualWolves.has(id));
  if (!confirmedHumanId) throw new Error("確定できる人間がいません。");

  const ordinaryPool: SoloStatement[] = [];
  const anchorPool: SoloStatement[] = [];
  for (const speakerId of npcIds) {
    if (speakerId === confirmedHumanId) continue;
    for (const targetId of npcIds) {
      if (speakerId === targetId) continue;
      const statement = validStatement(speakerId, targetId, actualWolves);
      if (targetId === confirmedHumanId) anchorPool.push(statement);
      else ordinaryPool.push(statement);
    }
  }

  const pool = [...ordinaryPool, ...anchorPool];
  const selected: SoloStatement[] = [];
  let solutions = possibleWolfSets(
    npcIds,
    actualWolves.size,
    confirmedHumanId,
    selected,
  );

  while (solutions.length > 1) {
    let best: SoloStatement | undefined;
    let bestSolutions = solutions;
    for (const candidatePool of [ordinaryPool, anchorPool]) {
      for (const statement of candidatePool) {
        if (selected.includes(statement)) continue;
        const next = solutions.filter((wolves) =>
          statementMatches(statement, wolves),
        );
        if (next.length > 0 && next.length < bestSolutions.length) {
          best = statement;
          bestSolutions = next;
        }
      }
      if (best) break;
    }
    if (!best) throw new Error("一意に解ける証言を生成できませんでした。");
    selected.push(best);
    solutions = bestSolutions;
  }

  const selectedKeys = new Set(
    selected.map((statement) => `${statement.speakerId}:${statement.targetId}`),
  );
  const extraStatements = npcIds
    .filter((speakerId) => speakerId !== confirmedHumanId)
    .map((speakerId) =>
      pool.find(
        (statement) =>
          statement.speakerId === speakerId &&
          !selectedKeys.has(`${statement.speakerId}:${statement.targetId}`),
      ),
    )
    .filter((statement): statement is SoloStatement => Boolean(statement));

  return {
    wolfCount: actualWolves.size,
    confirmedHumanId,
    statements: selected,
    extraStatements,
    askedSpeakerIds: new Set(),
    questionsRemaining: Math.min(3, extraStatements.length),
  };
}
