import { describe, expect, it } from "vitest";
import {
  generateSoloPuzzle,
  possibleWolfSets,
  statementMatches,
} from "./solo-puzzle";

describe("一人用推理パズル", () => {
  it("村人は真実、人狼は嘘になる証言を生成する", () => {
    const puzzle = generateSoloPuzzle(
      ["a", "b", "c", "d", "e", "f"],
      new Set(["b", "e"]),
    );
    const wolves = new Set(["b", "e"]);
    expect(
      puzzle.statements.every((statement) =>
        statementMatches(statement, wolves),
      ),
    ).toBe(true);
  });

  it("表示された情報だけで答えが一つに定まる", () => {
    const npcIds = ["a", "b", "c", "d", "e", "f"];
    const puzzle = generateSoloPuzzle(npcIds, new Set(["b", "e"]));
    expect(
      possibleWolfSets(
        npcIds,
        puzzle.wolfCount,
        puzzle.confirmedHumanId,
        puzzle.statements,
      ),
    ).toEqual([new Set(["b", "e"])]);
  });

  it("確定済みの人間を直接否定するだけの問題にはしない", () => {
    const puzzle = generateSoloPuzzle(
      ["a", "b", "c", "d", "e", "f"],
      new Set(["b"]),
    );
    expect(
      puzzle.statements.every(
        (statement) => statement.targetId !== puzzle.confirmedHumanId,
      ),
    ).toBe(true);
    expect(puzzle.statements.length).toBeGreaterThan(1);
  });

  it("4〜15人相当の構成を連続生成しても必ず一意に解ける", () => {
    for (let totalPlayers = 4; totalPlayers <= 15; totalPlayers += 1) {
      const npcIds = Array.from(
        { length: totalPlayers - 1 },
        (_, index) => `npc-${index}`,
      );
      const wolfCount = Math.min(
        totalPlayers >= 11 ? 3 : totalPlayers >= 7 ? 2 : 1,
        Math.floor((totalPlayers - 1) / 2),
      );
      const wolves = new Set(npcIds.slice(0, wolfCount));
      const puzzle = generateSoloPuzzle(npcIds, wolves);
      expect(
        possibleWolfSets(
          npcIds,
          wolfCount,
          puzzle.confirmedHumanId,
          puzzle.statements,
        ),
      ).toEqual([wolves]);
    }
  });

  it("人狼数と配置を変えても、表示情報から正解以外を除外できる", () => {
    for (let totalPlayers = 4; totalPlayers <= 15; totalPlayers += 1) {
      const npcIds = Array.from(
        { length: totalPlayers - 1 },
        (_, index) => `npc-${index}`,
      );
      const maxWolfCount = Math.floor((totalPlayers - 1) / 2);
      for (let wolfCount = 1; wolfCount <= maxWolfCount; wolfCount += 1) {
        for (const offset of [0, Math.floor(npcIds.length / 2)]) {
          const wolves = new Set(
            Array.from(
              { length: wolfCount },
              (_, index) => npcIds[(offset + index * 2) % npcIds.length],
            ),
          );
          if (wolves.size !== wolfCount) continue;
          const puzzle = generateSoloPuzzle(npcIds, wolves);
          expect(
            possibleWolfSets(
              npcIds,
              wolfCount,
              puzzle.confirmedHumanId,
              puzzle.statements,
            ),
          ).toEqual([wolves]);
        }
      }
    }
  });
});
