import * as http from "http";
import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import * as dotenv from "dotenv";
import { createLobby, handleComponent, resetChannel } from "./game";
import { showStats } from "./stats";

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder()
    .setName("jinro")
    .setDescription("シンプルな人狼ゲームを開始します"),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("このチャンネルの人狼ゲームを終了します")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("自分の戦績を確認します"),
].map((command) => command.toJSON());

client.once("ready", async () => {
  if (!client.user) return;
  client.user.setActivity("/jinro で人狼", { type: ActivityType.Playing });
  await client.application?.commands.set(commands);
  console.log(`${client.user.tag} is ready.`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "jinro") {
        await createLobby(interaction);
      } else if (interaction.commandName === "reset") {
        await interaction.deferReply();
        const reset = await resetChannel(interaction.channelId);
        await interaction.editReply(
          reset ? "ゲームを終了しました。" : "進行中のゲームはありません。",
        );
      } else if (interaction.commandName === "stats") {
        await showStats(interaction);
      }
      return;
    }

    if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit()
    ) {
      await handleComponent(interaction);
    }
  } catch (error) {
    console.error("Interaction error:", error);
    const message = {
      content: "処理中にエラーが発生しました。",
      ephemeral: true,
    } as const;
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred)
        await interaction.followUp(message).catch(() => undefined);
      else await interaction.reply(message).catch(() => undefined);
    }
  }
});

const port = Number(process.env.PORT ?? 10000);
http
  .createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Tomatobot is running.");
  })
  .listen(port);

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required.");
void client.login(token);
