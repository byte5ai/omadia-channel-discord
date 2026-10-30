import type {
  ActionRowBuilder,
  Message,
  MessageActionRowComponentBuilder,
  RepliableInteraction,
} from 'discord.js';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import { plainFallback, renderAnswer } from './render.js';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
type Log = (message: string) => void;

/**
 * Answer an inbound message: the first message is a reply (threads the answer
 * to the question in busy channels, without pinging the asker), the rest
 * follow in the channel. A rejected V2 payload falls back to plain text so
 * the user still gets the answer.
 */
export async function deliverReply(
  message: Message,
  answer: SemanticAnswer,
  rows: Row[],
  log: Log,
): Promise<void> {
  const channel = message.channel;
  if (!channel.isSendable()) return;
  const payloads = await renderAnswer(answer, rows, log);
  try {
    for (const [i, payload] of payloads.entries()) {
      if (i === 0) await message.reply(payload);
      else await channel.send(payload);
    }
  } catch (err) {
    log(`components v2 send failed, falling back to text: ${(err as Error).message}`);
    const plain = plainFallback(answer);
    for (const [i, payload] of plain.entries()) {
      const last = i === plain.length - 1;
      await channel.send(last ? { ...payload, components: rows } : payload);
    }
  }
}

/** Answer a deferred interaction: edit the "thinking…" reply, then follow up. */
export async function deliverInteraction(
  interaction: RepliableInteraction,
  answer: SemanticAnswer,
  rows: Row[],
  log: Log,
): Promise<void> {
  const payloads = await renderAnswer(answer, rows, log);
  try {
    const [first, ...rest] = payloads;
    if (first) await interaction.editReply(first);
    for (const payload of rest) await interaction.followUp(payload);
  } catch (err) {
    log(`components v2 reply failed, falling back to text: ${(err as Error).message}`);
    const [first, ...rest] = plainFallback(answer);
    if (first) await interaction.editReply({ ...first, components: rest.length === 0 ? rows : [] });
    for (const [i, payload] of rest.entries()) {
      const last = i === rest.length - 1;
      await interaction.followUp(last ? { ...payload, components: rows } : payload);
    }
  }
}
