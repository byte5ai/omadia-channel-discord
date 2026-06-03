import { ChannelType, type Message } from 'discord.js';

import type { IncomingTurn } from '@omadia/channel-sdk';

/** A Discord message is a DM when it has no guild (1:1 with the bot). */
export function isDirectMessage(msg: Message): boolean {
  return !msg.guild || msg.channel.type === ChannelType.DM;
}

/**
 * Pull the routable plain text out of a Discord message. The leading bot
 * mention (`<@id>` / `<@!id>`) is stripped so the orchestrator sees the bare
 * prompt ("@Omadia what's the weather" → "what's the weather"). Returns
 * `undefined` for empty/whitespace-only content (e.g. an attachment-only post,
 * or a guild message whose content was redacted because the privileged
 * Message-Content intent is off and the bot wasn't addressed).
 */
export function extractText(msg: Message, botUserId: string): string | undefined {
  const stripped = msg.content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

/** True when this guild message directly @mentions the bot user (not @everyone/@here). */
export function mentionsBot(msg: Message, botUserId: string): boolean {
  return msg.mentions.users.has(botUserId);
}

/** Translate a native Discord message into the core `IncomingTurn` shape. */
export function buildIncomingTurn(channelId: string, msg: Message, text: string): IncomingTurn {
  const dm = isDirectMessage(msg);
  const displayName = msg.author.globalName ?? msg.author.username;
  return {
    channelId,
    conversationId: msg.channelId,
    userRef: {
      kind: 'discord-user',
      id: msg.author.id,
      ...(displayName ? { displayName } : {}),
    },
    text,
    metadata: {
      isDm: dm,
      guildId: msg.guildId ?? null,
      discordChannelId: msg.channelId,
      messageId: msg.id,
    },
    rawEvent: msg,
  };
}
