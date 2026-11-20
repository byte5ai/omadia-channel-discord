import { ChannelType, type Message } from 'discord.js';

import type { IncomingTurn } from '@omadia/channel-sdk';

import { DISCORD_CHANNEL_TYPE } from './renderer.js';

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
    channelType: DISCORD_CHANNEL_TYPE,
    channelKey: msg.channelId,
    conversationType: dm ? 'direct' : 'group',
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

/** The slice of a Discord chat-input interaction a turn is built from. */
export interface SlashInteractionLike {
  channelId: string | null;
  guildId: string | null;
  locale?: string;
  user: { id: string; globalName?: string | null; username: string };
}

/**
 * Translate a slash command into the core `IncomingTurn` shape. `text` is what
 * the command stands for as a message (`/ask` passes the question; `/agent`
 * passes `/agent <name>` unchanged so the kernel's management layer reads it
 * like typed text).
 */
export function buildSlashTurn(channelId: string, interaction: SlashInteractionLike, text: string): IncomingTurn {
  const conversationId = interaction.channelId ?? `dm:${interaction.user.id}`;
  const inGuild = interaction.guildId !== null;
  return {
    channelId,
    conversationId,
    channelType: DISCORD_CHANNEL_TYPE,
    channelKey: conversationId,
    conversationType: inGuild ? 'group' : 'direct',
    userRef: {
      kind: 'discord-user',
      id: interaction.user.id,
      displayName: interaction.user.globalName ?? interaction.user.username,
    },
    text,
    metadata: {
      via: 'slash',
      isDm: !inGuild,
      guildId: interaction.guildId,
      discordChannelId: interaction.channelId,
      ...(interaction.locale ? { locale: interaction.locale } : {}),
    },
  };
}
