import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_RESOLVER_SERVICE,
  getChatAgent,
  resolveChannelRoute,
  InMemorySpeakerHistoryStore,
  type ChannelHandle,
  type CoreApi,
  type LogLevel,
} from '@omadia/channel-sdk';
import type { PluginContext, RoutinesIntegration } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { PendingChoices } from './choices.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';
import { DiscordConnection, type GuildResponsePolicy } from './discordConnection.js';
import { DiscordRosterProvider } from './roster.js';
import {
  createDiscordConversationSendProvider,
  createDiscordTargetedSendProvider,
  type SendProviderDeps,
} from './sendProviders.js';
import {
  createDiscordAgentIdentityProvider,
  DiscordBotFleet,
  startStoredAgentBots,
  type AgentBotDeps,
} from './agentBots.js';
import { discordBotChannelKey } from './conversationEvents.js';
import { createChannelState } from './state.js';
import { createDiscordProactiveSend, createDiscordRoutineTurn, ROUTINES_INTEGRATION_SERVICE } from './routines.js';
import { planTurn, type TurnDeps } from './turn.js';

/**
 * Channel-plugin entry. The kernel's dynamic channel resolver imports this
 * module and calls the exported `activate(ctx, core)` (ChannelPlugin "shape
 * 1"). We log the Discord bot into the Gateway in the background, mount the
 * status/invite admin UI, and return a handle the kernel closes on
 * deactivate/uninstall.
 */
