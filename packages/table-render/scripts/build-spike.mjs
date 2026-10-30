#!/usr/bin/env node
/**
 * build-spike.mjs — bundles dev/spike.ts the same way a channel plugin's
 * build-zip.mjs would bundle this package: one ESM file, fonts and the resvg
 * WASM inlined via the `binary` loader, so nothing has to be shipped beside
 * dist/plugin.js in the Hub ZIP.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const result = await build({
  entryPoints: [join(pkgRoot, 'dev/spike.ts')],
  outfile: join(pkgRoot, 'dist/spike.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.woff': 'binary', '.wasm': 'binary' },
  // Aliased: satori's ESM build imports `createRequire` itself, so the plain
  // banner channel-discord uses would be a duplicate declaration.
  banner: {
    js: "import{createRequire as __omadiaCreateRequire}from'node:module';const require=__omadiaCreateRequire(import.meta.url);",
  },
  metafile: true,
  logLevel: 'warning',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`✓ dist/spike.js ${(bytes / 1024 / 1024).toFixed(2)} MB`);
