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
  AgentIdentityProvisionOutcome,
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

  add(runtime: DiscordBotRuntime): void {
    this.agentBots.set(runtime.botKey, runtime);
    this.presence.clear();
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
    await Promise.all([...this.agentBots.values()].map((r) => r.close()));
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

const refuse = (
  code: Extract<AgentIdentityProvisionOutcome, { ok: false }>['code'],
  message: string,
): AgentIdentityProvisionOutcome => ({ ok: false, code, message });

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDiscordAgentIdentityProvider(deps: AgentBotDeps): AgentIdentityProvider {
  const lookup = deps.lookupApplication ?? fetchApplication;
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    fields: AGENT_BOT_FIELDS,
    async provision(input) {
      const token = input.credentials['bot_token']?.trim() ?? '';
      if (!BOT_TOKEN_RE.test(token)) return refuse('invalid_input', 'this is not a Discord bot token');
      if (token === deps.fleet.defaultBot.token) return refuse('already_in_use', 'this is the Discord channel’s own bot');
      let app: DiscordApplication;
      try {
        app = await lookup(token);
      } catch (err) {
        const status = statusOf(err);
        return status === 401 || status === 403
          ? refuse('invalid_credentials', 'Discord rejected this bot token')
          : refuse('unreachable', 'Discord could not be reached to check the token');
      }
      const botKey = discordBotChannelKey(app.id);
      if (botKey === deps.fleet.defaultBot.channelKey()) {
        return refuse('already_in_use', 'this is the Discord channel’s own bot');
      }
      // The same bot again (a re-entered or reset token): reconnect it on the new token.
      await deps.fleet.remove(botKey)?.close();
      await deps.secrets.set(`${AGENT_BOT_TOKEN_PREFIX}${app.id}`, token);
      try {
        deps.fleet.add(deps.startAgentBot(token, app));
      } catch (err) {
        await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${app.id}`);
        deps.log('error', `agent bot ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the bot could not be started');
      }
      deps.log('info', `agent bot ${app.name} (${botKey}) connecting for agent '${input.agentSlug}'`);
      return { ok: true, channelKey: botKey, externalRef: app.botUsername ?? app.name, displayName: app.name };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      await deps.fleet.remove(key)?.close();
      const appId = /^discord-app:(\d{15,25})$/.exec(key)?.[1];
      if (appId) await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${appId}`);
      deps.log('info', `agent bot ${key} disconnected and its token removed`);
    },
    async status(channelKey) {
      const runtime = deps.fleet.agentBot(channelKey.trim().toLowerCase());
      if (!runtime) return { state: 'stopped', detail: 'the bot is not running in this installation (token missing or rejected)' };
      const state = runtime.status();
      return { state: state === 'error' ? 'stopped' : 'running', detail: state };
    },
    defaultChannelKey: () => deps.fleet.defaultBot.channelKey(),
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/**
 * Connect every agent bot whose token is in the vault (boot). A token Discord
 * rejects stays where it is and the bot stays disconnected: the operator sees
 * it on the agent page and replaces or removes it.
 */
export async function startStoredAgentBots(deps: AgentBotDeps): Promise<void> {
  const lookup = deps.lookupApplication ?? fetchApplication;
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_BOT_TOKEN_PREFIX));
  for (const key of keys) {
    const token = await deps.secrets.get(key);
    if (!token || token === deps.fleet.defaultBot.token) continue;
    try {
      const app = await lookup(token);
      if (deps.fleet.agentBot(discordBotChannelKey(app.id))) continue;
      deps.fleet.add(deps.startAgentBot(token, app));
    } catch (err) {
      deps.log('warn', `agent bot from vault key ${key} did not start: ${errorMessage(err)}`);
    }
  }
  deps.log('info', `discord agent bots running: ${String(deps.fleet.agentBotKeys().length)}`);
}
