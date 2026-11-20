// Kernel-initiated sends (#330 B3/C3b, #2043): DM one person, post into a
// channel. Text only; no identity of its own, no poll, no card.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type TargetedMessage } from '@omadia/channel-sdk';

import {
  createDiscordConversationSendProvider,
  createDiscordTargetedSendProvider,
  discordUserIdOf,
  type ProactiveChannel,
  type SendProviderDeps,
} from '../src/sendProviders.js';

const USER = '123456789012345678';
const CHANNEL = '223456789012345678';

function apiError(code: number): Error {
  return Object.assign(new Error(`discord ${String(code)}`), { code });
}

function setup(over: Partial<SendProviderDeps> = {}, failWith?: { channel?: Error; dm?: Error }) {
  const posted: { target: string; content?: string }[] = [];
  const place = (target: string, guildId: string | null): ProactiveChannel => ({
    guildId,
    send: async (o) => {
      posted.push({ target, ...('content' in o && typeof o.content === 'string' ? { content: o.content } : {}) });
      return { id: `m-${String(posted.length)}`, channelId: `c-${target}` };
    },
  });
  const deps: SendProviderDeps = {
    port: {
      channel: async (id) => {
        if (failWith?.channel) throw failWith.channel;
        return place(id, 'g1');
      },
      directChannel: async (id) => {
        if (failWith?.dm) throw failWith.dm;
        return place(`dm:${id}`, null);
      },
    },
    speakerHistory: new InMemorySpeakerHistoryStore(),
    log: () => undefined,
    isAllowed: () => true,
    allowDms: true,
    ...over,
  };
  return { deps, posted };
}

const text = (t: string): TargetedMessage => ({ text: t });

describe('capabilities', () => {
  it('declare nothing beyond text: no own identity, poll, card, mentions or AI label', () => {
    const { deps } = setup();
    for (const provider of [createDiscordTargetedSendProvider(deps), createDiscordConversationSendProvider(deps)]) {
      assert.equal(provider.channelType, 'discord');
      assert.deepEqual({ ...provider.supports }, {});
    }
  });
});

describe('targeted send (a DM to one person)', () => {
  it('posts the text as a system message and reports the message and the DM channel', async () => {
    const { deps, posted } = setup();
    const out = await createDiscordTargetedSendProvider(deps).sendToUser({ principalId: `discord-user:${USER}` }, text('Erinnerung'));
    assert.deepEqual(out, { outcome: 'delivered', messageId: 'm-1', conversationId: `c-dm:${USER}` });
    assert.deepEqual(posted, [{ target: `dm:${USER}`, content: 'Erinnerung' }]);
  });

  it('reads the user from the principal in either spelling or from the user reference', () => {
    assert.equal(discordUserIdOf({ principalId: `user:discord-user:${USER}` }), USER);
    assert.equal(discordUserIdOf({ principalId: 'x', userRef: { kind: 'discord-user', id: USER } }), USER);
    assert.equal(discordUserIdOf({ principalId: 'uli@example.com' }), undefined);
    assert.equal(discordUserIdOf({ principalId: 'discord-user:abc' }), undefined);
  });

  it('a person only known by e-mail is unreachable by name, nothing is posted', async () => {
    const { deps, posted } = setup();
    const out = await createDiscordTargetedSendProvider(deps).sendToUser({ principalId: 'uli@example.com' }, text('x'));
    assert.equal(out.outcome, 'unreachable');
    assert.equal(out.outcome === 'unreachable' && out.code, 'no_binding');
    assert.deepEqual(posted, []);
  });

  it('refuses to send as a named identity: there is one bot, never another identity (kernel contract)', async () => {
    const { deps, posted } = setup();
    const out = await createDiscordTargetedSendProvider(deps).sendToUser(
      { principalId: `discord-user:${USER}` },
      text('x'),
      { asChannelKey: 'discord:agent-mira' },
    );
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    assert.deepEqual(posted, []);
  });

  it('refuses a poll and a question card instead of posting text nobody can answer', async () => {
    const { deps, posted } = setup();
    const provider = createDiscordTargetedSendProvider(deps);
    const target = { principalId: `discord-user:${USER}` };
    const poll = { pollId: 'p1', question: 'Wann?', options: [{ id: 'a', label: 'Mo' }, { id: 'b', label: 'Di' }] };
    const card = { cardId: 'c1', title: 'T', questions: [] };
    for (const message of [{ text: 'x', poll }, { text: 'x', card }] as TargetedMessage[]) {
      const out = await provider.sendToUser(target, message);
      assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
    }
    assert.deepEqual(posted, []);
  });

  it('respects the settings: DMs off, or a person not on the allowlist', async () => {
    for (const over of [{ allowDms: false }, { isAllowed: () => false }]) {
      const { deps, posted } = setup(over);
      const out = await createDiscordTargetedSendProvider(deps).sendToUser({ principalId: `discord-user:${USER}` }, text('x'));
      assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
      assert.deepEqual(posted, []);
    }
  });

  it('names why a person cannot be reached, never throws', async () => {
    const cases: [number, string][] = [[10013, 'user_not_found'], [50007, 'blocked']];
    for (const [code, expected] of cases) {
      const { deps } = setup({}, { dm: apiError(code) });
      const out = await createDiscordTargetedSendProvider(deps).sendToUser({ principalId: `discord-user:${USER}` }, text('x'));
      assert.equal(out.outcome === 'unreachable' && out.code, expected);
    }
    const { deps } = setup({}, { dm: new Error('boom') });
    const out = await createDiscordTargetedSendProvider(deps).sendToUser({ principalId: `discord-user:${USER}` }, text('x'));
    assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
  });
});

describe('conversation send (a post into a channel)', () => {
  it('posts into the channel and reports the message', async () => {
    const { deps, posted } = setup();
    const out = await createDiscordConversationSendProvider(deps).sendToConversation(CHANNEL, text('Hinweis'));
    assert.equal(out.outcome, 'delivered');
    assert.deepEqual(posted, [{ target: CHANNEL, content: 'Hinweis' }]);
  });

  it('refuses a named identity, a poll, a card and a non-channel id', async () => {
    const { deps, posted } = setup();
    const provider = createDiscordConversationSendProvider(deps);
    const identity = await provider.sendToConversation(CHANNEL, text('x'), { asChannelKey: 'discord:agent-mira' });
    assert.equal(identity.outcome === 'unreachable' && identity.code, 'not_permitted');
    const poll = await provider.sendToConversation(CHANNEL, { text: 'x', poll: { pollId: 'p', question: 'q', options: [] } });
    assert.equal(poll.outcome === 'unreachable' && poll.code, 'channel_error');
    const bad = await provider.sendToConversation('session-scope', text('x'));
    assert.equal(bad.outcome === 'unreachable' && bad.code, 'no_binding');
    assert.deepEqual(posted, []);
  });

  it('does not post into a server that is not on the allowlist', async () => {
    const { deps, posted } = setup({ isAllowed: () => false });
    const out = await createDiscordConversationSendProvider(deps).sendToConversation(CHANNEL, text('x'));
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    assert.deepEqual(posted, []);
  });

  it('names an unknown channel and missing permissions', async () => {
    const cases: [number, string][] = [[10003, 'no_binding'], [50001, 'not_permitted'], [50013, 'not_permitted']];
    for (const [code, expected] of cases) {
      const { deps } = setup({}, { channel: apiError(code) });
      const out = await createDiscordConversationSendProvider(deps).sendToConversation(CHANNEL, text('x'));
      assert.equal(out.outcome === 'unreachable' && out.code, expected);
    }
  });
});
