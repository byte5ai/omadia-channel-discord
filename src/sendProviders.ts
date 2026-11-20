import type { BaseMessageOptions } from 'discord.js';

import type { ConversationReaction } from '@omadia/plugin-api';
import type {
  ConversationReactionOutcome,
  ConversationSendProvider,
  LogLevel,
  SendProviderCapabilities,
  SpeakerHistoryStore,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendProvider,
} from '@omadia/channel-sdk';

import { deliverProactive, type DeliveryContext } from './delivery.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';

/**
 * Kernel-initiated sends of this channel: a notification to one person
 * (`TargetedSendProvider`, a DM) and a post into a conversation
 * (`ConversationSendProvider`, a channel or thread). Plain text only.
 *
 * What the provider DECLARES is what it does, nothing more (#2043):
 *  - `asChannelKey`: the post goes out through exactly the bot that key
 *    names, `discord-app:<appId>`: the installation's own bot or an agent's
 *    own bot (spec 2042 §5.3). An unknown key is refused, never answered
 *    through another bot. Without `asChannelKey` the installation's bot posts;
 *  - no `poll` / `card`: the kernel posts a poll or question card without
 *    native support as numbered text through `sendToConversation` itself and
 *    turns a typed reply into the answer; this provider only reports the id
 *    of the Discord message it posted (`messageId`), which a reply points at.
 *    The replies reach the kernel as `created` events (`conversationEvents.ts`);
 *  - no `mentions`, no `aiLabel`: the kernel adds the instance's disclosure
 *    line to the text instead;
 *  - `reactions` (conversation provider only, spec 2043 §5.14): a thumbs-up
 *    on a message, set by exactly the bot `asChannelKey` names, through
 *    Discord's Create Reaction (`PUT /channels/{channel.id}/messages/
 *    {message.id}/reactions/{emoji}/@me`, 204 on success; needs
 *    READ_MESSAGE_HISTORY and ADD_REACTIONS).
 */

/** The capabilities of the DM provider: the named identity, otherwise text only. */
export const DISCORD_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ asChannelKey: true });

/** The capabilities of the conversation provider: also reactions as the named identity. */
export const DISCORD_CONVERSATION_CAPABILITIES: SendProviderCapabilities = Object.freeze({
  asChannelKey: true,
  reactions: true,
});

/** The platform form of each kernel reaction: Discord's unicode thumbs-up. */
const REACTION_EMOJI: Readonly<Record<ConversationReaction, string>> = Object.freeze({ acknowledge: '\u{1F44D}' });

const SNOWFLAKE = /^\d{15,25}$/;
const DISCORD_USER_PRINCIPAL = /^(?:user:)?discord-user:(\d{15,25})$/i;

/** Discord REST error codes this module tells apart (`DiscordAPIError.code`). */
const API_UNKNOWN_CHANNEL = 10003;
const API_UNKNOWN_USER = 10013;
const API_MISSING_ACCESS = 50001;
const API_CANNOT_DM_USER = 50007;
const API_MISSING_PERMISSIONS = 50013;
const API_UNKNOWN_MESSAGE = 10008;
const API_REACTION_BLOCKED = 90001;

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

type Unreachable = Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;

const unreachable = (code: Unreachable['code'], message: string): Unreachable => ({
  outcome: 'unreachable',
  code,
  message,
});

/** Where a proactive message goes: a channel, thread or DM the bot can post into. */
export interface ProactiveChannel {
  send: (o: BaseMessageOptions) => Promise<unknown>;
  /** The server the channel belongs to; null for a DM. */
  readonly guildId: string | null;
}

/** The connection's side of a send: find the place to post. Both reject with the Discord API error. */
export interface SendPort {
  channel(channelId: string): Promise<ProactiveChannel>;
  directChannel(userId: string): Promise<ProactiveChannel>;
  /** `PUT` the bot's own reaction at `route` (see {@link ownReactionRoute}); resolves on Discord's 204. */
  addOwnReaction(route: OwnReactionRoute): Promise<void>;
}

export type OwnReactionRoute = `/channels/${string}/messages/${string}/reactions/${string}/@me`;

