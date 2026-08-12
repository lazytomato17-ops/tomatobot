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
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
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
  addPublicClaimSuspicion,
  chooseNpcQuestionAnswer,
  chooseStrategicNightTarget,
  findNpcInsight,
  HUMAN_ARGUMENT_REASONS,
  LONE_WOLF_FAKE_CLAIM_CHANCE,
  MADMAN_FAKE_CLAIM_CHANCE,
  MADMAN_WHITE_CLAIM_CHANCE,
  npcDecisionSuspicion,
  npcOpinionLine,
  personalityForSerial,
  WOLF_FAKE_CLAIM_CHANCE,
} from "./npc";
export { npcDecisionSuspicion } from "./npc";
import {
  countVotes,
  discussionDuration,
  relativeTime,
  resolveVoteOutcome,
  topVotedIds,
} from "./presentation";
import { gameStatsFields, recordGameStats } from "./stats";
import type {
  GameState,
  HumanArgument,
  HumanArgumentReason,
  Player,
  PublicResult,
  RoleName,
  Winner,
} from "./types";

const VOTE_SECONDS = 45;
const NIGHT_SECONDS = 45;
const VOTE_MIN_SECONDS = 10;
const NIGHT_MIN_SECONDS = 8;
const VOTE_REVEAL_SECONDS = 5;
const NIGHT_REVEAL_SECONDS = 6;
const SEER_AUTO_SECONDS = 30;
const RESULT_HOLD_SECONDS = 4;
const START_HOLD_SECONDS = 4;
export const DEBUG_TIMINGS = {
  discussion: 45,
  vote: 30,
  night: 30,
  seerAuto: 20,
  transition: 3,
} as const;
export const DEBUG_USER_ID = "1010400040797360218";
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 15;
const NPC_QUESTIONS_PER_DAY = 2;

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

const HUMAN_ARGUMENT_INFO: Record<
  HumanArgumentReason,
  { label: string; description: string; publicText: string; emoji: string }
> = {
  "black-result": {
    label: "人狼判定が出ている",
    description: "公開された占い結果を根拠にします",
    publicText: "占い師COから人狼判定が出ている",
    emoji: "🐺",
  },
  "vote-contradiction": {
    label: "発言と投票が矛盾",
    description: "占い結果と投票先の食い違いを指摘します",
    publicText: "占い結果と投票先が矛盾している",
    emoji: "🗳️",
  },
  "broken-claim": {
    label: "占いCOが破綻",
    description: "人狼数や処刑結果との矛盾を指摘します",
    publicText: "公開情報から占いCOが破綻している",
    emoji: "⚠️",
  },
  "counter-claim": {
    label: "対抗COがいる",
    description: "同じ役職を名乗る人が複数います",
    publicText: "同じ役職の対抗COがいる",
    emoji: "🎭",
  },
  "previous-votes": {
    label: "前日の得票が多い",
    description: "前日の投票結果を根拠にします",
    publicText: "前日の投票で票が集まっている",
    emoji: "📊",
  },
  intuition: {
    label: "直感・違和感",
    description: "明確な証拠はないが疑いを表明します",
    publicText: "今のところ一番違和感がある",
    emoji: "💭",
  },
};
function componentId(action: string, game: GameState): string {
  return `tb:${action}:${game.channelId}:${game.day}`;
}

