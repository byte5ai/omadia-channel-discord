/* eslint-disable no-console -- dev runner */
// Offline preview: renders every scenario through the real renderer, runs the
// discord.js builder validation (toJSON), checks the V2 per-message limits,
// and dumps payload JSON + uploads to dev/out/<scenario>/. Bundled and run by
// dev/preview.mjs — no Discord connection, no token.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import { buildComponents } from '../src/components.js';
import { createPendingStore } from '../src/pending.js';
import { renderAnswer } from '../src/render.js';

// @ts-expect-error -- plain JS dev module
import { SCENARIOS } from './scenarios.mjs';

type Json = { type: number; components?: Json[]; items?: unknown[]; content?: string };

function countComponents(list: Json[]): number {
  return list.reduce(
    (n, c) => n + 1 + (c.components ? countComponents(c.components) : 0),
    0,
  );
}

function textLength(list: Json[]): number {
  return list.reduce(
    (n, c) => n + (c.content?.length ?? 0) + (c.components ? textLength(c.components) : 0),
    0,
  );
}

// Serve dev/assets like dev/run.mjs does, so "bild" exercises the upload
// path. If `npm run dev` already holds the port, it serves the same files.
const assets = createServer((req, res) => {
  const file = join(process.cwd(), 'dev/assets', basename(req.url ?? ''));
  if (!existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'image/png');
  res.end(readFileSync(file));
});
await new Promise<void>((done) => {
  assets.once('error', () => done());
  assets.listen(Number(process.env.PORT ?? 8787), () => done());
});

const outRoot = join(process.cwd(), 'dev/out');
rmSync(outRoot, { recursive: true, force: true });
const pending = createPendingStore();
let failures = 0;

for (const [name, answer] of Object.entries(SCENARIOS as Record<string, SemanticAnswer>)) {
  const dir = join(outRoot, name);
  mkdirSync(dir, { recursive: true });
  const rows = buildComponents(answer, pending, {
    conversationId: 'preview',
    channelType: 'discord',
    channelKey: 'guild:preview',
  });
  const started = performance.now();
  const payloads = await renderAnswer(answer, rows, (m) => console.log(`  log: ${m}`));
  const ms = Math.round(performance.now() - started);

  const summary: string[] = [];
  payloads.forEach((p, i) => {
    const json = p.components.map((c) => c.toJSON() as Json);
    const comps = countComponents(json);
    const text = textLength(json);
    const problems: string[] = [];
    if (comps > 40) problems.push(`${comps} components > 40`);
    if (text > 4000) problems.push(`${text} chars > 4000`);
    if (p.files.length > 10) problems.push(`${p.files.length} files > 10`);
    if (problems.length > 0) {
      failures++;
      console.log(`  ✗ ${name} message ${i + 1}: ${problems.join(', ')}`);
    }
    const types = json.map((c) => c.type).join(',');
    summary.push(`[${types}] ${comps}c ${text}ch ${p.files.length}f`);
    writeFileSync(join(dir, `message-${i + 1}.json`), JSON.stringify(json, null, 2));
    for (const f of p.files) {
      if (Buffer.isBuffer(f.attachment)) writeFileSync(join(dir, f.name ?? 'file'), f.attachment);
    }
  });
  console.log(`${name.padEnd(9)} ${String(ms).padStart(4)} ms  ${payloads.length} msg  ${summary.join(' | ')}`);
}

pending.dispose();
assets.close();
console.log(failures === 0 ? '\n✓ all payloads valid' : `\n✗ ${failures} payload(s) over limits`);
process.exitCode = failures === 0 ? 0 : 1;
