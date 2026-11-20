// Triggers and routines on Discord (spec 2042 §5.12, §5.3): every turn opens
// the kernel's routines scope with a delivery ref naming the bot, and a
// delivery goes out through exactly that bot.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type ChatAgent, type IncomingTurn } from '@omadia/channel-sdk';

import { PendingChoices } from '../src/choices.js';
import { createDiscordProactiveSend, createDiscordRoutineTurn, parseDeliveryRef } from '../src/routines.js';
import type { ProactiveChannel, SendProviderDeps } from '../src/sendProviders.js';
import { planTurn } from '../src/turn.js';
import { MIRA, PAUL } from './helpers.js';

const CHANNEL_ID = '@omadia/channel-discord';
const MIRA_KEY = 'discord-app:323456789012345678';
const CHAN = '223456789012345678';
const USER = '123456789012345678';

function bot(nativeIdentity: boolean, isAllowed = true) {
  const posted: { target: string; content: string }[] = [];
  const place = (target: string, guildId: string | null): ProactiveChannel => ({
    guildId,
    send: async (o) => {
      posted.push({ target, content: 'content' in o && typeof o.content === 'string' ? o.content : '' });
      return { id: `m-${String(posted.length)}` };
    },
  });
  const deps: SendProviderDeps = {
    port: { channel: async (id) => place(id, 'g1'), directChannel: async (id) => place(`dm:${id}`, null) },
    speakerHistory: new InMemorySpeakerHistoryStore(),
    log: () => undefined,
    isAllowed: () => isAllowed,
    allowDms: true,
    ...(nativeIdentity ? { nativeIdentity: true } : {}),
  };
  return { deps, posted };
}

function fleet(isAllowed = true) {
  const shared = bot(false, isAllowed);
  const mira = bot(true, isAllowed);
  const lookup = (key: string | undefined) => (key === undefined ? shared.deps : key === MIRA_KEY ? mira.deps : undefined);
  return { shared, mira, send: createDiscordProactiveSend(lookup) };
}

describe('routines scope per turn', () => {
  it("files the conversation and, on an agent's own bot, that bot", () => {
    const seen: unknown[] = [];
    const routines = { beginRoutineTurn: (info: unknown) => (seen.push(info), <T,>(fn: () => Promise<T>) => fn()) };
    createDiscordRoutineTurn(routines as never, CHANNEL_ID, () => MIRA_KEY)({ userId: USER, conversationId: CHAN });
    createDiscordRoutineTurn(routines as never, CHANNEL_ID, () => undefined)({ userId: USER, conversationId: CHAN });
    assert.deepEqual(seen, [
      { userId: USER, channel: 'discord', conductorBinding: false, conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: CHAN, asChannelKey: MIRA_KEY } },
      { userId: USER, channel: 'discord', conductorBinding: false, conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: CHAN } },
    ]);
  });

  it('the turn runs inside the scope, with the user id the agent sees', async () => {
    const events: unknown[] = [];
    let inside = false;
    const agent = { chat: async (input: { userId?: string }) => (events.push({ inside, userId: input.userId }), { text: 'ok', speaker: MIRA }) } as unknown as ChatAgent;
    const turn: IncomingTurn = {
      channelId: CHANNEL_ID,
      conversationId: CHAN,
      channelType: 'discord',
      channelKey: CHAN,
      conversationType: 'direct',
      userRef: { kind: 'discord-user', id: USER },
      text: 'erinnere mich',
    };
    await planTurn(
      {
        route: () => undefined,
        singleton: () => agent,
        choices: new PendingChoices(),
        log: () => undefined,
        routineTurn: (info) => {
          events.push(info);
          return async (fn) => {
            inside = true;
            try {
              return await fn();
            } finally {
              inside = false;
            }
          };
        },
      },
      turn,
    ).run();
    assert.deepEqual(events, [{ userId: USER, conversationId: CHAN }, { inside: true, userId: USER }]);
  });
});

describe('proactive send', () => {
  it("goes out through the agent's own bot, without a name line", async () => {
    const f = fleet();
    await f.send({ kind: 'channel', conversationId: CHAN, asChannelKey: MIRA_KEY }, { text: 'Dein Bericht ist fertig.', speaker: MIRA });
    await f.send({ kind: 'channel', conversationId: CHAN, asChannelKey: MIRA_KEY }, { text: 'Noch etwas.', speaker: PAUL });
    assert.deepEqual(f.mira.posted.map((p) => p.content), ['Dein Bericht ist fertig.', 'Noch etwas.']);
    assert.equal(f.shared.posted.length, 0);
  });

  it("goes out through the installation's bot, named like an answer when the speaker changes", async () => {
    const f = fleet();
    await f.send({ kind: 'channel', conversationId: CHAN }, { text: 'Eins.', speaker: MIRA });
    await f.send({ kind: 'channel', conversationId: CHAN }, { text: 'Zwei.', speaker: PAUL });
    assert.equal(f.mira.posted.length, 0);
    assert.match(f.shared.posted[1]?.content ?? '', /Paul/);
  });

  it('a DM conversation goes to the person', async () => {
    const f = fleet();
    await f.send({ kind: 'channel', conversationId: `dm:${USER}`, asChannelKey: MIRA_KEY }, { text: 'Hallo.', speaker: MIRA });
    assert.equal(f.mira.posted[0]?.target, `dm:${USER}`);
  });

  it('a bot that does not run here, or a server off the allowlist, is an error', async () => {
    const f = fleet();
    await assert.rejects(
      f.send({ kind: 'channel', conversationId: CHAN, asChannelKey: 'discord-app:999999999999999999' }, { text: 'x', speaker: MIRA }),
      /no Discord bot/,
    );
    const closed = fleet(false);
    await assert.rejects(closed.send({ kind: 'channel', conversationId: CHAN }, { text: 'x', speaker: MIRA }), /allowlist/);
    assert.equal(f.shared.posted.length + f.mira.posted.length + closed.shared.posted.length, 0);
  });

  it('"nothing to report" is dropped', async () => {
    const f = fleet();
    await f.send({ kind: 'channel', conversationId: CHAN, asChannelKey: MIRA_KEY }, { text: 'NO_REPLY', speaker: MIRA });
    assert.equal(f.mira.posted.length, 0);
  });

  it('reads only Discord conversations from a ref', () => {
    assert.deepEqual(parseDeliveryRef({ conversationId: CHAN, asChannelKey: ' Discord-App:1 ' }), { conversationId: CHAN, asChannelKey: 'discord-app:1' });
    assert.equal(parseDeliveryRef({ conversationId: 'chat-1' }), undefined);
    assert.equal(parseDeliveryRef(null), undefined);
  });
});
