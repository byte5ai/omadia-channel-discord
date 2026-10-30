import {
  classifyTable,
  DEFAULT_LIMITS,
  effectiveAligns,
  paginate,
  type ShapeLimits,
  type TableShape,
} from './classify.js';
import { parseSegments } from './parse-tables.js';
import { renderTablePng, type RenderOptions } from './render-png.js';
import { toAltText, toCards, toCsv, toKeyValueLines } from './to-text.js';

export type { MarkdownTable, Segment } from './parse-tables.js';
export type { TableShape, ShapeLimits } from './classify.js';
export { OMADIA_DAY, OMADIA_NIGHT, type StatusTone, type TableTheme } from './theme.js';
export { parseSegments } from './parse-tables.js';

export interface TableImage {
  png: Uint8Array;
  fileName: string;
  /** Plain-text table content (≤1024 chars) for the attachment description. */
  altText: string;
}

export interface TableFile {
  data: Uint8Array;
  fileName: string;
  contentType: string;
}

/**
 * Ordered answer parts. A channel renders them in sequence — Discord as
 * Components V2 TextDisplay / MediaGallery / File, iMessage as consecutive
 * bubbles. `text` parts are still markdown.
 */
export type AnswerPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'table';
      shape: Exclude<TableShape, 'kv' | 'cards'>;
      images: TableImage[];
      csv: TableFile;
    };

export interface RenderAnswerOptions extends RenderOptions {
  limits?: ShapeLimits;
  /** Base name for generated files, e.g. "tabelle" → tabelle-1.png. */
  fileBaseName?: string;
}

/** Merge adjacent text parts so channels don't emit needless extra messages. */
function pushText(parts: AnswerPart[], text: string): void {
  if (text.trim().length === 0) return;
  const last = parts.at(-1);
  if (last?.kind === 'text') last.text = `${last.text}\n${text}`;
  else parts.push({ kind: 'text', text });
}

/**
 * Turn an answer's markdown into channel-ready parts: every GFM table is
 * replaced by the shape that reads best in a chat (see `classifyTable`).
 */
export async function renderAnswerTables(
  text: string,
  options: RenderAnswerOptions = {},
): Promise<AnswerPart[]> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const base = options.fileBaseName ?? 'tabelle';
  const parts: AnswerPart[] = [];
  let tableNo = 0;

  for (const segment of parseSegments(text)) {
    if (segment.kind === 'text') {
      pushText(parts, segment.text);
      continue;
    }
    const table = segment.table;
    const shape = classifyTable(table, limits);
    if (shape === 'kv') {
      pushText(parts, toKeyValueLines(table));
      continue;
    }
    if (shape === 'cards') {
      pushText(parts, toCards(table));
      continue;
    }

    tableNo++;
    const aligns = effectiveAligns(table);
    const pages = paginate(table.rows, limits.rowsPerImage);
    const images: TableImage[] = [];
    for (const [i, pageRows] of pages.entries()) {
      const footer =
        pages.length > 1 ? `Seite ${i + 1}/${pages.length}` : undefined;
      const png = await renderTablePng(
        { headers: table.headers, rows: pageRows, aligns, footer },
        { ...options, maxWidth: options.maxWidth ?? limits.maxImageWidth },
      );
      const suffix = pages.length > 1 ? `-${i + 1}` : '';
      images.push({
        png,
        fileName: `${base}-${tableNo}${suffix}.png`,
        altText: toAltText({ ...table, rows: pageRows }),
      });
    }
    parts.push({
      kind: 'table',
      shape,
      images,
      csv: {
        data: new TextEncoder().encode(toCsv(table)),
        fileName: `${base}-${tableNo}.csv`,
        contentType: 'text/csv; charset=utf-8',
      },
    });
  }
  return parts;
}
