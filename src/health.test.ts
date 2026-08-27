import { describe, expect, it } from "vitest";
import { healthResponse } from "./health";

describe("ヘルスチェック", () => {
  it("Discordへ接続済みなら正常を返す", () => {
    expect(healthResponse(true)).toEqual({
      statusCode: 200,
      body: "Tomatobot is ready.",
    });
  });

  it("起動途中や切断中は異常を返す", () => {
    expect(healthResponse(false)).toEqual({
      statusCode: 503,
      body: "Tomatobot is starting.",
    });
  });
});
