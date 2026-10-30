import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';

import archivoMedium from '@fontsource/archivo/files/archivo-latin-500-normal.woff';
import archivoRegular from '@fontsource/archivo/files/archivo-latin-400-normal.woff';
import geistMono from '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

import {
  CELL_PAD_X,
  CELL_PAD_Y,
  columnWidths,
  HEADER_HEIGHT,
  MIN_COL,
  OUTER_PAD,
  ROW_HEIGHT,
  STATUS_DOT_WIDTH,
} from './measure.js';
import { type ColumnAlign, plainCell } from './parse-tables.js';
import { parseStatus } from './status.js';
import { OMADIA_NIGHT, type StatusTone, type TableTheme } from './theme.js';

export interface RenderTableInput {
  /** Raw markdown cells; inline markup is resolved here. */
  headers: string[];
  rows: string[][];
  aligns: ColumnAlign[];
  /** e.g. "Seite 2/3" — rendered under the table. */
  footer?: string;
}

export interface RenderOptions {
  /** OMADIA_NIGHT (default) or OMADIA_DAY. */
  theme?: TableTheme;
  /** Logical width cap in px; columns wrap their text beyond it. */
  maxWidth?: number;
  /** Device-pixel ratio of the PNG. */
  scale?: number;
  /**
   * Space around the panel in px (default 16). With a `transparent` ground
   * the host's own background shows there, so 0 lets the panel sit flush.
   */
  margin?: number;
}

// Design system type scale: table text 14/400, header 13/500, IDs Geist Mono 13.
const TEXT_SIZE = 14;
const HEADER_SIZE = 13;
const MONO_SIZE = 13;
const PANEL_RADIUS = 10;

let wasmReady: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  wasmReady ??= initWasm(resvgWasm).catch((e: unknown) => {
    wasmReady = null;
    throw e;
  });
  await wasmReady;
}

type Node = {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown };
};

function div(style: Record<string, unknown>, children?: unknown): Node {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

const JUSTIFY: Record<ColumnAlign, string> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

/** What one body cell shows, resolved from its markdown. */
interface CellContent {
  text: string;
  tone: StatusTone | null;
  mono: boolean;
}

function cellContent(raw: string): CellContent {
  // A cell that is one code span is an ID or code → Geist Mono.
  const mono = /^`[^`]+`$/.test(raw.trim());
  const { tone, text } = parseStatus(plainCell(raw));
  return { text, tone, mono };
}

function cellBox(
  width: number,
  align: ColumnAlign,
  minHeight: number,
  children: unknown,
): Node {
  return div(
    {
      width,
      minHeight,
      // satori defaults to content-box: padding would add to the column width.
      boxSizing: 'border-box',
      flexShrink: 0,
      alignItems: 'center',
      padding: `${CELL_PAD_Y}px ${CELL_PAD_X}px`,
      justifyContent: JUSTIFY[align],
      textAlign: align,
    },
    children,
  );
}

function bodyCell(c: CellContent, theme: TableTheme): unknown {
  if (c.tone) {
    // Status: coloured text with a 6px dot — the only colour in the image.
    const color = theme.status[c.tone];
    return div({ alignItems: 'center', gap: 8, color }, [
      div({ width: 6, height: 6, borderRadius: 999, backgroundColor: color, flexShrink: 0 }),
      c.text,
    ]);
  }
  if (c.mono) {
    return div({ fontFamily: 'Geist Mono', fontSize: MONO_SIZE }, c.text);
  }
  return c.text;
}

function tableTree(
  headers: string[],
  rows: CellContent[][],
  aligns: ColumnAlign[],
  widths: number[],
  footer: string | undefined,
  theme: TableTheme,
  margin: number,
): Node {
  const header = div(
    { borderBottom: `1px solid ${theme.line}` },
    headers.map((h, col) =>
      cellBox(
        widths[col] ?? MIN_COL,
        aligns[col] ?? 'left',
        HEADER_HEIGHT,
        div({ color: theme.meta, fontSize: HEADER_SIZE, fontWeight: 500 }, h),
      ),
    ),
  );
  // No zebra, no row rules: the design system separates by light, not lines.
  const body = rows.map((row) =>
    div(
      { color: theme.ink },
      headers.map((_, col) =>
        cellBox(
          widths[col] ?? MIN_COL,
          aligns[col] ?? 'left',
          ROW_HEIGHT,
          bodyCell(row[col] ?? { text: '', tone: null, mono: false }, theme),
        ),
      ),
    ),
  );

  const panel: Record<string, unknown> = {
    flexDirection: 'column',
    backgroundColor: theme.surface,
    border: `1px solid ${theme.line}`,
    borderRadius: PANEL_RADIUS,
    overflow: 'hidden',
  };
  if (theme.shadow) panel.boxShadow = theme.shadow;

  const children: Node[] = [div(panel, [header, ...body])];
  if (footer) {
    children.push(div({ marginTop: 10, color: theme.meta, fontSize: 13 }, footer));
  }
  return div(
    {
      flexDirection: 'column',
      padding: margin,
      backgroundColor: theme.ground,
      fontFamily: 'Archivo',
      fontSize: TEXT_SIZE,
      lineHeight: 1.35,
    },
    children,
  );
}

export async function renderTablePng(
  input: RenderTableInput,
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const theme = options.theme ?? OMADIA_NIGHT;
  const headers = input.headers.map((h) => parseStatus(plainCell(h)).text);
  const rows = input.rows.map((r) => headers.map((_, col) => cellContent(r[col] ?? '')));

  // Status cells carry a dot in front of the text; measure it as extra width.
  const measured = rows.map((r) =>
    r.map((c) => (c.tone ? ' '.repeat(STATUS_DOT_WIDTH) : '') + c.text),
  );
  const margin = options.margin ?? OUTER_PAD;
  const widths = columnWidths(headers, measured, options.maxWidth ?? 720);
  const width = widths.reduce((a, b) => a + b, 0) + margin * 2 + 2;

  await ensureWasm();
  const svg = await satori(
    tableTree(headers, rows, input.aligns, widths, input.footer, theme, margin) as never,
    {
      width,
      fonts: [
        { name: 'Archivo', data: Buffer.from(archivoRegular), weight: 400, style: 'normal' },
        { name: 'Archivo', data: Buffer.from(archivoMedium), weight: 500, style: 'normal' },
        { name: 'Geist Mono', data: Buffer.from(geistMono), weight: 400, style: 'normal' },
      ],
    },
  )
    .then((s) => s)
    .catch((e: unknown) => {
      throw new Error(`table layout failed: ${String(e)}`);
    });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: options.scale ?? 2 },
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();
  resvg.free();
  return png;
}