export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  const channelId = ctx.agentId;

  // The bot token is a vault secret collected at install (manifest setup.fields
  // type:secret). require() throws a clear error if it's missing.
  const token = await ctx.secrets.require('discord_bot_token');

  const guildPolicy = parseGuildPolicy(ctx.config.get<string>('respond_in_guilds'));
  const allowDms = ctx.config.get<boolean>('allow_dms') ?? true;
  const messageContentIntent = ctx.config.get<boolean>('message_content_intent') ?? false;
  const guildMembersIntent = ctx.config.get<boolean>('guild_members_intent') ?? false;
  const enableSlashCommand = ctx.config.get<boolean>('enable_slash_command') ?? true;
  const ignoreBots = ctx.config.get<boolean>('ignore_bots') ?? true;
  const allowlist = parseAllowlist(ctx.config.get<string>('allowlist') ?? '');

  // A host with neither a channel resolver nor a shared agent has nobody to
  // answer. With a resolver every turn resolves its own agent (src/turn.ts)
  // and the shared chatAgent@1 is never used: it refuses non-canvas turns.
  if (!ctx.services.get(CHANNEL_RESOLVER_SERVICE) && !getChatAgent(ctx)) {
    throw new Error(
      '@omadia/channel-discord: orchestrator unavailable (no channelResolver, no getChatAgent) — the orchestrator plugin must be installed and active',
    );
  }

  // Triggers and routines (spec 2042 §5.12): published by the kernel only
  // with a database. Absent = agents cannot set triggers or routines here.
  const routines = ctx.services.get<RoutinesIntegration>(ROUTINES_INTEGRATION_SERVICE);

  const state = createChannelState();
  const speakerHistory = new InMemorySpeakerHistoryStore();
  const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => core.log(level, message, context);
  const policy = { guildPolicy, allowDms, ignoreBots, allowlist };
  // Every bot of the installation (shared and agent bots), read when a message
  // arrives: `fleet` exists by then.
  const isOwnBot = (userId: string): boolean => own.conn.self()?.id === userId || fleet.isAgentBotUser(userId);

  /**
   * One Discord bot: the installation's own bot, or an agent's own bot
   * (spec 2042 §5.3). An agent bot resolves every turn on its own key and
   * answers only as the agent whose identity it is; it gets no slash
   * commands (there is nothing to choose) and its answers no name line.
   */
  const connectBot = (botToken: string, agentBot: boolean) => {
    let conn: DiscordConnection | undefined;
    const turnDeps: TurnDeps = {
      route: (channelKey, context) => resolveChannelRoute(ctx, DISCORD_CHANNEL_TYPE, channelKey, context),
      singleton: () => getChatAgent(ctx),
      // One bot's numbered question is answered to that bot, not to a colleague's.
      choices: new PendingChoices(),
      log,
      ...(agentBot ? { ownBotKey: () => conn?.channelKey() } : {}),
      // A trigger or routine the agent sets here delivers through this bot.
      ...(routines
        ? { routineTurn: createDiscordRoutineTurn(routines, channelId, () => (agentBot ? conn?.channelKey() : undefined)) }
        : {}),
    };
    const botState = agentBot ? createChannelState() : state;
    conn = new DiscordConnection({
      channelId,
      token: botToken,
      log,
      state: botState,
      // An agent's bot answers when addressed (mention, reply, DM); "every
      // message" is the kernel's to hand out (`conversationDelivery`), or N
      // agents would all answer one message.
      policy: agentBot && policy.guildPolicy === 'all' ? { ...policy, guildPolicy: 'mention' as const } : policy,
      isSiblingBot: (userId) => isOwnBot(userId),
      messageContentIntent,
      guildMembersIntent,
      enableSlashCommand: enableSlashCommand && !agentBot,
      speakerHistory,
      // Feature-detected: older kernels have no conversation-message registry.
      ...(core.emitConversationMessage ? { emitConversationMessage: (event) => core.emitConversationMessage?.(event) } : {}),
      ...(core.reportConversationMessage
        ? { reportConversationMessage: (event) => core.reportConversationMessage?.(event) ?? Promise.resolve({ answeredCard: false }) }
        : {}),
      planTurn: (turn) => planTurn(turnDeps, turn),
      ...(agentBot ? { agentBot: true } : {}),
    });
    const connection = conn;
    const sendDeps: SendProviderDeps = {
      port: connection.sendPort(),
      speakerHistory,
      log,
      isAllowed: (userId, guildId) => connection.isAllowlisted(userId, guildId),
      allowDms,
      ...(agentBot ? { nativeIdentity: true } : {}),
    };
    const roster = new DiscordRosterProvider({
      describe: (conversationId) => connection.describeConversation(conversationId),
      self: () => connection.self(),
      channelKey: () => connection.channelKey(),
    });
    connection.start();
    return { conn: connection, state: botState, sendDeps, roster };
  };

  const own = connectBot(token, false);
  const conn = own.conn;
  const fleet = new DiscordBotFleet({
    channelKey: () => conn.channelKey(),
    sendDeps: own.sendDeps,
    roster: own.roster,
    token,
  });

  // Who is in a conversation, as the bot `asChannelKey` sees it: the kernel's
  // audience floor needs it to answer in a group (fail-closed without it).
  // Feature-detected: older kernels have no roster registry.
  core.registerRosterProvider?.(channelId, fleet.rosterProvider());

  // Status / invite admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');
  const disposeRoutes = ctx.routes.register(
    '/api/discord-channel/admin',
    createAdminRouter({ uiAssetsPath, state, smokeMode: ctx.smokeMode }),
  );

  // Kernel-initiated sends: a notification to one person, a post into a
  // channel, through exactly the bot `asChannelKey` names (no key: the
  // installation's own bot). Feature-detected: older kernels have no such registries.
  const lookup = (asChannelKey: string | undefined) => fleet.sendDepsFor(asChannelKey);
  core.registerTargetedSendProvider?.(channelId, createDiscordTargetedSendProvider(lookup));
  core.registerConversationSendProvider?.(channelId, createDiscordConversationSendProvider(lookup));
  // Trigger and routine deliveries go out through the bot the conversation
  // came through: an agent's own bot, or the installation's.
  if (routines) {
    routines.publishProactiveSend(DISCORD_CHANNEL_TYPE, createDiscordProactiveSend(lookup));
    log('info', 'discord proactive send registered (triggers and routines deliver through the bot they were set on)');
  }

  // --- Agents' own bots (spec 2042 §5.3) --------------------------------
  // Needs the vault write permission (tokens are stored per bot) and a kernel
  // that takes agent identities; without either, agents keep `/agent`.
  const secrets = ctx.secrets;
  if (secrets.set && secrets.delete) {
    const agentBotDeps: AgentBotDeps = {
      fleet,
      secrets: {
        get: (key) => secrets.get(key),
        keys: () => secrets.keys(),
        set: (key, value) => secrets.set!(key, value),
        delete: (key) => secrets.delete!(key),
      },
      startAgentBot: (agentToken, app) => {
        const bot = connectBot(agentToken, true);
        return {
          botUserId: () => bot.conn.self()?.id,
          botKey: discordBotChannelKey(app.id),
          appId: app.id,
          name: app.name,
          sendDeps: bot.sendDeps,
          roster: bot.roster,
          canSee: (conversationId) => bot.conn.canSee(conversationId),
          status: () => (bot.state.status === 'connected' ? 'connected' : bot.state.status === 'error' ? 'error' : 'connecting'),
          close: () => bot.conn.close(),
        };
      },
      log: (level, message) => core.log(level, message),
    };
    // In the background: Discord's REST check can exceed the activate budget.
    void startStoredAgentBots(agentBotDeps).catch((err: unknown) =>
      core.log('warn', `discord agent bots could not be started: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (typeof core.registerAgentIdentityProvider === 'function') {
      core.registerAgentIdentityProvider(channelId, createDiscordAgentIdentityProvider(agentBotDeps));
      core.log('info', 'discord agent bots: identity provider registered (one bot per agent)');
    } else {
      core.log('info', 'kernel takes no agent identities — agents are reached through the shared bot only');
    }
  }

  core.log('info', 'Discord channel activated — open the admin UI for status + the invite link', {
    adminUi: '/api/discord-channel/admin/index.html',
    guildPolicy,
    allowDms,
    allowlisted: allowlist.size,
    slashCommand: enableSlashCommand,
    guildMembersIntent,
  });

  return {
    async close() {
      disposeRoutes();
      await fleet.closeAll();
      await conn.close();
    },
  };
}

/** Validate the guild-response policy enum, defaulting to 'mention'. */
function parseGuildPolicy(raw: string | undefined): GuildResponsePolicy {
  return raw === 'all' || raw === 'off' || raw === 'mention' ? raw : 'mention';
}

/** Parse the comma-separated allowlist into a set of trimmed Discord snowflake ids. */
function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}
