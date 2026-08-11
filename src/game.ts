import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  escapeMarkdown,
  Message,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  buildCustomRoles,
  buildRoles,
  getWinner,
  ROLE_INFO,
  ROLE_NAMES,
  roleConfigFromRoles,
  shuffle,
} from "./roles";
import {
  assignGameRoles,
  buildSoloRoles,
  chooseNpcVoteTarget,
  SOLO_PLAYER_COUNT,
} from "./solo";
import {
  combinedSuspicion,
  findNpcInsight,
  npcOpinionLine,
  personalityForSerial,
} from "./npc";
import {
  countVotes,
  discussionDuration,
  relativeTime,
  resolveVoteOutcome,
  topVotedIds,
} from "./presentation";
import type {
  GameState,
  Player,
  PublicResult,
  RoleName,
  Winner,
} from "./types";

const VOTE_SECONDS = 45;
const NIGHT_SECONDS = 45;
const VOTE_REVEAL_SECONDS = 5;
const NIGHT_REVEAL_SECONDS = 6;
const RESULT_HOLD_SECONDS = 4;
const START_HOLD_SECONDS = 4;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 15;

const games = new Map<string, GameState>();

const COLORS = {
  lobby: 0x5865f2,
  day: 0xf0b232,
  vote: 0x9b59b6,
  night: 0x2b2d31,
  danger: 0xed4245,
  success: 0x57f287,
};
const NPC_NAMES = [
  "アカネ",
  "レン",
  "ミオ",
  "ハル",
  "ソラ",
  "ユズ",
  "ナギ",
  "リン",
  "カイ",
  "モモ",
  "シロ",
  "ルナ",
  "トワ",
  "コウ",
];
function componentId(action: string, game: GameState): string {
  return `tb:${action}:${game.channelId}:${game.day}`;
}

function clearGameTimers(game: GameState): void {
  for (const timer of game.timers) clearTimeout(timer);
  game.timers = [];
}

function schedule(
  game: GameState,
  delayMs: number,
  callback: () => void,
): void {
  game.timers.push(setTimeout(callback, delayMs));
}

type PhaseRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

interface PhasePayload {
  content?: string;
  embeds: EmbedBuilder[];
  components?: PhaseRow[];
}

async function openPhasePanel(
  game: GameState,
  payload: PhasePayload,
): Promise<void> {
  game.phaseMessage = await game.channel.send(payload);
}

function alivePlayers(game: GameState): Player[] {
  return game.players.filter((player) => player.alive);
}

function aliveHumans(game: GameState): Player[] {
  return alivePlayers(game).filter((player) => !player.isNpc);
}

function safeName(player: Player): string {
  return escapeMarkdown(player.name);
}

function memoryFor(game: GameState, npcId: string): Map<string, number> {
  const memory = game.npcMemory.get(npcId) ?? new Map<string, number>();
  game.npcMemory.set(npcId, memory);
  return memory;
}

function rememberSuspect(
  game: GameState,
  npcId: string,
  targetId: string,
  amount: number,
): void {
  const memory = memoryFor(game, npcId);
  memory.set(targetId, (memory.get(targetId) ?? 0) + amount);
}

function decayNpcMemory(game: GameState): void {
  const livingIds = new Set(alivePlayers(game).map((player) => player.id));
  for (const memory of game.npcMemory.values()) {
    for (const [targetId, score] of memory) {
      if (!livingIds.has(targetId)) memory.delete(targetId);
      else if (Math.abs(score) < 0.25) memory.delete(targetId);
      else memory.set(targetId, score * 0.75);
    }
  }
}

function recordNpcClaim(
  game: GameState,
  speaker: Player,
  claimedRole: "占い師" | "霊能者",
  target: Player,
  result: PublicResult,
): void {
  if (
    game.npcClaims.some(
      (claim) =>
        claim.day === game.day &&
        claim.speakerId === speaker.id &&
        claim.claimedRole === claimedRole &&
        claim.targetId === target.id,
    )
  )
    return;
  game.npcClaims.push({
    day: game.day,
    speakerId: speaker.id,
    claimedRole,
    targetId: target.id,
    result,
  });
}

function progressBar(done: number, total: number): string {
  const size = 8;
  const filled = total > 0 ? Math.round((done / total) * size) : 0;
  return `${"▰".repeat(filled)}${"▱".repeat(size - filled)}`;
}

function playerNameRows(players: Player[]): string {
  return players
    .map((player) => `${player.isNpc ? "🤖" : "👤"} ${safeName(player)}`)
    .join("　");
}

function roleRows(players: Player[]): string {
  if (players.length === 0) return "—";
  return players
    .map(
      (player) =>
        `**${safeName(player)}**　${ROLE_INFO[player.role as RoleName].icon} ${player.role}`,
    )
    .join("\n");
}

function configuredRoles(game: GameState): RoleName[] {
  return ROLE_NAMES.flatMap((role) =>
    Array<RoleName>(game.roleConfig[role]).fill(role),
  );
}

function roleConfigRows(game: GameState): string {
  const config = game.roleConfig;
  return [
    `${ROLE_INFO.人狼.icon} 人狼 **${config.人狼}**　　${ROLE_INFO.占い師.icon} 占い師 **${config.占い師}**`,
    `${ROLE_INFO.騎士.icon} 騎士 **${config.騎士}**　　${ROLE_INFO.霊能者.icon} 霊能者 **${config.霊能者}**`,
    `${ROLE_INFO.村人.icon} 村人 **${config.村人}**`,
  ].join("\n");
}

function mentionRows(players: Player[]): string {
  return players.map((player) => `<@${player.id}>`).join("\n") || "—";
}

export function dayEmbed(game: GameState): EmbedBuilder {
  const living = alivePlayers(game);
  return new EmbedBuilder()
    .setTitle(`${game.day}日目｜議論`)
    .setDescription(
      `話し合って、投票先を決めよう。\n\n投票開始：${relativeTime(game.phaseEndsAt)}`,
    )
    .addFields({
      name: `生存者（${living.length}人）`,
      value: playerNameRows(living),
    })
    .setColor(COLORS.day);
}

export function finishedDayEmbed(game: GameState): EmbedBuilder {
  const living = alivePlayers(game);
  return new EmbedBuilder()
    .setTitle(`${game.day}日目｜議論終了`)
    .setDescription("議論を終了しました。")
    .addFields({
      name: `生存者（${living.length}人）`,
      value: playerNameRows(living),
    })
    .setColor(COLORS.day);
}

