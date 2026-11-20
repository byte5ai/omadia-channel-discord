// Kernel-initiated sends (#330 B3/C3b, #2043): DM one person, post into a
// channel. Text only, through exactly the bot `asChannelKey` names; no poll,
// no card.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type TargetedMessage } from '@omadia/channel-sdk';

import {
  createDiscordConversationSendProvider,
  createDiscordTargetedSendProvider,
  discordUserIdOf,
  ownReactionRoute,
  type ProactiveChannel,
  type SendProviderDeps,
} from '../src/sendProviders.js';

const USER = '123456789012345678';
const CHANNEL = '223456789012345678';

function apiError(code: number): Error {
  return Object.assign(new Error(`discord ${String(code)}`), { code });
}

function setup(over: Partial<SendProviderDeps> = {}, failWith?: { channel?: Error; dm?: Error; react?: Error }) {
  const posted: { target: string; content?: string }[] = [];
  const reactions: string[] = [];
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
      addOwnReaction: async (route) => {
        if (failWith?.react) throw failWith.react;
        reactions.push(route);
      },
    },
    speakerHistory: new InMemorySpeakerHistoryStore(),
    log: () => undefined,
    isAllowed: () => true,
    allowDms: true,
    ...over,
  };
  // One bot: no key and its own key name it, nothing else does.
  const lookup = (key: string | undefined) => (key === undefined || key === OWN_KEY ? deps : undefined);
  return { deps: lookup, posted, reactions };
}

const OWN_KEY = 'discord-app:323456789012345678';

const text = (t: string): TargetedMessage => ({ text: t });

