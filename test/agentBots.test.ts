// Agents' own Discord bots (spec 2042 §5.3, §8 item 20): the identity provider
// checks a token with Discord, keeps it in the plugin vault and connects the
// bot; an agent bot resolves on its own key and answers only as the agent
// whose identity it is; sends go out through exactly the bot named.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type ChatAgent, type ChatTurnInput, type IncomingTurn } from '@omadia/channel-sdk';

import {
  AGENT_BOT_TOKEN_PREFIX,
  createDiscordAgentIdentityProvider,
  DiscordBotFleet,
  startStoredAgentBots,
  type AgentBotDeps,
  type DiscordApplication,
  type DiscordBotRuntime,
} from '../src/agentBots.js';
import { PendingChoices } from '../src/choices.js';
import { renderAnswer } from '../src/renderer.js';
import { createDiscordConversationSendProvider, type SendProviderDeps } from '../src/sendProviders.js';
import { planTurn } from '../src/turn.js';
import { MIRA } from './helpers.js';

const DEFAULT_APP = '111111111111111111';
const MIRA_APP = '222222222222222222';
// Shaped like a bot token, but not a real one (and not matching Discord's token scanner).
const DEFAULT_TOKEN = 'fake-default-bot-token-aaaa.part.not-a-real-discord-token-0001';
const MIRA_TOKEN = 'fake-mira-agent-bot-token-bb.part.not-a-real-discord-token-0002';
const CHANNEL = '333333333333333333';

function sendDeps(posted: string[], label: string): SendProviderDeps {
  return {
    port: {
      channel: async () => ({
        guildId: 'g1',
        send: async (o) => {
          posted.push(`${label}:${String((o as { content?: string }).content)}`);
          return { id: 'm1', channelId: CHANNEL };
        },
      }),
      directChannel: async () => {
        throw new Error('no dm');
      },
    },
    speakerHistory: new InMemorySpeakerHistoryStore(),
    log: () => undefined,
    isAllowed: () => true,
    allowDms: true,
  };
}

function runtime(appId: string, posted: string[] = [], seen = true): DiscordBotRuntime & { closed: number } {
  const r = {
    botKey: `discord-app:${appId}`,
    appId,
    name: `app-${appId}`,
    sendDeps: sendDeps(posted, appId),
    roster: { channelType: 'discord', getRoster: async () => undefined },
    canSee: async () => seen,
    status: () => 'connected' as const,
    closed: 0,
    close: async () => {
      r.closed += 1;
    },
  };
  return r;
}

function vault() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k),
    keys: async () => [...data.keys()],
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

function rig(lookupApplication: (token: string) => Promise<DiscordApplication>, posted: string[] = []) {
  const fleet = new DiscordBotFleet({
    channelKey: () => `discord-app:${DEFAULT_APP}`,
    sendDeps: sendDeps(posted, 'default'),
    roster: { channelType: 'discord', getRoster: async () => undefined },
    token: DEFAULT_TOKEN,
  });
  const secrets = vault();
  const started: string[] = [];
  const logs: string[] = [];
  const deps: AgentBotDeps = {
    fleet,
    secrets,
    lookupApplication,
    startAgentBot: (_token, app) => (started.push(app.id), runtime(app.id, posted)),
    log: (_l, m) => void logs.push(m),
  };
  return { fleet, secrets, started, logs, deps, provider: createDiscordAgentIdentityProvider(deps) };
}

const mira = async (): Promise<DiscordApplication> => ({ id: MIRA_APP, name: 'Mira', botUsername: 'Mira' });
const input = (token: string) => ({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: token } });

describe('identity provider', () => {
  it('checks the token, keeps it in the vault, connects the bot and returns discord-app:<appId>', async () => {
    const r = rig(mira);
    const out = await r.provider.provision(input(MIRA_TOKEN));
    assert.deepEqual(out, { ok: true, channelKey: `discord-app:${MIRA_APP}`, externalRef: 'Mira', displayName: 'Mira' });
    assert.equal(r.secrets.data.get(`${AGENT_BOT_TOKEN_PREFIX}${MIRA_APP}`), MIRA_TOKEN);
    assert.deepEqual(r.started, [MIRA_APP]);
    assert.equal(r.logs.join('\n').includes(MIRA_TOKEN), false, 'the token is never logged');
    assert.equal(r.provider.defaultChannelKey?.(), `discord-app:${DEFAULT_APP}`);
  });

  it('refuses a malformed token without asking Discord, and the channel’s own token', async () => {
    let asked = 0;
    const r = rig(async () => (asked++, mira()));
    assert.equal((await r.provider.provision(input('nope'))).ok, false);
    const own = await r.provider.provision(input(DEFAULT_TOKEN));
    assert.equal(own.ok === false && own.code, 'already_in_use');
    assert.equal(asked, 0);
  });

  it('refuses the channel’s own application under another token', async () => {
    const r = rig(async () => ({ id: DEFAULT_APP, name: 'Colleague' }));
    const out = await r.provider.provision(input(MIRA_TOKEN));
    assert.equal(out.ok === false && out.code, 'already_in_use');
    assert.equal(r.secrets.data.size, 0);
  });

  it('a token Discord rejects is invalid_credentials, a network failure unreachable', async () => {
    const rejected = rig(async () => {
      throw Object.assign(new Error('Discord answered 401'), { status: 401 });
    });
    const a = await rejected.provider.provision(input(MIRA_TOKEN));
    assert.equal(a.ok === false && a.code, 'invalid_credentials');
    const down = rig(async () => {
      throw new Error('fetch failed');
    });
    const b = await down.provider.provision(input(MIRA_TOKEN));
    assert.equal(b.ok === false && b.code, 'unreachable');
  });

  it('release disconnects the bot and deletes its token', async () => {
    const r = rig(mira);
    await r.provider.provision(input(MIRA_TOKEN));
    const bot = r.fleet.agentBot(`discord-app:${MIRA_APP}`) as DiscordBotRuntime & { closed: number };
    await r.provider.release(`discord-app:${MIRA_APP}`);
    assert.equal(bot.closed, 1);
    assert.equal(r.secrets.data.size, 0);
    assert.equal((await r.provider.status!(`discord-app:${MIRA_APP}`)).state, 'stopped');
  });

  it('boot reconnects every stored agent bot', async () => {
    const r = rig(mira);
    r.secrets.data.set(`${AGENT_BOT_TOKEN_PREFIX}${MIRA_APP}`, MIRA_TOKEN);
    r.secrets.data.set('discord_bot_token', DEFAULT_TOKEN);
    await startStoredAgentBots(r.deps);
    assert.deepEqual(r.fleet.agentBotKeys(), [`discord-app:${MIRA_APP}`]);
  });
});

