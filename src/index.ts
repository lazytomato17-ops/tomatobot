import * as http from "http";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import * as dotenv from "dotenv";
import { createLobby, handleComponent, resetChannel } from "./game";
import { healthResponse } from "./health";
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
    .setDescription("自分が開始した人狼ゲームを終了します"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("自分の戦績を確認します"),
].map((command) => command.toJSON());

client.once(Events.ClientReady, async (readyClient) => {
  readyClient.user.setActivity("/jinro で人狼", {
    type: ActivityType.Playing,
  });
  await readyClient.application.commands.set(commands).catch((error) => {
    console.error("Discord command sync failed:", error);
  });
  console.log(`${readyClient.user.tag} is ready.`);
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "jinro") {
        await createLobby(interaction);
      } else if (interaction.commandName === "reset") {
        await interaction.deferReply({ ephemeral: true });
        const result = await resetChannel(interaction.channelId, true, {
          userId: interaction.user.id,
          canManageMessages: Boolean(
            interaction.memberPermissions?.has(
              PermissionFlagsBits.ManageMessages,
            ),
          ),
          collectReason: true,
        });
        await interaction.editReply({
          content:
            result.status === "reset"
              ? result.components.length
                ? "ゲームを終了しました。\nよければ、終了した理由を1つ教えてください（任意）。"
                : "ゲームを終了しました。"
              : result.status === "forbidden"
                ? "ゲームを終了できるのはホストまたは管理者だけです。"
                : "進行中のゲームはありません。",
          components: result.components,
        });
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
const server = http.createServer((_request, response) => {
  const health = healthResponse(client.isReady());
  response.writeHead(health.statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(health.body);
});
server.listen(port);

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required.");
void client.login(token).catch((error) => {
  console.error("Discord login failed:", error);
  process.exitCode = 1;
  server.close();
});
