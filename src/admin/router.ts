import express, { type Router } from 'express';

import { type AppInfo, botSettingsUrl, inviteUrl } from '../app-info.js';
import { type GuildPolicy, SLASH_COMMAND_NAME } from '../config.js';

export type ConnectionState =
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error';

export interface GuildSummary {
  id: string;
  name: string;
  memberCount: number;
  iconUrl?: string;
}

/** Live, mutable connection status — the plugin updates it; the router reads it. */
export interface AdminStatus {
  state: ConnectionState;
  app?: AppInfo;
  botTag?: string;
  botId?: string;
  botAvatarUrl?: string;
  guilds: GuildSummary[];
  readyAt?: string;
  /** Last time a real user turn came in — ticks the wizard's "test" step. */
  lastTurnAt?: string;
  lastError?: string;
  tokenInvalid?: boolean;
  guildPolicy: GuildPolicy;
  respondToDms: boolean;
  allowlistSize: number;
}

export interface AdminDeps {
  readonly status: AdminStatus;
  /** Filesystem path to `assets/admin-ui` (served statically). */
  readonly uiAssetsPath: string;
}

interface Warning {
  level: 'error' | 'warning';
  text: string;
  linkUrl?: string;
  linkLabel?: string;
}

function warningsFor(s: AdminStatus): Warning[] {
  const out: Warning[] = [];
  if (s.tokenInvalid) {
    out.push({
      level: 'error',
      text: 'Der Bot-Token ist ungültig oder wurde zurückgesetzt. Erzeuge im Developer Portal einen neuen und trage ihn in den Einstellungen dieses Plugins ein.',
      linkUrl: 'https://discord.com/developers/applications',
      linkLabel: 'Developer Portal öffnen',
    });
  }
  if (s.app && s.guildPolicy === 'all' && !s.app.messageContent) {
    out.push({
      level: 'warning',
      text: '„Auf jede Nachricht“ ist eingestellt, aber der Message Content Intent ist im Developer Portal nicht aktiv. Ohne ihn sieht der Bot nur Nachrichten, die ihn erwähnen. Intent einschalten und das Plugin neu laden.',
      linkUrl: botSettingsUrl(s.app.id),
      linkLabel: 'Bot-Einstellungen öffnen',
    });
  }
  return out;
}

/**
 * Channel-scoped admin router: serves the setup-wizard UI plus one JSON
 * status endpoint. Every response uses the `{ ok }` envelope the runtime
 * smoke probe expects. Mounted via `core.registerRouter` (auto-503 on
 * deactivate).
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = express.Router();

  // `redirect: false` avoids the trailing-slash/rewrite/static triple-redirect
  // that breaks iframe loading behind /bot-api.
  router.use(express.static(deps.uiAssetsPath, { redirect: false }));

  router.get('/api/status', (_req, res) => {
    const s = deps.status;
    res.json({
      ok: true,
      state: s.state,
      app: s.app ?? null,
      bot: s.botId
        ? { id: s.botId, tag: s.botTag, avatarUrl: s.botAvatarUrl }
        : null,
      guilds: s.guilds,
      readyAt: s.readyAt ?? null,
      lastTurnAt: s.lastTurnAt ?? null,
      lastError: s.lastError ?? null,
      inviteUrl: s.app ? inviteUrl(s.app.id) : null,
      botSettingsUrl: s.app ? botSettingsUrl(s.app.id) : null,
      slashCommand: `/${SLASH_COMMAND_NAME}`,
      guildPolicy: s.guildPolicy,
      respondToDms: s.respondToDms,
      allowlistSize: s.allowlistSize,
      warnings: warningsFor(s),
    });
  });

  return router;
}
