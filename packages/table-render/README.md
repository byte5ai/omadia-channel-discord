# @omadia/table-render

Turns the markdown tables in an orchestrator answer into something a chat
without table support can show: Discord now, iMessage next. It is bundled
*into* each channel plugin, not run as a host service. There are no native
deps: satori does the layout, `@resvg/resvg-wasm` rasterises, and esbuild
inlines the fonts and the resvg WASM.

```ts
const parts = await renderAnswerTables(answer.text, { theme: OMADIA_NIGHT });
// → [{ kind: 'text', text }, { kind: 'table', images: [{ png, fileName, altText }], csv }, …]
```

| Shape | When | Output |
|---|---|---|
| `kv` | 2 columns, cells ≤ 120 chars | `**key:** value` lines (stays text) |
| `image` | ≤ 6 columns, or more if they fit in 720 px | PNG (2×), a new image every 20 rows, plus CSV and alt text |
| `cards` | > 6 columns and too wide | one quoted block per row |

Tables inside code fences are left alone.

## Look: omadia UI design system

Images follow the omadia UI design system (canvas "omadia UI", boards
*Tokens* and *Daten*). The tokens are in `src/theme.ts`. Use `OMADIA_NIGHT`
(default) or `OMADIA_DAY`.

- The table is a panel on *Fläche* with a 1 px *Linie* border and a 10 px radius, sitting on *Grund*.
- Header is 13/500 in *Meta*, 38 px high. Rows are 14/400 in *Tinte*, 44 px min. No zebra stripes and no row rules.
- Numeric columns are right-aligned automatically.
- Type is Archivo. A cell that is a single code span (`` `PROJ-2231` ``) renders in Geist Mono 13.
- **Colour is status only.** ✅/⚠️/❌ and similar become coloured text with a 6 px dot (*Verifiziert*, *Achtung*, *Fehler*). Every other emoji is dropped from the image. The CSV and alt text keep the original.
- *Tag* adds the panel shadow, which falls to the bottom left.

`dev/make-chart.ts` renders a sample bar chart in the *chart · bar* style:
light levels instead of a palette, with the key bar in *Tinte*.

## Run

From the repository root (npm workspace):

```bash
npm install
npm run typecheck -w @omadia/table-render
npm run spike -w @omadia/table-render   # bundle → render dev/fixtures.ts (Nacht + some Tag) → dev/out/
```

From this folder, `node scripts/make-chart.mjs [out.png] [ground]` renders the
sample chart, for example the one used by the Discord dev scenario
(`../../dev/assets/umsatz.png transparent`).

## Integration notes

- The channel's esbuild needs `loader: { '.woff': 'binary', '.wasm': 'binary' }`.
- satori imports `createRequire` itself, so a `require` banner must alias it
  (see scripts/build-spike.mjs).
- Archivo and Geist Mono are SIL OFL 1.1, and their notices belong in the
  channel's THIRD_PARTY_NOTICES (this repo: `THIRD_PARTY_NOTICES.md`).
