import { EmbedBuilder } from 'discord.js';

import {
  renderPlainAnswer,
  type DecorationId,
  type SemanticAnswer,
  type SpeakerHistoryStore,
} from '@omadia/channel-sdk';

/** Discord hard limit for a single message `content` field. */
export const DISCORD_MAX_CONTENT = 2000;
/** Max cell width when re-aligning a markdown table into a monospace block. */
const MAX_TABLE_COL = 40;
/** A monospace table wider than this wraps badly on Discord, so above it we
 *  fall back to a per-record list instead. Tuned to fit the default desktop
 *  message column without soft-wrapping. */
const DISCORD_TABLE_MAX_WIDTH = 58;
/** Embed description limit for an image's alt text. */
const MAX_EMBED_DESCRIPTION = 4096;

/** The `ChannelPlugin.type` this channel is known by in the decoration registry. */
export const DISCORD_CHANNEL_TYPE = 'discord';

/**
 * A Discord message ready to send. Deliberately has no components (buttons)
 * and no reaction: Discord is a plain-text channel for omadia (spec 2042
 * §5.14), the only embeds are image attachments the agent produced.
 */
export interface DiscordRenderResult {
  /** Markdown message body. May exceed 2000 chars — chunk with {@link chunkContent}. */
  content: string;
  /** Image attachments of the answer (content, not decoration). */
  embeds: EmbedBuilder[];
  /**
   * The decorations this render attached to the message, by registry id.
   * Always empty today: the AI disclosure line is part of `answer.text`
   * (the kernel folds it in by the operator's frequency setting), so the
   * channel adds nothing of its own. Every id listed here must pass
   * `admitDecorations(DISCORD_CHANNEL_TYPE, …)`.
   */
  decorations: readonly { readonly id: DecorationId }[];
}

export interface RenderContext {
  /** Conversation key for the speaker history (name-line decision). */
  conversationKey: string;
  speakerHistory: SpeakerHistoryStore;
}

/**
 * Render the kernel's channel-agnostic {@link SemanticAnswer} as a Discord
 * message: what a colleague would write, nothing more (spec 2042 §5.14).
 *
 * The SDK's reference renderer decides the text: a name line only where INV-4
 * asks for one (this channel has ONE bot identity, so the SDK adds it when
 * several agents speak in the conversation), colleagues' contributions as
 * "Mira: …", a `system` notice as its own text, cards as numbered text. No
 * verifier badge, consulted footer, follow-up list, disclaimer, privacy
 * receipt or buttons: their purpose lives in the structured answer.
 *
 * Discord renders Markdown natively, so the text is passed through almost
 * untouched: masked links `[label](url)` only render inside embeds and
 * degrade to `label (url)`, and GFM tables (which Discord shows as literal
 * pipes) become aligned code blocks.
 */
export function renderAnswer(a: SemanticAnswer, ctx: RenderContext): DiscordRenderResult {
  const plain = renderPlainAnswer(a, {
    nativeIdentity: false,
    conversationKey: ctx.conversationKey,
    speakerHistory: ctx.speakerHistory,
  });
  const parts: string[] = [];
  const body = formatTables(mdToDiscord(plain)).trim();
  if (body) parts.push(body);

  const embeds: EmbedBuilder[] = [];
  for (const att of a.attachments ?? []) {
    if (att.kind === 'image') {
      embeds.push(
        new EmbedBuilder().setImage(att.url).setDescription(att.altText.slice(0, MAX_EMBED_DESCRIPTION)),
      );
    } else {
      parts.push(`${att.altText}: ${att.url}`);
    }
  }

  return { content: parts.join('\n\n'), embeds, decorations: [] };
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

/**
 * `block` = header row + body rows (delimiter row already dropped). The header
 * defines the canonical column count (GFM: extra body cells are ignored, short
 * rows are padded) so a single ragged source row can't shift the whole table.
 *
 * Hybrid layout: an aligned monospace table reads great but only while it fits
 * Discord's width — beyond {@link DISCORD_TABLE_MAX_WIDTH} every row soft-wraps
 * into an unreadable mess, so wide tables fall back to a per-record list.
 */
function renderTableBlock(block: string[]): string {
  const header = splitRow(block[0]!);
  const cols = header.length;
  const rows = block.map((r) => normalizeRow(splitRow(r), cols));

  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(MAX_TABLE_COL, Math.max(...rows.map((r) => r[c]!.length))),
  );
  const fmt = (cells: string[]): string =>
    cells.map((cell, c) => pad(truncate(cell, widths[c]!), widths[c]!)).join(' | ');
  const tableLines = [fmt(rows[0]!), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.slice(1).map(fmt)];
  const widest = Math.max(...tableLines.map((l) => l.length));

  if (widest <= DISCORD_TABLE_MAX_WIDTH) {
    return '```\n' + tableLines.join('\n') + '\n```';
  }
  return renderRecords(header, rows.slice(1));
}

/**
 * Per-record fallback for tables too wide for a Discord code block. Each row
 * becomes a bold key + name title line plus a single `Header: value · …`
 * detail line (plain text, which Discord soft-wraps cleanly). Empty cells are
 * skipped. Generic over any table: column 0 = key, column 1 = name, the rest
 * are labelled details.
 */
function renderRecords(header: string[], dataRows: string[][]): string {
  return dataRows
    .map((cells) => {
      const title = [cells[0] ? `**${cells[0]}**` : '', cells[1] ?? '']
        .filter((s) => s.length > 0)
        .join(' · ');
      const details: string[] = [];
      for (let i = 2; i < header.length; i++) {
        const value = cells[i] ?? '';
        if (value.length > 0) details.push(`${header[i]}: ${value}`);
      }
      return details.length > 0 ? `${title}\n${details.join(' · ')}` : title;
    })
    .join('\n\n');
}

/** Clip a row to the header's column count and right-pad short rows. */
function normalizeRow(cells: string[], cols: number): string[] {
  const out = cells.slice(0, cols);
  while (out.length < cols) out.push('');
  return out;
}

/**
 * Split a markdown table row into trimmed cells. Escape-aware: a `\|` inside a
 * cell is a literal pipe (GFM), not a column boundary — without this, a
 * supplier name like `World of Sweets GmbH \|` would shift every following
 * column in that row. Drops the outer pipes.
 */
function splitRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
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
