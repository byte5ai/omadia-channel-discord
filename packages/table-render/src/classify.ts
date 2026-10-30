import { naturalTableWidth } from './measure.js';
import { type ColumnAlign, type MarkdownTable, plainCell } from './parse-tables.js';

/**
 * How a table should be shown in a chat that cannot render markdown tables:
 *  - `kv`    two columns → one "**key:** value" line per row (stays text)
 *  - `image` fits a phone screen as a picture (wide cells wrap inside it)
 *  - `cards` many columns AND too wide to fit → one block per row
 */
export type TableShape = 'kv' | 'image' | 'cards';

export interface ShapeLimits {
  /** Up to this many columns an image is used however wide the text is. */
  maxImageColumns: number;
  /** Logical image width; more columns still render if they fit in it. */
  maxImageWidth: number;
  /** Rows per rendered image; longer tables are split into pages. */
  rowsPerImage: number;
  /** A 2-column table whose cells stay below this length renders as kv. */
  maxKvCellLength: number;
}

export const DEFAULT_LIMITS: ShapeLimits = {
  maxImageColumns: 6,
  maxImageWidth: 720,
  rowsPerImage: 20,
  maxKvCellLength: 120,
};

const NUMERIC_CELL =
  /^[-+−]?[€$£]?\s?\d[\d.,'\s]*(\s?(%|€|\$|£|k|m|mio\.?|tsd\.?|h|min|std\.?))?$/i;

export function classifyTable(
  table: MarkdownTable,
  limits: ShapeLimits = DEFAULT_LIMITS,
): TableShape {
  const cols = table.headers.length;
  if (cols === 2) {
    const longest = Math.max(
      ...table.rows.flat().map((c) => plainCell(c).length),
      0,
    );
    if (longest <= limits.maxKvCellLength) return 'kv';
  }
  if (cols <= limits.maxImageColumns) return 'image';
  // Many columns: fine as long as they are narrow (e.g. a month matrix);
  // squeezing long text into 7+ wrapped columns is what becomes unreadable.
  const plain = (row: string[]): string[] => row.map(plainCell);
  const width = naturalTableWidth(plain(table.headers), table.rows.map(plain));
  return width <= limits.maxImageWidth ? 'image' : 'cards';
}

/**
 * Effective alignment per column: an explicit GFM alignment wins; otherwise a
 * column whose non-empty cells are mostly numbers is right-aligned.
 */
export function effectiveAligns(table: MarkdownTable): ColumnAlign[] {
  return table.headers.map((_, col) => {
    const explicit = table.aligns[col] ?? 'left';
    if (explicit !== 'left') return explicit;
    const values = table.rows
      .map((r) => plainCell(r[col] ?? ''))
      .filter((v) => v.length > 0 && v !== '-' && v !== '–');
    if (values.length === 0) return 'left';
    const numeric = values.filter((v) => NUMERIC_CELL.test(v)).length;
    return numeric / values.length >= 0.8 ? 'right' : 'left';
  });
}

export function paginate<T>(rows: T[], size: number): T[][] {
  if (rows.length <= size) return [rows];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}