describe('capabilities', () => {
  it('declare the named identity and nothing else: no poll, card, mentions or AI label', () => {
    const { deps } = setup();
    const targeted = createDiscordTargetedSendProvider(deps);
    assert.equal(targeted.channelType, 'discord');
    assert.deepEqual({ ...targeted.supports }, { asChannelKey: true });
  });

  it('the conversation provider also declares reactions, and implements them', () => {
    const { deps } = setup();
    const conversation = createDiscordConversationSendProvider(deps);
    assert.equal(conversation.channelType, 'discord');
    assert.deepEqual({ ...conversation.supports }, { asChannelKey: true, reactions: true });
    assert.equal(typeof conversation.react, 'function');
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

  it('refuses to send as an identity that does not run here, never through another bot (kernel contract)', async () => {
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
    assert.deepEqual(out, { outcome: 'delivered', messageId: 'm-1', conversationId: `c-${CHANNEL}` });
    assert.deepEqual(posted, [{ target: CHANNEL, content: 'Hinweis' }]);
  });

  it('refuses an unknown identity, a poll, a card and a non-channel id', async () => {
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

describe('reaction (a thumbs-up on a message, spec 2043 §5.14)', () => {
  const MESSAGE = '423456789012345678';
  const THUMBS_UP_ROUTE = `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%F0%9F%91%8D/@me`;
  const as = { asChannelKey: OWN_KEY };

  it('builds Discord\'s Create Reaction route with the URL-encoded emoji', () => {
    assert.equal(ownReactionRoute(CHANNEL, MESSAGE, '\u{1F44D}'), THUMBS_UP_ROUTE);
  });

  it('PUTs a thumbs-up on the message (channel id + message id as the inbound event stated them)', async () => {
    const { deps, reactions, posted } = setup();
    const out = await createDiscordConversationSendProvider(deps).react!(CHANNEL, MESSAGE, 'acknowledge', as);
    assert.deepEqual(out, { outcome: 'reacted' });
    assert.deepEqual(reactions, [THUMBS_UP_ROUTE]);
    assert.deepEqual(posted, [], 'a reaction posts no message');
  });

  it('accepts the identity key in any case, like a send', async () => {
    const { deps, reactions } = setup();
    const out = await createDiscordConversationSendProvider(deps).react!(CHANNEL, MESSAGE, 'acknowledge', {
      asChannelKey: OWN_KEY.toUpperCase(),
    });
    assert.deepEqual(out, { outcome: 'reacted' });
    assert.equal(reactions.length, 1);
  });

  it('refuses an unknown or missing identity, never reacts through another bot', async () => {
    const { deps, reactions } = setup();
    const provider = createDiscordConversationSendProvider(deps);
    for (const asChannelKey of ['discord:agent-mira', 'discord-app:999999999999999999', '', '  ']) {
      const out = await provider.react!(CHANNEL, MESSAGE, 'acknowledge', { asChannelKey });
      assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted', asChannelKey);
    }
    const none = await provider.react!(CHANNEL, MESSAGE, 'acknowledge', undefined as never);
    assert.equal(none.outcome === 'unreachable' && none.code, 'not_permitted');
    assert.deepEqual(reactions, []);
  });

  it('refuses ids that are not Discord ids and an unknown reaction', async () => {
    const { deps, reactions } = setup();
    const provider = createDiscordConversationSendProvider(deps);
    const badChannel = await provider.react!('session-scope', MESSAGE, 'acknowledge', as);
    assert.equal(badChannel.outcome === 'unreachable' && badChannel.code, 'no_binding');
    const badMessage = await provider.react!(CHANNEL, '1700000000.0001', 'acknowledge', as);
    assert.equal(badMessage.outcome === 'unreachable' && badMessage.code, 'no_binding');
    const party = await provider.react!(CHANNEL, MESSAGE, 'party' as never, as);
    assert.equal(party.outcome === 'unreachable' && party.code, 'channel_error');
    assert.deepEqual(reactions, []);
  });

  it('does not react in a server that is not on the allowlist', async () => {
    const { deps, reactions } = setup({ isAllowed: () => false });
    const out = await createDiscordConversationSendProvider(deps).react!(CHANNEL, MESSAGE, 'acknowledge', as);
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    assert.deepEqual(reactions, []);
  });

  it('maps 403, 404 and 429 and keeps Discord\'s message, never throws', async () => {
    const httpError = (status: number, code: number | string, text: string): Error =>
      Object.assign(new Error(text), { status, code });
    const rateLimit = Object.assign(new Error('Request to use token, but token was unavailable'), { name: 'RateLimitError' });
    const cases: [Error, string, string][] = [
      [httpError(403, 50013, 'Missing Permissions'), 'not_permitted', 'Missing Permissions'],
      [httpError(403, 90001, 'Reaction blocked'), 'not_permitted', 'Reaction blocked'],
      [httpError(403, 50001, 'Missing Access'), 'not_permitted', 'Missing Access'],
      [httpError(404, 10008, 'Unknown Message'), 'no_binding', 'Unknown Message'],
      [httpError(404, 10003, 'Unknown Channel'), 'no_binding', 'Unknown Channel'],
      [httpError(429, 'RateLimited', 'You are being rate limited.'), 'channel_error', 'You are being rate limited.'],
      [rateLimit, 'channel_error', 'token was unavailable'],
      [httpError(500, 0, 'Internal Server Error'), 'channel_error', 'Internal Server Error'],
      [new Error('socket hang up'), 'channel_error', 'socket hang up'],
    ];
    for (const [err, expected, text] of cases) {
      const { deps } = setup({}, { react: err });
      const out = await createDiscordConversationSendProvider(deps).react!(CHANNEL, MESSAGE, 'acknowledge', as);
      assert.equal(out.outcome === 'unreachable' && out.code, expected, err.message);
      assert.ok(out.outcome === 'unreachable' && out.message.includes(text), out.outcome === 'unreachable' ? out.message : '');
    }
  });

  it('an unknown channel on the lookup is no_binding, nothing is set', async () => {
    const { deps, reactions } = setup({}, { channel: apiError(10003) });
    const out = await createDiscordConversationSendProvider(deps).react!(CHANNEL, MESSAGE, 'acknowledge', as);
    assert.equal(out.outcome === 'unreachable' && out.code, 'no_binding');
    assert.deepEqual(reactions, []);
  });
});
