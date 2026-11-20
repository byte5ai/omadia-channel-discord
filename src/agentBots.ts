/**
 * Agents' own Discord bots (spec 2042 §5.3, §8 item 20).
 *
 * An operator gives an agent a bot of its own: an application created in the
 * Discord Developer Portal (named like the agent), whose bot token is entered
 * on the agent's page in omadia. The kernel hands the token to
 * {@link createDiscordAgentIdentityProvider} once; this plugin checks it with
 * Discord (`GET /oauth2/applications/@me`), keeps it in its own vault
 * (`agent_bot_token_<appId>`), connects the bot to the Gateway and returns its
 * routing key `discord-app:<appId>`. The kernel stores (agent, key) and from
 * then on routes every turn through that bot to the agent, and posts the
 * agent's messages through it.
 *
 * {@link DiscordBotFleet} holds every connected bot (the installation's own
 * one and the agent bots) and answers the per-identity questions the kernel
 * asks: which bot posts for `asChannelKey`, which bot reads a roster, which
 * agent bots can see a channel.
 */

import type {
  AgentIdentityField,
  AgentIdentityProvider,
  AgentIdentityRefusal,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { discordBotChannelKey } from './conversationEvents.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';
import type { SendProviderDeps } from './sendProviders.js';

/** Vault key of an agent bot's token. */
export const AGENT_BOT_TOKEN_PREFIX = 'agent_bot_token_';
const DISCORD_API = 'https://discord.com/api/v10';
/** A bot token: three dot-separated base64url parts. Checked before any call goes out. */
const BOT_TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const SNOWFLAKE = /^\d{15,25}$/;
const PRESENCE_TTL_MS = 60_000;

export const AGENT_BOT_FIELDS: readonly AgentIdentityField[] = Object.freeze([
  {
    key: 'bot_token',
    label: { en: 'Bot token', de: 'Bot-Token' },
    help: {
      en: 'Create an application for this agent in the Discord Developer Portal (named like the agent), add a bot and paste its token. Enable the same privileged intents as for the channel’s own bot, then invite the bot to your server.',
      de: 'Lege für diesen Agenten im Discord Developer Portal eine Anwendung an (benannt wie der Agent), füge einen Bot hinzu und trage seinen Token ein. Aktiviere dieselben privilegierten Intents wie beim eigenen Bot des Kanals und lade den Bot danach auf deinen Server ein.',
    },
    secret: true,
  },
]);

/** One connected bot as the fleet sees it. */
export interface DiscordBotRuntime {
  /** `discord-app:<appId>`. */
  readonly botKey: string;
  readonly appId: string;
  readonly name: string;
  readonly sendDeps: SendProviderDeps;
  readonly roster: ConversationRosterProvider;
  /** Can the bot see this channel (it is on the server, has access)? */
  canSee(conversationId: string): Promise<boolean>;
  /** `connected` once the Gateway said ready. */
  status(): 'connected' | 'connecting' | 'error';
  /** The bot's Discord user id, once connected. */
  botUserId?(): string | undefined;
  close(): Promise<void>;
}

/** The installation's own bot: its key is known once the Gateway is ready. */
export interface DiscordDefaultBot {
  channelKey(): string | undefined;
  readonly sendDeps: SendProviderDeps;
  readonly roster: ConversationRosterProvider;
  /** The token of the installation's own bot, to refuse it as an agent bot. */
  readonly token: string;
}

export class DiscordBotFleet {
  private readonly agentBots = new Map<string, DiscordBotRuntime>();
  private readonly presence = new Map<string, { readonly at: number; readonly keys: readonly string[] }>();

  constructor(readonly defaultBot: DiscordDefaultBot) {}

  agentBot(botKey: string): DiscordBotRuntime | undefined {
    return this.agentBots.get(botKey);
  }

  agentBotKeys(): readonly string[] {
    return [...this.agentBots.keys()];
  }

  private closed = false;
  /** Bots whose start waits for Discord to become reachable again (boot). */
  private readonly retrying = new Set<string>();

  /**
   * Hold a connected bot. A bot that runs under the key already is closed
   * first (never two Gateway sessions for one bot), and after
   * {@link closeAll} nothing is held: a late start is closed at once.
   * `false` = not added.
   */
  async add(runtime: DiscordBotRuntime): Promise<boolean> {
    if (this.closed) {
      await runtime.close();
      return false;
    }
    const previous = this.agentBots.get(runtime.botKey);
    this.agentBots.set(runtime.botKey, runtime);
    this.retrying.delete(runtime.botKey);
    this.presence.clear();
    if (previous && previous !== runtime) await previous.close();
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  markRetrying(botKey: string, retrying: boolean): void {
    if (retrying) this.retrying.add(botKey);
    else this.retrying.delete(botKey);
  }

  isRetrying(botKey: string): boolean {
    return this.retrying.has(botKey);
  }

  /** Is this Discord user one of this installation's agent bots? */
  isAgentBotUser(userId: string): boolean {
    for (const runtime of this.agentBots.values()) if (runtime.botUserId?.() === userId) return true;
    return false;
  }

  /** Removes and returns the runtime; the caller closes it. */
  remove(botKey: string): DiscordBotRuntime | undefined {
    const runtime = this.agentBots.get(botKey);
    this.agentBots.delete(botKey);
    this.presence.clear();
    return runtime;
  }

  private isDefaultKey(key: string | undefined): boolean {
    return key === undefined || key === this.defaultBot.channelKey();
  }

  /** The bot a send goes out as: no key = the installation's own bot. */
  sendDepsFor(asChannelKey: string | undefined): SendProviderDeps | undefined {
    if (this.isDefaultKey(asChannelKey)) return this.defaultBot.sendDeps;
    return this.agentBots.get(asChannelKey as string)?.sendDeps;
  }

  /** The roster as the bot `asChannelKey` sees it; no key = the installation's own bot. */
  rosterProvider(): ConversationRosterProvider {
    return {
      channelType: DISCORD_CHANNEL_TYPE,
      getRoster: (conversationId: string, opts?: ConversationRosterRequest): Promise<ConversationRoster | undefined> => {
        const key = opts?.asChannelKey?.trim().toLowerCase();
        if (this.isDefaultKey(key)) return this.defaultBot.roster.getRoster(conversationId, opts);
        const runtime = key === undefined ? undefined : this.agentBots.get(key);
        return runtime ? runtime.roster.getRoster(conversationId, opts) : Promise.resolve(undefined);
      },
    };
  }

  /** The agent bots that can see this channel, cached for a minute. */
  async presentIn(conversationId: string): Promise<readonly string[]> {
    if (!SNOWFLAKE.test(conversationId)) return [];
    const cached = this.presence.get(conversationId);
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.keys;
    const checks = await Promise.all(
      [...this.agentBots.values()].map(async (r) => ((await r.canSee(conversationId).catch(() => false)) ? r.botKey : undefined)),
    );
    const keys = checks.filter((k): k is string => k !== undefined);
    this.presence.set(conversationId, { at: Date.now(), keys });
    return keys;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const running = [...this.agentBots.values()];
    this.agentBots.clear();
    this.retrying.clear();
    await Promise.all(running.map((r) => r.close()));
  }
}

export interface AgentBotSecrets {
  get(key: string): Promise<string | undefined>;
  keys(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What Discord says about a bot token. */
export interface DiscordApplication {
  readonly id: string;
  readonly name: string;
  readonly botUsername?: string;
}

export type ApplicationLookup = (token: string) => Promise<DiscordApplication>;

/** Discord's answer for the application of a bot token. Throws with `status` on failure. */
export const fetchApplication: ApplicationLookup = async (token) => {
  const res = await fetch(`${DISCORD_API}/oauth2/applications/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Discord answered ${String(res.status)}`), { status: res.status });
  const body = (await res.json()) as { id?: unknown; name?: unknown; bot?: { username?: unknown } };
  if (typeof body.id !== 'string' || !SNOWFLAKE.test(body.id)) throw new Error('Discord returned no application id');
  return {
    id: body.id,
    name: typeof body.name === 'string' ? body.name : body.id,
    ...(typeof body.bot?.username === 'string' ? { botUsername: body.bot.username } : {}),
  };
};

export interface AgentBotDeps {
  readonly fleet: DiscordBotFleet;
  readonly secrets: AgentBotSecrets;
  /** Builds and connects the runtime of an agent bot (login runs in the background). */
  readonly startAgentBot: (token: string, app: DiscordApplication) => DiscordBotRuntime;
  readonly lookupApplication?: ApplicationLookup;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const refuse = (code: AgentIdentityRefusal['code'], message: string): AgentIdentityRefusal => ({ ok: false, code, message });

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Discord's answer to a bad or revoked token. */
function isRejectedToken(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isRefusal = (value: object): value is AgentIdentityRefusal => (value as { ok?: unknown }).ok === false;

/** Which application a token is, or why it is refused. */
async function applicationOf(
  deps: AgentBotDeps,
  credentials: Readonly<Record<string, string>>,
): Promise<{ token: string; app: DiscordApplication } | AgentIdentityRefusal> {
  const token = credentials['bot_token']?.trim() ?? '';
  if (!BOT_TOKEN_RE.test(token)) return refuse('invalid_input', 'this is not a Discord bot token');
  if (token === deps.fleet.defaultBot.token) return refuse('already_in_use', 'this is the Discord channel’s own bot');
  try {
    const app = await (deps.lookupApplication ?? fetchApplication)(token);
    if (discordBotChannelKey(app.id) === deps.fleet.defaultBot.channelKey()) {
      return refuse('already_in_use', 'this is the Discord channel’s own bot');
    }
    return { token, app };
  } catch (err) {
    return isRejectedToken(err)
      ? refuse('invalid_credentials', 'Discord rejected this bot token')
      : refuse('unreachable', 'Discord could not be reached to check the token');
  }
}

export function createDiscordAgentIdentityProvider(deps: AgentBotDeps): AgentIdentityProvider {
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    fields: AGENT_BOT_FIELDS,
    // No side effect: the kernel decides whether this bot is free.
    async identify(input) {
      const found = await applicationOf(deps, input.credentials);
      if (isRefusal(found)) return found;
      const { app } = found;
      return { ok: true, channelKey: discordBotChannelKey(app.id), externalRef: app.botUsername ?? app.name, displayName: app.name };
    },
    // Called only for a bot no agent owns (the kernel checked).
    async provision(input, channelKey) {
      const found = await applicationOf(deps, input.credentials);
      if (isRefusal(found)) return found;
      const { token, app } = found;
      const botKey = discordBotChannelKey(app.id);
      if (botKey !== channelKey.trim().toLowerCase()) return refuse('invalid_input', 'the token names another bot than the one checked');
      if (deps.fleet.isClosed) return refuse('unreachable', 'the Discord channel is shutting down');
      const vaultKey = `${AGENT_BOT_TOKEN_PREFIX}${app.id}`;
      await deps.secrets.set(vaultKey, token);
      try {
        // `add` closes a bot that still ran under this key (nobody owned it).
        if (!(await deps.fleet.add(deps.startAgentBot(token, app)))) {
          return refuse('unreachable', 'the Discord channel is shutting down');
        }
      } catch (err) {
        await deps.secrets.delete(vaultKey);
        deps.log('error', `agent bot ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the bot could not be started');
      }
      deps.log('info', `agent bot ${app.name} (${botKey}) connecting for agent '${input.agentSlug}'`);
      return { ok: true };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      deps.fleet.markRetrying(key, false);
      await deps.fleet.remove(key)?.close();
      const appId = /^discord-app:(\d{15,25})$/.exec(key)?.[1];
      if (appId) await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${appId}`);
      deps.log('info', `agent bot ${key} disconnected and its token removed`);
    },
    async status(channelKey) {
      const key = channelKey.trim().toLowerCase();
      const runtime = deps.fleet.agentBot(key);
      if (runtime) {
        const state = runtime.status();
        return { state: state === 'error' ? 'stopped' : 'running', detail: state };
      }
      if (deps.fleet.isRetrying(key)) return { state: 'unknown', detail: 'Discord is not reachable; the bot connects as soon as it is' };
      return { state: 'stopped', detail: 'the bot is not running in this installation (token missing or rejected)' };
    },
    defaultChannelKey: () => deps.fleet.defaultBot.channelKey(),
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/** Backoff of a stored bot whose start failed because Discord was not reachable. */
export const BOOT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

/**
 * Connect every agent bot whose token is in the vault (boot), all at once. A
 * token Discord REJECTS stays where it is and the bot stays disconnected: the
 * operator sees it on the agent page and replaces or removes it. Any other
 * failure (Discord unreachable during a deploy) is retried with backoff.
 */
export async function startStoredAgentBots(
  deps: AgentBotDeps,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const lookup = deps.lookupApplication ?? fetchApplication;
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_BOT_TOKEN_PREFIX));
  const startOne = async (key: string): Promise<void> => {
    const botKey = discordBotChannelKey(key.slice(AGENT_BOT_TOKEN_PREFIX.length));
    for (let attempt = 0; !deps.fleet.isClosed; attempt++) {
      const token = await deps.secrets.get(key);
      if (!token || token === deps.fleet.defaultBot.token) return;
      try {
        const app = await lookup(token);
        if (deps.fleet.agentBot(discordBotChannelKey(app.id))) return;
        await deps.fleet.add(deps.startAgentBot(token, app));
        return;
      } catch (err) {
        if (isRejectedToken(err)) {
          deps.log('warn', `agent bot from vault key ${key} not started: Discord rejects its token`);
          return;
        }
        const delay = BOOT_RETRY_DELAYS_MS[Math.min(attempt, BOOT_RETRY_DELAYS_MS.length - 1)] ?? 300_000;
        deps.fleet.markRetrying(botKey, true);
        deps.log('warn', `agent bot from vault key ${key} did not start (${errorMessage(err)}); retrying in ${String(delay)} ms`);
        await sleep(delay);
      }
    }
  };
  await Promise.all(keys.map(startOne));
  deps.log('info', `discord agent bots running: ${String(deps.fleet.agentBotKeys().length)}`);
}
