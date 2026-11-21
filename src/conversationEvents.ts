import { MessageReferenceType, type Message } from 'discord.js';

import type { ChannelUserRef, ConversationMessageEvent } from '@omadia/channel-sdk';

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
 * Discord bot user has the id of its application). The same string is the
 * routing key of an agent's own bot (spec 2042 §5.3), `asChannelKey` on sends
 * and `receivedByChannelKey` on events; it stays the same across restarts and
 * tokens.
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
  return {
    ...messageEventBase(channelId, botKey, message, message.author),
    revision: 0,
    kind: 'created',
    ...messageBody(botUserId, message, text),
    occurredAt: new Date(message.createdTimestamp).toISOString(),
  };
}

/** A Discord user as the author of an event: the platform's statement, never message text. */
export function discordAuthor(user: { id: string; username?: string | null; globalName?: string | null }): ChannelUserRef {
  const displayName = user.globalName ?? user.username ?? undefined;
  return { kind: 'discord-user', id: user.id, ...(displayName ? { displayName } : {}) };
}

type EventBase = Pick<
  ConversationMessageEvent,
  'channelId' | 'channelType' | 'conversationId' | 'conversationType' | 'receivedByChannelKey' | 'messageId' | 'author'
>;

function messageEventBase(
  channelId: string,
  botKey: string,
  message: Pick<Message, 'id' | 'channelId' | 'guild' | 'channel'>,
  author: { id: string; username?: string | null; globalName?: string | null },
): EventBase {
  return {
    channelId,
    channelType: DISCORD_CHANNEL_TYPE,
    conversationId: message.channelId,
    conversationType: isDirectMessage(message as Message) ? 'direct' : 'group',
    receivedByChannelKey: botKey,
    messageId: message.id,
    author: discordAuthor(author),
  };
}

/**
 * What a message says and how: its text, the message it replies to, whether
 * it is a forward (somebody else's text: a forwarded ballot is not the
 * forwarder's ballot) and whether it addresses the bot.
 */
function messageBody(
  botUserId: string,
  message: Message,
  text: string,
): Pick<ConversationMessageEvent, 'text' | 'replyToMessageId' | 'forwarded' | 'addressedToBot'> {
  const forwarded = message.reference?.type === MessageReferenceType.Forward;
  const replyTo = forwarded ? undefined : message.reference?.messageId;
  return {
    text,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    ...(forwarded ? { forwarded: true } : {}),
    ...(isAddressedToBot(message, botUserId) ? { addressedToBot: true } : {}),
  };
}

/**
 * The `edited` event of a message whose text changed. `revision` is a hint
 * the connection counts per message; the kernel assigns the stored revision
 * itself. Undefined without text (nothing to report) or when Discord did not
 * mark the message as edited (an embed that resolved, not an edit).
 */
export function buildEditedEvent(
  channelId: string,
  botKey: string,
  botUserId: string,
  message: Message,
  text: string | undefined,
  revision: number,
): ConversationMessageEvent | undefined {
  if (!text || message.editedTimestamp === null) return undefined;
  return {
    ...messageEventBase(channelId, botKey, message, message.author),
    revision,
    kind: 'edited',
    ...messageBody(botUserId, message, text),
    occurredAt: new Date(message.editedTimestamp).toISOString(),
  };
}

/**
 * The `deleted` event of a message. Discord's delete event names neither the
 * author nor who deleted it; the author is known only when the message was
 * still cached. Without one there is no event: an author is never guessed.
 */
export function buildDeletedEvent(
  channelId: string,
  botKey: string,
  message: Pick<Message, 'id' | 'channelId' | 'guild' | 'channel'> & {
    author: { id: string; username?: string | null; globalName?: string | null } | null;
  },
  revision: number,
  now: Date,
): ConversationMessageEvent | undefined {
  if (!message.author) return undefined;
  return {
    ...messageEventBase(channelId, botKey, message, message.author),
    revision,
    kind: 'deleted',
    occurredAt: now.toISOString(),
  };
}

/** One reaction added or removed by `user` on `message`, as Discord's gateway stated it. */
export function buildReactionEvent(
  channelId: string,
  botKey: string,
  message: Pick<Message, 'id' | 'channelId' | 'guild' | 'channel'>,
  user: { id: string; username?: string | null; globalName?: string | null },
  emoji: { name: string | null; id: string | null },
  removed: boolean,
  now: Date,
): ConversationMessageEvent | undefined {
  const name = emoji.name ?? emoji.id;
  if (!name) return undefined;
  return {
    ...messageEventBase(channelId, botKey, message, user),
    revision: 0,
    kind: 'reaction',
    reaction: { name, removed },
    occurredAt: now.toISOString(),
  };
}