export function voteEmbed(game: GameState): EmbedBuilder {
  const done = game.votes.size;
  const total = alivePlayers(game).length;
  const title = game.voteRound > 1 ? "再投票" : "投票";
  return new EmbedBuilder()
    .setTitle(`${game.day}日目｜${title}`)
    .setDescription(
      `投票済み　**${done} / ${total}**\n${progressBar(done, total)}\n\n投票終了：${relativeTime(game.phaseEndsAt)}`,
    )
    .setColor(COLORS.vote)
    .setFooter({ text: "投票先は結果発表まで非公開。締切前なら変更できます" });
}

export function nightEmbed(game: GameState): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${game.day}日目｜夜`)
    .setDescription(
      `能力者はDMを確認してください。\n全員の行動が終わると、夜が明けます。\n\n夜明け：${relativeTime(game.phaseEndsAt)}`,
    )
    .setColor(COLORS.night);
}

function createNpc(game: GameState): Player {
  let serial = 1;
  while (
    game.players.some(
      (player) => player.id === `npc-${game.channelId}-${serial}`,
    )
  )
    serial += 1;
  const unusedName = NPC_NAMES.find(
    (name) => !game.players.some((player) => player.name === name),
  );
  return {
    id: `npc-${game.channelId}-${serial}`,
    name: unusedName ?? `NPC${serial}`,
    user: null,
    isNpc: true,
    npcPersonality: personalityForSerial(serial),
    alive: true,
  };
}

function addNpc(game: GameState): boolean {
  if (game.players.length >= MAX_PLAYERS) return false;
  game.players.push(createNpc(game));
  return true;
}

function playerOptions(players: Player[]) {
  return players.map((player) => ({
    label: player.name.slice(0, 100),
    value: player.id,
  }));
}

export function lobbyPayload(game: GameState) {
  const humans = game.players.filter((player) => !player.isNpc);
  const humanCount = humans.length;
  const npcCount = Math.max(0, game.targetPlayerCount - humanCount);
  const host = game.players.find((player) => player.id === game.hostId);
  const failedPlayers = humans.filter((player) =>
    game.roleDmFailures.has(player.id),
  );

  if (failedPlayers.length > 0) {
    const embed = new EmbedBuilder()
      .setTitle("ゲーム開始｜DM待機")
      .setDescription(
        `次の参加者に役職DMを送れませんでした。\n${failedPlayers
          .map((player) => `<@${player.id}>`)
          .join("\n")}\n\nDMを受け取れる設定にしてから再送してください。`,
      )
      .setColor(COLORS.danger)
      .setFooter({ text: "配役は固定されたままです" });
    const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(componentId("start", game))
        .setLabel("DMを再送")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(componentId("cancel", game))
        .setLabel("募集を中止")
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [retryRow] };
  }

  const embed = new EmbedBuilder()
    .setTitle("人狼ゲーム｜参加受付")
    .setDescription(
      `**参加者（${humanCount}/${game.targetPlayerCount}）**\n${mentionRows(humans)}`,
    )
    .addFields(
      {
        name: "ゲーム設定",
        value: `プレイ人数：${game.targetPlayerCount}人\nNPC予定：${npcCount}人\n議論時間：${discussionDuration(game.targetPlayerCount, humanCount)}秒`,
      },
      {
        name: "配役",
        value: roleConfigRows(game),
      },
    )
    .setColor(COLORS.lobby)
    .setFooter({
      text: `ホスト：${host ? safeName(host) : "不明"}／不足分はNPCで補充`,
    });

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(componentId("player-count", game))
    .setPlaceholder(`プレイ人数：${game.targetPlayerCount}人`)
    .addOptions(
      Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, index) => {
        const count = MIN_PLAYERS + index;
        return {
          label: `${count}人`,
          value: String(count),
          default: count === game.targetPlayerCount,
        };
      }),
    );
  const countRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(countMenu);
  const participantRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("join", game))
      .setLabel("参加する")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(humanCount >= game.targetPlayerCount),
    new ButtonBuilder()
      .setCustomId(componentId("leave", game))
      .setLabel("退出する")
      .setStyle(ButtonStyle.Secondary),
  );
  const hostRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("role-config", game))
      .setLabel("配役を設定")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(componentId("start", game))
      .setLabel("ゲーム開始")
      .setStyle(ButtonStyle.Success)
      .setDisabled(humanCount === 0),
    new ButtonBuilder()
      .setCustomId(componentId("cancel", game))
      .setLabel("募集を中止")
      .setStyle(ButtonStyle.Danger),
  );

  return {
    embeds: [embed],
    components: [countRow, participantRow, hostRow],
  };
}

export async function createLobby(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.inGuild() ||
    interaction.channel?.type !== ChannelType.GuildText
  ) {
    await interaction.reply({
      content: "サーバーのテキストチャンネルで実行してください。",
      ephemeral: true,
    });
    return;
  }

  const existing = games.get(interaction.channelId);
  if (existing?.phase === "ended") {
    clearGameTimers(existing);
    games.delete(interaction.channelId);
  } else if (existing) {
    await interaction.reply({
      content: "このチャンネルでは既にゲームが進行中です。",
      ephemeral: true,
    });
    return;
  }

  const game: GameState = {
    channelId: interaction.channelId,
    channel: interaction.channel as TextChannel,
    hostId: interaction.user.id,
    phase: "lobby",
    players: [
      {
        id: interaction.user.id,
        name: interaction.user.displayName,
        user: interaction.user,
        isNpc: false,
        alive: true,
      },
    ],
    targetPlayerCount: SOLO_PLAYER_COUNT,
    roleConfig: roleConfigFromRoles(buildSoloRoles(SOLO_PLAYER_COUNT)),
    roleDmSent: new Set(),
    roleDmFailures: new Set(),
    day: 0,
    voteRound: 1,
    voteCandidateIds: [],
    votes: new Map(),
    voteHistory: [],
    nightChoices: new Map(),
    npcSuspicion: new Map(),
    npcMemory: new Map(),
    npcClaims: [],
    humanSuspicions: new Map(),
    seerResults: new Map(),
    timers: [],
    resolving: false,
  };

  games.set(game.channelId, game);
  await interaction.reply(lobbyPayload(game));
  game.lobbyMessage = (await interaction.fetchReply()) as Message;
}

export async function resetChannel(
  channelId: string,
  editMessage = true,
): Promise<boolean> {
  const game = games.get(channelId);
  if (!game) return false;
  clearGameTimers(game);
  games.delete(channelId);
  if (editMessage) {
    await game.lobbyMessage
      ?.edit({
        content: "ゲームはリセットされました。",
        embeds: [],
        components: [],
      })
      .catch(() => undefined);
  }
  return true;
}

async function updateLobby(game: GameState): Promise<void> {
  await game.lobbyMessage?.edit(lobbyPayload(game));
}

async function handleJoin(
  interaction: ButtonInteraction,
  game: GameState,
  action: "join" | "leave",
): Promise<void> {
  if (game.phase !== "lobby") {
    await interaction.reply({
      content: "募集は終了しています。",
      ephemeral: true,
    });
    return;
  }

  const index = game.players.findIndex(
    (player) => player.id === interaction.user.id,
  );
  if (action === "leave") {
    if (index < 0) {
      await interaction.reply({
        content: "現在このゲームには参加していません。",
        ephemeral: true,
      });
      return;
    }
    if (interaction.user.id === game.hostId) {
      await interaction.reply({
        content: "ホストは退出できません。募集を中止してください。",
        ephemeral: true,
      });
      return;
    }
    game.players.splice(index, 1);
  } else {
    if (index >= 0) {
      await interaction.reply({
        content: "すでに参加しています。",
        ephemeral: true,
      });
      return;
    }
    const humanCount = game.players.filter((player) => !player.isNpc).length;
    if (humanCount >= game.targetPlayerCount) {
      await interaction.reply({
        content: `このゲームは${game.targetPlayerCount}人設定です。`,
        ephemeral: true,
      });
      return;
    }
    game.players.push({
      id: interaction.user.id,
      name: interaction.user.displayName,
      user: interaction.user,
      isNpc: false,
      alive: true,
    });
  }

  await interaction.deferUpdate();
  await updateLobby(game);
}

async function handlePlayerCountChange(
  interaction: StringSelectMenuInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "プレイ人数を変更できるのはホストだけです。",
      ephemeral: true,
    });
    return;
  }
  if (game.phase !== "lobby") {
    await interaction.reply({
      content: "ゲーム開始後は人数を変更できません。",
      ephemeral: true,
    });
    return;
  }

  const count = Number(interaction.values[0]);
  const humans = game.players.filter((player) => !player.isNpc);
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
    await interaction.reply({
      content: "プレイ人数は4〜15人から選んでください。",
      ephemeral: true,
    });
    return;
  }
  if (count < humans.length) {
    await interaction.reply({
      content: `現在${humans.length}人が参加中のため、それ未満にはできません。`,
      ephemeral: true,
    });
    return;
  }

  game.players = humans;
  game.targetPlayerCount = count;
  let configWasReset = false;
  try {
    game.roleConfig = roleConfigFromRoles(
      buildCustomRoles(count, {
        人狼: game.roleConfig.人狼,
        占い師: game.roleConfig.占い師,
        騎士: game.roleConfig.騎士,
        霊能者: game.roleConfig.霊能者,
      }),
    );
  } catch {
    const recommendedRoles =
      humans.length === 1 ? buildSoloRoles(count) : buildRoles(count);
    game.roleConfig = roleConfigFromRoles(recommendedRoles);
    configWasReset = true;
  }
  await interaction.deferUpdate();
  await updateLobby(game);
  if (configWasReset) {
    await interaction.followUp({
      content:
        "新しい人数では元の配役が成立しないため、配役を標準構成に戻しました。",
      ephemeral: true,
    });
  }
}

function roleCountInput(
  id: string,
  label: string,
  value: number,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setValue(String(value))
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2),
  );
}

async function handleRoleConfigButton(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "配役を変更できるのはホストだけです。",
      ephemeral: true,
    });
    return;
  }
  if (game.phase !== "lobby") {
    await interaction.reply({
      content: "ゲーム開始後は配役を変更できません。",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(componentId("role-config-submit", game))
    .setTitle(`配役設定（${game.targetPlayerCount}人）`)
    .addComponents(
      roleCountInput("wolf-count", "人狼（1人以上）", game.roleConfig.人狼),
      roleCountInput("seer-count", "占い師（0〜1人）", game.roleConfig.占い師),
      roleCountInput("guard-count", "騎士（0〜1人）", game.roleConfig.騎士),
      roleCountInput(
        "medium-count",
        "霊能者（0〜1人）",
        game.roleConfig.霊能者,
      ),
    );
  await interaction.showModal(modal);
}

function parseRoleCount(
  interaction: ModalSubmitInteraction,
  id: string,
): number {
  const text = interaction.fields.getTextInputValue(id).trim();
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

async function handleRoleConfigSubmit(
  interaction: ModalSubmitInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId || game.phase !== "lobby") {
    await interaction.reply({
      content: "現在は配役を変更できません。",
      ephemeral: true,
    });
    return;
  }

  try {
    const roles = buildCustomRoles(game.targetPlayerCount, {
      人狼: parseRoleCount(interaction, "wolf-count"),
      占い師: parseRoleCount(interaction, "seer-count"),
      騎士: parseRoleCount(interaction, "guard-count"),
      霊能者: parseRoleCount(interaction, "medium-count"),
    });
    game.roleConfig = roleConfigFromRoles(roles);
  } catch (error) {
    await interaction.reply({
      content:
        error instanceof Error ? error.message : "配役を確認してください。",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: "配役を更新しました。", ephemeral: true });
  await updateLobby(game);
}

async function handleStart(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "ゲームを開始できるのは主催者だけです。",
      ephemeral: true,
    });
    return;
  }
  if (game.phase !== "lobby") {
    await interaction.reply({
      content: "ゲームは既に始まっています。",
      ephemeral: true,
    });
    return;
  }
  if (game.roleDmFailures.size === 0) {
    game.players = game.players.filter((player) => !player.isNpc);
    while (game.players.length < game.targetPlayerCount) addNpc(game);
  }

  await interaction.deferUpdate();
  await startGame(game);
}

async function handleCancel(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "募集を中止できるのは主催者だけです。",
      ephemeral: true,
    });
    return;
  }

  await resetChannel(game.channelId, false);
  await interaction.update({
    content: "募集を中止しました。",
    embeds: [],
    components: [],
  });
}

function recordSeerResult(
  game: GameState,
  seerId: string,
  target: Player,
): void {
  const results = game.seerResults.get(seerId) ?? [];
  if (!results.some((result) => result.targetId === target.id)) {
    results.push({ targetId: target.id, isWolf: target.role === "人狼" });
  }
  game.seerResults.set(seerId, results);
}

function initializeSeerResults(game: GameState): void {
  for (const seer of game.players.filter(
    (player) => player.role === "占い師",
  )) {
    const targets = game.players.filter((player) => player.id !== seer.id);
    if (targets.length) recordSeerResult(game, seer.id, randomItem(targets));
  }
}

export function roleDmEmbed(game: GameState, player: Player): EmbedBuilder {
  const role = player.role as RoleName;
  const info = ROLE_INFO[role];
  const allies =
    role === "人狼"
      ? game.players
          .filter((other) => other.role === "人狼" && other.id !== player.id)
          .map((other) => safeName(other))
      : [];
  const allyText = allies.length ? `\n仲間の人狼: ${allies.join("、")}` : "";
  const firstResult = game.seerResults.get(player.id)?.[0];
  const firstTarget = firstResult
    ? game.players.find((target) => target.id === firstResult.targetId)
    : undefined;
  const firstResultText =
    role === "占い師" && firstResult && firstTarget
      ? `\n\n🔮 初日の占い結果: **${safeName(firstTarget)}** は **${firstResult.isWolf ? "人狼" : "人間"}** です。`
      : "";

  return new EmbedBuilder()
    .setTitle(`${info.icon} 役職｜${role}`)
    .setDescription(`${info.description}${allyText}${firstResultText}`)
    .addFields({
      name: "勝利条件",
      value:
        info.team === "wolf" ? "人狼陣営を勝利させる" : "人狼を全員処刑する",
    })
    .setColor(info.team === "wolf" ? COLORS.danger : COLORS.lobby);
}

export function gameStartEmbed(game: GameState): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`ゲーム開始｜${game.players.length}人`)
    .setDescription("役職をDMに送信しました。\n確認したらゲーム開始です。")
    .addFields({ name: "配役", value: roleConfigRows(game) })
    .setColor(COLORS.lobby)
    .setFooter({ text: "まもなく最初の議論が始まります" });
}

async function startGame(game: GameState): Promise<void> {
  const hasPreparedRoles = game.players.every((player) => player.role);
  if (!hasPreparedRoles) {
    const assignments = assignGameRoles(
      game.players,
      Math.random,
      configuredRoles(game),
    );
    game.players.forEach((player) => {
      player.role = assignments.get(player.id);
      player.alive = true;
    });
    game.day = 1;
    game.seerResults.clear();
    game.roleDmSent.clear();
    game.voteHistory = [];
    game.npcClaims = [];
    game.npcMemory.clear();
    initializeSeerResults(game);
  }

  game.roleDmFailures.clear();
  await game.lobbyMessage?.edit({
    content: "",
    embeds: [gameStartEmbed(game)],
    components: [],
  });

  await Promise.all(
    game.players.map(async (player) => {
      if (player.isNpc || !player.user || game.roleDmSent.has(player.id))
        return;
      try {
        await player.user.send({ embeds: [roleDmEmbed(game, player)] });
        game.roleDmSent.add(player.id);
      } catch {
        game.roleDmFailures.add(player.id);
      }
    }),
  );

  if (game.roleDmFailures.size > 0) {
    await game.lobbyMessage?.edit({ content: "", ...lobbyPayload(game) });
    return;
  }

  game.phaseMessage = undefined;
  clearGameTimers(game);
  schedule(game, START_HOLD_SECONDS * 1000, () => void startDay(game));
}

async function startDay(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.phase = "day";
  game.votes.clear();
  game.nightChoices.clear();
  game.npcSuspicion.clear();
  decayNpcMemory(game);
  game.humanSuspicions.clear();
  game.resolving = false;

  const living = alivePlayers(game);
  const livingHumanPlayers = aliveHumans(game);
  const daySeconds = discussionDuration(
    living.length,
    livingHumanPlayers.length,
  );
  game.phaseEndsAt = Date.now() + daySeconds * 1000;
  const hasNpc = living.some((player) => player.isNpc);
  const suspectTargets =
    livingHumanPlayers.length === 1
      ? living.filter((player) => player.id !== livingHumanPlayers[0].id)
      : living;
  const suspectMenu = new StringSelectMenuBuilder()
    .setCustomId(componentId("suspect", game))
    .setPlaceholder("怪しいと思う人（任意）")
    .addOptions(playerOptions(suspectTargets));
  const payload = {
    content: "",
    embeds: [dayEmbed(game)],
    components:
      livingHumanPlayers.length > 0 && hasNpc && suspectTargets.length > 0
        ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              suspectMenu,
            ),
          ]
        : [],
  };
  await openPhasePanel(game, payload);

  scheduleNpcDiscussion(game, daySeconds);
  schedule(game, daySeconds * 1000, () => void startVoting(game));
}

function scheduleNpcDiscussion(game: GameState, daySeconds: number): void {
  const maxSpeakers = aliveHumans(game).length >= 2 ? 1 : 3;
  const speakingNpcs = shuffle(
    alivePlayers(game).filter((player) => player.isNpc),
  ).slice(0, maxSpeakers);
  speakingNpcs.forEach((npc, index) => {
    const availableMs = Math.max(2000, daySeconds * 1000 - 2000);
    const delayMs = Math.min(4000 + index * 7000, availableMs);
    schedule(game, delayMs, () => {
      if (game.phase !== "day" || !npc.alive) return;
      const targets = alivePlayers(game).filter(
        (player) => player.id !== npc.id,
      );
      if (!targets.length) return;

      const knownResult = [...(game.seerResults.get(npc.id) ?? [])]
        .reverse()
        .find((result) =>
          targets.some((target) => target.id === result.targetId),
        );
      if (npc.role === "占い師" && knownResult) {
        const target = targets.find(
          (candidate) => candidate.id === knownResult.targetId,
        );
        if (!target) return;
        const resultText: PublicResult = knownResult.isWolf ? "人狼" : "人間";
        recordNpcClaim(game, npc, "占い師", target, resultText);
        rememberSuspect(game, npc.id, target.id, knownResult.isWolf ? 6 : -3);
        game.npcSuspicion.set(
          target.id,
          (game.npcSuspicion.get(target.id) ?? 0) +
            (knownResult.isWolf ? 3 : -1),
        );
        void game.channel.send(
          `**${safeName(npc)}**（NPC）　🔮 占い師を名乗る。「**${safeName(target)}** は **${resultText}**」`,
        );
        return;
      }

      if (npc.role === "霊能者" && game.lastExecuted) {
        const resultText: PublicResult =
          game.lastExecuted.role === "人狼" ? "人狼" : "人間";
        recordNpcClaim(game, npc, "霊能者", game.lastExecuted, resultText);
        void game.channel.send(
          `**${safeName(npc)}**（NPC）　👻 霊能者を名乗る。「**${safeName(game.lastExecuted)}** は **${resultText}**」`,
        );
        return;
      }

      if (npc.role === "人狼" && Math.random() < 0.4) {
        const fakeTargets = targets.filter((target) => target.role !== "人狼");
        const target = randomItem(fakeTargets.length ? fakeTargets : targets);
        recordNpcClaim(game, npc, "占い師", target, "人狼");
        rememberSuspect(game, npc.id, target.id, 2);
        game.npcSuspicion.set(
          target.id,
          (game.npcSuspicion.get(target.id) ?? 0) + 3,
        );
        void game.channel.send(
          `**${safeName(npc)}**（NPC）　🔮 占い師を名乗る。「**${safeName(target)}** は **人狼**」`,
        );
        return;
      }

      const personality = npc.npcPersonality ?? "慎重";
      const insight = findNpcInsight(
        game.npcClaims,
        game.voteHistory,
        npc.id,
        new Set(targets.map((target) => target.id)),
      );
      if (insight) {
        const suspect = targets.find(
          (candidate) => candidate.id === insight.suspectId,
        );
        if (suspect) {
          rememberSuspect(game, npc.id, suspect.id, 4);
          const line = npcOpinionLine(
            personality,
            safeName(suspect),
            insight.reason,
          );
          void game.channel.send(`**${safeName(npc)}**（NPC）　${line}`);
          return;
        }
      }

      const suspicion = combinedSuspicion(
        game.npcSuspicion,
        memoryFor(game, npc.id),
        personality,
      );
      const targetId = chooseNpcVoteTarget(npc, targets, suspicion);
      const target = targets.find((candidate) => candidate.id === targetId);
      if (!target) return;
      rememberSuspect(game, npc.id, target.id, 1);
      const line = npcOpinionLine(
        personality,
        safeName(target),
        previousVoteReason(game, target.id),
      );
      void game.channel.send(`**${safeName(npc)}**（NPC）　${line}`);
    });
  });
}

async function updateVoteProgress(game: GameState): Promise<void> {
  await game.phaseMessage
    ?.edit({
      embeds: [voteEmbed(game)],
    })
    .catch(() => undefined);
}

function scheduleNpcVotes(game: GameState): void {
  const npcs = alivePlayers(game).filter((player) => player.isNpc);
  npcs.forEach((npc, index) => {
    schedule(game, 1000 + index * 700, () => {
      if (game.phase !== "voting" || !npc.alive) return;
      const targets = alivePlayers(game).filter(
        (player) =>
          player.id !== npc.id && game.voteCandidateIds.includes(player.id),
      );
      if (!targets.length) return;
      const personality = npc.npcPersonality ?? "慎重";
      const suspicion = combinedSuspicion(
        game.npcSuspicion,
        memoryFor(game, npc.id),
        personality,
      );
      const targetId = chooseNpcVoteTarget(npc, targets, suspicion);
      game.votes.set(npc.id, targetId);
      rememberSuspect(game, npc.id, targetId, 0.75);
      void updateVoteProgress(game);
      if (game.votes.size >= alivePlayers(game).length)
        void queueVoteResolution(game);
    });
  });
}

async function startVoting(game: GameState): Promise<void> {
  if (game.phase !== "day") return;
  await game.phaseMessage
    ?.edit({ embeds: [finishedDayEmbed(game)], components: [] })
    .catch(() => undefined);
  game.phase = "voting";
  game.voteRound = 1;
  game.voteCandidateIds = alivePlayers(game).map((player) => player.id);
  await beginVoting(game);
}

async function beginVoting(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.resolving = false;
  game.votes.clear();
  game.phaseEndsAt = Date.now() + VOTE_SECONDS * 1000;
  const candidates = alivePlayers(game).filter((player) =>
    game.voteCandidateIds.includes(player.id),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("vote", game))
    .setPlaceholder(
      game.voteRound > 1
        ? "再投票する人を選んでください"
        : "処刑したい人を選んでください",
    )
    .addOptions(playerOptions(candidates));

  const payload = {
    content: "",
    embeds: [voteEmbed(game)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  };
  await openPhasePanel(game, payload);

  scheduleNpcVotes(game);
  schedule(game, VOTE_SECONDS * 1000, () => void queueVoteResolution(game));
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function mostVotedTarget(targets: string[], fallback: Player[]): string {
  if (targets.length === 0) return randomItem(fallback).id;
  return randomItem(topVotedIds(targets));
}

export function voteTallyRows(game: GameState): string {
  const rows = countVotes([...game.votes.values()]).map(({ id, count }) => {
    const player = game.players.find((candidate) => candidate.id === id);
    if (!player) return `不明：${count}票`;
    return `${player.isNpc ? "🤖" : "👤"} ${safeName(player)}：${count}票`;
  });
  return rows.join("\n") || "投票なし";
}

export function voteBallotFields(
  game: GameState,
): Array<{ name: string; value: string }> {
  const rows = game.players
    .filter((player) => game.votes.has(player.id))
    .map((voter) => {
      const target = game.players.find(
        (candidate) => candidate.id === game.votes.get(voter.id),
      );
      const voterText = `${voter.isNpc ? "🤖" : "👤"} ${safeName(voter)}`;
      const targetText = target
        ? `${target.isNpc ? "🤖" : "👤"} ${safeName(target)}`
        : "不明";
      return `${voterText} → ${targetText}`;
    });
  if (rows.length === 0) return [{ name: "投票先", value: "投票なし" }];

  const fields: Array<{ name: string; value: string }> = [];
  for (let index = 0; index < rows.length; index += 8) {
    fields.push({
      name: index === 0 ? "投票先" : "投票先（続き）",
      value: rows.slice(index, index + 8).join("\n"),
    });
  }
  return fields;
}

export function recordCurrentVoteRound(game: GameState): void {
  if (
    game.voteHistory.some(
      (record) => record.day === game.day && record.round === game.voteRound,
    )
  )
    return;

  const ballots = [...game.votes.entries()].map(([voterId, targetId]) => ({
    voterId,
    targetId,
  }));
  game.voteHistory.push({ day: game.day, round: game.voteRound, ballots });

  const topIds = topVotedIds(ballots.map((ballot) => ballot.targetId));
  for (const npc of alivePlayers(game).filter((player) => player.isNpc)) {
    const ownTarget = game.votes.get(npc.id);
    if (ownTarget) rememberSuspect(game, npc.id, ownTarget, 0.5);
    if (npc.npcPersonality === "同調") {
      for (const targetId of topIds) {
        if (targetId !== npc.id) rememberSuspect(game, npc.id, targetId, 1);
      }
    }
  }
}

function previousVoteReason(
  game: GameState,
  targetId: string,
): string | undefined {
  const records = game.voteHistory.filter(
    (record) => record.day === game.day - 1,
  );
  if (records.length === 0) return undefined;
  const latest = records.sort((left, right) => right.round - left.round)[0];
  const count = latest.ballots.filter(
    (ballot) => ballot.targetId === targetId,
  ).length;
  return count >= 2 ? `昨日も${count}票集まっていた` : undefined;
}

async function handleSuspect(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const actor = game.players.find(
    (player) => player.id === interaction.user.id,
  );
  const target = game.players.find(
    (player) => player.id === interaction.values[0] && player.alive,
  );
  if (
    game.phase !== "day" ||
    game.day !== day ||
    !actor?.alive ||
    actor.isNpc ||
    !target
  ) {
    await interaction.reply({
      content: "現在は疑い先を伝えられません。",
      ephemeral: true,
    });
    return;
  }
  if (actor.id === target.id) {
    await interaction.reply({
      content: "自分自身は指定できません。",
      ephemeral: true,
    });
    return;
  }

  const previousId = game.humanSuspicions.get(actor.id);
  if (previousId)
    game.npcSuspicion.set(
      previousId,
      (game.npcSuspicion.get(previousId) ?? 0) - 4,
    );
  game.humanSuspicions.set(actor.id, target.id);
  game.npcSuspicion.set(target.id, (game.npcSuspicion.get(target.id) ?? 0) + 4);
  await interaction.reply({
    content: `疑い先を **${safeName(target)}** に設定しました。NPCが投票判断に使用します。`,
    ephemeral: true,
  });
}

async function handleVote(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const voter = game.players.find(
    (player) => player.id === interaction.user.id,
  );
  if (game.phase !== "voting" || game.day !== day || !voter?.alive) {
    await interaction.reply({
      content: "現在は投票できません。",
      ephemeral: true,
    });
    return;
  }

  const targetId = interaction.values[0];
  if (
    !alivePlayers(game).some((player) => player.id === targetId) ||
    !game.voteCandidateIds.includes(targetId)
  ) {
    await interaction.reply({
      content: "その人には投票できません。",
      ephemeral: true,
    });
    return;
  }

  game.votes.set(voter.id, targetId);
  await interaction.reply({
    content: "投票を受け付けました。",
    ephemeral: true,
  });
  await updateVoteProgress(game);

  if (game.votes.size >= alivePlayers(game).length)
    void queueVoteResolution(game);
}

async function queueVoteResolution(game: GameState): Promise<void> {
  if (game.phase !== "voting" || game.resolving) return;
  game.resolving = true;
  clearGameTimers(game);
  game.phaseEndsAt = Date.now() + VOTE_REVEAL_SECONDS * 1000;
  await game.phaseMessage
    ?.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${game.day}日目｜投票終了`)
          .setDescription(
            `投票を締め切りました。\n\n${progressBar(game.votes.size, alivePlayers(game).length)}\n結果を集計しています…`,
          )
          .setColor(COLORS.vote),
      ],
      components: [],
    })
    .catch(() => undefined);
  schedule(game, VOTE_REVEAL_SECONDS * 1000, () => void revealVoteResult(game));
}

