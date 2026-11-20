import type { BaseMessageOptions } from 'discord.js';

import type {
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
 *    line to the text instead.
 */

/** The capabilities declared by both providers: the named identity, otherwise text only. */
export const DISCORD_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ asChannelKey: true });

const SNOWFLAKE = /^\d{15,25}$/;
const DISCORD_USER_PRINCIPAL = /^(?:user:)?discord-user:(\d{15,25})$/i;

/** Discord REST error codes this module tells apart (`DiscordAPIError.code`). */
const API_UNKNOWN_CHANNEL = 10003;
const API_UNKNOWN_USER = 10013;
const API_MISSING_ACCESS = 50001;
const API_CANNOT_DM_USER = 50007;
const API_MISSING_PERMISSIONS = 50013;

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

/** Post INTO a channel or thread (`conversationId` is the Discord channel id). */
export function createDiscordConversationSendProvider(lookup: DiscordBotLookup): ConversationSendProvider {
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    supports: DISCORD_SEND_CAPABILITIES,
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
