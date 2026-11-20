import type { BaseMessageOptions, Message } from 'discord.js';

import {
  admitDecorations,
  type AgentSpeaker,
  type LogLevel,
  type SemanticAnswer,
  type SystemNotice,
} from '@omadia/channel-sdk';

import {
  chunkContent,
  DISCORD_CHANNEL_TYPE,
  renderAnswer,
  type DiscordRenderResult,
  type RenderContext,
} from './renderer.js';

/**
 * The ONE place that puts text into Discord. Every user-visible message of
 * this channel, an agent's answer or a plugin-local notice, is a
 * {@link SemanticAnswer} with a speaker (an agent, or `system`) rendered by
 * {@link renderAnswer}; no other module calls `reply` / `send` / `editReply`
 * / `followUp` (spec 2042 INV-4, criterion 5, enforced by
 * `test/emitters.test.ts`). There is no receipt reaction and there are no
 * buttons: Discord is a plain-text channel (spec §5.14).
 */

export interface DeliveryContext extends RenderContext {
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
}

/** What a deferred slash-command interaction offers for the reply. */
export interface InteractionReplyTarget {
  editReply: (o: BaseMessageOptions) => Promise<unknown>;
  followUp: (o: BaseMessageOptions) => Promise<unknown>;
}

/** What an interaction that was not deferred offers for a private reply. */
export interface EphemeralReplyTarget {
  reply: (o: BaseMessageOptions & { ephemeral: true }) => Promise<unknown>;
}

/** A plugin-local notice (access refused, error, silence) as a `system` answer. */
export function systemAnswer(text: string, notice?: SystemNotice): SemanticAnswer {
  return {
    text,
    speaker: { kind: 'system' },
    ...(notice ? { systemNotice: notice } : {}),
  };
}

/** The answer for a resolver or selection notice from the kernel. */
export function noticeAnswer(notice: SystemNotice): SemanticAnswer {
  return systemAnswer(notice.text, notice);
}

/**
 * The one acknowledgement of long work, in the agent's own name (spec 2042
 * §5.8): the pace text is that agent's words, so it goes out under its speaker.
 */
export function agentAcknowledgement(text: string, speaker: AgentSpeaker): SemanticAnswer {
  return { text, speaker };
}

/** Shown instead of an answer nobody can be named for. */
export const UNATTRIBUTED_TEXT =
  'Die Antwort konnte keinem Agenten zugeordnet werden und wurde deshalb nicht gesendet. Bitte versuche es erneut.';

/**
 * Render an answer, with the checks every outgoing message passes.
 *
 * Fail closed on attribution (INV-4): the kernel stamps every answer with its
 * speaker, so an answer without one is a contract violation. Its text is NOT
 * sent, as nobody could be named for it; the user gets a `system` notice
 * instead of silence, and the log an error.
 */
function prepare(answer: SemanticAnswer, ctx: DeliveryContext): BaseMessageOptions[] {
  let outgoing = answer;
  if (answer.speaker === undefined) {
    ctx.log('error', 'discord answer without speaker refused (kernel contract violation, INV-4)', {
      conversation: ctx.conversationKey,
    });
    outgoing = systemAnswer(UNATTRIBUTED_TEXT);
  }
  const result = renderAnswer(outgoing, ctx);
  // Defence in depth: the renderer attaches no decoration today. Should one be
  // added without a registry entry for this channel, say so loudly in the log.
  const { refused } = admitDecorations(DISCORD_CHANNEL_TYPE, result.decorations);
  for (const refusal of refused) {
    ctx.log('error', 'discord decoration not declared in the registry', { ...refusal });
  }
  return buildPayloads(result);
}

/** Reply to a received message: the first chunk threads to it, overflow chunks follow in the channel. */
export async function deliverToMessage(
  message: Message,
  answer: SemanticAnswer,
  ctx: DeliveryContext,
): Promise<void> {
  const payloads = prepare(answer, ctx);
  const channel = message.channel;
  const sendable =
    'send' in channel ? (channel as { send: (o: BaseMessageOptions) => Promise<unknown> }) : null;
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i]!;
    if (i === 0) {
      await message.reply(payload);
    } else if (sendable) {
      await sendable.send(payload);
    }
  }
}