async function revealVoteResult(game: GameState): Promise<void> {
  if (game.phase !== "voting" || !game.resolving) return;
  clearGameTimers(game);
  recordCurrentVoteRound(game);

  const living = alivePlayers(game);
  const outcome = resolveVoteOutcome([...game.votes.values()], game.voteRound);

  if (outcome.kind === "revote") {
    game.phaseEndsAt = Date.now() + RESULT_HOLD_SECONDS * 1000;
    const tied = living.filter((player) =>
      outcome.candidateIds.includes(player.id),
    );
    await game.phaseMessage?.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${game.day}日目｜同票`)
          .setDescription(
            `${playerNameRows(tied)} が同票でした。\n\n再投票を行います。`,
          )
          .addFields(
            { name: "得票数", value: voteTallyRows(game) },
            ...voteBallotFields(game),
          )
          .setColor(COLORS.vote),
      ],
      components: [],
    });
    schedule(game, RESULT_HOLD_SECONDS * 1000, () => {
      game.voteRound = 2;
      game.voteCandidateIds = outcome.candidateIds;
      void beginVoting(game);
    });
    return;
  }

  if (outcome.kind === "no-execution") {
    game.lastExecuted = undefined;
    game.phaseEndsAt = Date.now() + RESULT_HOLD_SECONDS * 1000;
    const noExecutionText = outcome.candidateIds.length
      ? "同票のため、本日の処刑はありません。"
      : "投票が集まらなかったため、本日の処刑はありません。";
    await game.phaseMessage?.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${game.day}日目｜投票結果`)
          .setDescription(noExecutionText)
          .addFields(
            { name: "得票数", value: voteTallyRows(game) },
            ...voteBallotFields(game),
          )
          .setColor(COLORS.vote),
      ],
      components: [],
    });
    schedule(game, RESULT_HOLD_SECONDS * 1000, () => void startNight(game));
    return;
  }

  const executed = game.players.find(
    (player) => player.id === outcome.targetId,
  );
  if (!executed) return;

  executed.alive = false;
  game.lastExecuted = executed;
  const winner = getWinner(game.players);
  game.phaseEndsAt = Date.now() + RESULT_HOLD_SECONDS * 1000;
  await game.phaseMessage?.edit({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${game.day}日目｜投票結果`)
        .setDescription(
          `村の決定により、**${safeName(executed)}** が処刑されました。`,
        )
        .addFields(
          { name: "得票数", value: voteTallyRows(game) },
          ...voteBallotFields(game),
        )
        .setColor(COLORS.danger),
    ],
    components: [],
  });
  schedule(game, RESULT_HOLD_SECONDS * 1000, () => {
    if (winner) void endGame(game, winner);
    else void startNight(game);
  });
}

function nightActionKey(action: string, playerId: string): string {
  return `${action}:${playerId}`;
}

function expectedNightActions(game: GameState): string[] {
  const expected: string[] = [];
  for (const player of alivePlayers(game)) {
    if (player.role === "人狼")
      expected.push(nightActionKey("kill", player.id));
    if (player.role === "占い師")
      expected.push(nightActionKey("seer", player.id));
    if (player.role === "騎士")
      expected.push(nightActionKey("guard", player.id));
  }
  return expected;
}

async function sendNightMenu(
  game: GameState,
  player: Player,
  action: "kill" | "seer" | "guard",
  prompt: string,
  targets: Player[],
): Promise<void> {
  if (player.isNpc || !player.user || targets.length === 0) return;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId(`night-${action}`, game))
    .setPlaceholder(prompt)
    .addOptions(playerOptions(targets));

  try {
    await player.user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(
            action === "kill"
              ? "🌙 夜の行動｜襲撃"
              : action === "seer"
                ? "🌙 夜の行動｜占い"
                : "🌙 夜の行動｜護衛",
          )
          .setDescription(prompt)
          .setColor(COLORS.night),
      ],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      ],
    });
  } catch {
    await game.channel.send(`<@${player.id}> に夜行動のDMを送れませんでした。`);
  }
}

function setNpcNightChoices(game: GameState): void {
  const living = alivePlayers(game);
  for (const npc of living.filter((player) => player.isNpc)) {
    if (npc.role === "人狼") {
      const targets = living.filter((player) => player.role !== "人狼");
      if (targets.length)
        game.nightChoices.set(
          nightActionKey("kill", npc.id),
          randomItem(targets).id,
        );
    } else if (npc.role === "占い師") {
      const targets = living.filter((player) => player.id !== npc.id);
      if (targets.length) {
        const target = randomItem(targets);
        game.nightChoices.set(nightActionKey("seer", npc.id), target.id);
        recordSeerResult(game, npc.id, target);
      }
    } else if (npc.role === "騎士") {
      const targets = living.filter((player) => player.id !== npc.id);
      if (targets.length)
        game.nightChoices.set(
          nightActionKey("guard", npc.id),
          randomItem(targets).id,
        );
    }
  }
}

async function startNight(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.phase = "night";
  game.nightChoices.clear();
  game.resolving = false;
  game.phaseEndsAt = Date.now() + NIGHT_SECONDS * 1000;

  const nightPayload = {
    content: "",
    embeds: [nightEmbed(game)],
    components: [],
  };
  await openPhasePanel(game, nightPayload);

  const medium = alivePlayers(game).find((player) => player.role === "霊能者");
  if (medium?.user && game.lastExecuted) {
    const result = game.lastExecuted.role === "人狼" ? "人狼" : "人間";
    await medium.user
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle("👻 霊能結果")
            .setDescription(
              `**${safeName(game.lastExecuted)}** は **${result}** でした。`,
            )
            .setColor(COLORS.night),
        ],
      })
      .catch(() => undefined);
  }

  const living = alivePlayers(game);
  setNpcNightChoices(game);
  await Promise.all(
    living.map(async (player) => {
      if (player.isNpc) return;
      if (player.role === "人狼") {
        await sendNightMenu(
          game,
          player,
          "kill",
          "襲撃する人を選んでください。",
          living.filter((target) => target.role !== "人狼"),
        );
      } else if (player.role === "占い師") {
        await sendNightMenu(
          game,
          player,
          "seer",
          "占う人を選んでください。",
          living.filter((target) => target.id !== player.id),
        );
      } else if (player.role === "騎士") {
        await sendNightMenu(
          game,
          player,
          "guard",
          "守る人を選んでください。",
          living.filter((target) => target.id !== player.id),
        );
      }
    }),
  );

  schedule(game, NIGHT_SECONDS * 1000, () => void queueNightResolution(game));
  if (expectedNightActions(game).every((key) => game.nightChoices.has(key))) {
    schedule(game, 2000, () => void queueNightResolution(game));
  }
}

async function handleNightAction(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  action: "kill" | "seer" | "guard",
  day: number,
): Promise<void> {
  const actor = game.players.find(
    (player) => player.id === interaction.user.id,
  );
  const requiredRole: Record<typeof action, RoleName> = {
    kill: "人狼",
    seer: "占い師",
    guard: "騎士",
  };

  if (
    game.phase !== "night" ||
    game.day !== day ||
    !actor?.alive ||
    actor.role !== requiredRole[action]
  ) {
    await interaction.reply({
      content: "この夜行動は現在使用できません。",
      ephemeral: true,
    });
    return;
  }

  const targetId = interaction.values[0];
  const target = game.players.find(
    (player) => player.id === targetId && player.alive,
  );
  if (!target) {
    await interaction.reply({
      content: "対象が見つかりません。",
      ephemeral: true,
    });
    return;
  }

  if (action === "kill" && target.role === "人狼") {
    await interaction.reply({
      content: "仲間の人狼は襲撃できません。",
      ephemeral: true,
    });
    return;
  }
  if ((action === "seer" || action === "guard") && target.id === actor.id) {
    await interaction.reply({
      content: "自分自身は選べません。",
      ephemeral: true,
    });
    return;
  }

  game.nightChoices.set(nightActionKey(action, actor.id), target.id);

  if (action === "seer") {
    recordSeerResult(game, actor.id, target);
    const result = target.role === "人狼" ? "人狼" : "人間";
    await interaction.update({
      content: `🔮 **${safeName(target)}** は **${result}** です。`,
      components: [],
    });
  } else {
    await interaction.update({
      content: `選択しました: **${safeName(target)}**`,
      components: [],
    });
  }

  if (expectedNightActions(game).every((key) => game.nightChoices.has(key)))
    void queueNightResolution(game);
}

async function queueNightResolution(game: GameState): Promise<void> {
  if (game.phase !== "night" || game.resolving) return;
  game.resolving = true;
  clearGameTimers(game);
  game.phaseEndsAt = Date.now() + NIGHT_REVEAL_SECONDS * 1000;
  await game.phaseMessage
    ?.edit({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${game.day}日目｜夜明け前`)
          .setDescription(
            "夜の行動がすべて終わりました。\nまもなく朝になります。",
          )
          .setColor(COLORS.night),
      ],
    })
    .catch(() => undefined);
  schedule(
    game,
    NIGHT_REVEAL_SECONDS * 1000,
    () => void revealNightResult(game),
  );
}

