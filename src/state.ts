/**
 * Shared, in-memory channel state. A single instance is created in
 * `activate()` and read by the admin router (to render status / invite URL)
 * and written by the Discord connection (on every Gateway transition).
 *
 * It is intentionally a plain mutable object — there is exactly one writer
 * (the discord.js event loop) and N readers (admin-UI poll requests), and the
 * fields are independent scalars, so no locking is needed.
 *
 * Unlike WhatsApp there is no QR: a Discord bot authenticates with a static
 * token, so the "pairing" surface is just connection status + the OAuth2
 * invite URL the operator uses to add the bot to a server.
 */

export type ConnectionStatus =
  | 'starting' // activate() called, client not yet logged in
  | 'connecting' // logging in / reconnecting to the Gateway
  | 'connected' // ready — logged in and receiving events
  | 'error'; // fatal (bad token, disallowed intents, …) — see lastError

export interface BotIdentity {
  /** The bot user id (also the OAuth2 client_id). */
  id: string;
  /** The bot's username (without discriminator). */
  username: string;
  /** Full tag, e.g. "Omadia#1234" (legacy) or the username for the new system. */
  tag: string;
  /** Count of guilds (servers) the bot is currently a member of. */
  guildCount: number;
}

export interface ChannelState {
  status: ConnectionStatus;
  /** The linked bot identity once connected, or null. */
  me: BotIdentity | null;
  /** OAuth2 URL to add the bot to a server (built once the identity is known). */
  inviteUrl: string | null;
  /** Whether the /ask slash command was registered this session. */
  slashCommandReady: boolean;
  /** Last error message surfaced to the operator, or null. */
  lastError: string | null;
  /** Epoch-ms of the last state transition — lets the UI show "x s ago". */
  updatedAt: number;
}

export function createChannelState(): ChannelState {
  return {
    status: 'starting',
    me: null,
    inviteUrl: null,
    slashCommandReady: false,
    lastError: null,
    updatedAt: Date.now(),
  };
}

/** Apply a partial update and bump `updatedAt` in one place. */
export function patchState(state: ChannelState, patch: Partial<ChannelState>): void {
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}