export function canControlDebug(game: GameState, userId: string): boolean {
  return userId === DEBUG_USER_ID && game.hostId === DEBUG_USER_ID;
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

function gameSeconds(
  game: GameState,
  normalSeconds: number,
  debugSeconds: number = DEBUG_TIMINGS.transition,
): number {
  return game.debugMode ? debugSeconds : normalSeconds;
}

export function discussionSecondsForGame(
  game: GameState,
  playerCount: number,
  humanCount: number,
): number {
  return game.debugMode
    ? DEBUG_TIMINGS.discussion
    : discussionDuration(playerCount, humanCount);
}

export function remainingPhaseMinimumMs(
  startedAt: number | undefined,
  minimumSeconds: number,
  now: number = Date.now(),
): number {
  if (!startedAt) return 0;
  return Math.max(0, startedAt + minimumSeconds * 1000 - now);
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

export function publicResultForRole(role?: RoleName): PublicResult {
  return role === "人狼" ? "人狼" : "人間";
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

function recordRoleClaim(
  game: GameState,
  speaker: Player,
  claimedRole: "占い師" | "霊能者",
  target: Player,
  result: PublicResult,
  resultDay?: number,
): boolean {
  const availableDays = availableClaimDays(game, speaker.id, claimedRole);
  const assignedResultDay = resultDay ?? availableDays[0];
  if (!assignedResultDay || !availableDays.includes(assignedResultDay))
    return false;
  if (
    game.npcClaims.some(
      (claim) =>
        claim.day === game.day &&
        claim.speakerId === speaker.id &&
        claim.claimedRole === claimedRole &&
        claim.targetId === target.id,
    )
  )
    return false;
  game.npcClaims.push({
    day: game.day,
    resultDay: assignedResultDay,
    speakerId: speaker.id,
    claimedRole,
    targetId: target.id,
    result,
  });
  return true;
}

type ClaimedRole = "占い師" | "霊能者" | "騎士";

export function claimedRoleForPlayer(
  game: GameState,
  playerId: string,
): ClaimedRole | undefined {
  const resultClaim = game.npcClaims.find(
    (claim) => claim.speakerId === playerId,
  );
  if (resultClaim) return resultClaim.claimedRole;
  return [...game.roleDeclarations].some(
    (declaration) => declaration.split(":")[1] === playerId,
  )
    ? "騎士"
    : undefined;
}

function playerResultClaims(
  game: GameState,
  playerId: string,
  claimedRole: "占い師" | "霊能者",
) {
  return game.npcClaims.filter(
    (claim) =>
      claim.speakerId === playerId && claim.claimedRole === claimedRole,
  );
}

function usedClaimDays(
  game: GameState,
  playerId: string,
  claimedRole: "占い師" | "霊能者",
): Set<number> {
  const maxDay =
    claimedRole === "占い師" ? game.day : game.executionHistory.length;
  const used = new Set<number>();
  for (const claim of playerResultClaims(game, playerId, claimedRole)) {
    const explicitDay = claim.resultDay;
    if (
      explicitDay !== undefined &&
      explicitDay >= 1 &&
      explicitDay <= maxDay &&
      !used.has(explicitDay)
    ) {
      used.add(explicitDay);
      continue;
    }
    const fallbackDay = Array.from(
      { length: maxDay },
      (_, index) => index + 1,
    ).find((day) => !used.has(day));
    if (fallbackDay !== undefined) used.add(fallbackDay);
  }
  return used;
}

export function availableClaimDays(
  game: GameState,
  playerId: string,
  claimedRole: "占い師" | "霊能者",
): number[] {
  const maxDay =
    claimedRole === "占い師" ? game.day : game.executionHistory.length;
  const used = usedClaimDays(game, playerId, claimedRole);
  return Array.from({ length: maxDay }, (_, index) => index + 1).filter(
    (day) => !used.has(day),
  );
}

export function remainingClaimSlots(
  game: GameState,
  playerId: string,
  claimedRole: "占い師" | "霊能者",
): number {
  return availableClaimDays(game, playerId, claimedRole).length;
}

export function applyPublicClaimSuspicion(
  game: GameState,
  target: Player,
  result: PublicResult,
): void {
  if (!target.alive) return;
  addPublicClaimSuspicion(game.npcSuspicion, target.id, result);
}

function hasNpcClaimedRole(
  game: GameState,
  npcId: string,
  claimedRole: "占い師" | "霊能者",
): boolean {
  return claimedRoleForPlayer(game, npcId) === claimedRole;
}

export function npcDiscussionSpeakers(
  game: GameState,
  maxSpeakers: number,
): Player[] {
  const livingNpcs = alivePlayers(game).filter((player) => player.isNpc);
  const priority = livingNpcs.filter(
    (npc) =>
      npc.role === "占い師" ||
      (npc.role === "霊能者" && Boolean(game.lastExecuted)) ||
      hasNpcClaimedRole(game, npc.id, "占い師") ||
      hasNpcClaimedRole(game, npc.id, "霊能者"),
  );
  const priorityIds = new Set(priority.map((npc) => npc.id));
  const remainingSlots = Math.max(0, maxSpeakers - priority.length);
  const others = shuffle(
    livingNpcs.filter((npc) => !priorityIds.has(npc.id)),
  ).slice(0, remainingSlots);
  return [...priority, ...others];
}

export function nextNpcSeerTarget(
  game: GameState,
  seer: Player,
): Player | undefined {
  const targets = alivePlayers(game).filter((player) => player.id !== seer.id);
  const inspectedIds = new Set(
    (game.seerResults.get(seer.id) ?? []).map((result) => result.targetId),
  );
  const uninspected = targets.filter((target) => !inspectedIds.has(target.id));
  const candidates = uninspected.length ? uninspected : targets;
  return candidates.length ? randomItem(candidates) : undefined;
}

export function roleClaimLine(
  speaker: Player,
  claimedRole: "占い師" | "霊能者",
  target: Player,
  result: PublicResult,
  resultDay?: number,
): string {
  const icon = claimedRole === "占い師" ? "🔮" : "👻";
  const dayLabel = resultDay ? `**${resultDay}日目**｜` : "";
  return `**${safeName(speaker)}**（${speaker.isNpc ? "NPC" : "プレイヤー"}）　${icon} ${claimedRole}CO：${dayLabel}**${safeName(target)}** は **${result}**`;
}

function roleRetractionLine(speaker: Player, claimedRole: ClaimedRole): string {
  return `**${safeName(speaker)}**（${speaker.isNpc ? "NPC" : "プレイヤー"}）　↩️ ${claimedRole}COを取り消しました。これまでの判定は無効です。`;
}

export function roleDeclarationLine(
  speaker: Player,
  claimedRole: "騎士",
): string {
  return `**${safeName(speaker)}**（${speaker.isNpc ? "NPC" : "プレイヤー"}）　🛡️ ${claimedRole}CO`;
}

function publicPlayerLabel(player: Player): string {
  return `**${safeName(player)}**（${player.isNpc ? "NPC" : "プレイヤー"}）`;
}

function chunkedClaimFields(name: string, lines: string[]) {
  if (lines.length === 0) return [{ name, value: "—" }];
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 900 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((value, index) => ({
    name: index === 0 ? name : `${name}（続き）`,
    value,
  }));
}

function resultClaimRows(
  game: GameState,
  claimedRole: "占い師" | "霊能者",
): string[] {
  const claims = game.npcClaims
    .filter((claim) => claim.claimedRole === claimedRole)
    .slice(-30);
  const bySpeaker = new Map<string, typeof claims>();
  for (const claim of claims) {
    const entries = bySpeaker.get(claim.speakerId) ?? [];
    entries.push(claim);
    bySpeaker.set(claim.speakerId, entries);
  }
  return [...bySpeaker.entries()].flatMap(([speakerId, entries]) => {
    const speaker = game.players.find((player) => player.id === speakerId);
    if (!speaker) return [];
    const results = entries.flatMap((claim, index) => {
      const target = game.players.find(
        (player) => player.id === claim.targetId,
      );
      if (!target) return [];
      const resultDay = claim.resultDay ?? index + 1;
      return `${resultDay}日目 **${safeName(target)}** ${claim.result === "人狼" ? "●" : "○"}`;
    });
    return results.length
      ? [`${publicPlayerLabel(speaker)}　${results.join("｜")}`]
      : [];
  });
}

function guardClaimRows(game: GameState): string[] {
  return [...game.roleDeclarations].slice(-30).flatMap((declaration) => {
    const [dayText, speakerId, claimedRole] = declaration.split(":");
    if (claimedRole !== "騎士") return [];
    const speaker = game.players.find((player) => player.id === speakerId);
    return speaker ? [`${dayText}日目　${publicPlayerLabel(speaker)}`] : [];
  });
}

export function claimListEmbed(game: GameState): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`CO・判定一覧｜${game.day}日目`)
    .setDescription(
      "公開中のCOを整理しています。COした役職が本物とは限りません。取り消されたCOは表示されません。",
    )
    .addFields(
      ...chunkedClaimFields("🔮 占い師CO", resultClaimRows(game, "占い師")),
      ...chunkedClaimFields("👻 霊能者CO", resultClaimRows(game, "霊能者")),
      ...chunkedClaimFields("🛡️ 騎士CO", guardClaimRows(game)),
    )
    .setColor(COLORS.day)
    .setFooter({ text: "● 人狼判定　○ 人間判定（各欄は直近30件）" });
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
    `${ROLE_INFO.人狼.icon} 人狼 **${config.人狼}**　　${ROLE_INFO.狂人.icon} 狂人 **${config.狂人}**`,
    `${ROLE_INFO.占い師.icon} 占い師 **${config.占い師}**　　${ROLE_INFO.騎士.icon} 騎士 **${config.騎士}**`,
    `${ROLE_INFO.霊能者.icon} 霊能者 **${config.霊能者}**　　${ROLE_INFO.村人.icon} 村人 **${config.村人}**`,
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
    .setFooter({
      text: "自分以外へ投票。結果発表までは非公開で、締切前なら変更できます",
    });
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
        value: `プレイ人数：${game.targetPlayerCount}人\nNPC予定：${npcCount}人\n議論時間：${discussionSecondsForGame(game, game.targetPlayerCount, humanCount)}秒`,
      },
      {
        name: "配役",
        value: roleConfigRows(game),
      },
    );
  if (game.debugMode) {
    embed.addFields({
      name: "🛠️ デバッグモード",
      value: `有効｜戦績保存なし\nホスト役職：${game.debugHostRole ?? "自動抽選"}\n待ち時間短縮・ホスト専用スキップ`,
    });
  }
  embed
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
  const hostButtons = [
    new ButtonBuilder()
      .setCustomId(componentId("role-config", game))
      .setLabel("配役を設定")
      .setStyle(ButtonStyle.Secondary),
  ];
  if (game.hostId === DEBUG_USER_ID) {
    hostButtons.push(
      new ButtonBuilder()
        .setCustomId(componentId("debug-settings", game))
        .setLabel(game.debugMode ? "デバッグ ON" : "デバッグ")
        .setEmoji("🛠️")
        .setStyle(game.debugMode ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  hostButtons.push(
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
  const hostRow =
    new ActionRowBuilder<ButtonBuilder>().addComponents(hostButtons);

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
    pendingDmMessages: new Map(),
    day: 0,
    voteRound: 1,
    voteCandidateIds: [],
    votes: new Map(),
    voteHistory: [],
    nightChoices: new Map(),
    npcSuspicion: new Map(),
    npcMemory: new Map(),
    npcClaims: [],
    roleDeclarations: new Set(),
    humanSuspicions: new Map(),
    npcQuestionCounts: new Map(),
    seerResults: new Map(),
    executionHistory: [],
    timers: [],
    resolving: false,
    resolutionQueued: false,
    debugMode: false,
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
    if (game.phaseMessage && game.phaseMessage.id !== game.lobbyMessage?.id) {
      await game.phaseMessage.edit({ components: [] }).catch(() => undefined);
    }
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
        狂人: game.roleConfig.狂人,
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
  normalizeDebugHostRole(game);
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

type ConfigurableRole = "人狼" | "狂人" | "占い師" | "騎士" | "霊能者";

const CONFIGURABLE_ROLES: Array<{
  role: ConfigurableRole;
  action: "wolf" | "madman" | "seer" | "guard" | "medium";
}> = [
  { role: "人狼", action: "wolf" },
  { role: "狂人", action: "madman" },
  { role: "占い師", action: "seer" },
  { role: "騎士", action: "guard" },
  { role: "霊能者", action: "medium" },
];

function normalizeDebugHostRole(game: GameState): void {
  if (game.debugHostRole && game.roleConfig[game.debugHostRole] === 0)
    game.debugHostRole = undefined;
}

export function debugPanel(game: GameState) {
  const embed = new EmbedBuilder()
    .setTitle("デバッグ設定")
    .setDescription(
      "この試合だけ待ち時間を短くし、必要な場面は手動で進められます。操作中に急いで進みすぎない速さです。",
    )
    .addFields(
      {
        name: "状態",
        value: game.debugMode ? "ON" : "OFF",
        inline: true,
      },
      {
        name: "ホスト役職",
        value: game.debugHostRole ?? "自動抽選",
        inline: true,
      },
      {
        name: "有効になる機能",
        value: `議論${DEBUG_TIMINGS.discussion}秒／投票${DEBUG_TIMINGS.vote}秒／夜${DEBUG_TIMINGS.night}秒\n全員操作済みでも即終了しない\n手動で各フェーズをスキップ\n自分の役職を指定\n戦績には記録しない`,
      },
    )
    .setColor(game.debugMode ? COLORS.day : COLORS.lobby)
    .setFooter({ text: "ロビーにいる間だけ変更できます" });

  const toggleRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("debug-toggle", game))
      .setLabel(game.debugMode ? "デバッグをOFF" : "デバッグをON")
      .setStyle(game.debugMode ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  const components: PhaseRow[] = [toggleRow];
  if (game.debugMode) {
    const roleMenu = new StringSelectMenuBuilder()
      .setCustomId(componentId("debug-role", game))
      .setPlaceholder("ホストの役職を選ぶ")
      .addOptions(
        {
          label: "自動抽選",
          value: "random",
          description: "通常どおり配役から抽選する",
          default: game.debugHostRole === undefined,
        },
        ...ROLE_NAMES.filter((role) => game.roleConfig[role] > 0).map(
          (role) => ({
            label: role,
            value: role,
            emoji: ROLE_INFO[role].icon,
            description: `ホストを${role}に固定する`,
            default: game.debugHostRole === role,
          }),
        ),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(roleMenu),
    );
  }
  return { content: "", embeds: [embed], components };
}

async function handleDebugSettings(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (!canControlDebug(game, interaction.user.id)) {
    await interaction.reply({
      content: "デバッグ機能は開発者専用です。",
      ephemeral: true,
    });
    return;
  }
  if (game.phase !== "lobby") {
    await interaction.reply({
      content: "デバッグ設定はロビーで変更してください。",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ ...debugPanel(game), ephemeral: true });
}

async function handleDebugToggle(
  interaction: ButtonInteraction,
  game: GameState,
): Promise<void> {
  if (!canControlDebug(game, interaction.user.id) || game.phase !== "lobby") {
    await interaction.reply({
      content: "現在はデバッグ設定を変更できません。",
      ephemeral: true,
    });
    return;
  }
  game.debugMode = !game.debugMode;
  if (!game.debugMode) game.debugHostRole = undefined;
  await interaction.update(debugPanel(game));
  await updateLobby(game);
}

async function handleDebugRole(
  interaction: StringSelectMenuInteraction,
  game: GameState,
): Promise<void> {
  if (
    !canControlDebug(game, interaction.user.id) ||
    game.phase !== "lobby" ||
    !game.debugMode
  ) {
    await interaction.reply({
      content: "現在はデバッグ用の役職を変更できません。",
      ephemeral: true,
    });
    return;
  }
  const value = interaction.values[0];
  const role = ROLE_NAMES.find((candidate) => candidate === value);
  if (value !== "random" && (!role || game.roleConfig[role] === 0)) {
    await interaction.reply({
      content: "現在の配役にはその役職がありません。",
      ephemeral: true,
    });
    return;
  }
  game.debugHostRole = value === "random" ? undefined : role;
  await interaction.update(debugPanel(game));
  await updateLobby(game);
}

function canUseRoleCount(
  game: GameState,
  role: ConfigurableRole,
  count: number,
): boolean {
  try {
    buildCustomRoles(game.targetPlayerCount, {
      人狼: role === "人狼" ? count : game.roleConfig.人狼,
      狂人: role === "狂人" ? count : game.roleConfig.狂人,
      占い師: role === "占い師" ? count : game.roleConfig.占い師,
      騎士: role === "騎士" ? count : game.roleConfig.騎士,
      霊能者: role === "霊能者" ? count : game.roleConfig.霊能者,
    });
    return true;
  } catch {
    return false;
  }
}

export function roleConfigPanel(game: GameState) {
  const embed = new EmbedBuilder()
    .setTitle(`配役設定｜${game.targetPlayerCount}人`)
    .setDescription("ボタンで人数を調整します。変更はすぐ反映されます。")
    .addFields({ name: "現在の配役", value: roleConfigRows(game) })
    .setColor(COLORS.lobby)
    .setFooter({ text: "村人は残り人数から自動計算されます" });

  const roleRows = CONFIGURABLE_ROLES.map(({ role, action }) => {
    const current = game.roleConfig[role];
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(componentId(`role-decrease-${action}`, game))
        .setLabel("−")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!canUseRoleCount(game, role, current - 1)),
      new ButtonBuilder()
        .setCustomId(componentId(`role-current-${action}`, game))
        .setLabel(`${ROLE_INFO[role].icon} ${role} ${current}人`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(componentId(`role-increase-${action}`, game))
        .setLabel("＋")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canUseRoleCount(game, role, current + 1)),
    );
  });
  return { content: "", embeds: [embed], components: roleRows };
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

  await interaction.reply({ ...roleConfigPanel(game), ephemeral: true });
}

async function handleRoleConfigAdjust(
  interaction: ButtonInteraction,
  game: GameState,
  action: string,
): Promise<void> {
  if (interaction.user.id !== game.hostId || game.phase !== "lobby") {
    await interaction.reply({
      content: "現在は配役を変更できません。",
      ephemeral: true,
    });
    return;
  }

  const match =
    /^role-(decrease|increase)-(wolf|madman|seer|guard|medium)$/.exec(action);
  const configRole = CONFIGURABLE_ROLES.find(
    (item) => item.action === match?.[2],
  );
  if (!match || !configRole) {
    await interaction.reply({
      content: "その設定は変更できません。",
      ephemeral: true,
    });
    return;
  }

  const nextCount =
    game.roleConfig[configRole.role] + (match[1] === "increase" ? 1 : -1);
  try {
    const roles = buildCustomRoles(game.targetPlayerCount, {
      人狼: configRole.role === "人狼" ? nextCount : game.roleConfig.人狼,
      狂人: configRole.role === "狂人" ? nextCount : game.roleConfig.狂人,
      占い師: configRole.role === "占い師" ? nextCount : game.roleConfig.占い師,
      騎士: configRole.role === "騎士" ? nextCount : game.roleConfig.騎士,
      霊能者: configRole.role === "霊能者" ? nextCount : game.roleConfig.霊能者,
    });
    game.roleConfig = roleConfigFromRoles(roles);
    normalizeDebugHostRole(game);
  } catch (error) {
    await interaction.reply({
      content:
        error instanceof Error ? error.message : "配役を確認してください。",
      ephemeral: true,
    });
    return;
  }

  await interaction.update(roleConfigPanel(game));
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
    results.push({
      targetId: target.id,
      isWolf: publicResultForRole(target.role) === "人狼",
    });
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
  const embed = new EmbedBuilder()
    .setTitle(`ゲーム開始｜${game.players.length}人`)
    .setDescription("役職をDMに送信しました。\n確認したらゲーム開始です。")
    .addFields({ name: "配役", value: roleConfigRows(game) })
    .setColor(COLORS.lobby)
    .setFooter({ text: "まもなく最初の議論が始まります" });
  if (game.debugMode)
    embed.addFields({
      name: "🛠️ デバッグモード",
      value: `ホスト役職：${game.debugHostRole ?? "自動抽選"}\nこの試合は戦績に記録されません。`,
    });
  return embed;
}

export function forceAssignedRole(
  assignments: Map<string, RoleName>,
  hostId: string,
  preferredRole: RoleName | undefined,
): void {
  if (!preferredRole || assignments.get(hostId) === preferredRole) return;
  const swapEntry = [...assignments.entries()].find(
    ([playerId, role]) => playerId !== hostId && role === preferredRole,
  );
  const currentHostRole = assignments.get(hostId);
  if (!swapEntry || !currentHostRole) return;
  assignments.set(hostId, preferredRole);
  assignments.set(swapEntry[0], currentHostRole);
}

async function startGame(game: GameState): Promise<void> {
  const hasPreparedRoles = game.players.every((player) => player.role);
  if (!hasPreparedRoles) {
    const assignments = assignGameRoles(
      game.players,
      Math.random,
      configuredRoles(game),
    );
    if (game.debugMode)
      forceAssignedRole(assignments, game.hostId, game.debugHostRole);
    game.players.forEach((player) => {
      player.role = assignments.get(player.id);
      player.alive = true;
    });
    game.day = 1;
    game.seerResults.clear();
    game.roleDmSent.clear();
    game.voteHistory = [];
    game.npcClaims = [];
    game.roleDeclarations.clear();
    game.npcMemory.clear();
    game.npcQuestionCounts.clear();
    game.executionHistory = [];
    game.lastGuardedId = undefined;
    game.pendingDmMessages.clear();
    game.statsMatchId = randomUUID();
    game.statsRecorded = false;
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
  schedule(game, gameSeconds(game, START_HOLD_SECONDS) * 1000, () =>
    void startDay(game),
  );
}

function activeHumanPlayer(
  game: GameState,
  userId: string,
): Player | undefined {
  return game.players.find(
    (player) => player.id === userId && !player.isNpc && player.alive,
  );
}

function claimedRoleFromToken(token: string): "占い師" | "霊能者" | undefined {
  if (token === "seer") return "占い師";
  if (token === "medium") return "霊能者";
  return undefined;
}

function claimTargets(
  game: GameState,
  claimant: Player,
  claimedRole: "占い師" | "霊能者",
): Player[] {
  const publishedIds = new Set(
    playerResultClaims(game, claimant.id, claimedRole).map(
      (claim) => claim.targetId,
    ),
  );
  const candidates =
    claimedRole === "霊能者"
      ? game.executionHistory
      : game.players.filter((player) => player.id !== claimant.id);
  return candidates.filter((player) => !publishedIds.has(player.id));
}

type TrueResultClaim = { day: number; target: Player; result: PublicResult };

export function availableTrueSeerClaims(
  game: GameState,
  claimant: Player,
): TrueResultClaim[] {
  const lockedRole = claimedRoleForPlayer(game, claimant.id);
  if (
    claimant.role !== "占い師" ||
    (lockedRole !== undefined && lockedRole !== "占い師")
  )
    return [];

  const availableDays = new Set(
    availableClaimDays(game, claimant.id, "占い師"),
  );
  if (availableDays.size === 0) return [];
  const publishedIds = new Set(
    playerResultClaims(game, claimant.id, "占い師").map(
      (claim) => claim.targetId,
    ),
  );
  return (game.seerResults.get(claimant.id) ?? [])
    .map((result, index) => ({ ...result, day: index + 1 }))
    .filter(
      (result) =>
        availableDays.has(result.day) && !publishedIds.has(result.targetId),
    )
    .flatMap((result) => {
      const target = game.players.find(
        (player) => player.id === result.targetId,
      );
      return target
        ? [
            {
              day: result.day,
              target,
              result: result.isWolf ? ("人狼" as const) : ("人間" as const),
            },
          ]
        : [];
    });
}

export function availableTrueMediumClaims(
  game: GameState,
  claimant: Player,
): TrueResultClaim[] {
  const lockedRole = claimedRoleForPlayer(game, claimant.id);
  if (
    claimant.role !== "霊能者" ||
    (lockedRole !== undefined && lockedRole !== "霊能者")
  )
    return [];

  const availableDays = new Set(
    availableClaimDays(game, claimant.id, "霊能者"),
  );
  const publishedIds = new Set(
    playerResultClaims(game, claimant.id, "霊能者").map(
      (claim) => claim.targetId,
    ),
  );
  return game.executionHistory
    .map((target, index) => ({
      day: index + 1,
      target,
      result: publicResultForRole(target.role),
    }))
    .filter(
      ({ day, target }) =>
        availableDays.has(day) && !publishedIds.has(target.id),
    );
}

export function hasConflictingSeerClaim(
  game: GameState,
  playerId: string,
): boolean {
  const actualResults = game.seerResults.get(playerId) ?? [];
  return playerResultClaims(game, playerId, "占い師").some(
    (claim, index) => {
      const resultDay = claim.resultDay ?? index + 1;
      const actual = actualResults[resultDay - 1];
      if (!actual) return false;
      const actualResult: PublicResult = actual.isWolf ? "人狼" : "人間";
      return claim.targetId !== actual.targetId || claim.result !== actualResult;
    },
  );
}

function trueResultClaimSummary(
  results: TrueResultClaim[],
): string {
  return results
    .map(
      ({ day, target, result }) =>
        `${day}日目｜**${safeName(target)}** ${result === "人狼" ? "● 人狼" : "○ 人間"}`,
    )
    .join("\n");
}

function quickResultClaimButton(
  game: GameState,
  claimedRole: "占い師" | "霊能者",
) {
  const roleToken = claimedRole === "占い師" ? "seer" : "medium";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId(`claim-quick-${roleToken}`, game))
      .setLabel("この結果を公開")
      .setEmoji(claimedRole === "占い師" ? "🔮" : "👻")
      .setStyle(ButtonStyle.Primary),
  );
}

function quickGuardClaimButton(game: GameState) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("claim-quick-guard", game))
      .setLabel("騎士COする")
      .setEmoji("🛡️")
      .setStyle(ButtonStyle.Primary),
  );
}

