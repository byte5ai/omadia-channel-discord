#!/usr/bin/env node
// Bundles dev/make-chart.ts with the same loaders as the table renderer and
// runs it. Usage: node scripts/make-chart.mjs [out.png] [ground-color]

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const outfile = join(pkgRoot, 'dist/make-chart.js');

await build({
  entryPoints: [join(pkgRoot, 'dev/make-chart.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.woff': 'binary', '.wasm': 'binary' },
  banner: {
    js: "import{createRequire as __omadiaCreateRequire}from'node:module';const require=__omadiaCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
