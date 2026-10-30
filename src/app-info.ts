const API = 'https://discord.com/api/v10';

// Application flags (https://discord.com/developers/docs/resources/application).
// Either one means the Message Content intent is switched on in the portal.
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export interface AppInfo {
  readonly id: string;
  readonly name: string;
  readonly iconUrl?: string;
  /**
   * Message Content intent enabled in the Developer Portal. Without it the bot
   * still sees DMs and messages that @mention it — only "answer every message
   * in a channel" needs it. Requesting the intent while it is off makes the
   * gateway close with 4014, so we only request what the portal allows.
   */
  readonly messageContent: boolean;
}

export class InvalidTokenError extends Error {
  constructor() {
    super('Der Bot-Token ist ungültig oder wurde zurückgesetzt.');
    this.name = 'InvalidTokenError';
  }
}

interface ApplicationResponse {
  id: string;
  name: string;
  icon: string | null;
  flags?: number;
}

/**
 * Everything the old setup asked the operator to copy by hand, read from
 * `GET /applications/@me` with the bot token itself.
 */
export async function fetchAppInfo(token: string): Promise<AppInfo> {
  const res = await fetch(`${API}/applications/@me`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r)
    .catch((e: unknown) => {
      throw new Error(`Discord nicht erreichbar: ${(e as Error).message}`);
    });
  if (res.status === 401) throw new InvalidTokenError();
  if (!res.ok) throw new Error(`Discord antwortet mit HTTP ${res.status}`);

  const app = (await res.json()) as ApplicationResponse;
  const flags = app.flags ?? 0;
  return {
    id: app.id,
    name: app.name,
    iconUrl: app.icon
      ? `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png?size=128`
      : undefined,
    messageContent:
      (flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0,
  };
}

// View Channels, Send Messages, Send Messages in Threads, Embed Links,
// Attach Files, Read Message History.
const INVITE_PERMISSIONS = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 38n) |
  (1n << 14n) |
  (1n << 15n) |
  (1n << 16n)
).toString();

export function inviteUrl(applicationId: string): string {
  return (
    'https://discord.com/oauth2/authorize' +
    `?client_id=${encodeURIComponent(applicationId)}` +
    '&scope=bot+applications.commands' +
    `&permissions=${INVITE_PERMISSIONS}`
  );
}

/** Deep link to the page where the Message Content intent is toggled. */
export function botSettingsUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${encodeURIComponent(applicationId)}/bot`;
}