function customClaimButton(game: GameState) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("claim-custom-open", game))
      .setLabel("別の内容でCO")
      .setEmoji("🎭")
      .setStyle(ButtonStyle.Secondary),
  );
}

function claimRetractionRow(game: GameState) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("claim-retract", game))
      .setLabel("COを取り消す")
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Danger),
  );
}

function claimRetractionConfirmRow(game: GameState) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("claim-retract-confirm", game))
      .setLabel("取り消す")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(componentId("claim-retract-cancel", game))
      .setLabel("やめる")
      .setStyle(ButtonStyle.Secondary),
  );
}

function resultDayLabel(claimedRole: "占い師" | "霊能者", day: number) {
  return claimedRole === "占い師"
    ? `${day}日目の占い結果`
    : `${day}日目の処刑結果`;
}

function claimRoleRow(game: GameState, lockedRole?: ClaimedRole) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("claim-role", game))
    .setPlaceholder(
      lockedRole ? `${lockedRole}COを続ける` : "COする役職を選ぶ",
    );
  const options = [
    {
      role: "占い師" as const,
      option: {
        label: "占い師CO",
        value: "seer",
        emoji: "🔮",
        description: "占い結果を公開する",
      },
    },
    {
      role: "霊能者" as const,
      option: {
        label: "霊能者CO",
        value: "medium",
        emoji: "👻",
        description: "前日に処刑された人の結果を公開する",
      },
    },
    {
      role: "騎士" as const,
      option: {
        label: "騎士CO",
        value: "guard",
        emoji: "🛡️",
        description: "騎士だと公開する",
      },
    },
  ];
  menu.addOptions(
    options
      .filter(({ role }) => !lockedRole || role === lockedRole)
      .map(({ option }) => option),
  );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function customClaimTargetPanel(
  game: GameState,
  claimant: Player,
  claimedRole: "占い師" | "霊能者",
) {
  const resultDay = availableClaimDays(game, claimant.id, claimedRole)[0];
  if (resultDay === undefined)
    return { content: "現在公開できる結果はありません。", components: [] };

  const targets = claimTargets(game, claimant, claimedRole);
  if (targets.length === 0)
    return { content: "公開できる対象がいません。", components: [] };

  const roleToken = claimedRole === "占い師" ? "seer" : "medium";
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      componentId(`claim-target-${roleToken}-${resultDay}`, game),
    )
    .setPlaceholder("判定する相手を選ぶ")
    .addOptions(playerOptions(targets));
  return {
    content: `**${claimedRole}CO｜${resultDayLabel(claimedRole, resultDay)}**\n判定する相手を選んでください。`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  };
}

