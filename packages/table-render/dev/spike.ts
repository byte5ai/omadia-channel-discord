/* eslint-disable no-console -- dev runner */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OMADIA_DAY, renderAnswerTables, type TableTheme } from '../src/index.js';

import { FIXTURES } from './fixtures.js';

const outDir = join(process.cwd(), 'dev/out');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Every fixture in Nacht (the default), a few again in Tag.
const runs: Array<[string, string, TableTheme | undefined]> = [
  ...Object.entries(FIXTURES).map(([n, t]): [string, string, undefined] => [n, t, undefined]),
  ['medium-tag', FIXTURES.medium ?? '', OMADIA_DAY],
  ['status-tag', FIXTURES.status ?? '', OMADIA_DAY],
];

for (const [name, text, theme] of runs) {
  const started = performance.now();
  const parts = await renderAnswerTables(text, { fileBaseName: name, theme });
  const ms = Math.round(performance.now() - started);

  const summary = parts.map((p) =>
    p.kind === 'text'
      ? `text(${p.text.length})`
      : `table:${p.shape}[${p.images.length} png]`,
  );
  console.log(`${name.padEnd(9)} ${String(ms).padStart(5)} ms  ${summary.join(' → ')}`);

  const textOut: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      textOut.push(p.text);
      continue;
    }
    for (const img of p.images) {
      writeFileSync(join(outDir, img.fileName), img.png);
      textOut.push(`[image ${img.fileName} ${img.png.byteLength} B]`);
    }
    writeFileSync(join(outDir, p.csv.fileName), p.csv.data);
    textOut.push(`[file ${p.csv.fileName}]`);
  }
  writeFileSync(join(outDir, `${name}.txt`), textOut.join('\n---\n'));
}
