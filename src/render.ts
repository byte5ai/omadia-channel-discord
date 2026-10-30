import { type AnswerPart, OMADIA_NIGHT, renderAnswerTables } from '@omadia/table-render';
import {
  type ActionRowBuilder,
  AttachmentBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';

import type { SemanticAnswer, VerifierBadge } from '@omadia/channel-sdk';

import { interactiveQuestion } from './components.js';
import { toProseBlocks } from './markdown.js';
import { chunkText } from './text-chunk.js';

// Components V2 per-message limits.
const MAX_COMPONENTS = 40;
const MAX_TEXT = 4000;
const MAX_FILES = 10;
const MAX_GALLERY_ITEMS = 10;
const MEDIA_DESC_MAX = 1024;
// Default (non-boosted) guild upload cap. Larger files are linked instead.
const FILE_LIMIT_BYTES = 8 * 1024 * 1024;
// Legacy `content` cap for the plain-text fallback.
const CONTENT_LIMIT = 2000 - 16;

// Design-system table look on a transparent ground with no margin: the panel
// sits directly in the conversation, whatever the Discord theme or hover
// highlight behind it.
const TABLE_RENDER = {
  theme: { ...OMADIA_NIGHT, ground: 'transparent' },
  margin: 0,
};

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
type TopLevel =
  | TextDisplayBuilder
  | SeparatorBuilder
  | MediaGalleryBuilder
  | FileBuilder
  | Row;

/** One Components V2 message. Compatible with `send` / `reply` / `editReply`. */
export interface DiscordMessagePayload {
  flags: MessageFlags.IsComponentsV2;
  components: TopLevel[];
  files: AttachmentBuilder[];
  /** LLM output must never ping @everyone, roles or users. */
  allowedMentions: { parse: []; repliedUser: false };
}

/** Legacy text-only message, used when a V2 send is rejected. */
export interface PlainMessagePayload {
  content: string;
  allowedMentions: { parse: []; repliedUser: false };
}

const VERIFIER_LABEL: Record<VerifierBadge['status'], string> = {
  verified: '✅ Verifiziert',
  partial: '⚠\uFE0F Teilweise verifiziert',
  corrected: '✏\uFE0F Korrigiert',
  failed: '❌ Nicht verifiziert',
};

function trailerLines(answer: SemanticAnswer): string[] {
  const lines: string[] = [];
  const v = answer.verifier;
  if (v) {
    const label = VERIFIER_LABEL[v.status];
    lines.push(`-# ${v.hint ? `${label} — ${v.hint}` : label}`);
  }
  if (answer.disclaimer) lines.push(`-# ${answer.disclaimer}`);
  return lines;
}

function sanitizeFileName(name: string | undefined): string {
  const base = (name ?? 'datei').replace(/[/\\]+/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : 'datei';
}

/** Blocks in display order, before they are packed into messages. */
type Block =
  | { kind: 'text'; text: string }
  | { kind: 'separator' }
  | { kind: 'gallery'; items: MediaGalleryItemBuilder[]; uploads: AttachmentBuilder[] }
  | { kind: 'file'; upload: AttachmentBuilder }
  // An image by URL, resolved to an uploaded gallery item before packing.
  | { kind: 'remote-image'; url: string; alt: string };

type ResolvedBlock = Exclude<Block, { kind: 'remote-image' }>;

const IMAGE_FETCH_TIMEOUT_MS = 8000;
// Formats Discord displays inline. SVG is not one of them.
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function mediaItem(url: string, description: string): MediaGalleryItemBuilder {
  const item = new MediaGalleryItemBuilder().setURL(url);
  if (description) item.setDescription(description.slice(0, MEDIA_DESC_MAX));
  return item;
}

/**
 * Download an image and upload it with the message. Left to Discord's media
 * proxy, a URL only works when it is public and long-lived — diagrams from a
 * local or VPN-only Omadia, or behind short-lived signed links, would show as
 * an empty placeholder. Falls back to the plain URL if the download fails.
 */
async function resolveRemoteImage(
  block: Extract<Block, { kind: 'remote-image' }>,
  index: number,
  log: (message: string) => void,
): Promise<ResolvedBlock> {
  const fallback: ResolvedBlock = {
    kind: 'gallery',
    items: [mediaItem(block.url, block.alt)],
    uploads: [],
  };
  const res = await fetch(block.url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  })
    .then((r) => r)
    .catch((err: unknown) => {
      log(`image download failed (${block.url}): ${(err as Error).message}`);
      return null;
    });
  if (!res) return fallback;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const ext = IMAGE_EXT[type];
  if (!res.ok || !ext) {
    log(`image not uploadable (${block.url}): HTTP ${res.status}, ${type || 'no content-type'}`);
    return fallback;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > FILE_LIMIT_BYTES) return fallback;

  const name = `bild-${index}.${ext}`;
  return {
    kind: 'gallery',
    items: [mediaItem(`attachment://${name}`, block.alt)],
    uploads: [
      new AttachmentBuilder(bytes, {
        name,
        description: block.alt.slice(0, MEDIA_DESC_MAX),
      }),
    ],
  };
}

async function resolveBlocks(
  blocks: Block[],
  log: (message: string) => void,
): Promise<ResolvedBlock[]> {
  let n = 0;
  return Promise.all(
    blocks.map((b) =>
      b.kind === 'remote-image' ? resolveRemoteImage(b, ++n, log) : b,
    ),
  );
}

function proseToBlocks(markdown: string): Block[] {
  return toProseBlocks(markdown).flatMap((b): Block[] => {
    if (b.kind === 'separator') return [b];
    if (b.kind === 'image') return [{ kind: 'remote-image', url: b.url, alt: b.alt }];
    return chunkText(b.text, MAX_TEXT).map((text) => ({ kind: 'text', text }));
  });
}

function tableToBlocks(part: Extract<AnswerPart, { kind: 'table' }>): Block[] {
  // One gallery per page: several items in one gallery render as a mosaic,
  // which would shrink each table page to a thumbnail.
  const pages = part.images.map((img): Block => {
    const upload = new AttachmentBuilder(Buffer.from(img.png), {
      name: img.fileName,
      description: img.altText.slice(0, MEDIA_DESC_MAX),
    });
    return {
      kind: 'gallery',
      items: [mediaItem(`attachment://${img.fileName}`, img.altText)],
      uploads: [upload],
    };
  });
  const csv = new AttachmentBuilder(Buffer.from(part.csv.data), {
    name: part.csv.fileName,
  });
  return [...pages, { kind: 'file', upload: csv }];
}

function attachmentBlocks(answer: SemanticAnswer): {
  blocks: Block[];
  linkLines: string[];
} {
  const blocks: Block[] = [];
  const linkLines: string[] = [];
  // One gallery per image (full width) — these are usually diagrams.
  const images = (answer.attachments ?? []).filter((a) => a.kind === 'image');
  for (const img of images.slice(0, MAX_GALLERY_ITEMS)) {
    blocks.push({ kind: 'remote-image', url: img.url, alt: img.altText });
  }
  for (const att of answer.attachments ?? []) {
    if (att.kind !== 'file') continue;
    if (typeof att.sizeBytes === 'number' && att.sizeBytes > FILE_LIMIT_BYTES) {
      linkLines.push(`📎 [${att.altText || 'Datei'}](${att.url})`);
      continue;
    }
    // discord.js downloads the URL itself when the message is sent.
    blocks.push({
      kind: 'file',
      upload: new AttachmentBuilder(att.url, { name: sanitizeFileName(att.altText) }),
    });
  }
  return { blocks, linkLines };
}

function newPayload(): DiscordMessagePayload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [],
    files: [],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/**
 * Greedy packer: fills a message until the next block would break a V2 limit
 * (40 components incl. nested, 4000 text chars, 10 uploads), then starts a
 * new one. Action rows always go on the last message.
 */
function pack(blocks: ResolvedBlock[], rows: Row[]): DiscordMessagePayload[] {
  const payloads: DiscordMessagePayload[] = [];
  let cur = newPayload();
  let used = { components: 0, text: 0 };

  const cost = (b: ResolvedBlock): { components: number; text: number; files: number } => {
    switch (b.kind) {
      case 'text':
        return { components: 1, text: b.text.length, files: 0 };
      case 'separator':
        return { components: 1, text: 0, files: 0 };
      case 'gallery':
        return { components: 1 + b.items.length, text: 0, files: b.uploads.length };
      case 'file':
        return { components: 1, text: 0, files: 1 };
    }
  };

  for (const block of blocks) {
    const c = cost(block);
    const full =
      used.components + c.components > MAX_COMPONENTS ||
      used.text + c.text > MAX_TEXT ||
      cur.files.length + c.files > MAX_FILES;
    if (full && cur.components.length > 0) {
      payloads.push(cur);
      cur = newPayload();
      used = { components: 0, text: 0 };
    }
    // A separator right at a message boundary is just noise.
    if (block.kind === 'separator' && cur.components.length === 0) continue;

    switch (block.kind) {
      case 'text':
        cur.components.push(new TextDisplayBuilder().setContent(block.text));
        break;
      case 'separator':
        cur.components.push(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
        );
        break;
      case 'gallery':
        cur.components.push(new MediaGalleryBuilder().addItems(...block.items));
        cur.files.push(...block.uploads);
        break;
      case 'file':
        cur.components.push(
          new FileBuilder().setURL(`attachment://${block.upload.name ?? 'datei'}`),
        );
        cur.files.push(block.upload);
        break;
    }
    used = {
      components: used.components + c.components,
      text: used.text + c.text,
    };
  }

  const rowCost = rows.reduce((n, r) => n + 1 + r.components.length, 0);
  if (rows.length > 0 && used.components + rowCost > MAX_COMPONENTS && cur.components.length > 0) {
    payloads.push(cur);
    cur = newPayload();
  }
  cur.components.push(...rows);
  if (cur.components.length === 0) {
    cur.components.push(new TextDisplayBuilder().setContent('…'));
  }
  payloads.push(cur);
  return payloads;
}

/**
 * Render a `SemanticAnswer` into Components V2 messages: prose as text
 * displays, `---` as separators, markdown tables as image galleries (+ CSV
 * file, see @omadia/table-render), answer images as galleries, files as file
 * components, verifier/disclaimer as subtext, and the action rows last.
 */
export async function renderAnswer(
  answer: SemanticAnswer,
  rows: Row[] = [],
  log: (message: string) => void = () => undefined,
): Promise<DiscordMessagePayload[]> {
  let prose = answer.text ?? '';
  if (prose.trim().length === 0) {
    // Bare interactive element — surface its question so the buttons have context.
    prose = interactiveQuestion(answer) ?? '';
  }

  const parts = await renderAnswerTables(prose, TABLE_RENDER)
    .then((p) => p)
    .catch((err: unknown): AnswerPart[] => {
      // Never lose an answer over a rendering problem: fall back to the raw
      // markdown (tables then show as text, like in 0.1.x).
      log(`table rendering failed, sending raw markdown: ${(err as Error).message}`);
      return [{ kind: 'text', text: prose }];
    });

  const blocks: Block[] = parts.flatMap((p) =>
    p.kind === 'text' ? proseToBlocks(p.text) : tableToBlocks(p),
  );

  const { blocks: attBlocks, linkLines } = attachmentBlocks(answer);
  blocks.push(...attBlocks);

  const trailer = [...linkLines, ...trailerLines(answer)];
  if (trailer.length > 0) blocks.push({ kind: 'text', text: trailer.join('\n') });

  return pack(await resolveBlocks(blocks, log), rows);
}

/** Text-only fallback for a payload Discord rejected (keeps the answer). */
export function plainFallback(answer: SemanticAnswer): PlainMessagePayload[] {
  const text = [answer.text, ...trailerLines(answer)].filter(Boolean).join('\n\n');
  return chunkText(text || '…', CONTENT_LIMIT).map((content) => ({
    content,
    allowedMentions: { parse: [], repliedUser: false },
  }));
}
