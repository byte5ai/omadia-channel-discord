import { type MarkdownTable, plainCell } from './parse-tables.js';

function csvField(value: string): string {
  return /[",;\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * RFC-4180 CSV with a UTF-8 BOM so Excel (de-DE) opens umlauts correctly.
 * Semicolon-separated: a comma-CSV opens as one column in German Excel.
 */
export function toCsv(table: MarkdownTable): string {
  const lines = [table.headers, ...table.rows].map((row) =>
    row.map((c) => csvField(plainCell(c))).join(';'),
  );
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Two-column table → "**key:** value" lines; keeps inline markdown. The header
 * row is dropped: it is almost always "Feld | Wert" and the keys say enough.
 */
export function toKeyValueLines(table: MarkdownTable): string {
  return table.rows.map(([k = '', v = '']) => `**${k}:** ${v}`).join('\n');
}

/** Wide table → one block per row, first column as the block title. */
export function toCards(table: MarkdownTable): string {
  const [, ...restHeaders] = table.headers;
  return table.rows
    .map(([title = '', ...rest]) => {
      const fields = rest
        .map((v, i) => (v.length > 0 ? `${restHeaders[i] ?? ''}: ${v}` : null))
        .filter((f): f is string => f !== null);
      return [`**${title}**`, ...fields.map((f) => `> ${f}`)].join('\n');
    })
    .join('\n\n');
}

/**
 * Plain-text rendering used as image alt text (Discord caps descriptions at
 * 1024 chars) — screen readers and search get the data, not "image.png".
 */
export function toAltText(table: MarkdownTable, max = 1024): string {
  const rows = [table.headers, ...table.rows].map((r) =>
    r.map(plainCell).join(' | '),
  );
  const full = rows.join('\n');
  return full.length <= max ? full : `${full.slice(0, max - 1)}…`;
}