function claimListButton(game: GameState): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(componentId("claim-list", game))
    .setLabel("CO・判定一覧")
    .setEmoji("📋")
    .setStyle(ButtonStyle.Secondary);
}

function debugNextRow(game: GameState, label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId("debug-next", game))
      .setLabel(label)
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function handleClaimListButton(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const isParticipant = game.players.some(
    (player) => player.id === interaction.user.id && !player.isNpc,
  );
  if (
    (game.phase !== "day" && game.phase !== "voting") ||
    day !== game.day ||
    !isParticipant
  ) {
    await interaction.reply({
      content: "現在はCO・判定一覧を確認できません。",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    embeds: [claimListEmbed(game)],
    ephemeral: true,
  });
}

export function claimPanel(game: GameState, claimant: Player): PhasePayload {
  const lockedRole = claimedRoleForPlayer(game, claimant.id);
  const seerResults = availableTrueSeerClaims(game, claimant);
  const mediumResults = availableTrueMediumClaims(game, claimant);
  const canQuickGuard = claimant.role === "騎士" && lockedRole === undefined;
  const canChooseDetails =
    !lockedRole ||
    (lockedRole !== "騎士" &&
      remainingClaimSlots(game, claimant.id, lockedRole) > 0);
  const components: PhaseRow[] = [];
  const hasQuickResult = seerResults.length > 0 || mediumResults.length > 0;
  const hasQuickClaim = hasQuickResult || canQuickGuard;

  if (seerResults.length > 0)
    components.push(quickResultClaimButton(game, "占い師"));
  if (mediumResults.length > 0)
    components.push(quickResultClaimButton(game, "霊能者"));
  if (canQuickGuard) components.push(quickGuardClaimButton(game));
  if (canChooseDetails) {
    if (hasQuickClaim) components.push(customClaimButton(game));
    else if (!lockedRole) components.push(claimRoleRow(game));
    else
      components.push(
        ...customClaimTargetPanel(game, claimant, lockedRole).components,
      );
  }
  if (lockedRole) components.push(claimRetractionRow(game));

  const lines: string[] = [];
  const trueResults = seerResults.length > 0 ? seerResults : mediumResults;
  if (trueResults.length > 0) {
    lines.push(
      `**公開する${seerResults.length > 0 ? "占い" : "霊能"}結果**`,
      trueResultClaimSummary(trueResults),
    );
  } else if (canQuickGuard) {
    lines.push("**騎士COしますか？**");
  } else if (!lockedRole) {
    lines.push("**COする役職を選んでください。**");
  } else if (canChooseDetails) {
    lines.push(
      `**${lockedRole}CO｜次の結果**`,
      "判定する相手を選んでください。",
    );
  } else {
    lines.push(`**${lockedRole}CO済み**`, "現在公開できる結果はありません。");
  }
  if (hasConflictingSeerClaim(game, claimant.id))
    lines.push(
      "\n⚠️ 本当の占い結果へ戻すには、現在のCOを取り消してください。",
    );

  return { content: lines.join("\n"), embeds: [], components };
}

async function handleClaimButton(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "day" || day !== game.day || !claimant) {
    await interaction.reply({
      content: "現在は役職COできません。",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ ...claimPanel(game, claimant), ephemeral: true });
}

async function handleQuickResultClaim(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
  claimedRole: "占い師" | "霊能者",
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "day" || day !== game.day || !claimant) {
    await interaction.reply({
      content: "現在は結果を公開できません。",
      ephemeral: true,
    });
    return;
  }

  const quickResults =
    claimedRole === "占い師"
      ? availableTrueSeerClaims(game, claimant)
      : availableTrueMediumClaims(game, claimant);
  if (quickResults.length === 0) {
    await interaction.update({
      content: "そのまま公開できる本当の結果はありません。",
      components: [],
    });
    return;
  }

  const publishedLines: string[] = [];
  for (const { day: resultDay, target, result } of quickResults) {
    if (
      !recordRoleClaim(
        game,
        claimant,
        claimedRole,
        target,
        result,
        resultDay,
      )
    )
      continue;
    if (claimedRole === "占い師")
      applyPublicClaimSuspicion(game, target, result);
    publishedLines.push(
      roleClaimLine(claimant, claimedRole, target, result, resultDay),
    );
  }
  if (publishedLines.length === 0) {
    await interaction.update({
      content: "その占い結果はすでに公開済みです。",
      components: [],
    });
    return;
  }

  await interaction.update({
    content:
      publishedLines.length > 1
        ? `実際の${claimedRole === "占い師" ? "占い" : "霊能"}結果を${publishedLines.length}件まとめて公開しました。`
        : `実際の${claimedRole === "占い師" ? "占い" : "霊能"}結果をそのまま公開しました。`,
    components: [],
  });
  await game.channel.send(publishedLines.join("\n"));
}

async function handleQuickGuardClaim(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  if (
    game.phase !== "day" ||
    day !== game.day ||
    !claimant ||
    claimant.role !== "騎士" ||
    claimedRoleForPlayer(game, claimant.id) !== undefined
  ) {
    await interaction.reply({
      content: "現在は騎士COを公開できません。",
      ephemeral: true,
    });
    return;
  }
  game.roleDeclarations.add(`${game.day}:${claimant.id}:騎士`);
  await interaction.update({ content: "騎士COを公開しました。", components: [] });
  await game.channel.send(roleDeclarationLine(claimant, "騎士"));
}

async function handleCustomClaimOpen(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  const lockedRole = claimant
    ? claimedRoleForPlayer(game, claimant.id)
    : undefined;
  const canChooseDetails =
    !lockedRole ||
    (lockedRole !== "騎士" &&
      claimant !== undefined &&
      remainingClaimSlots(game, claimant.id, lockedRole) > 0);
  if (
    game.phase !== "day" ||
    day !== game.day ||
    !claimant ||
    !canChooseDetails
  ) {
    await interaction.reply({
      content: "現在はCO内容を設定できません。",
      ephemeral: true,
    });
    return;
  }
  if (lockedRole) {
    await interaction.update(customClaimTargetPanel(game, claimant, lockedRole));
    return;
  }
  await interaction.update({
    content: "**別の内容でCO**\n名乗る役職を選んでください。",
    components: [claimRoleRow(game)],
  });
}

export function retractPlayerClaim(
  game: GameState,
  playerId: string,
): ClaimedRole | undefined {
  const claimedRole = claimedRoleForPlayer(game, playerId);
  if (!claimedRole) return undefined;

  game.npcClaims = game.npcClaims.filter(
    (claim) => claim.speakerId !== playerId,
  );
  for (const declaration of [...game.roleDeclarations]) {
    if (declaration.split(":")[1] === playerId)
      game.roleDeclarations.delete(declaration);
  }

  game.npcSuspicion.clear();
  for (const claim of game.npcClaims.filter(
    (candidate) => candidate.day === game.day,
  )) {
    const target = game.players.find(
      (player) => player.id === claim.targetId,
    );
    if (target) applyPublicClaimSuspicion(game, target, claim.result);
  }
  return claimedRole;
}

async function handleClaimRetractionPrompt(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  const claimedRole = claimant
    ? claimedRoleForPlayer(game, claimant.id)
    : undefined;
  if (game.phase !== "day" || day !== game.day || !claimant || !claimedRole) {
    await interaction.reply({
      content: "現在取り消せるCOはありません。",
      ephemeral: true,
    });
    return;
  }
  await interaction.update({
    content: `**${claimedRole}COを取り消しますか？**\n公開済みの判定もすべて無効になります。取り消したことは全員に通知されます。`,
    components: [claimRetractionConfirmRow(game)],
  });
}

async function handleClaimRetractionConfirm(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "day" || day !== game.day || !claimant) {
    await interaction.reply({
      content: "現在COを取り消せません。",
      ephemeral: true,
    });
    return;
  }
  const claimedRole = retractPlayerClaim(game, claimant.id);
  if (!claimedRole) {
    await interaction.update({
      content: "取り消せるCOはありません。",
      components: [],
    });
    return;
  }
  await interaction.update({
    content: `${claimedRole}COを取り消しました。もう一度COし直せます。`,
    components: [],
  });
  await game.channel.send(roleRetractionLine(claimant, claimedRole));
}

async function handleClaimRetractionCancel(
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.update({
    content: "COの取り消しをやめました。",
    components: [],
  });
}

async function handleClaimRole(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  const roleToken = interaction.values[0];
  const requestedRole: ClaimedRole | undefined =
    roleToken === "guard" ? "騎士" : claimedRoleFromToken(roleToken);
  if (game.phase !== "day" || day !== game.day || !claimant || !requestedRole) {
    await interaction.reply({
      content: "現在は役職COできません。",
      ephemeral: true,
    });
    return;
  }
  const lockedRole = claimedRoleForPlayer(game, claimant.id);
  if (lockedRole && lockedRole !== requestedRole) {
    await interaction.update({
      content: `この試合ではすでに${lockedRole}COをしています。役職は変更できません。`,
      components: [],
    });
    return;
  }
  if (requestedRole === "騎士") {
    if (lockedRole === "騎士") {
      await interaction.update({
        content: "騎士COはすでに公開しています。",
        components: [],
      });
      return;
    }
    const declarationKey = `${game.day}:${claimant.id}:騎士`;
    game.roleDeclarations.add(declarationKey);
    await interaction.update({ content: "COを公開しました。", components: [] });
    await game.channel.send(roleDeclarationLine(claimant, "騎士"));
    return;
  }
  const claimedRole = requestedRole;

  if (remainingClaimSlots(game, claimant.id, claimedRole) === 0) {
    await interaction.update({
      content: "現在公開できるCO結果はすべて公開済みです。",
      components: [],
    });
    return;
  }
  await interaction.update(customClaimTargetPanel(game, claimant, claimedRole));
}

function parseClaimResultAction(
  action: string,
  step: "target" | "result",
):
  | { roleToken: string; claimedRole: "占い師" | "霊能者"; resultDay: number }
  | undefined {
  const match = new RegExp(`^claim-${step}-(seer|medium)-(\\d+)$`).exec(
    action,
  );
  if (!match) return undefined;
  const claimedRole = claimedRoleFromToken(match[1]);
  const resultDay = Number(match[2]);
  return claimedRole && Number.isInteger(resultDay)
    ? { roleToken: match[1], claimedRole, resultDay }
    : undefined;
}

