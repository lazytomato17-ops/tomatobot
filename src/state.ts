// src/state.ts
import { GameState } from './types';
import { User, TextChannel } from 'discord.js';

export const games = new Map<string, GameState>();

export function createEmptyState(): GameState {
    return {
        state: 'idle',
        channel: null,
        hostId: '',
        lobbyMessage: null,
        players: [],
        npcCount: 0,
        dayCount: 0,
        history: [],
        chatLog: [],
        timeline: [],
        voteLog: [],
        gayaInterval: null,
        lovers: [],
        settings: {
            wolfMode: 'auto',
            roles: ['seer'],
            discussionTime: 30,
            autoFinishVoting: true,
            gayaMode: false,
            willMode: false,
            firstNightPeace: false,
            voteTransparency: 'anonymous',
            tieVoteHandling: 'random',
            continuousGuard: false,
            matchType: 'casual',
            mediumInfo: 'team',
            loquaciousMode: false,
        },
        actions: [],
        evidence: [],
        cursedTarget: null,
        lastExecutionResult: null,
        winnerTeam: null,
        timers: [],
        isRevote: false,
        revoteCandidates: [],
        settingsTab: 'basic'
    };
}

export function getGame(channelId: string): GameState {
    if (!games.has(channelId)) {
        games.set(channelId, createEmptyState());
    }
    return games.get(channelId)!;
}

export function moveGameChannel(oldChannelId: string, newChannelId: string) {
    const game = games.get(oldChannelId);
    if (game) {
        games.set(newChannelId, game);
        games.delete(oldChannelId);
    }
}

export function findGameByUserId(userId: string): GameState | null {
    for (const [, g] of games.entries()) {
        if (g.state === 'playing' && g.players?.some(p => p.id === userId)) return g;
    }
    for (const [, g] of games.entries()) {
        if (g.players?.some(p => p.id === userId)) return g;
    }
    return null;
}

export function initGame(channel: any, author: User): GameState {
    resetGame(channel.id, true);
    const game = getGame(channel.id);
    game.channel = channel;
    game.hostId = author.id;
    game.state = 'recruiting';
    game.players = [{
        id: author.id, user: author, name: author.username, isNpc: false,
        settings: undefined
    }];
    return game;
}

export function resetGame(channelId: string, force = false): void {
    const game = getGame(channelId);
    if (game.timers?.length > 0) {
        game.timers.forEach(t => clearTimeout(t));
    }
    game.timers = [];
    if (game.gayaInterval) clearInterval(game.gayaInterval);

    if (force) {
        games.delete(channelId);
    } else {
        game.state = 'recruiting';
        game.dayCount = 0;
        game.history = [];
        game.chatLog = [];
        game.timeline = [];
        game.voteLog = [];
        game.actions = [];
        game.evidence = [];
        game.cursedTarget = null;
        game.lovers = [];
        game.lastExecutionResult = null;
        game.winnerTeam = null;
        game.isRevote = false;
        game.revoteCandidates = [];
        game.players = game.players.filter(p => !p.isNpc).map(p => ({
            id: p.id, user: p.user, name: p.name, isNpc: false, ghostBet: null,
            lastGuarded: null, settings: undefined
        }));
    }
}