async function revealNightResult(game: GameState): Promise<void> {
  if (game.phase !== "night" || !game.resolving) return;
  clearGameTimers(game);

  const living = alivePlayers(game);
  const wolves = living.filter((player) => player.role === "人狼");
  const possibleVictims = living.filter((player) => player.role !== "人狼");
  const wolfTargets = wolves
    .map((wolf) => game.nightChoices.get(nightActionKey("kill", wolf.id)))
    .filter((target): target is string => Boolean(target));
  const victimId = mostVotedTarget(wolfTargets, possibleVictims);
  const victim = game.players.find((player) => player.id === victimId);

  const guard = living.find((player) => player.role === "騎士");
  const guardedId = guard
    ? game.nightChoices.get(nightActionKey("guard", guard.id))
    : undefined;

  const wasGuarded = Boolean(victim && victim.id === guardedId);
  if (victim && !wasGuarded) {
    victim.alive = false;
  }

  const winner = getWinner(game.players);
  game.phaseEndsAt = Date.now() + RESULT_HOLD_SECONDS * 1000;
  const morningDescription = wasGuarded
    ? "昨夜の犠牲者はいませんでした。"
    : victim
      ? `昨夜、**${safeName(victim)}** が襲撃されました。`
      : "昨夜の犠牲者はいませんでした。";
  await game.phaseMessage?.edit({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${game.day}日目｜朝`)
        .setDescription(morningDescription)
        .setColor(wasGuarded || !victim ? COLORS.success : COLORS.danger),
    ],
    components: [],
  });
  if (!winner) game.day += 1;
  schedule(game, RESULT_HOLD_SECONDS * 1000, () => {
    if (winner) void endGame(game, winner);
    else void startDay(game);
  });
}

async function endGame(game: GameState, winner: Winner): Promise<void> {
  clearGameTimers(game);
  game.phase = "ended";
  const winnerText = winner === "villager" ? "村人陣営" : "人狼陣営";
  const survivors = game.players.filter((player) => player.alive);
  const eliminated = game.players.filter((player) => !player.alive);
  const resultLine =
    winner === "villager"
      ? "村からすべての人狼を追放しました。"
      : "人狼は最後まで正体を隠し通しました。";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("rematch", game))
      .setLabel("もう一度遊ぶ")
      .setStyle(ButtonStyle.Success),
  );

  const endPayload = {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle(`ゲーム終了｜${winnerText}の勝利`)
        .setDescription(resultLine)
        .addFields(
          {
            name: `生存（${survivors.length}人）`,
            value: roleRows(survivors),
          },
          {
            name: `死亡（${eliminated.length}人）`,
            value: roleRows(eliminated),
          },
        )
        .setColor(winner === "villager" ? COLORS.lobby : COLORS.danger)
        .setFooter({ text: `${game.day}日目で決着` }),
    ],
    components: [row],
  };
  await openPhasePanel(game, endPayload);

  schedule(game, 10 * 60 * 1000, () => games.delete(game.channelId));
}

async function handleRematch(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "再戦を始められるのは主催者だけです。",
      ephemeral: true,
    });
    return;
  }
  if (game.phase !== "ended") {
    await interaction.reply({
      content: "現在は再戦できません。",
      ephemeral: true,
    });
    return;
  }

  clearGameTimers(game);
  game.phase = "lobby";
  game.day = 0;
  game.lastExecuted = undefined;
  game.votes.clear();
  game.nightChoices.clear();
  game.npcSuspicion.clear();
  game.npcMemory.clear();
  game.npcClaims = [];
  game.voteHistory = [];
  game.humanSuspicions.clear();
  game.seerResults.clear();
  game.roleDmSent.clear();
  game.roleDmFailures.clear();
  game.voteRound = 1;
  game.voteCandidateIds = [];
  game.resolving = false;
  game.players = game.players.filter((player) => !player.isNpc);
  game.players.forEach((player) => {
    player.alive = true;
    player.role = undefined;
  });

  await interaction.update({ content: "", ...lobbyPayload(game) });
  game.lobbyMessage = interaction.message as Message;
  game.phaseMessage = undefined;
}

export async function handleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith("tb:")) return;
  const [, action, channelId, dayText] = interaction.customId.split(":");
  const game = games.get(channelId);

  if (!game) {
    await interaction.reply({
      content: "このゲームは終了しています。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.isButton()) {
    if (action === "join") await handleJoin(interaction, game, "join");
    else if (action === "leave") await handleJoin(interaction, game, "leave");
    else if (action === "role-config")
      await handleRoleConfigButton(interaction, game);
    else if (action === "start") await handleStart(interaction, game);
    else if (action === "cancel") await handleCancel(interaction, game);
    else if (action === "rematch") await handleRematch(interaction, game);
    return;
  }

  const day = Number(dayText);
  if (action === "player-count")
    await handlePlayerCountChange(interaction, game);
  else if (action === "suspect") await handleSuspect(interaction, game, day);
  else if (action === "vote") await handleVote(interaction, game, day);
  else if (action === "night-kill")
    await handleNightAction(interaction, game, "kill", day);
  else if (action === "night-seer")
    await handleNightAction(interaction, game, "seer", day);
  else if (action === "night-guard")
    await handleNightAction(interaction, game, "guard", day);
}

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith("tb:")) return;
  const [, action, channelId] = interaction.customId.split(":");
  const game = games.get(channelId);

  if (!game) {
    await interaction.reply({
      content: "このゲームは終了しています。",
      ephemeral: true,
    });
    return;
  }

  if (action === "role-config-submit") {
    await handleRoleConfigSubmit(interaction, game);
  }
}