/**
 * Put the answer into the deferred reply of a slash command: `edit` replaces
 * the "thinking…" placeholder with the first chunk; `follow_up` keeps what is
 * already shown (the acknowledgement) and adds the answer as new messages.
 * Returns false when there was nothing to send.
 */
export async function deliverToInteraction(
  interaction: InteractionReplyTarget,
  answer: SemanticAnswer,
  ctx: DeliveryContext,
  mode: 'edit' | 'follow_up' = 'edit',
): Promise<boolean> {
  const payloads = prepare(answer, ctx);
  if (payloads.length === 0) return false;
  const [first, ...rest] = payloads;
  if (mode === 'edit') await interaction.editReply(first!);
  else await interaction.followUp(first!);
  for (const extra of rest) await interaction.followUp(extra);
  return true;
}

/** A plain message into a channel: the answer of work that outlived the interaction token. */
export async function deliverToChannel(
  channel: { send: (o: BaseMessageOptions) => Promise<unknown> },
  answer: SemanticAnswer,
  ctx: DeliveryContext,
): Promise<boolean> {
  const payloads = prepare(answer, ctx);
  for (const payload of payloads) await channel.send(payload);
  return payloads.length > 0;
}

/** What a proactive post (a kernel send, no inbound message) reports back. */
export interface ProactivePost {
  /** Platform id of the first message, when Discord returned one. */
  readonly messageId?: string;
  /** The conversation the message went into (the DM channel for a DM). */
  readonly conversationId?: string;
}

/**
 * A proactive post: a message the kernel asked for (a notification to a person
 * or into a channel), not the answer to a received message. It goes out as a
 * `system` message: this channel has one bot identity, so nothing is posted in
 * an agent's own name. Returns undefined when there was nothing to send.
 */
export async function deliverProactive(
  target: { send: (o: BaseMessageOptions) => Promise<unknown> },
  message: { readonly text: string; readonly attachments?: SemanticAnswer['attachments'] },
  ctx: DeliveryContext,
): Promise<ProactivePost | undefined> {
  const payloads = prepare(
    { ...systemAnswer(message.text), ...(message.attachments ? { attachments: message.attachments } : {}) },
    ctx,
  );
  let post: ProactivePost | undefined;
  for (const payload of payloads) {
    const sent = (await target.send(payload)) as { id?: unknown; channelId?: unknown } | undefined;
    post ??= {
      ...(typeof sent?.id === 'string' ? { messageId: sent.id } : {}),
      ...(typeof sent?.channelId === 'string' ? { conversationId: sent.channelId } : {}),
    };
  }
  return post;
}

/**
 * Deliver the result of a paced slash-command turn. Past the interaction's
 * reply window the answer is a normal channel message (the token is dead);
 * after an acknowledgement it is added to the thread of messages rather than
 * replacing the acknowledgement; otherwise it replaces "thinking…".
 */
export async function deliverSlashResult(
  interaction: InteractionReplyTarget & { channel?: unknown },
  answer: SemanticAnswer,
  paced: { acknowledged: boolean; deliverAsFollowUp: boolean },
  ctx: DeliveryContext,
): Promise<boolean> {
  const channel = interaction.channel;
  if (paced.deliverAsFollowUp && channel && typeof channel === 'object' && 'send' in channel) {
    return deliverToChannel(channel as { send: (o: BaseMessageOptions) => Promise<unknown> }, answer, ctx);
  }
  return deliverToInteraction(interaction, answer, ctx, paced.acknowledged ? 'follow_up' : 'edit');
}

/** A reply only the sender sees, for an interaction that was not deferred. */
export async function deliverEphemeral(
  interaction: EphemeralReplyTarget,
  answer: SemanticAnswer,
  ctx: DeliveryContext,
): Promise<void> {
  const payloads = prepare(answer, ctx);
  const first = payloads[0];
  if (first) await interaction.reply({ ...first, ephemeral: true });
}

/** Turn a rendered result into one or more Discord message payloads; image embeds ride the last chunk. */
export function buildPayloads(result: DiscordRenderResult): BaseMessageOptions[] {
  const chunks = chunkContent(result.content);
  const hasEmbeds = result.embeds.length > 0;
  if (chunks.length === 0) {
    return hasEmbeds ? [{ embeds: result.embeds }] : [];
  }
  return chunks.map((content, i) =>
    hasEmbeds && i === chunks.length - 1 ? { content, embeds: result.embeds } : { content },
  );
}
