#!/usr/bin/env node
/**
 * Local Discord test harness — drives the BUILT plugin against REAL Discord with
 * a SCRIPTED orchestrator (dev/fake-channel-sdk.mjs). No middleware host needed.
 *
 *   DISCORD_BOT_TOKEN=... npm run dev     # builds dist/plugin.js, then runs this
 *
 * Then open the setup wizard (http://localhost:8787/api/discord/admin/index.html),
 * invite the bot, and in Discord @mention it / DM it / run /ask with one of the
 * keywords from dev/scenarios.mjs (tabelle, lang, kunde, matrix, projekte,
 * status, bild, auswahl, menu, code, noreply).
 *
 * Optional env: DISCORD_RESPOND_IN_GUILDS (mention|all|off), DISCORD_ALLOW_DMS,
 * DISCORD_ALLOWLIST (comma-separated user/guild ids), PORT.
 */

import express from 'express';

import { createFsMemory, DEV_MEMORY_ROOT } from './fs-memory.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error(
    'Set DISCORD_BOT_TOKEN before running (Developer Portal → Bot → Reset Token).',
  );
  process.exit(1);
}

// 1) Make the bundle's external `import "@omadia/channel-sdk"` resolve to the
//    functional fake. (Recreated each run; harmless if a real one exists too.)
const stubDir = resolve(pkgRoot, 'node_modules/@omadia/channel-sdk');
mkdirSync(stubDir, { recursive: true });
writeFileSync(
  resolve(stubDir, 'package.json'),
  JSON.stringify({
    name: '@omadia/channel-sdk',
    version: '0.0.0-dev',
    type: 'module',
    main: 'index.js',
    exports: './index.js',
  }),
);
writeFileSync(
  resolve(stubDir, 'index.js'),
  `export * from ${JSON.stringify(pathToFileURL(resolve(here, 'fake-channel-sdk.mjs')).href)};\n`,
);

// 2) Import the BUILT plugin bundle.
const distEntry = pathToFileURL(resolve(pkgRoot, 'dist/plugin.js')).href;
const mod = await import(distEntry).catch((err) => {
  console.error(`Failed to import dist/plugin.js — run "node scripts/build-zip.mjs" first.\n${err.message}`);
  process.exit(1);
});
if (typeof mod.activate !== 'function') {
  console.error('dist/plugin.js has no `activate` export.');
  process.exit(1);
}

// 3) Fake PluginContext + CoreApi.
const cfg = {
  respond_in_guilds: process.env.DISCORD_RESPOND_IN_GUILDS ?? 'mention',
  allow_dms: process.env.DISCORD_ALLOW_DMS ?? 'true',
  allowlist: process.env.DISCORD_ALLOWLIST ?? '',
};

const ctx = {
  agentId: '@omadia/channel-discord',
  secrets: {
    get: async (k) => (k === 'discord_bot_token' ? token : undefined),
    require: async (k) => {
      if (k === 'discord_bot_token') return token;
      throw new Error(`missing secret: ${k}`);
    },
    keys: async () => ['discord_bot_token'],
  },
  config: {
    get: (k) => cfg[k],
    require: (k) => {
      const v = cfg[k];
      if (v === undefined) throw new Error(`missing config: ${k}`);
      return v;
    },
  },
  services: { get: () => undefined },
  // Chat history persists here across restarts, like ctx.memory on the host.
  memory: createFsMemory(DEV_MEMORY_ROOT),
  log: (...args) => console.log('[discord]', ...args),
};

const app = express();
// Test images for dev/scenarios.mjs ("bild").
app.use('/dev-assets', express.static(resolve(here, 'assets')));
// Serve a minimal stand-in for the harness stylesheet the iframe normally
// provides, so the local admin UI is legible (cosmetic only).
app.get('/bot-api/_harness/admin-ui.css', (_req, res) =>
  res.type('text/css').send(
    ':root{--bg:#fff;--fg:#111;--fg-strong:#000;--fg-muted:#666;--fg-subtle:#999;--accent:#5865F2;--success:#22c55e;--warning:#f59e0b;--danger:#ef4444;--border:#ddd;--bg-elevated:#fafafa;--radius-sm:8px;--radius-pill:9999px;--font-mono:ui-monospace,monospace}' +
      'body{font-family:system-ui,sans-serif;max-width:812px;margin:1rem auto;padding:0 1rem;color:var(--fg)}' +
      '.harness-subtitle{color:var(--fg-muted)}.harness-empty{color:var(--fg-muted);font-style:italic}' +
      '.harness-btn{display:inline-block;padding:.5rem .9rem;border:1px solid var(--border);border-radius:var(--radius-pill);text-decoration:none;color:var(--fg)}' +
      '.harness-btn--primary{background:var(--accent);color:#fff;border-color:var(--accent)}' +
      '.harness-banner-error{background:#fee2e2;color:var(--danger);padding:.6rem;border-radius:8px}' +
      '.harness-table{width:100%;border-collapse:collapse}.harness-table th,.harness-table td{text-align:left;padding:.4rem;border-bottom:1px solid var(--border)}',
  ),
);

const core = {
  registerRouter: (channelId, prefix, router) => {
    app.use(prefix, router);
    console.log(`[core] mounted router ${channelId} @ ${prefix}`);
  },
  registerRoute: () => {},
  log: (level, msg) => console.log(`[core:${level}]`, msg),
};

const PORT = Number(process.env.PORT ?? 8787);
const handle = await mod.activate(ctx, core);
const server = app.listen(PORT, () => {
  console.log(`\n  Admin UI:  http://localhost:${PORT}/api/discord/admin/index.html`);
  console.log(
    '  In Discord: @mention, DM or /ask with a keyword: tabelle, lang, kunde, matrix, projekte, status, bild, auswahl, menu, code, noreply.',
  );
  console.log('  Ctrl+C to stop.\n');
});

const shutdown = async () => {
  console.log('\nshutting down…');
  await handle.close().catch(() => undefined);
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