/** Discord's Create Reaction route; the emoji must be URL-encoded (else `10014: Unknown Emoji`). */
export function ownReactionRoute(channelId: string, messageId: string, emoji: string): OwnReactionRoute {
  return `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
}

export interface SendProviderDeps {
  port: SendPort;
  speakerHistory: SpeakerHistoryStore;
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  /** The channel's access policy: who and which servers may interact with the bot. */
  isAllowed: (userId: string | undefined, guildId: string | null) => boolean;
  allowDms: boolean;
  /** Spec 2042 §5.3 — an agent's own bot: no name line. */
  nativeIdentity?: boolean;
}

/**
 * The bot a send goes out as: `undefined` = the installation's own bot, else
 * the bot with exactly that key. `undefined` back = no such bot runs here.
 */
export type DiscordBotLookup = (asChannelKey: string | undefined) => SendProviderDeps | undefined;

function apiCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** discord.js rejects with a `RateLimitError` (no status) when it is told not to queue. */
function isRateLimited(err: unknown): boolean {
  return httpStatus(err) === HTTP_TOO_MANY_REQUESTS || (err as { name?: unknown } | null)?.name === 'RateLimitError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The bot for `asChannelKey`, or why there is none. Never another bot. */
function botFor(lookup: DiscordBotLookup, asChannelKey: string | undefined): SendProviderDeps | Unreachable {
  const key = asChannelKey === undefined ? undefined : asChannelKey.trim().toLowerCase();
  const deps = lookup(key);
  if (deps) return deps;
  return unreachable('not_permitted', `no Discord bot '${String(asChannelKey)}' runs in this installation - nothing was posted`);
}

function isUnreachable(value: SendProviderDeps | Unreachable): value is Unreachable {
  return (value as Unreachable).outcome === 'unreachable';
}

/** Poll and question cards are not declared; refuse instead of degrading to text the sender cannot get answers for. */
function refuseRichMessage(message: TargetedMessage): Unreachable | undefined {
  if (message.poll || message.card) {
    return unreachable(
      'channel_error',
      'this Discord channel declares no poll or question card support - nothing was posted, ask in a numbered chat question instead',
    );
  }
  return undefined;
}

/** How a send through `deps` renders (its speaker history, its name line rule). */
export function sendDeliveryContext(deps: SendProviderDeps, conversationKey: string): DeliveryContext {
  return {
    conversationKey: `discord:${conversationKey}`,
    speakerHistory: deps.speakerHistory,
    log: deps.log,
    ...(deps.nativeIdentity ? { nativeIdentity: true } : {}),
  };
}

/** The Discord user id a principal or user reference names, or undefined (an e-mail principal names nobody here). */
export function discordUserIdOf(target: {
  principalId: string;
  userRef?: { kind: string; id: string };
}): string | undefined {
  if (target.userRef?.kind === 'discord-user' && SNOWFLAKE.test(target.userRef.id)) return target.userRef.id;
  return DISCORD_USER_PRINCIPAL.exec(target.principalId.trim())?.[1];
}

/** Notify ONE person by direct message. The kernel resolves roles and principals; this only delivers. */
export function createDiscordTargetedSendProvider(lookup: DiscordBotLookup): TargetedSendProvider {
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    supports: DISCORD_SEND_CAPABILITIES,
    async sendToUser(target, message, opts): Promise<TargetedDeliveryOutcome> {
      const deps = botFor(lookup, opts?.asChannelKey);
      if (isUnreachable(deps)) return deps;
      const rich = refuseRichMessage(message);
      if (rich) return rich;
      const userId = discordUserIdOf(target);
      if (!userId) {
        return unreachable(
          'no_binding',
          `no Discord user id is known for '${target.principalId}' (only user:discord-user:<id> principals can be reached here)`,
        );
      }
      if (!deps.allowDms || !deps.isAllowed(userId, null)) {
        return unreachable('not_permitted', 'direct messages to this person are switched off by the channel settings');
      }
      try {
        const dm = await deps.port.directChannel(userId);
        const post = await deliverProactive(dm, message, sendDeliveryContext(deps, userId));
        if (!post) return unreachable('channel_error', 'the message had no text to post');
        return { outcome: 'delivered', ...post };
      } catch (err) {
        const code = apiCode(err);
        if (code === API_UNKNOWN_USER) return unreachable('user_not_found', 'Discord does not know this user');
        if (code === API_CANNOT_DM_USER) {
          return unreachable('blocked', 'the user does not accept direct messages from this bot');
        }
        deps.log('warn', 'discord targeted send failed', { error: errorText(err), code });
        return unreachable('channel_error', errorText(err));
      }
    },
  };
}

type ReactionUnreachable = Extract<ConversationReactionOutcome, { outcome: 'unreachable' }>;

/** A failed Create Reaction as the kernel's outcome; Discord's own message is kept. */
function reactionFailure(err: unknown, deps: SendProviderDeps): ReactionUnreachable {
  const code = apiCode(err);
  const status = httpStatus(err);
  const platform = errorText(err);
  if (code === API_UNKNOWN_CHANNEL || code === API_UNKNOWN_MESSAGE || status === HTTP_NOT_FOUND) {
    return unreachable('no_binding', `the message or channel is gone or not visible to this bot: ${platform}`);
  }
  if (
    code === API_MISSING_ACCESS ||
    code === API_MISSING_PERMISSIONS ||
    code === API_REACTION_BLOCKED ||
    status === HTTP_FORBIDDEN
  ) {
    return unreachable(
      'not_permitted',
      `the bot may not react here (needs Add Reactions and Read Message History): ${platform}`,
    );
  }
  if (isRateLimited(err)) {
    return unreachable('channel_error', `Discord rate limit, no reaction was set: ${platform}`);
  }
  deps.log('warn', 'discord reaction failed', { error: platform, code, status });
  return unreachable('channel_error', platform);
}

/** Set a thumbs-up on a message as exactly the bot `asChannelKey` names. Never throws. */
async function reactAs(
  lookup: DiscordBotLookup,
  conversationId: string,
  messageId: string,
  reaction: ConversationReaction,
  asChannelKey: string | undefined,
): Promise<ConversationReactionOutcome> {
  // A reaction always names its identity; without one it is not set, not set as the installation's bot.
  if (!asChannelKey?.trim()) return unreachable('not_permitted', 'a reaction names no Discord bot - nothing was set');
  const deps = botFor(lookup, asChannelKey);
  if (isUnreachable(deps)) return deps;
  const emoji = Object.hasOwn(REACTION_EMOJI, reaction) ? REACTION_EMOJI[reaction] : undefined;
  if (!emoji) return unreachable('channel_error', `this Discord channel has no reaction '${String(reaction)}'`);
  if (!SNOWFLAKE.test(conversationId) || !SNOWFLAKE.test(messageId)) {
    return unreachable('no_binding', `'${conversationId}' / '${messageId}' is not a Discord channel and message id`);
  }
  try {
    const channel = await deps.port.channel(conversationId);
    if (!deps.isAllowed(undefined, channel.guildId)) {
      return unreachable('not_permitted', 'this server is not on the channel\'s allowlist');
    }
    await deps.port.addOwnReaction(ownReactionRoute(conversationId, messageId, emoji));
    return { outcome: 'reacted' };
  } catch (err) {
    return reactionFailure(err, deps);
  }
}

/** Post INTO a channel or thread (`conversationId` is the Discord channel id). */
export function createDiscordConversationSendProvider(lookup: DiscordBotLookup): ConversationSendProvider {
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    supports: DISCORD_CONVERSATION_CAPABILITIES,
    react: (conversationId, messageId, reaction, opts) =>
      reactAs(lookup, conversationId, messageId, reaction, opts?.asChannelKey),
    async sendToConversation(conversationId, message, opts): Promise<TargetedDeliveryOutcome> {
      const deps = botFor(lookup, opts?.asChannelKey);
      if (isUnreachable(deps)) return deps;
      const rich = refuseRichMessage(message);
      if (rich) return rich;
      if (!SNOWFLAKE.test(conversationId)) {
        return unreachable('no_binding', `'${conversationId}' is not a Discord channel id`);
      }
      try {
        const channel = await deps.port.channel(conversationId);
        if (!deps.isAllowed(undefined, channel.guildId)) {
          return unreachable('not_permitted', 'this server is not on the channel\'s allowlist');
        }
        const post = await deliverProactive(channel, message, sendDeliveryContext(deps, conversationId));
        if (!post) return unreachable('channel_error', 'the message had no text to post');
        return { outcome: 'delivered', ...post };
      } catch (err) {
        const code = apiCode(err);
        if (code === API_UNKNOWN_CHANNEL) {
          return unreachable('no_binding', 'the bot does not know this channel - it has not been added to that server');
        }
        if (code === API_MISSING_ACCESS || code === API_MISSING_PERMISSIONS) {
          return unreachable('not_permitted', 'the bot may not post in this channel');
        }
        deps.log('warn', 'discord conversation send failed', { error: errorText(err), code });
        return unreachable('channel_error', errorText(err));
      }
    },
  };
}
