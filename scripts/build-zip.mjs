#!/usr/bin/env node
/**
 * build-zip.mjs — builds the uploadable Discord-channel package.
 *
 * Unlike the agent boilerplate (tsc → dist), a channel bundles its non-host
 * dependencies (discord.js, @omadia/table-render with its fonts, Twemoji and
 * resvg WASM) into a single `dist/plugin.js` via esbuild. Host peers
 * (@omadia/channel-sdk, @omadia/plugin-api, express) and discord.js's optional
 * native addons stay external. See creating-plugins.md §5.
 *
 * Steps:
 *   1) esbuild bundle src/plugin.ts → dist/plugin.js
 *   2) Stage runtime artefacts into out/<safeName>-<version>-package/
 *   3) Verify dist/plugin.js exists
 *   4) Zip into out/<safeName>-<version>.zip
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// --- 1) esbuild bundle ---------------------------------------------------
console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(pkgRoot, 'dist/plugin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Host-provided peers stay external; everything else is inlined. The
  // optional native acceleration addons are external so discord.js's
  // try/catch fallback to pure JS works when they're absent on the host.
  // @omadia/table-render is NOT a host peer despite the scope — it is ours.
  external: [
    '@omadia/channel-sdk',
    '@omadia/plugin-api',
    'express',
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
  ],
  // Fonts and the resvg WASM become Uint8Arrays inside the bundle, so the
  // ZIP needs no loose asset files.
  loader: { '.woff': 'binary', '.wasm': 'binary' },
  // ESM banner so bundled CJS code has a working `require`. Aliased: satori's
  // ESM build imports `createRequire` itself (duplicate declaration otherwise).
  banner: {
    js: "import{createRequire as __omadiaCreateRequire}from'node:module';const require=__omadiaCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// --- 2) Metadata ---------------------------------------------------------
const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: name + version required');
}
const entryRel = pkg.main ?? 'dist/plugin.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after build: ${entryRel}`);
}

// --- 3) Stage runtime artefacts -----------------------------------------
// Sanitize the scoped name the way `npm pack` does: strip `@`, `/` → `-`.
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const INCLUDE = [
  'manifest.yaml',
  'package.json',
  'dist',
  'assets',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'NOTICE',
];
for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}

// --- 4) Zip --------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — on Windows use 7z a / Compress-Archive');
}

console.log(`✓ built ${zipPath}`);
