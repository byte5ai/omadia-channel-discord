#!/usr/bin/env node
// Bundles dev/preview-entry.ts with the same loaders as the plugin build and
// runs it. `npm run preview` → dev/out/<scenario>/message-N.json + PNG/CSV.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
// Not dist/: build-zip ships everything in dist/.
const outfile = join(pkgRoot, 'out/preview.js');

await build({
  entryPoints: [join(here, 'preview-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.woff': 'binary', '.wasm': 'binary' },
  // Type-only imports of the host SDK vanish; nothing else must resolve.
  external: ['@omadia/channel-sdk', '@omadia/plugin-api', 'zlib-sync', 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import{createRequire as __omadiaCreateRequire}from'node:module';const require=__omadiaCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href);
