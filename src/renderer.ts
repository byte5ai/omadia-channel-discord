import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

import type { FollowUpOption, OutgoingInteractive, SemanticAnswer } from '@omadia/channel-sdk';

import type { InteractionRegistry } from './interactions.js';

// `OutgoingRoutineList` and `PrivacyReceipt` are reachable via SemanticAnswer
// but not re-exported by name from the SDK index, so we address them
// structurally rather than importing the names.
type RoutineList = Extract<OutgoingInteractive, { kind: 'routine_list' }>;
type ChoiceLike = Exclude<OutgoingInteractive, { kind: 'routine_list' }>;
type PrivacyReceipt = NonNullable<SemanticAnswer['privacyReceipt']>;

/** Discord hard limit for a single message `content` field. */
export const DISCORD_MAX_CONTENT = 2000;
/** Max cell width when re-aligning a markdown table into a monospace block. */
const MAX_TABLE_COL = 40;
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

  const body = formatTables(mdToDiscord(a.text)).trim();
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

  if (a.privacyReceipt) {
    const receipt = renderPrivacyReceipt(a.privacyReceipt);
    if (receipt) parts.push(receipt);
  }

  return { content: parts.join('\n\n'), embeds, components };
}

/** Best-effort Markdown adjustment for Discord. Discord supports **bold**,
 *  *italic*, `code`, headings, lists and block-quotes natively, so we only fix
 *  masked links, which render literally in a normal (non-embed) message. */
export function mdToDiscord(md: string): string {
  return md.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DELIM = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * Discord does NOT render GitHub-flavored Markdown tables — `| a | b |` rows
 * show up as literal pipe text. Detect contiguous table blocks (header +
 * `---` delimiter + body rows) and re-emit each as a column-aligned monospace
 * block wrapped in a ``` code fence, which Discord DOES render with aligned
 * columns. Everything outside a table is passed through untouched.
 */
export function formatTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (TABLE_ROW.test(line) && next !== undefined && TABLE_DELIM.test(next) && next.includes('-')) {
      const block: string[] = [line];
      let j = i + 2; // skip header + delimiter
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) {
        block.push(lines[j]!);
        j++;
      }
      out.push(renderTableBlock(block));
      i = j - 1;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** `block` = header row + body rows (delimiter row already dropped). */
function renderTableBlock(block: string[]): string {
  const rows = block.map(splitRow);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.min(
      MAX_TABLE_COL,
      Math.max(...rows.map((r) => (r[c] ?? '').length)),
    );
  }
  const fmt = (cells: string[]): string =>
    Array.from({ length: cols }, (_, c) => pad(truncate(cells[c] ?? '', widths[c]!), widths[c]!)).join(
      ' | ',
    );
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const lines = [fmt(rows[0]!), sep, ...rows.slice(1).map(fmt)];
  return '```\n' + lines.join('\n') + '\n```';
}

/** Split a markdown table row into trimmed cells (drops the outer pipes). */
function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Render the Privacy-Shield receipt as a compact disclosure under the answer.
 * Discord has no collapsible UI, so this mirrors the web-ui PrivacyReceiptCard
 * as a one-line summary + a subtext explainer. PII-free by construction.
 * Returns '' when there is nothing meaningful to disclose.
 */
export function renderPrivacyReceipt(r: PrivacyReceipt): string {
  const parts: string[] = [];
  if (r.datasetsInterned > 0) {
    parts.push(`${r.datasetsInterned} ${plural(r.datasetsInterned, 'Tool-Ergebnis', 'Tool-Ergebnisse')} server-seitig verarbeitet`);
  }
  if (r.fieldsMasked > 0) {
    parts.push(`${r.fieldsMasked} ${plural(r.fieldsMasked, 'Feld', 'Felder')} maskiert`);
  }
  if (r.verbsExecuted.length > 0) {
    parts.push(`${r.verbsExecuted.length} ${plural(r.verbsExecuted.length, 'Verb', 'Verben')}`);
  }
  if (r.pseudonymProjectionUsed) parts.push('Pseudonyme verwendet');
  const identityOnWire = r.identityValuesOnWire ?? 0;
  if (identityOnWire > 0) {
    parts.push(`⚠ ${identityOnWire} ${plural(identityOnWire, 'Name', 'Namen')} ans Modell`);
  }
  const bypassed = r.bypassedTools ?? [];
  if (bypassed.length > 0) {
    parts.push(`${bypassed.length} ${plural(bypassed.length, 'Tool', 'Tools')} nicht maskiert`);
  }
  if (parts.length === 0) return '';

  const explainer =
    identityOnWire > 0
      ? 'Du hast eine Person namentlich genannt — dieser Name ging im Klartext an das Modell. Die aus den Tools geholten Daten blieben server-seitig hinter der Boundary.'
      : 'Rohe Tool-Ergebnisse blieben server-seitig hinter der Data-Plane-Boundary — das Modell sah nur einen identitätsfreien Digest.';
  const lines = [`🛡 **Privacy Shield** · ${parts.join(' · ')}`, `-# ${explainer}`];
  if (bypassed.length > 0) {
    lines.push(
      '-# Der Operator hat für mindestens ein Plugin den Privacy-Mode auf »Bypass« gestellt — dessen Tool-Ergebnisse erreichten das Modell unmaskiert.',
    );
  }
  return lines.join('\n');
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
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

const FENCE = '```';

/**
 * Split a message body into Discord-sized chunks (<= 2000 chars), breaking on
 * line boundaries. Fence-aware: if a chunk boundary falls inside a ``` code
 * block (e.g. a long re-aligned table), the open fence is closed at the end of
 * the chunk and re-opened at the start of the next, so every message renders
 * as valid Markdown. A single oversized line is hard-split as a last resort.
 */
export function chunkContent(content: string, max = DISCORD_MAX_CONTENT): string[] {
  if (content.length <= max) return content.length > 0 ? [content] : [];

  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;
  let openInBuf = false; // a ``` fence is currently open within buf
  let carryFence = false; // the next chunk must re-open a fence

  const startBuf = (): void => {
    buf = [];
    len = 0;
    openInBuf = false;
    if (carryFence) {
      buf.push(FENCE);
      len = FENCE.length + 1;
      openInBuf = true;
      carryFence = false;
    }
  };
  const flush = (): void => {
    if (buf.length === 0) return;
    const arr = buf.slice();
    if (openInBuf) {
      arr.push(FENCE); // close the dangling fence…
      carryFence = true; // …and re-open it in the next chunk
    }
    chunks.push(arr.join('\n'));
  };

  startBuf();
  for (const rawLine of content.split('\n')) {
    const pieces =
      rawLine.length > max
        ? Array.from({ length: Math.ceil(rawLine.length / max) }, (_, k) =>
            rawLine.slice(k * max, (k + 1) * max),
          )
        : [rawLine];
    for (const line of pieces) {
      const add = line.length + (buf.length > 0 ? 1 : 0);
      const reserveClose = openInBuf ? FENCE.length + 1 : 0;
      const baseline = carryFence ? 1 : 0; // a freshly re-opened fence isn't "real" content
      if (len + add + reserveClose > max && buf.length > baseline) {
        flush();
        startBuf();
      }
      buf.push(line);
      len += line.length + 1;
      if (line.trimStart().startsWith(FENCE)) openInBuf = !openInBuf;
    }
  }
  flush();
  return chunks;
}
