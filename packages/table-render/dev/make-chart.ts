/* eslint-disable no-console -- dev asset generator */
// Renders a sample bar chart in the omadia UI "chart · bar" style: no colour
// palette, light levels only, the most important bar brightest. Used as the
// stand-in diagram for channel-discord's "bild" scenario:
//   node scripts/make-chart.mjs ../../dev/assets/umsatz.png transparent
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';

import archivoMedium from '@fontsource/archivo/files/archivo-latin-500-normal.woff';
import archivoRegular from '@fontsource/archivo/files/archivo-latin-400-normal.woff';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

import { OMADIA_NIGHT } from '../src/theme.js';

// Bars use two tones the table theme doesn't need: Linie stark and Text.
// Optional 2nd arg overrides Grund, e.g. a channel's chat background.
const T = {
  ...OMADIA_NIGHT,
  ground: process.argv[3] ?? OMADIA_NIGHT.ground,
  lineStrong: '#2E2E33',
  text: '#A1A1AA',
};

const DATA: Array<[string, number]> = [
  ['Januar', 120], ['Februar', 135], ['März', 128], ['April', 150], ['Mai', 162],
  ['Juni', 158], ['Juli', 171], ['August', 149], ['September', 180], ['Oktober', 192],
];
const MAX = 200;
const HIGHLIGHT = 'Oktober';

const div = (style: Record<string, unknown>, children?: unknown) => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

const rows = DATA.map(([label, value]) => {
  const lit = label === HIGHLIGHT;
  return div({ alignItems: 'center', gap: 10, height: 26 }, [
    div({ width: 90, fontSize: 13, color: T.text }, label),
    div({ flexGrow: 1, height: 10, borderRadius: 3, backgroundColor: T.line }, [
      div({
        width: `${(value / MAX) * 100}%`,
        height: 10,
        borderRadius: 3,
        backgroundColor: lit ? T.ink : T.lineStrong,
      }),
    ]),
    div({ width: 44, justifyContent: 'flex-end', fontSize: 13, color: lit ? T.ink : T.text }, String(value)),
  ]);
});

const tree = div(
  {
    // Transparent ground → no margin, like the table images in Discord.
    padding: T.ground === 'transparent' ? 0 : 16,
    backgroundColor: T.ground,
    fontFamily: 'Archivo',
    width: 640,
    boxSizing: 'border-box',
  },
  [
    div(
      {
        flexDirection: 'column',
        gap: 14,
        flexGrow: 1,
        padding: 24,
        backgroundColor: T.surface,
        border: `1px solid ${T.line}`,
        borderRadius: 14,
      },
      [
        div({ justifyContent: 'space-between', alignItems: 'baseline' }, [
          div({ fontSize: 16, fontWeight: 500, color: T.ink }, 'Umsatz 2026'),
          div({ fontSize: 13, color: T.meta }, 'Tsd. €'),
        ]),
        div({ flexDirection: 'column', gap: 4 }, rows),
      ],
    ),
  ],
);

await initWasm(resvgWasm);
const svg = await satori(tree as never, {
  width: 640,
  fonts: [
    { name: 'Archivo', data: Buffer.from(archivoRegular), weight: 400, style: 'normal' },
    { name: 'Archivo', data: Buffer.from(archivoMedium), weight: 500, style: 'normal' },
  ],
});
const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
const out = resolve(process.argv[2] ?? 'dev/out/umsatz.png');
writeFileSync(out, png);
console.log(`✓ ${out} (${png.byteLength} B)`);