async function handleClaimTarget(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
  action: string,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  const request = parseClaimResultAction(action, "target");
  const roleToken = request?.roleToken;
  const claimedRole = request?.claimedRole;
  const resultDay = request?.resultDay;
  const target = game.players.find(
    (player) => player.id === interaction.values[0],
  );
  if (
    game.phase !== "day" ||
    day !== game.day ||
    !claimant ||
    !request ||
    !claimedRole ||
    resultDay === undefined ||
    !target ||
    (claimedRoleForPlayer(game, claimant.id) !== undefined &&
      claimedRoleForPlayer(game, claimant.id) !== claimedRole) ||
    !availableClaimDays(game, claimant.id, claimedRole).includes(resultDay) ||
    !claimTargets(game, claimant, claimedRole).some(
      (candidate) => candidate.id === target.id,
    )
  ) {
    await interaction.reply({
      content: "そのCOは公開できません。",
      ephemeral: true,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      componentId(`claim-result-${roleToken}-${resultDay}`, game),
    )
    .setPlaceholder(`${safeName(target)}への判定を選ぶ`)
    .addOptions(
      { label: "人狼判定", value: `${target.id}|人狼`, emoji: "🐺" },
      { label: "人間判定", value: `${target.id}|人間`, emoji: "🟢" },
    );
  await interaction.update({
    content: `**${resultDayLabel(claimedRole, resultDay)}**｜**${safeName(target)}** への判定を選んでください。`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  });
}

async function handleClaimResult(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
  action: string,
): Promise<void> {
  const claimant = activeHumanPlayer(game, interaction.user.id);
  const request = parseClaimResultAction(action, "result");
  const claimedRole = request?.claimedRole;
  const resultDay = request?.resultDay;
  const [targetId, resultText] = interaction.values[0].split("|");
  const target = game.players.find((player) => player.id === targetId);
  const result =
    resultText === "人狼" || resultText === "人間" ? resultText : undefined;
  if (
    game.phase !== "day" ||
    day !== game.day ||
    !claimant ||
    !request ||
    !claimedRole ||
    resultDay === undefined ||
    !target ||
    !result ||
    (claimedRoleForPlayer(game, claimant.id) !== undefined &&
      claimedRoleForPlayer(game, claimant.id) !== claimedRole) ||
    !availableClaimDays(game, claimant.id, claimedRole).includes(resultDay) ||
    !claimTargets(game, claimant, claimedRole).some(
      (candidate) => candidate.id === target.id,
    )
  ) {
    await interaction.reply({
      content: "そのCOは公開できません。",
      ephemeral: true,
    });
    return;
  }

  if (
    !recordRoleClaim(
      game,
      claimant,
      claimedRole,
      target,
      result,
      resultDay,
    )
  ) {
    await interaction.update({
      content: "同じ相手へのCOはすでに公開済みです。",
      components: [],
    });
    return;
  }
  if (claimedRole === "占い師") {
    applyPublicClaimSuspicion(game, target, result);
  }
  const remaining = remainingClaimSlots(game, claimant.id, claimedRole);
  await interaction.update({
    content:
      remaining > 0
        ? `COを公開しました。あと${remaining}件公開できます。`
        : "COを公開しました。",
    components: [],
  });
  await game.channel.send(
    roleClaimLine(claimant, claimedRole, target, result, resultDay),
  );
}

async function startDay(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.phase = "day";
  game.votes.clear();
  game.nightChoices.clear();
  game.npcSuspicion.clear();
  decayNpcMemory(game);
  game.humanSuspicions.clear();
  game.npcQuestionCounts.clear();
  game.resolving = false;
  game.resolutionQueued = false;
  game.phaseStartedAt = Date.now();
  await flushPendingDmMessages(game);

  const living = alivePlayers(game);
  const livingHumanPlayers = aliveHumans(game);
  const daySeconds = discussionSecondsForGame(
    game,
    living.length,
    livingHumanPlayers.length,
  );
  game.phaseEndsAt = Date.now() + daySeconds * 1000;
  const hasNpc = living.some((player) => player.isNpc);
  const dayComponents: PhaseRow[] = [];
  if (livingHumanPlayers.length > 0 && hasNpc && living.length > 1) {
    dayComponents.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId("suspect-open", game))
          .setLabel("意見を表明")
          .setEmoji("💬")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId("npc-question-open", game))
          .setLabel("NPCに聞く")
          .setEmoji("❓")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (livingHumanPlayers.length > 0) {
    dayComponents.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId("claim", game))
          .setLabel("COする")
          .setEmoji("📣")
          .setStyle(ButtonStyle.Secondary),
        claimListButton(game),
      ),
    );
  }
  if (game.debugMode) dayComponents.push(debugNextRow(game, "投票へ進む"));
  const payload = {
    content: "",
    embeds: [dayEmbed(game)],
    components: dayComponents,
  };
  await openPhasePanel(game, payload);

  scheduleNpcDiscussion(game, daySeconds);
  schedule(game, daySeconds * 1000, () => void startVoting(game));
}

