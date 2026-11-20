/**
 * Triggers and routines on Discord (spec 2042 §5.12, §5.3).
 *
 *  - Every turn opens the kernel's routines scope (`beginRoutineTurn`): who
 *    the person is and where a later delivery goes. Only then does the
 *    kernel offer the agent its trigger tools and `manage_routine`. The
 *    delivery ref names the conversation and, on an agent's own bot, that
 *    bot (`asChannelKey`, `discord-app:<appId>`).
 *  - The proactive send (`publishProactiveSend('discord', …)`) delivers a
 *    trigger's or routine's message through exactly the bot the ref names:
 *    an agent's own bot without a name line, the installation's own bot
 *    rendered like an answer (name line from the message's speaker). A bot
 *    that no longer runs here is an error, never a substitute; the kernel
 *    delivers a ref that names a bot only while that bot is the agent's.
 */

import { isNoReply, type SemanticAnswer } from '@omadia/channel-sdk';
import type { RoutinesIntegration, RoutineTurnRunner } from '@omadia/plugin-api';

import { deliverToChannel, systemAnswer } from './delivery.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';
import { sendDeliveryContext, type DiscordBotLookup } from './sendProviders.js';

/** The kernel's routines surface (`routinesIntegration@1`, optional_requires). */
export const ROUTINES_INTEGRATION_SERVICE = 'routinesIntegration';

type ProactiveSend = Parameters<RoutinesIntegration['publishProactiveSend']>[1];

/** The delivery ref a Discord turn files: the generic channel shape. */
export interface DiscordDeliveryRef {
  readonly kind: 'channel';
  readonly channelId: string;
  /** The Discord channel (or `dm:<userId>`) the turn came from. */
  readonly conversationId: string;
  /** The agent's own bot the conversation runs through; absent = the installation's bot. */
  readonly asChannelKey?: string;
}

/** Opens one turn's routines scope; the runner wraps the turn body. */
export type DiscordRoutineTurn = (info: { readonly userId: string; readonly conversationId: string }) => RoutineTurnRunner;

export function createDiscordRoutineTurn(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  channelId: string,
  asChannelKey: () => string | undefined,
): DiscordRoutineTurn {
  return ({ userId, conversationId }) => {
    const key = asChannelKey();
    const conversationRef: DiscordDeliveryRef = {
      kind: 'channel',
      channelId,
      conversationId,
      ...(key ? { asChannelKey: key } : {}),
    };
    return routines.beginRoutineTurn({ userId, channel: DISCORD_CHANNEL_TYPE, conversationRef });
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SNOWFLAKE = /^\d{15,25}$/;

/** The conversation and bot of a delivery ref, or undefined when it is not one of ours. */
export function parseDeliveryRef(ref: unknown): { conversationId: string; asChannelKey: string | undefined } | undefined {
  if (!isRecord(ref) || typeof ref['conversationId'] !== 'string') return undefined;
  const conversationId = ref['conversationId'];
  const dmUser = conversationId.startsWith('dm:') ? conversationId.slice(3) : undefined;
  if (!SNOWFLAKE.test(dmUser ?? conversationId)) return undefined;
  const raw = ref['asChannelKey'];
  const asChannelKey = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : undefined;
  return { conversationId, asChannelKey };
}

export function createDiscordProactiveSend(lookup: DiscordBotLookup): ProactiveSend {
  return async (conversationRef, message) => {
    const ref = parseDeliveryRef(conversationRef);
    if (!ref) throw new Error('not a Discord delivery: the ref names no Discord channel');
    const deps = lookup(ref.asChannelKey);
    if (!deps) throw new Error(`no Discord bot '${ref.asChannelKey ?? 'default'}' runs in this installation; nothing was sent`);
    // "Nothing to report this run": dropped, the run history keeps the turn.
    if (isNoReply(message)) return;
    const channel = ref.conversationId.startsWith('dm:')
      ? await deps.port.directChannel(ref.conversationId.slice(3))
      : await deps.port.channel(ref.conversationId);
    if (!deps.isAllowed(undefined, channel.guildId)) throw new Error("this server is not on the channel's allowlist");
    // An agent's words carry its speaker; kernel texts (approvals, reminders) name nobody.
    const answer: SemanticAnswer =
      message.speaker?.kind === 'agent' ? { text: message.text, speaker: message.speaker } : systemAnswer(message.text);
    await deliverToChannel(channel, answer, sendDeliveryContext(deps, ref.conversationId));
  };
}
