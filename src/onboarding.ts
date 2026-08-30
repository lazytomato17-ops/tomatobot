import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from "discord.js";

export const GUIDE_SITE_URL = "https://tomatobot-web.onrender.com/#how-to-play";
export const BOT_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1442475786736242807&scope=bot%20applications.commands&permissions=0";

export const guideCommand = new SlashCommandBuilder()
  .setName("guide")
  .setDescription("人狼の始め方を30秒で確認します");

export const inviteCommand = new SlashCommandBuilder()
  .setName("invite")
  .setDescription("TomatoBotを別のサーバーに追加します");

export function guideText(): string {
  return [
    "🐺 **遊び方｜30秒**",
    "1. `/jinro` で募集を作る",
    "2. 友達は「参加する」を押す（1人ならNPCが補充されます）",
    "3. 主催者が「ゲーム開始」を押し、DMで届く役職を確認する",
    "",
    "役職が届かない場合は、サーバーメンバーからのDMを許可してください。",
  ].join("\n");
}

export function guideComponents(): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("詳しい遊び方")
        .setEmoji("📖")
        .setStyle(ButtonStyle.Link)
        .setURL(GUIDE_SITE_URL),
      new ButtonBuilder()
        .setLabel("Botを追加")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Link)
        .setURL(BOT_INVITE_URL),
    ),
  ];
}

export function inviteText(): string {
  return [
    "🐺 **TomatoBotを追加**",
    "下のボタンから、遊びたいサーバーに追加できます。",
  ].join("\n");
}

export function inviteComponents(): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Botを追加")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Link)
        .setURL(BOT_INVITE_URL),
    ),
  ];
}

export async function handleGuideCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: guideText(),
    components: guideComponents(),
    ephemeral: true,
  });
}

export async function handleInviteCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: inviteText(),
    components: inviteComponents(),
    ephemeral: true,
  });
}

function onboardingComponents(): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("詳しい遊び方")
        .setEmoji("📖")
        .setStyle(ButtonStyle.Link)
        .setURL(GUIDE_SITE_URL),
    ),
  ];
}

export function onboardingText(): string {
  return [
    "🐺 **TomatoBotを追加してくれてありがとうございます。**",
    "`/jinro` で募集を作れます。1人ならNPCが入り、友達は「参加する」を押すだけです。",
    "分からなくなったら `/guide` でいつでも確認できます。",
  ].join("\n");
}

function canSendOnboarding(channel: TextChannel): boolean {
  const botMember = channel.guild.members.me;
  if (!botMember) return false;
  return channel
    .permissionsFor(botMember)
    .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
}

export function findOnboardingChannel(guild: Guild): TextChannel | undefined {
  if (guild.systemChannel && canSendOnboarding(guild.systemChannel))
    return guild.systemChannel;

  return [...guild.channels.cache.values()]
    .filter(
      (channel): channel is TextChannel =>
        channel.type === ChannelType.GuildText && canSendOnboarding(channel),
    )
    .sort((left, right) => left.rawPosition - right.rawPosition)[0];
}

export async function sendGuildOnboarding(guild: Guild): Promise<boolean> {
  const channel = findOnboardingChannel(guild);
  if (!channel) return false;
  await channel.send({
    content: onboardingText(),
    components: onboardingComponents(),
  });
  return true;
}
