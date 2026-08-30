import { describe, expect, it } from "vitest";
import { betaTesterIds, isBetaTester, isOwner, ownerIds } from "./access";

describe("βテスター権限", () => {
  it("標準では開発者と指定テスターだけを許可する", () => {
    expect(isBetaTester("1010400040797360218")).toBe(true);
    expect(isBetaTester("1439620582504402964")).toBe(true);
    expect(isBetaTester("other-user")).toBe(false);
  });

  it("環境変数で対象者を差し替えられる", () => {
    expect(betaTesterIds("first, second, ,third")).toEqual(
      new Set(["first", "second", "third"]),
    );
    expect(isBetaTester("second", "first,second")).toBe(true);
    expect(isBetaTester("1010400040797360218", "first,second")).toBe(false);
  });
});

describe("運営者権限", () => {
  it("標準では開発者だけを許可する", () => {
    expect(isOwner("1010400040797360218")).toBe(true);
    expect(isOwner("1439620582504402964")).toBe(false);
    expect(isOwner("other-user")).toBe(false);
  });

  it("環境変数で対象者を差し替えられる", () => {
    expect(ownerIds("first, second, ,third")).toEqual(
      new Set(["first", "second", "third"]),
    );
    expect(isOwner("second", "first,second")).toBe(true);
    expect(isOwner("1010400040797360218", "first,second")).toBe(false);
  });
});