function scheduleNpcDiscussion(game: GameState, daySeconds: number): void {
  const maxSpeakers = aliveHumans(game).length >= 2 ? 1 : 3;
  const speakingNpcs = npcDiscussionSpeakers(game, maxSpeakers);
  speakingNpcs.forEach((npc, index) => {
    const availableMs = Math.max(2000, daySeconds * 1000 - 2000);
    const delayMs = Math.min(4000 + index * 7000, availableMs);
    schedule(game, delayMs, () => {
      if (game.phase !== "day" || !npc.alive) return;
      const targets = alivePlayers(game).filter(
        (player) => player.id !== npc.id,
      );
      if (!targets.length) return;

      const previouslyClaimedTargetIds = new Set(
        game.npcClaims
          .filter(
            (claim) =>
              claim.speakerId === npc.id && claim.claimedRole === "占い師",
          )
          .map((claim) => claim.targetId),
      );
      const availableSeerDays = new Set(
        availableClaimDays(game, npc.id, "占い師"),
      );
      const knownResults = (game.seerResults.get(npc.id) ?? [])
        .map((result, resultIndex) => ({
          ...result,
          resultDay: resultIndex + 1,
        }))
        .reverse();
      const knownResult = knownResults.find(
        (result) =>
          availableSeerDays.has(result.resultDay) &&
          !previouslyClaimedTargetIds.has(result.targetId),
      );
      if (npc.role === "占い師" && knownResult) {
        const target = game.players.find(
          (candidate) => candidate.id === knownResult.targetId,
        );
        if (!target) return;
        const resultText: PublicResult = knownResult.isWolf ? "人狼" : "人間";
        if (
          !recordRoleClaim(
            game,
            npc,
            "占い師",
            target,
            resultText,
            knownResult.resultDay,
          )
        )
          return;
        rememberSuspect(game, npc.id, target.id, knownResult.isWolf ? 6 : -3);
        applyPublicClaimSuspicion(game, target, resultText);
        void game.channel.send(
          roleClaimLine(
            npc,
            "占い師",
            target,
            resultText,
            knownResult.resultDay,
          ),
        );
        return;
      }

      if (npc.role === "霊能者" && game.lastExecuted) {
        const resultText = publicResultForRole(game.lastExecuted.role);
        const resultDay = game.executionHistory.length;
        if (
          !recordRoleClaim(
            game,
            npc,
            "霊能者",
            game.lastExecuted,
            resultText,
            resultDay,
          )
        )
          return;
        void game.channel.send(
          roleClaimLine(
            npc,
            "霊能者",
            game.lastExecuted,
            resultText,
            resultDay,
          ),
        );
        return;
      }

      const isContinuingSeerClaim = hasNpcClaimedRole(game, npc.id, "占い師");
      if (
        (npc.role === "人狼" || npc.role === "狂人") &&
        availableClaimDays(game, npc.id, "占い師").length > 0 &&
        (isContinuingSeerClaim ||
          Math.random() <
            (npc.role === "狂人"
              ? MADMAN_FAKE_CLAIM_CHANCE
              : game.roleConfig.人狼 === 1
                ? LONE_WOLF_FAKE_CLAIM_CHANCE
                : WOLF_FAKE_CLAIM_CHANCE))
      ) {
        const availableFakeTargets =
          npc.role === "人狼"
            ? targets.filter((target) => target.role !== "人狼")
            : targets;
        const claimedTargetIds = new Set(
          game.npcClaims
            .filter(
              (claim) =>
                claim.speakerId === npc.id && claim.claimedRole === "占い師",
            )
            .map((claim) => claim.targetId),
        );
        const unclaimedFakeTargets = availableFakeTargets.filter(
          (target) => !claimedTargetIds.has(target.id),
        );
        const fakeTargets = unclaimedFakeTargets.length
          ? unclaimedFakeTargets
          : availableFakeTargets.length
            ? availableFakeTargets
            : targets;
        const target = randomItem(fakeTargets);
        const earlierResult = game.npcClaims.find(
          (claim) =>
            claim.speakerId === npc.id &&
            claim.claimedRole === "占い師" &&
            claim.targetId === target.id,
        )?.result;
        const fakeResult: PublicResult =
          earlierResult ??
          (npc.role === "狂人" && Math.random() < MADMAN_WHITE_CLAIM_CHANCE
            ? "人間"
            : "人狼");
        const resultDay = availableClaimDays(
          game,
          npc.id,
          "占い師",
        )[0];
        if (
          !recordRoleClaim(
            game,
            npc,
            "占い師",
            target,
            fakeResult,
            resultDay,
          )
        )
          return;
        rememberSuspect(
          game,
          npc.id,
          target.id,
          fakeResult === "人狼" ? 2 : -1,
        );
        applyPublicClaimSuspicion(game, target, fakeResult);
        void game.channel.send(
          roleClaimLine(npc, "占い師", target, fakeResult, resultDay),
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

      const suspicion = npcDecisionSuspicion(game, npc);
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
      const suspicion = npcDecisionSuspicion(game, npc);
      const targetId = chooseNpcVoteTarget(npc, targets, suspicion);
      game.votes.set(npc.id, targetId);
      void updateVoteProgress(game);
      if (game.votes.size >= alivePlayers(game).length)
        queueVoteResolutionAfterMinimum(game);
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

async function handleDebugNext(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  if (
    !canControlDebug(game, interaction.user.id) ||
    !game.debugMode ||
    game.day !== day ||
    game.resolving ||
    (game.phase !== "day" &&
      game.phase !== "voting" &&
      game.phase !== "night")
  ) {
    await interaction.reply({
      content: "現在はデバッグ進行できません。",
      ephemeral: true,
    });
    return;
  }

  const phase = game.phase;
  await interaction.reply({
    content:
      phase === "day"
        ? "議論を終了して投票へ進みます。"
        : phase === "voting"
          ? "投票を締め切ります。"
          : "未選択の夜行動を自動決定して朝へ進みます。",
    ephemeral: true,
  });
  if (phase === "day") await startVoting(game);
  else if (phase === "voting") await queueVoteResolution(game, true);
  else await queueNightResolution(game, true);
}

async function beginVoting(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.resolving = false;
  game.resolutionQueued = false;
  game.votes.clear();
  game.phaseStartedAt = Date.now();
  const voteSeconds = gameSeconds(game, VOTE_SECONDS, DEBUG_TIMINGS.vote);
  game.phaseEndsAt = Date.now() + voteSeconds * 1000;
  const candidates = alivePlayers(game).filter((player) =>
    game.voteCandidateIds.includes(player.id),
  );

  const payload = {
    content: "",
    embeds: [voteEmbed(game)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId("vote-open", game))
          .setLabel(game.voteRound > 1 ? "再投票する" : "投票する")
          .setEmoji("🗳️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(candidates.length < 2),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        claimListButton(game),
      ),
      ...(game.debugMode ? [debugNextRow(game, "投票を締め切る")] : []),
    ],
  };
  await openPhasePanel(game, payload);

  scheduleNpcVotes(game);
  schedule(game, voteSeconds * 1000, () => void queueVoteResolution(game));
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function resolveWolfTarget(
  wolves: Player[],
  choices: ReadonlyMap<string, string>,
  fallback: Player[],
): string | undefined {
  const humanTargets = wolves
    .filter((wolf) => !wolf.isNpc)
    .map((wolf) => choices.get(nightActionKey("kill", wolf.id)))
    .filter((target): target is string => Boolean(target));
  const allTargets = wolves
    .map((wolf) => choices.get(nightActionKey("kill", wolf.id)))
    .filter((target): target is string => Boolean(target));
  const targets = humanTargets.length ? humanTargets : allTargets;
  if (targets.length === 0)
    return fallback.length ? randomItem(fallback).id : undefined;
  const leaders = topVotedIds(targets);
  return leaders.length === 1 ? leaders[0] : undefined;
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
        if (targetId !== npc.id) rememberSuspect(game, npc.id, targetId, 0.4);
      }
    }
  }
}

export function humanOpinionLine(
  actor: Player,
  target: Player,
  reason: HumanArgumentReason,
  previous?: { target: Player; argument: HumanArgument },
): string {
  const speaker = `**${safeName(actor)}**（プレイヤー）　👀`;
  const statement = previous
    ? `${speaker} 意見変更：**${safeName(previous.target)}** → **${safeName(target)}**`
    : `${speaker} **${safeName(target)}**を疑う`;
  return `${statement}\n根拠：${HUMAN_ARGUMENT_INFO[reason].publicText}`;
}

export function remainingNpcQuestions(
  game: GameState,
  playerId: string,
): number {
  return Math.max(
    0,
    NPC_QUESTIONS_PER_DAY - (game.npcQuestionCounts.get(playerId) ?? 0),
  );
}

export function npcQuestionLine(
  actor: Player,
  npc: Player,
  target: Player | undefined,
  reason: string,
): string {
  const answer = target
    ? `今は **${safeName(target)}** が気になる。${reason}。`
    : `今は特に疑っている人はいない。${reason}。`;
  return `**${safeName(actor)}**（プレイヤー）　❓ **${safeName(npc)}**に質問\n**${safeName(npc)}**（NPC）　💬 ${answer}`;
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

async function handleSuspectOpen(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const actor = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "day" || game.day !== day || !actor) {
    await interaction.reply({
      content: "現在は意見を表明できません。",
      ephemeral: true,
    });
    return;
  }
  const targets = alivePlayers(game).filter((player) => player.id !== actor.id);
  if (targets.length === 0) {
    await interaction.reply({
      content: "指定できる相手がいません。",
      ephemeral: true,
    });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("suspect", game))
    .setPlaceholder("いま疑っている人を選ぶ")
    .addOptions(playerOptions(targets));
  await interaction.reply({
    content:
      "疑う相手を選んでください。次に根拠を選びます。意見はあとから変更できます。",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    ephemeral: true,
  });
}

async function handleVoteOpen(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const voter = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "voting" || game.resolving || game.day !== day || !voter) {
    await interaction.reply({
      content: "現在は投票できません。",
      ephemeral: true,
    });
    return;
  }
  const targets = alivePlayers(game).filter(
    (player) =>
      player.id !== voter.id && game.voteCandidateIds.includes(player.id),
  );
  if (targets.length === 0) {
    await interaction.reply({
      content: "投票できる相手がいません。",
      ephemeral: true,
    });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("vote", game))
    .setPlaceholder(
      game.voteRound > 1
        ? "再投票する人を選んでください"
        : "処刑したい人を選んでください",
    )
    .addOptions(playerOptions(targets));
  await interaction.reply({
    content: game.votes.has(voter.id)
      ? "投票先を変更できます。"
      : "投票先を選んでください。",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    ephemeral: true,
  });
}

async function handleNpcQuestionOpen(
  interaction: ButtonInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const actor = activeHumanPlayer(game, interaction.user.id);
  if (game.phase !== "day" || game.day !== day || !actor) {
    await interaction.reply({
      content: "現在はNPCに質問できません。",
      ephemeral: true,
    });
    return;
  }

  const remaining = remainingNpcQuestions(game, actor.id);
  if (remaining === 0) {
    await interaction.reply({
      content: "今日の質問は2回とも使いました。",
      ephemeral: true,
    });
    return;
  }

  const npcs = alivePlayers(game).filter((player) => player.isNpc);
  if (npcs.length === 0) {
    await interaction.reply({
      content: "質問できるNPCがいません。",
      ephemeral: true,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("npc-question", game))
    .setPlaceholder("話を聞きたいNPCを選ぶ")
    .addOptions(playerOptions(npcs));
  await interaction.reply({
    content: `回答は全員に公開されます。今日はあと${remaining}回質問できます。`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    ephemeral: true,
  });
}

async function handleNpcQuestion(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const actor = activeHumanPlayer(game, interaction.user.id);
  const npc = game.players.find(
    (player) =>
      player.id === interaction.values[0] && player.alive && player.isNpc,
  );
  if (game.phase !== "day" || game.day !== day || !actor || !npc) {
    await interaction.reply({
      content: "現在はNPCに質問できません。",
      ephemeral: true,
    });
    return;
  }

  if (remainingNpcQuestions(game, actor.id) === 0) {
    await interaction.reply({
      content: "今日の質問は2回とも使いました。",
      ephemeral: true,
    });
    return;
  }

  const answer = chooseNpcQuestionAnswer(game, npc);
  const target = answer?.targetId
    ? game.players.find((player) => player.id === answer.targetId)
    : undefined;
  if (!answer || (answer.targetId && !target)) {
    await interaction.reply({
      content: "いま聞ける意見がありません。",
      ephemeral: true,
    });
    return;
  }

  game.npcQuestionCounts.set(
    actor.id,
    (game.npcQuestionCounts.get(actor.id) ?? 0) + 1,
  );
  const remaining = remainingNpcQuestions(game, actor.id);
  await interaction.reply({
    content:
      remaining > 0
        ? `回答を公開しました。今日はあと${remaining}回質問できます。`
        : "回答を公開しました。今日の質問はこれで終了です。",
    ephemeral: true,
  });
  await game.channel.send(npcQuestionLine(actor, npc, target, answer.reason));
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
      content: "現在は意見を表明できません。",
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

  const menu = new StringSelectMenuBuilder()
    .setCustomId(componentId("suspect-reason", game))
    .setPlaceholder("疑う根拠を選ぶ")
    .addOptions(
      HUMAN_ARGUMENT_REASONS.map((reason) => ({
        label: HUMAN_ARGUMENT_INFO[reason].label,
        description: HUMAN_ARGUMENT_INFO[reason].description,
        emoji: HUMAN_ARGUMENT_INFO[reason].emoji,
        value: `${target.id}|${reason}`,
      })),
    );
  await interaction.update({
    content: `**${safeName(target)}** を疑う根拠を選んでください。\n公開情報に合わない根拠は、NPCから逆に疑われることがあります。`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  });
}

async function handleSuspectReason(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const actor = activeHumanPlayer(game, interaction.user.id);
  const [targetId, reasonText] = interaction.values[0].split("|");
  const reason = HUMAN_ARGUMENT_REASONS.find(
    (candidate) => candidate === reasonText,
  );
  const target = game.players.find(
    (player) => player.id === targetId && player.alive,
  );
  if (
    game.phase !== "day" ||
    game.day !== day ||
    !actor ||
    !target ||
    actor.id === target.id ||
    !reason
  ) {
    await interaction.reply({
      content: "現在はその意見を表明できません。",
      ephemeral: true,
    });
    return;
  }

  const previousArgument = game.humanSuspicions.get(actor.id);
  if (
    previousArgument?.targetId === target.id &&
    previousArgument.reason === reason
  ) {
    await interaction.update({
      content: `その意見はすでに公開しています。`,
      components: [],
    });
    return;
  }
  const previousTarget = game.players.find(
    (player) => player.id === previousArgument?.targetId,
  );
  const argument: HumanArgument = { targetId: target.id, reason };
  game.humanSuspicions.set(actor.id, argument);
  await interaction.update({
    content: "意見を公開しました。全員とNPCに見えています。",
    components: [],
  });
  await game.channel.send(
    humanOpinionLine(
      actor,
      target,
      reason,
      previousTarget && previousArgument
        ? { target: previousTarget, argument: previousArgument }
        : undefined,
    ),
  );
}

async function handleVote(
  interaction: StringSelectMenuInteraction,
  game: GameState,
  day: number,
): Promise<void> {
  const voter = game.players.find(
    (player) => player.id === interaction.user.id,
  );
  if (
    game.phase !== "voting" ||
    game.resolving ||
    game.day !== day ||
    !voter?.alive
  ) {
    await interaction.reply({
      content: "現在は投票できません。",
      ephemeral: true,
    });
    return;
  }

  const targetId = interaction.values[0];
  if (targetId === voter.id) {
    await interaction.reply({
      content: "自分自身には投票できません。",
      ephemeral: true,
    });
    return;
  }
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
    queueVoteResolutionAfterMinimum(game);
}

function queueVoteResolutionAfterMinimum(game: GameState): void {
  if (game.resolving || game.resolutionQueued) return;
  if (game.debugMode) return;
  const delayMs = remainingPhaseMinimumMs(
    game.phaseStartedAt,
    VOTE_MIN_SECONDS,
  );
  if (delayMs > 0) {
    game.resolutionQueued = true;
    schedule(game, delayMs, () => {
      game.resolutionQueued = false;
      void queueVoteResolution(game);
    });
    return;
  }
  void queueVoteResolution(game);
}

async function queueVoteResolution(
  game: GameState,
  skipMinimum = false,
): Promise<void> {
  if (game.phase !== "voting" || game.resolving) return;
  if (!skipMinimum) {
    const delayMs = remainingPhaseMinimumMs(
      game.phaseStartedAt,
      VOTE_MIN_SECONDS,
    );
    if (delayMs > 0) {
      if (game.resolutionQueued) return;
      game.resolutionQueued = true;
      schedule(game, delayMs, () => {
        game.resolutionQueued = false;
        void queueVoteResolution(game);
      });
      return;
    }
  }
  game.resolving = true;
  game.resolutionQueued = false;
  clearGameTimers(game);
  const revealSeconds = gameSeconds(game, VOTE_REVEAL_SECONDS);
  game.phaseEndsAt = Date.now() + revealSeconds * 1000;
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
  schedule(game, revealSeconds * 1000, () => void revealVoteResult(game));
}

async function revealVoteResult(game: GameState): Promise<void> {
  if (game.phase !== "voting" || !game.resolving) return;
  clearGameTimers(game);
  const holdSeconds = gameSeconds(game, RESULT_HOLD_SECONDS);
  recordCurrentVoteRound(game);

  const living = alivePlayers(game);
  const outcome = resolveVoteOutcome([...game.votes.values()], game.voteRound);

  if (outcome.kind === "revote") {
    game.phaseEndsAt = Date.now() + holdSeconds * 1000;
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
    schedule(game, holdSeconds * 1000, () => {
      game.voteRound = 2;
      game.voteCandidateIds = outcome.candidateIds;
      void beginVoting(game);
    });
    return;
  }

  if (outcome.kind === "no-execution") {
    game.lastExecuted = undefined;
    game.phaseEndsAt = Date.now() + holdSeconds * 1000;
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
    schedule(game, holdSeconds * 1000, () => void startNight(game));
    return;
  }

  const executed = game.players.find(
    (player) => player.id === outcome.targetId,
  );
  if (!executed) return;

  executed.alive = false;
  game.lastExecuted = executed;
  game.executionHistory.push(executed);
  const winner = getWinner(game.players);
  game.phaseEndsAt = Date.now() + holdSeconds * 1000;
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
  schedule(game, holdSeconds * 1000, () => {
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
): Promise<boolean> {
  if (player.isNpc || !player.user || targets.length === 0) return false;
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
    return true;
  } catch {
    return false;
  }
}

function queuePrivateNotice(
  game: GameState,
  playerId: string,
  message: string,
): void {
  const messages = game.pendingDmMessages.get(playerId) ?? [];
  messages.push(message);
  game.pendingDmMessages.set(playerId, messages);
}

async function flushPendingDmMessages(game: GameState): Promise<void> {
  for (const [playerId, messages] of game.pendingDmMessages) {
    const player = game.players.find((candidate) => candidate.id === playerId);
    if (!player?.user || messages.length === 0) continue;
    const sent = await player.user
      .send(`📨 未送信だった結果\n${messages.join("\n")}`)
      .then(() => true)
      .catch(() => false);
    if (sent) game.pendingDmMessages.delete(playerId);
  }
}

function automaticNightNotice(
  game: GameState,
  player: Player,
  action: "kill" | "seer" | "guard",
): string {
  const targetId = game.nightChoices.get(nightActionKey(action, player.id));
  const target = game.players.find((candidate) => candidate.id === targetId);
  if (!target) return "夜行動は対象を選べず、見送りになりました。";
  if (action === "seer") {
    return `占いは **${safeName(target)}** が自動選択され、結果は **${publicResultForRole(target.role)}** でした。`;
  }
  return `${action === "kill" ? "襲撃" : "護衛"}は **${safeName(target)}** が自動選択されました。`;
}

function strategicNightTarget(
  game: GameState,
  action: "kill" | "guard",
  targets: Player[],
): Player | undefined {
  return chooseStrategicNightTarget(action, targets, (playerId) =>
    claimedRoleForPlayer(game, playerId),
  );
}

function setNpcNightChoices(game: GameState): void {
  const living = alivePlayers(game);
  const wolfTargets = living.filter((player) => player.role !== "人狼");
  const sharedWolfTarget = strategicNightTarget(game, "kill", wolfTargets);
  for (const npc of living.filter((player) => player.isNpc)) {
    if (npc.role === "人狼") {
      if (sharedWolfTarget)
        game.nightChoices.set(
          nightActionKey("kill", npc.id),
          sharedWolfTarget.id,
        );
    } else if (npc.role === "占い師") {
      const target = nextNpcSeerTarget(game, npc);
      if (target) {
        game.nightChoices.set(nightActionKey("seer", npc.id), target.id);
        recordSeerResult(game, npc.id, target);
      }
    } else if (npc.role === "騎士") {
      const targets = living.filter(
        (player) => player.id !== npc.id && player.id !== game.lastGuardedId,
      );
      const target = strategicNightTarget(game, "guard", targets);
      if (target)
        game.nightChoices.set(nightActionKey("guard", npc.id), target.id);
    }
  }
}

export function fillMissingNightAction(
  game: GameState,
  player: Player,
  action: "kill" | "seer" | "guard",
): void {
  const key = nightActionKey(action, player.id);
  if (game.nightChoices.has(key)) return;
  const living = alivePlayers(game);
  if (action === "seer") {
    const target = nextNpcSeerTarget(game, player);
    if (target) {
      game.nightChoices.set(key, target.id);
      recordSeerResult(game, player.id, target);
    }
    return;
  }
  const targets = living.filter((target) =>
    action === "kill"
      ? target.role !== "人狼"
      : target.id !== player.id && target.id !== game.lastGuardedId,
  );
  const target = strategicNightTarget(game, action, targets);
  if (target) game.nightChoices.set(key, target.id);
}

export function autoSelectHumanSeer(
  game: GameState,
  player: Player,
): string | undefined {
  const key = nightActionKey("seer", player.id);
  if (
    game.phase !== "night" ||
    !player.alive ||
    player.isNpc ||
    player.role !== "占い師" ||
    game.nightChoices.has(key)
  )
    return undefined;
  fillMissingNightAction(game, player, "seer");
  return game.nightChoices.has(key)
    ? automaticNightNotice(game, player, "seer")
    : undefined;
}

async function autoCompleteHumanSeer(
  game: GameState,
  player: Player,
): Promise<void> {
  const notice = autoSelectHumanSeer(game, player);
  if (!notice) return;
  const sent = player.user
    ? await player.user.send(`⏱️ おまかせ占い\n${notice}`).then(
        () => true,
        () => false,
      )
    : false;
  if (!sent) queuePrivateNotice(game, player.id, notice);
  if (expectedNightActions(game).every((key) => game.nightChoices.has(key)))
    queueNightResolutionAfterMinimum(game);
}

function fillAllMissingNightActions(game: GameState): void {
  for (const player of alivePlayers(game)) {
    if (player.role === "人狼") fillMissingNightAction(game, player, "kill");
    if (player.role === "占い師") fillMissingNightAction(game, player, "seer");
    if (player.role === "騎士") fillMissingNightAction(game, player, "guard");
  }
}

async function startNight(game: GameState): Promise<void> {
  clearGameTimers(game);
  game.phase = "night";
  game.nightChoices.clear();
  game.resolving = false;
  game.resolutionQueued = false;
  game.phaseStartedAt = Date.now();
  const nightSeconds = gameSeconds(game, NIGHT_SECONDS, DEBUG_TIMINGS.night);
  const seerAutoSeconds = gameSeconds(
    game,
    SEER_AUTO_SECONDS,
    DEBUG_TIMINGS.seerAuto,
  );
  game.phaseEndsAt = Date.now() + nightSeconds * 1000;

  const nightPayload = {
    content: "",
    embeds: [nightEmbed(game)],
    components: [],
  };
  await openPhasePanel(game, nightPayload);

  const medium = alivePlayers(game).find((player) => player.role === "霊能者");
  if (medium?.user && game.lastExecuted) {
    const result = publicResultForRole(game.lastExecuted.role);
    const sent = await medium.user
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
      .then(() => true)
      .catch(() => false);
    if (!sent) {
      queuePrivateNotice(
        game,
        medium.id,
        `霊能結果：**${safeName(game.lastExecuted)}** は **${result}** でした。`,
      );
      await game.channel.send(
        `<@${medium.id}> に結果DMを送れませんでした。DM設定を確認してください。`,
      );
    }
  }

  const living = alivePlayers(game);
  setNpcNightChoices(game);
  await Promise.all(
    living.map(async (player) => {
      if (player.isNpc) return;
      if (player.role === "人狼") {
        const sent = await sendNightMenu(
          game,
          player,
          "kill",
          "襲撃する人を選んでください。",
          living.filter((target) => target.role !== "人狼"),
        );
        if (!sent) {
          fillMissingNightAction(game, player, "kill");
          queuePrivateNotice(
            game,
            player.id,
            automaticNightNotice(game, player, "kill"),
          );
          await game.channel.send(
            `<@${player.id}> の夜行動DMを送れなかったため、自動で選択しました。`,
          );
        }
      } else if (player.role === "占い師") {
        const sent = await sendNightMenu(
          game,
          player,
          "seer",
          `${seerAutoSeconds}秒以内に選ばなければ、未占いの相手から自動で占います。`,
          living.filter((target) => target.id !== player.id),
        );
        if (!sent) {
          fillMissingNightAction(game, player, "seer");
          queuePrivateNotice(
            game,
            player.id,
            automaticNightNotice(game, player, "seer"),
          );
          await game.channel.send(
            `<@${player.id}> の夜行動DMを送れなかったため、自動で選択しました。`,
          );
        }
      } else if (player.role === "騎士") {
        const guardTargets = living.filter(
          (target) =>
            target.id !== player.id && target.id !== game.lastGuardedId,
        );
        const sent = await sendNightMenu(
          game,
          player,
          "guard",
          game.lastGuardedId
            ? "守る人を選んでください。前夜と同じ相手は選べません。"
            : "守る人を選んでください。",
          guardTargets,
        );
        if (!sent) {
          fillMissingNightAction(game, player, "guard");
          queuePrivateNotice(
            game,
            player.id,
            automaticNightNotice(game, player, "guard"),
          );
          await game.channel.send(
            `<@${player.id}> の夜行動DMを送れなかったため、自動で選択しました。`,
          );
        }
      }
    }),
  );

  for (const seer of living.filter(
    (player) => !player.isNpc && player.role === "占い師",
  )) {
    schedule(game, seerAutoSeconds * 1000, () => {
      void autoCompleteHumanSeer(game, seer);
    });
  }

  schedule(game, nightSeconds * 1000, () => void queueNightResolution(game));
  if (expectedNightActions(game).every((key) => game.nightChoices.has(key))) {
    queueNightResolutionAfterMinimum(game);
  } else if (game.debugMode && game.phase === "night" && !game.resolving) {
    await game.phaseMessage
      ?.edit({ components: [debugNextRow(game, "夜を終了する")] })
      .catch(() => undefined);
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
    game.resolving ||
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

  const actionKey = nightActionKey(action, actor.id);
  if (action === "seer" && game.nightChoices.has(actionKey)) {
    await interaction.reply({
      content: "今夜の占いはすでに確定しています。",
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
  if (action === "guard" && target.id === game.lastGuardedId) {
    await interaction.reply({
      content: "前夜と同じ相手は続けて護衛できません。",
      ephemeral: true,
    });
    return;
  }

  game.nightChoices.set(actionKey, target.id);

  if (action === "seer") {
    recordSeerResult(game, actor.id, target);
    const result = publicResultForRole(target.role);
    await interaction.update({
      content: `🔮 **${safeName(target)}** は **${result}** です。`,
      components: [],
    });
  } else {
    await interaction.update({
      content: `選択しました：**${safeName(target)}**\n締切までは変更できます。`,
      components: interaction.message.components.map((row) => row.toJSON()),
    });
  }

  if (expectedNightActions(game).every((key) => game.nightChoices.has(key)))
    queueNightResolutionAfterMinimum(game);
}

function queueNightResolutionAfterMinimum(game: GameState): void {
  if (game.resolving || game.resolutionQueued) return;
  if (game.debugMode) return;
  const delayMs = remainingPhaseMinimumMs(
    game.phaseStartedAt,
    NIGHT_MIN_SECONDS,
  );
  if (delayMs > 0) {
    game.resolutionQueued = true;
    schedule(game, delayMs, () => {
      game.resolutionQueued = false;
      void queueNightResolution(game);
    });
    return;
  }
  void queueNightResolution(game);
}

async function queueNightResolution(
  game: GameState,
  skipMinimum = false,
): Promise<void> {
  if (game.phase !== "night" || game.resolving) return;
  if (!skipMinimum) {
    const delayMs = remainingPhaseMinimumMs(
      game.phaseStartedAt,
      NIGHT_MIN_SECONDS,
    );
    if (delayMs > 0) {
      if (game.resolutionQueued) return;
      game.resolutionQueued = true;
      schedule(game, delayMs, () => {
        game.resolutionQueued = false;
        void queueNightResolution(game);
      });
      return;
    }
  }
  game.resolving = true;
  game.resolutionQueued = false;
  fillAllMissingNightActions(game);
  clearGameTimers(game);
  const revealSeconds = gameSeconds(game, NIGHT_REVEAL_SECONDS);
  game.phaseEndsAt = Date.now() + revealSeconds * 1000;
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
    revealSeconds * 1000,
    () => void revealNightResult(game),
  );
}

async function revealNightResult(game: GameState): Promise<void> {
  if (game.phase !== "night" || !game.resolving) return;
  clearGameTimers(game);
  const holdSeconds = gameSeconds(game, RESULT_HOLD_SECONDS);

  const living = alivePlayers(game);
  const wolves = living.filter((player) => player.role === "人狼");
  const possibleVictims = living.filter((player) => player.role !== "人狼");
  const victimId = resolveWolfTarget(
    wolves,
    game.nightChoices,
    possibleVictims,
  );
  const victim = game.players.find((player) => player.id === victimId);

  const guard = living.find((player) => player.role === "騎士");
  const guardedId = guard
    ? game.nightChoices.get(nightActionKey("guard", guard.id))
    : undefined;
  game.lastGuardedId = guardedId;

  const wasGuarded = Boolean(victim && victim.id === guardedId);
  if (victim && !wasGuarded) {
    victim.alive = false;
  }

  const winner = getWinner(game.players);
  game.phaseEndsAt = Date.now() + holdSeconds * 1000;
  const morningDescription = !victimId
    ? "人狼の襲撃先がまとまらず、昨夜の犠牲者はいませんでした。"
    : wasGuarded
      ? "護衛が成功し、昨夜の犠牲者はいませんでした。"
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
  schedule(game, holdSeconds * 1000, () => {
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

  const endEmbed = new EmbedBuilder()
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
    .setFooter({ text: `${game.day}日目で決着` });
  if (game.debugMode)
    endEmbed.addFields({
      name: "🛠️ デバッグモード",
      value: "この試合は戦績に記録されません。",
    });

  const endPayload = {
    content: "",
    embeds: [endEmbed],
    components: [row],
  };
  await openPhasePanel(game, endPayload);

  const humanPlayers = game.players
    .filter(
      (player): player is Player & { role: RoleName } =>
        !player.isNpc && player.role !== undefined,
    )
    .map((player) => ({
      userId: player.id,
      displayName: player.name,
      role: player.role,
      won: ROLE_INFO[player.role].team === winner,
      survived: player.alive,
    }));
  const resultMessage = game.phaseMessage;
  if (!game.debugMode && !game.statsRecorded && humanPlayers.length > 0) {
    game.statsRecorded = true;
    const matchId = game.statsMatchId ?? randomUUID();
    void recordGameStats({
      matchId,
      guildId: game.channel.guildId,
      channelId: game.channelId,
      winner,
      dayCount: game.day,
      players: humanPlayers,
    }).then(async (statsResult) => {
      if (statsResult.status !== "saved" || !resultMessage) return;
      const fields = gameStatsFields(humanPlayers, statsResult.players);
      if (fields.length === 0) return;
      endEmbed.addFields(fields);
      await resultMessage.edit({ embeds: [endEmbed] }).catch(() => undefined);
    });
  }

  schedule(game, 10 * 60 * 1000, () => {
    games.delete(game.channelId);
    void game.phaseMessage?.edit({ components: [] }).catch(() => undefined);
  });
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
  game.lastGuardedId = undefined;
  game.executionHistory = [];
  game.votes.clear();
  game.nightChoices.clear();
  game.npcSuspicion.clear();
  game.npcMemory.clear();
  game.npcClaims = [];
  game.roleDeclarations.clear();
  game.voteHistory = [];
  game.humanSuspicions.clear();
  game.npcQuestionCounts.clear();
  game.seerResults.clear();
  game.roleDmSent.clear();
  game.roleDmFailures.clear();
  game.pendingDmMessages.clear();
  game.statsMatchId = undefined;
  game.statsRecorded = false;
  game.voteRound = 1;
  game.voteCandidateIds = [];
  game.phaseStartedAt = undefined;
  game.resolving = false;
  game.resolutionQueued = false;
  game.players = game.players.filter((player) => !player.isNpc);
  game.players.forEach((player) => {
    player.alive = true;
    player.role = undefined;
  });

  await interaction.update({ components: [] });
  game.lobbyMessage = await game.channel.send(lobbyPayload(game));
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
      content:
        "このゲームは終了しているか、Botの再起動で進行情報が失われました。もう一度 `/jinro` から開始してください。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.isButton()) {
    if (action === "join") await handleJoin(interaction, game, "join");
    else if (action === "leave") await handleJoin(interaction, game, "leave");
    else if (action === "debug-settings")
      await handleDebugSettings(interaction, game);
    else if (action === "debug-toggle")
      await handleDebugToggle(interaction, game);
    else if (action === "debug-next")
      await handleDebugNext(interaction, game, Number(dayText));
    else if (action === "role-config")
      await handleRoleConfigButton(interaction, game);
    else if (action.startsWith("role-"))
      await handleRoleConfigAdjust(interaction, game, action);
    else if (action === "claim")
      await handleClaimButton(interaction, game, Number(dayText));
    else if (action === "claim-quick-seer")
      await handleQuickResultClaim(
        interaction,
        game,
        Number(dayText),
        "占い師",
      );
    else if (action === "claim-quick-medium")
      await handleQuickResultClaim(
        interaction,
        game,
        Number(dayText),
        "霊能者",
      );
    else if (action === "claim-quick-guard")
      await handleQuickGuardClaim(interaction, game, Number(dayText));
    else if (action === "claim-custom-open")
      await handleCustomClaimOpen(interaction, game, Number(dayText));
    else if (action === "claim-retract")
      await handleClaimRetractionPrompt(interaction, game, Number(dayText));
    else if (action === "claim-retract-confirm")
      await handleClaimRetractionConfirm(interaction, game, Number(dayText));
    else if (action === "claim-retract-cancel")
      await handleClaimRetractionCancel(interaction);
    else if (action === "claim-list")
      await handleClaimListButton(interaction, game, Number(dayText));
    else if (action === "suspect-open")
      await handleSuspectOpen(interaction, game, Number(dayText));
    else if (action === "npc-question-open")
      await handleNpcQuestionOpen(interaction, game, Number(dayText));
    else if (action === "vote-open")
      await handleVoteOpen(interaction, game, Number(dayText));
    else if (action === "start") await handleStart(interaction, game);
    else if (action === "cancel") await handleCancel(interaction, game);
    else if (action === "rematch") await handleRematch(interaction, game);
    return;
  }

  const day = Number(dayText);
  if (action === "player-count")
    await handlePlayerCountChange(interaction, game);
  else if (action === "debug-role")
    await handleDebugRole(interaction, game);
  else if (action === "claim-role")
    await handleClaimRole(interaction, game, day);
  else if (action.startsWith("claim-target-"))
    await handleClaimTarget(interaction, game, day, action);
  else if (action.startsWith("claim-result-"))
    await handleClaimResult(interaction, game, day, action);
  else if (action === "suspect") await handleSuspect(interaction, game, day);
  else if (action === "suspect-reason")
    await handleSuspectReason(interaction, game, day);
  else if (action === "npc-question")
    await handleNpcQuestion(interaction, game, day);
  else if (action === "vote") await handleVote(interaction, game, day);
  else if (action === "night-kill")
    await handleNightAction(interaction, game, "kill", day);
  else if (action === "night-seer")
    await handleNightAction(interaction, game, "seer", day);
  else if (action === "night-guard")
    await handleNightAction(interaction, game, "guard", day);
}
