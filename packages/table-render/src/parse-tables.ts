export type ColumnAlign = 'left' | 'center' | 'right';

export interface MarkdownTable {
  headers: string[];
  aligns: ColumnAlign[];
  rows: string[][];
  /** The table exactly as it appeared in the source text. */
  source: string;
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: MarkdownTable };

const DELIMITER_CELL = /^\s*:?-{1,}:?\s*$/;

/** Split a GFM table row into cells, honouring escaped pipes and code spans. */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  const cells: string[] = [];
  let buf = '';
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c));
}

function alignOf(cell: string): ColumnAlign {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function looksLikeRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

/**
 * Cut `text` into prose and GFM-table segments. Tables inside fenced code
 * blocks are left alone — the model sometimes shows table *syntax* on purpose.
 */
export function parseSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let prose: string[] = [];
  let inFence = false;

  const flushProse = (): void => {
    if (prose.length === 0) return;
    segments.push({ kind: 'text', text: prose.join('\n') });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const next = lines[i + 1];
    const startsTable =
      !inFence &&
      looksLikeRow(line) &&
      next !== undefined &&
      isDelimiterRow(next) &&
      splitRow(line).length === splitRow(next).length;
    if (!startsTable) {
      prose.push(line);
      continue;
    }

    const headers = splitRow(line);
    const aligns = splitRow(next).map(alignOf);
    const rows: string[][] = [];
    const sourceLines = [line, next];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const rowLine = lines[j] ?? '';
      if (!looksLikeRow(rowLine)) break;
      const cells = splitRow(rowLine);
      // GFM: pad short rows, drop excess cells.
      while (cells.length < headers.length) cells.push('');
      rows.push(cells.slice(0, headers.length));
      sourceLines.push(rowLine);
    }

    flushProse();
    segments.push({
      kind: 'table',
      table: { headers, aligns, rows, source: sourceLines.join('\n') },
    });
    i = j - 1;
  }
  flushProse();
  return segments;
}

/** Strip inline markdown for contexts that cannot render it (images, CSV). */
export function plainCell(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}
