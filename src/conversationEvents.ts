import type { Message } from 'discord.js';

import type { ConversationMessageEvent } from '@omadia/channel-sdk';

import { isDirectMessage, mentionsBot } from './inbound.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';

/**
 * Inbound messages as conversation events (#2043, #2086): every human message
 * the bot can read is told to the kernel, which stores it only for a
 * subscription of the receiving identity and drops it otherwise. The kernel
 * turns a typed reply to a question it posted as numbered text into a typed
 * `card_answer`; the channel only reports who wrote what, as what.
 */

/**
 * The key the kernel knows this bot's identity under: `discord-app:<application-id>` (a
 * Discord bot user has the id of its application). Discord has no binding key
 * per bot of its own yet, so this is the one this plugin would name as
 * `asChannelKey`; it stays the same across restarts and tokens.
 */
export function discordBotChannelKey(applicationId: string): string {
  return `discord-app:${applicationId}`;
}

/** Is the message addressed to the bot: a DM, a mention, or a reply that pings it. */
export function isAddressedToBot(message: Message, botUserId: string): boolean {
  return isDirectMessage(message) || mentionsBot(message, botUserId) || message.mentions.repliedUser?.id === botUserId;
}

/**
 * The `created` event of one received message, or undefined when there is no
 * text to report (an attachment-only post, or a body Discord withheld because
 * the privileged Message-Content intent is off).
 *
 * `conversationId` is the channel id, in a thread the thread's own id: the
 * same key the agent selection and bindings use. `text` has the bot's own
 * mention stripped, as in a turn.
 */
export function buildCreatedEvent(
  channelId: string,
  botKey: string,
  botUserId: string,
  message: Message,
  text: string | undefined,
): ConversationMessageEvent | undefined {
  if (!text) return undefined;
  const displayName = message.author.globalName ?? message.author.username;
  const replyTo = message.reference?.messageId;
  return {
    channelId,
    channelType: DISCORD_CHANNEL_TYPE,
    conversationId: message.channelId,
    conversationType: isDirectMessage(message) ? 'direct' : 'group',
    receivedByChannelKey: botKey,
    messageId: message.id,
    revision: 0,
    kind: 'created',
    author: { kind: 'discord-user', id: message.author.id, ...(displayName ? { displayName } : {}) },
    text,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    ...(isAddressedToBot(message, botUserId) ? { addressedToBot: true } : {}),
    occurredAt: new Date(message.createdTimestamp).toISOString(),
  };
}
