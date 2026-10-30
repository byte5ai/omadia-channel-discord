import type { Attachment, Collection, Message } from 'discord.js';

import type { IncomingAttachment, IncomingTurn } from '@omadia/channel-sdk';

import { type DiscordConfig, isAllowlisted } from './config.js';

/** The platform `channelType` selector for per-binding routing (US7). */
export const DISCORD_CHANNEL_TYPE = 'discord';

/**
 * The most specific operator-bindable key: the Discord channel id (a DM is a
 * channel too). The guild id travels in `metadata.guildId` and is tried next
 * (see `turn.ts`) — the same keys 0.1.5 used, so its bindings carry over.
 */
export function channelKeyFor(channelId: string): string {
  return channelId;
}

export interface InboundDeps {
  /** The platform channel id (`ctx.agentId`). */
  readonly channelId: string;
  /** The bot's own user id, for mention detection + loop avoidance. */
  readonly botUserId: string;
  readonly config: DiscordConfig;
}

function inferKind(mediaType: string): IncomingAttachment['kind'] {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return 'file';
}

function mapAttachments(
  attachments: Collection<string, Attachment>,
): IncomingAttachment[] {
  return [...attachments.values()].map((a) => {
    const mediaType = a.contentType ?? 'application/octet-stream';
    const att: IncomingAttachment = {
      kind: inferKind(mediaType),
      // Discord CDN URLs are publicly fetchable → the orchestrator fetches
      // them itself; no need to pre-fetch bytes.
      url: a.url,
      mediaType,
      sizeBytes: a.size,
    };
    if (a.name) att.name = a.name;
    return att;
  });
}

function stripMention(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Translate a Discord message into an `IncomingTurn`, applying the channel's
 * gating rules (0.1.5's). Returns `null` when the message should be ignored: a
 * bot/system author (prevents reply loops), a DM while `allow_dms` is off, a
 * guild message under `respond_in_guilds: off` or — under `mention` — one that
 * doesn't @mention the bot, an author/guild outside a non-empty `allowlist`,
 * or an empty message (no text and no attachments).
 */
export function messageToTurn(
  message: Message,
  deps: InboundDeps,
): IncomingTurn | null {
  const { config, botUserId, channelId } = deps;

  if (message.author.bot || message.system) return null;

  const guildId = message.guildId;
  const isDm = guildId === null;

  if (isDm) {
    if (!config.respondToDms) return null;
  } else {
    if (config.guildPolicy === 'off') return null;
    // A reply to one of the bot's messages pings it by default, so replies
    // count as mentions and keep a conversation going without "@Bot".
    if (config.guildPolicy === 'mention' && !message.mentions.users.has(botUserId)) {
      return null;
    }
  }
  if (!isAllowlisted(config, message.author.id, guildId)) return null;

  const text = stripMention(message.content, botUserId);
  const attachments = mapAttachments(message.attachments);
  if (text.length === 0 && attachments.length === 0) return null;

  const turn: IncomingTurn = {
    channelId,
    conversationId: message.channelId,
    channelType: DISCORD_CHANNEL_TYPE,
    channelKey: channelKeyFor(message.channelId),
    userRef: {
      kind: 'discord-user',
      id: message.author.id,
      displayName: message.member?.displayName ?? message.author.username,
    },
    text,
    metadata: {
      guildId: guildId ?? undefined,
      channelId: message.channelId,
      messageId: message.id,
    },
    rawEvent: message,
  };
  if (attachments.length > 0) turn.attachments = attachments;
  return turn;
}
