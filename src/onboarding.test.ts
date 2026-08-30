import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  BOT_INVITE_URL,
  findOnboardingChannel,
  GUIDE_SITE_URL,
  guideCommand,
  guideComponents,
  guideText,
  inviteCommand,
  inviteComponents,
  inviteText,
  onboardingText,
} from "./onboarding";

describe("初回ガイド", () => {
  it("30秒で最初の一戦を始められる情報だけを表示する", () => {
    expect(guideCommand.toJSON()).toMatchObject({
      name: "guide",
      description: "人狼の始め方を30秒で確認します",
    });
    expect(guideText()).toContain("`/jinro` で募集を作る");
    expect(guideText()).toContain("1人ならNPCが補充されます");
    expect(guideText()).toContain("DMを許可");

    const row = guideComponents()[0].toJSON();
    expect(row.components).toHaveLength(2);
    expect(row.components[0]).toMatchObject({
      label: "詳しい遊び方",
      url: GUIDE_SITE_URL,
    });
    expect(row.components[1]).toMatchObject({
      label: "Botを追加",
      url: BOT_INVITE_URL,
    });
  });

  it("招待コマンドは追加リンクだけを本人に案内できる", () => {
    expect(inviteCommand.toJSON()).toMatchObject({
      name: "invite",
      description: "TomatoBotを別のサーバーに追加します",
    });
    expect(inviteText()).toContain("遊びたいサーバーに追加");

    const row = inviteComponents()[0].toJSON();
    expect(row.components).toHaveLength(1);
    expect(row.components[0]).toMatchObject({
      label: "Botを追加",
      url: BOT_INVITE_URL,
    });
  });

  it("新規サーバーでは再び確認できるコマンドも案内する", () => {
    expect(onboardingText()).toContain("追加してくれてありがとうございます");
    expect(onboardingText()).toContain("`/guide`");
    expect(onboardingText()).toContain("友達は「参加する」を押すだけ");
  });

  it("案内を送れる先だけから最上部のテキストチャンネルを選ぶ", () => {
    const makeChannel = (rawPosition: number, allowed: boolean) =>
      ({
        type: ChannelType.GuildText,
        rawPosition,
        guild: { members: { me: {} } },
        permissionsFor: () => ({ has: () => allowed }),
      }) as unknown as TextChannel;
    const blocked = makeChannel(0, false);
    const lower = makeChannel(3, true);
    const upper = makeChannel(1, true);
    const guild = {
      systemChannel: blocked,
      channels: {
        cache: new Map([
          ["blocked", blocked],
          ["lower", lower],
          ["upper", upper],
        ]),
      },
    } as unknown as Guild;

    expect(findOnboardingChannel(guild)).toBe(upper);
  });
});
