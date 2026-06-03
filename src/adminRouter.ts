import express, { type Router } from 'express';

import type { ChannelState } from './state.js';

export interface AdminRouterDeps {
  /** Absolute path to the bundled `assets/admin-ui` directory. */
  uiAssetsPath: string;
  state: ChannelState;
  /** True during the kernel's admin-route smoke probe — return mock data. */
  smokeMode: boolean;
}

/**
 * Express router for the Discord admin UI. Mounted by `activate()` at
 * `/api/discord-channel/admin` via `ctx.routes.register`, then surfaced as an
 * iframe by web-ui because the manifest declares `admin_ui_path`. Serves the
 * single-file status page plus a tiny JSON API the page polls.
 *
 * Unlike WhatsApp there is no QR and no logout: a Discord bot uses a static
 * token (collected at install), so the surface is read-only — connection
 * status, the linked bot identity, and the OAuth2 invite URL.
 *
 * Response contract (host smoke-checks this): every endpoint returns
 * `{ ok: true, ... }` on success or `{ ok: false, error }` on failure.
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = express.Router();

  // Static single-file UI. `redirect: false` avoids the trailing-slash →
  // Next-rewrite → express.static 3x-redirect chain that breaks iframe loads.
  router.use(express.static(deps.uiAssetsPath, { redirect: false }));

  router.get('/api/status', (_req, res) => {
    if (deps.smokeMode) {
      res.json({
        ok: true,
        status: 'connected',
        me: { id: '000000000000000000', username: 'Smoke Test', tag: 'Smoke Test', guildCount: 1 },
        inviteUrl:
          'https://discord.com/oauth2/authorize?client_id=000000000000000000&permissions=0&scope=bot+applications.commands',
        slashCommandReady: true,
        lastError: null,
        updatedAt: deps.state.updatedAt,
      });
      return;
    }
    const s = deps.state;
    res.json({
      ok: true,
      status: s.status,
      me: s.me,
      inviteUrl: s.inviteUrl,
      slashCommandReady: s.slashCommandReady,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
    });
  });

  return router;
}
