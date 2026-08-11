import type { Message, TextChannel, User } from "discord.js";

export type RoleName = "村人" | "人狼" | "狂人" | "占い師" | "騎士" | "霊能者";
export type RoleConfig = Record<RoleName, number>;
export type GamePhase = "lobby" | "day" | "voting" | "night" | "ended";
export type Winner = "villager" | "wolf";
export type NpcPersonality = "慎重" | "直感" | "追及" | "同調";
export type PublicResult = "人狼" | "人間";

export interface VoteRecord {
  day: number;
  round: number;
  ballots: Array<{ voterId: string; targetId: string }>;
}

export interface RoleClaim {
  day: number;
  speakerId: string;
  claimedRole: "占い師" | "霊能者";
  targetId: string;
  result: PublicResult;
}

export interface Player {
  id: string;
  name: string;
  user: User | null;
  isNpc: boolean;
  npcPersonality?: NpcPersonality;
  role?: RoleName;
  alive: boolean;
}

export interface GameState {
  channelId: string;
  channel: TextChannel;
  hostId: string;
  phase: GamePhase;
  players: Player[];
  targetPlayerCount: number;
  roleConfig: RoleConfig;
  roleDmSent: Set<string>;
  roleDmFailures: Set<string>;
  day: number;
  voteRound: number;
  voteCandidateIds: string[];
  lobbyMessage?: Message;
  phaseMessage?: Message;
  phaseEndsAt?: number;
  votes: Map<string, string>;
  voteHistory: VoteRecord[];
  nightChoices: Map<string, string>;
  npcSuspicion: Map<string, number>;
  npcMemory: Map<string, Map<string, number>>;
  npcClaims: RoleClaim[];
  roleDeclarations: Set<string>;
  humanSuspicions: Map<string, string>;
  seerResults: Map<string, Array<{ targetId: string; isWolf: boolean }>>;
  lastExecuted?: Player;
  timers: NodeJS.Timeout[];
  resolving: boolean;
}
