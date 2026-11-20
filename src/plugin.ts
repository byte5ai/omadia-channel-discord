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
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { PendingChoices } from './choices.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';
import { DiscordConnection, type GuildResponsePolicy } from './discordConnection.js';
import { DiscordRosterProvider } from './roster.js';
import { createDiscordConversationSendProvider, createDiscordTargetedSendProvider } from './sendProviders.js';
import { createChannelState } from './state.js';
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

  const state = createChannelState();
  const speakerHistory = new InMemorySpeakerHistoryStore();
  const turnDeps: TurnDeps = {
    route: (channelKey, context) => resolveChannelRoute(ctx, DISCORD_CHANNEL_TYPE, channelKey, context),
    singleton: () => getChatAgent(ctx),
    choices: new PendingChoices(),
    log: (level, message, context) => core.log(level, message, context),
  };

  const conn = new DiscordConnection({
    channelId,
    token,
    log: (level, message, context) => core.log(level, message, context),
    state,
    policy: { guildPolicy, allowDms, ignoreBots, allowlist },
    messageContentIntent,
    guildMembersIntent,
    enableSlashCommand,
    speakerHistory,
    // Feature-detected: older kernels have no conversation-message registry.
    ...(core.emitConversationMessage ? { emitConversationMessage: (event) => core.emitConversationMessage?.(event) } : {}),
    planTurn: (turn) => planTurn(turnDeps, turn),
  });

  // Who is in a conversation: the kernel's audience floor needs it to answer
  // in a group (fail-closed without it). Feature-detected: older kernels
  // have no roster registry.
  core.registerRosterProvider?.(
    channelId,
    new DiscordRosterProvider({
      describe: (conversationId) => conn.describeConversation(conversationId),
      self: () => conn.self(),
    }),
  );

  // Status / invite admin UI. web-ui renders this as an iframe (manifest
  // `admin_ui_path`); the UI fetches its JSON API with RELATIVE paths so it
  // resolves through the `/bot-api` rewrite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');
  const disposeRoutes = ctx.routes.register(
    '/api/discord-channel/admin',
    createAdminRouter({ uiAssetsPath, state, smokeMode: ctx.smokeMode }),
  );

  // Non-blocking — login + ready + slash-command registration can exceed the
  // 10s activate budget.
  // Kernel-initiated sends: a notification to one person, a post into a
  // channel. Feature-detected: older kernels have no such registries.
  const sendDeps = {
    port: conn.sendPort(),
    speakerHistory,
    log: (level: LogLevel, message: string, context?: Record<string, unknown>) => core.log(level, message, context),
    isAllowed: (userId: string | undefined, guildId: string | null) => conn.isAllowlisted(userId, guildId),
    allowDms,
  };
  core.registerTargetedSendProvider?.(channelId, createDiscordTargetedSendProvider(sendDeps));
  core.registerConversationSendProvider?.(channelId, createDiscordConversationSendProvider(sendDeps));

  conn.start();

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
