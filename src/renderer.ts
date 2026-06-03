import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

import type { FollowUpOption, OutgoingInteractive, SemanticAnswer } from '@omadia/channel-sdk';

// `OutgoingRoutineList` is a member of the OutgoingInteractive union but is not
// re-exported by name from the SDK index, so we address it structurally via its
// discriminant rather than importing the type.
type RoutineList = Extract<OutgoingInteractive, { kind: 'routine_list' }>;
type ChoiceLike = Exclude<OutgoingInteractive, { kind: 'routine_list' }>;

import type { InteractionRegistry } from './interactions.js';

/** Discord hard limit for a single message `content` field. */
export const DISCORD_MAX_CONTENT = 2000;
/** Discord button label limit. */
const MAX_BUTTON_LABEL = 80;
/** Buttons per ActionRow (Discord limit) and the rows we are willing to spend. */
const BUTTONS_PER_ROW = 5;
const MAX_CHOICE_BUTTONS = 10; // 2 rows
const MAX_FOLLOWUP_BUTTONS = 5; // 1 row
/** Discord allows at most 5 ActionRows per message. */
const MAX_ROWS = 5;

export interface DiscordRenderResult {
  /** Markdown message body. May exceed 2000 chars — chunk with {@link chunkContent}. */
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export interface RenderContext {
  conversationId: string;
  registry: InteractionRegistry;
}

/**
 * Render the orchestrator's channel-agnostic {@link SemanticAnswer} into a
 * native Discord message: markdown body + (where present) buttons for choice
 * cards / follow-ups and embeds for image attachments.
 *
 * Discord renders standard Markdown natively, so the body is passed through
 * almost untouched — the one exception is masked links `[label](url)`, which
 * only render inside embeds, not normal messages, so they degrade to
 * `label (url)`. Richer SDK primitives degrade per the documented graceful-
 * degradation contract: a routine-list becomes a text table, anything that
 * cannot fit in buttons is also echoed as a text list.
 */
export function renderAnswer(a: SemanticAnswer, ctx: RenderContext): DiscordRenderResult {
  const parts: string[] = [];
  const embeds: EmbedBuilder[] = [];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  const body = mdToDiscord(a.text).trim();
  if (body) parts.push(body);

  if (a.interactive) {
    const { text, rows } = renderInteractive(a.interactive, ctx);
    if (text) parts.push(text);
    for (const row of rows) {
      if (components.length < MAX_ROWS) components.push(row);
    }
  }

  for (const att of a.attachments ?? []) {
    if (att.kind === 'image') {
      embeds.push(new EmbedBuilder().setImage(att.url).setDescription(att.altText.slice(0, 4096)));
    } else {
      parts.push(`📎 ${att.altText}: ${att.url}`);
    }
  }

  if (a.followUps && a.followUps.length > 0 && components.length < MAX_ROWS) {
    const row = renderFollowUps(a.followUps, ctx);
    if (row) {
      parts.push('💡 *Du kannst auch fragen:*');
      components.push(row);
    }
  }

  if (a.disclaimer) parts.push(`*${a.disclaimer}*`);

  return { content: parts.join('\n\n'), embeds, components };
}

/** Best-effort Markdown adjustment for Discord. Discord supports **bold**,
 *  *italic*, `code`, headings, lists and block-quotes natively, so we only fix
 *  masked links, which render literally in a normal (non-embed) message. */
export function mdToDiscord(md: string): string {
  return md.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
}

interface ChoiceOption {
  label: string;
  /** Text replayed as the user's next message when the button is clicked. */
  replay: string;
}

function renderInteractive(
  interactive: OutgoingInteractive,
  ctx: RenderContext,
): { text: string; rows: ActionRowBuilder<ButtonBuilder>[] } {
  if (interactive.kind === 'routine_list') {
    return { text: renderRoutineList(interactive), rows: [] };
  }

  const lines = [`**${interactive.question}**`];
  if (interactive.kind === 'choice' && interactive.rationale) {
    lines.push(`*${interactive.rationale}*`);
  }

  const options = extractOptions(interactive);
  const rows = buildButtonRows(options, ctx, ButtonStyle.Primary, MAX_CHOICE_BUTTONS);

  // If there are more options than we can render as buttons, list the overflow
  // as text so nothing is silently dropped.
  if (options.length > MAX_CHOICE_BUTTONS) {
    for (const o of options) lines.push(`• ${o.label}`);
  }

  return { text: lines.join('\n'), rows };
}

function extractOptions(interactive: ChoiceLike): ChoiceOption[] {
  switch (interactive.kind) {
    case 'choice':
      return interactive.options.map((o) => ({ label: o.label, replay: o.value }));
    case 'topic':
      return interactive.topics.map((o) => ({ label: o.label, replay: o.value }));
    case 'slots':
      return interactive.slots.map((s) => ({ label: s.label, replay: s.slotId }));
  }
}

function renderFollowUps(
  followUps: FollowUpOption[],
  ctx: RenderContext,
): ActionRowBuilder<ButtonBuilder> | undefined {
  const options: ChoiceOption[] = followUps
    .slice(0, MAX_FOLLOWUP_BUTTONS)
    .map((f) => ({ label: f.label, replay: f.prompt }));
  const rows = buildButtonRows(options, ctx, ButtonStyle.Secondary, MAX_FOLLOWUP_BUTTONS);
  return rows[0];
}

function buildButtonRows(
  options: ChoiceOption[],
  ctx: RenderContext,
  style: ButtonStyle,
  maxButtons: number,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const capped = options.slice(0, maxButtons);
  for (let i = 0; i < capped.length; i += BUTTONS_PER_ROW) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const o of capped.slice(i, i + BUTTONS_PER_ROW)) {
      const customId = ctx.registry.register({
        conversationId: ctx.conversationId,
        prompt: o.replay,
      });
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(truncate(o.label, MAX_BUTTON_LABEL))
          .setStyle(style),
      );
    }
    rows.push(row);
  }
  return rows;
}

function renderRoutineList(list: RoutineList): string {
  const lines = [`**Routinen** (${list.filter}) — ${String(list.routines.length)}`];
  for (const r of list.routines) {
    const mark = r.status === 'active' ? '🟢' : '⏸';
    lines.push(`${mark} **${r.name}** — \`${r.cron}\``);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Split a message body into Discord-sized chunks (<= 2000 chars), preferring
 * to break on paragraph / line boundaries so formatting and code fences are
 * not severed mid-token. A single oversized line is hard-split as a last
 * resort.
 */
export function chunkContent(content: string, max = DISCORD_MAX_CONTENT): string[] {
  if (content.length <= max) return content.length > 0 ? [content] : [];
  const chunks: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