describe('fleet', () => {
  it('a send for an agent bot goes out through exactly that bot; an unknown key is unreachable', async () => {
    const posted: string[] = [];
    const r = rig(mira, posted);
    r.fleet.add(runtime(MIRA_APP, posted));
    const send = createDiscordConversationSendProvider((key) => r.fleet.sendDepsFor(key));
    assert.equal((await send.sendToConversation(CHANNEL, { text: 'Hallo' }, { asChannelKey: `discord-app:${MIRA_APP}` })).outcome, 'delivered');
    assert.equal((await send.sendToConversation(CHANNEL, { text: 'Standard' })).outcome, 'delivered');
    assert.deepEqual(posted, [`${MIRA_APP}:Hallo`, 'default:Standard']);
    const unknown = await send.sendToConversation(CHANNEL, { text: 'x' }, { asChannelKey: 'discord-app:999999999999999999' });
    assert.equal(unknown.outcome === 'unreachable' && unknown.code, 'not_permitted');
  });

  it('presentIn lists the agent bots that can see the channel', async () => {
    const r = rig(mira);
    r.fleet.add(runtime(MIRA_APP, [], true));
    r.fleet.add(runtime('444444444444444444', [], false));
    assert.deepEqual(await r.fleet.presentIn(CHANNEL), [`discord-app:${MIRA_APP}`]);
  });
});

describe('an agent bot routes only to its own agent', () => {
  const turn: IncomingTurn = {
    channelId: 'de.byte5.channel.discord',
    conversationId: CHANNEL,
    channelType: 'discord',
    channelKey: CHANNEL,
    conversationType: 'group',
    userRef: { kind: 'discord-user', id: 'u1', displayName: 'Uli' },
    text: 'hallo',
    metadata: { guildId: 'g1', messageId: 'm1', locale: 'de-DE' },
  };
  const agent = (seen: string[]) =>
    ({ chat: async (i: ChatTurnInput) => (seen.push(i.userMessage), { text: 'Hier ist Mira.', speaker: MIRA }) }) as unknown as ChatAgent;

  it('resolves on its bot key and answers when the kernel says the key IS the agent', async () => {
    const keys: string[] = [];
    const seen: string[] = [];
    const out = await planTurn(
      {
        route: (key) => (keys.push(key), { decision: 'bound', exclusive: true, chatAgent: agent(seen), speaker: MIRA }),
        singleton: () => undefined,
        choices: new PendingChoices(),
        log: () => undefined,
        ownBotKey: () => `discord-app:${MIRA_APP}`,
      },
      turn,
    ).run();
    assert.deepEqual(keys, [`discord-app:${MIRA_APP}`]);
    assert.equal(out?.text, 'Hier ist Mira.');
  });

  it('a key the kernel does not know as an identity is refused — no other agent answers', async () => {
    const seen: string[] = [];
    const out = await planTurn(
      {
        route: () => ({ decision: 'bound', chatAgent: agent(seen), speaker: MIRA }),
        singleton: () => undefined,
        choices: new PendingChoices(),
        log: () => undefined,
        ownBotKey: () => `discord-app:${MIRA_APP}`,
      },
      turn,
    ).run();
    assert.deepEqual(seen, []);
    assert.equal(out?.speaker?.kind, 'system');
    assert.match(out?.text ?? '', /keinem Agenten zugeordnet/);
  });

  it('an own bot renders no name line, the shared bot does where the speaker is unclear', async () => {
    const history = new InMemorySpeakerHistoryStore();
    await history.record?.('discord:c', { kind: 'agent', agentId: 'b', slug: 'ben', displayName: 'Ben' } as never);
    const answer = { text: 'Antwort', speaker: MIRA };
    const own = renderAnswer(answer, { conversationKey: 'discord:c', speakerHistory: history, nativeIdentity: true });
    assert.equal(own.content, 'Antwort');
  });
});
