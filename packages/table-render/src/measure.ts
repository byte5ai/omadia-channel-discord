// Width estimation shared by the classifier and the PNG renderer. Estimates,
// not measurements: satori lays out for real, these only pick a shape and
// column budget before rendering.

export const CELL_PAD_X = 12;
export const CELL_PAD_Y = 10;
// Design system row heights: header 38px, body rows 44px (minimum; wrapped
// cells grow).
export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 44;
// Average advance of Archivo at 14px, slightly generous so estimates rarely clip.
const CHAR_WIDTH = 7.9;
export const MIN_COL = 56;
export const OUTER_PAD = 16;
/** A status dot (6px + 8px gap) measured as this many characters. */
export const STATUS_DOT_WIDTH = 2;

function naturalWidth(text: string, bold: boolean): number {
  const factor = bold ? 1.05 : 1;
  return Math.ceil(text.length * CHAR_WIDTH * factor) + CELL_PAD_X * 2;
}

function naturalColumns(headers: string[], rows: string[][]): number[] {
  return headers.map((h, col) =>
    Math.max(
      MIN_COL,
      naturalWidth(h, true),
      ...rows.map((r) => naturalWidth(r[col] ?? '', false)),
    ),
  );
}

/** Width the table would take with no wrapping, outer padding included. */
export function naturalTableWidth(headers: string[], rows: string[][]): number {
  return (
    naturalColumns(headers, rows).reduce((a, b) => a + b, 0) + OUTER_PAD * 2
  );
}

/**
 * Natural column widths, then a water-level cap so the table fits `maxWidth`:
 * only the widest columns shrink (and wrap); narrow ones keep their size.
 */
export function columnWidths(
  headers: string[],
  rows: string[][],
  maxWidth: number,
): number[] {
  const natural = naturalColumns(headers, rows);
  const budget = maxWidth - OUTER_PAD * 2;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= budget) return natural;

  const sorted = [...natural].sort((a, b) => a - b);
  let remaining = budget;
  let cap = MIN_COL;
  for (let i = 0; i < sorted.length; i++) {
    const left = sorted.length - i;
    const share = remaining / left;
    const w = sorted[i] ?? 0;
    if (w > share) {
      cap = Math.max(MIN_COL, Math.floor(share));
      break;
    }
    remaining -= w;
    cap = w;
  }
  return natural.map((w) => Math.min(w, cap));
}
