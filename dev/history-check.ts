/* eslint-disable no-console -- dev check */
// Checks that chat history survives a restart: two HistoryStore instances on
// the same file-backed memory, trimming to 12 turns, write order under
// concurrent records, and the RAM-only fallback without memory.
// Run: node dev/history-check.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHistoryStore } from '../src/history.js';

// @ts-expect-error -- plain JS dev module
import { createFsMemory } from './fs-memory.mjs';

const root = mkdtempSync(join(tmpdir(), 'discord-history-'));
const memory = createFsMemory(root);
const log = (m: string): void => console.log(`  log: ${m}`);
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const turn = (n: number) => ({ userMessage: `Frage ${n}`, assistantAnswer: `| Jahr | Umsatz |\n|---|---|\n| 202${n % 10} | ${n} |` });

// 1) Write two turns, "restart", read back.
const a = createHistoryStore(memory, log);
await a.record('1481747251784061042', turn(1));
await a.record('1481747251784061042', turn(2));
a.dispose();
const b = createHistoryStore(memory, log);
const restored = await b.get('1481747251784061042');
check('survives restart', restored.length === 2 && restored[1]?.userMessage === 'Frage 2', `${restored.length} turns`);
check('table text kept verbatim', restored[0]?.assistantAnswer.includes('| Jahr | Umsatz |') ?? false);

// 2) Trim to the last 12.
for (let i = 3; i <= 20; i++) await b.record('1481747251784061042', turn(i));
const c = createHistoryStore(memory, log);
const trimmed = await c.get('1481747251784061042');
check('trimmed to 12', trimmed.length === 12 && trimmed[0]?.userMessage === 'Frage 9', `first = ${trimmed[0]?.userMessage}`);

// 3) Concurrent records keep order on disk.
const d = createHistoryStore(memory, log);
await Promise.all([1, 2, 3, 4, 5].map((i) => d.record('42', turn(i))));
const onDisk = JSON.parse(readFileSync(join(root, 'history/42.json'), 'utf8')) as Array<{ userMessage: string }>;
check('concurrent writes ordered', onDisk.map((t) => t.userMessage).join(',') === 'Frage 1,Frage 2,Frage 3,Frage 4,Frage 5', onDisk.map((t) => t.userMessage).join(','));

// 4) Separate channels stay separate.
check('channels isolated', (await d.get('1481747251784061042')).length === 12 && (await d.get('42')).length === 5);

// 5) Corrupt file → empty history, no throw.
const { writeFileSync } = await import('node:fs');
writeFileSync(join(root, 'history/99.json'), '{not json');
check('corrupt file tolerated', (await createHistoryStore(memory, log).get('99')).length === 0);

// 6) No memory provider → RAM only.
const ram = createHistoryStore(undefined, log);
await ram.record('7', turn(1));
check('RAM fallback works', (await ram.get('7')).length === 1);
check('RAM fallback forgets on restart', (await createHistoryStore(undefined, log).get('7')).length === 0);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\n✓ all history checks passed' : `\n✗ ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
