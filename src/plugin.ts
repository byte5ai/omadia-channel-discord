import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as channelSdk from '@omadia/channel-sdk';
import {
  isNoReply,
  logNoReplyDrop,
  type ChatAgent,
  type ChannelHandle,
  type CoreApi,
  type IncomingTurn,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createAdminRouter } from './adminRouter.js';
import { DiscordConnection, type GuildResponsePolicy } from './discordConnection.js';
import { InteractionRegistry } from './interactions.js';
import { createChannelState } from './state.js';

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
  const enableSlashCommand = ctx.config.get<boolean>('enable_slash_command') ?? true;
  const ignoreBots = ctx.config.get<boolean>('ignore_bots') ?? true;
  const allowlist = parseAllowlist(ctx.config.get<string>('allowlist') ?? '');

  // Resolve the orchestrator's ChatAgent. Prefers the SDK's getChatAgent()
  // helper; falls back to the raw 'chatAgent' service lookup so the plugin
  // still runs on a host whose channel-sdk predates the helper.
  const agent = resolveChatAgent(ctx);
  if (!agent) {
    throw new Error(
      '@omadia/channel-discord: orchestrator unavailable (getChatAgent) — the orchestrator plugin must be installed and active',
    );
  }

  const state = createChannelState();
  const registry = new InteractionRegistry();

  const conn = new DiscordConnection({
    channelId,
    token,
    log: (level, message, context) => core.log(level, message, context),
    state,
    policy: { guildPolicy, allowDms, ignoreBots, allowlist },
    messageContentIntent,
    enableSlashCommand,
    registry,
    runTurn: (turn) => runTurn(ctx, agent, turn),
  });

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
  conn.start();

  core.log('info', 'Discord channel activated — open the admin UI for status + the invite link', {
    adminUi: '/api/discord-channel/admin/index.html',
    guildPolicy,
    allowDms,
    allowlisted: allowlist.size,
    slashCommand: enableSlashCommand,
  });

  return {
    async close() {
      disposeRoutes();
      await conn.close();
    },
  };
}

/**
 * Drive one orchestrator turn. Returns the {@link SemanticAnswer} to render,
 * or null when the orchestrator emitted NO_REPLY (the connection then stays
 * silent for a passive message). Mirrors the WhatsApp channel's fold.
 */
async function runTurn(
  ctx: PluginContext,
  defaultAgent: ChatAgent,
  turn: IncomingTurn,
): Promise<SemanticAnswer | null> {
  const guildId = (turn.metadata as { guildId?: string | null } | undefined)?.guildId;
  // US7 — route to the Agent bound to this Discord channel (per-channel), else
  // the guild-level binding (guildId), else the platform fallback, else the
  // default.
  const agent = resolveAgentForTurn(
    ctx,
    'discord',
    [turn.conversationId, guildId],
    defaultAgent,
  );
  const answer = await agent.chat({
    userMessage: turn.text,
    sessionScope: `discord:${turn.conversationId}`,
    userId: turn.userRef.id,
  });
  if (isNoReply(answer)) {
    logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
    return null;
  }
  return answer;
}

/**
 * Resolve the orchestrator's {@link ChatAgent}. Prefers the SDK helper
 * `getChatAgent(ctx)` (the blessed, typed path); falls back to the raw
 * service-registry lookup so the plugin also runs on a host whose
 * `@omadia/channel-sdk` predates the helper. Accessed via the namespace so a
 * missing export is just `undefined` at runtime rather than a module-load
 * error.
 */
function resolveChatAgent(ctx: PluginContext): ChatAgent | undefined {
  const helper = (channelSdk as { getChatAgent?: (c: PluginContext) => ChatAgent | undefined })
    .getChatAgent;
  if (helper) return helper(ctx);
  return ctx.services.get<{ agent: ChatAgent }>('chatAgent')?.agent;
}

/**
 * Structural view of the kernel's `channelResolver@1` — the per-binding router
 * published by the multi-orchestrator runtime. Consumed directly (not via a
 * new SDK export) so this plugin keeps running on hosts whose
 * `@omadia/channel-sdk` predates the US7 helper; the service itself is what the
 * helper wraps.
 */
interface ChannelBindingResolver {
  resolve(
    channelType: string,
    channelKey: string,
  ): { readonly decision: 'bound' | 'fallback' | 'reject'; readonly chatAgent?: ChatAgent };
}

const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

/**
 * US7 per-turn Agent resolution. Routes a turn to the Agent the operator bound
 * to its `(channelType, channelKey)` via `channelResolver@1`, falling back to
 * `defaultAgent` when no binding (and no platform fallback Agent) matches OR
 * the resolver is not published (single-Agent / pre-US7 host). `channelKeys`
 * are tried most-specific first: a `bound` decision wins immediately, a
 * `fallback` is remembered and used only if no key is explicitly bound.
 * Resolver errors are swallowed (default agent used) so a hiccup never drops a
 * turn. Without this, every turn reaches the shared, fully-tooled singleton
 * regardless of which Agent the channel is bound to.
 */
function resolveAgentForTurn(
  ctx: PluginContext,
  channelType: string,
  channelKeys: ReadonlyArray<string | null | undefined>,
  defaultAgent: ChatAgent,
): ChatAgent {
  const resolver = ctx.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  if (!resolver) return defaultAgent;
  let fallback: ChatAgent | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const decision = resolver.resolve(channelType, key);
      if (decision.decision === 'bound' && decision.chatAgent) return decision.chatAgent;
      if (decision.decision === 'fallback' && decision.chatAgent) fallback ??= decision.chatAgent;
    }
  } catch {
    return defaultAgent;
  }
  return fallback ?? defaultAgent;
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
