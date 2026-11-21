// Presence and membership (#330, #2043): the kernel subscribes a facilitator
// only in a conversation a channel reported the bot in (`bot_present`), and a
// facilitation hears who joined or left.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConversationMembershipEvent } from '@omadia/channel-sdk';

import { BOT_PRESENT_REEMIT_MS, BotPresence } from '../src/presence.js';

const SELF = { kind: 'discord-user', id: 'bot' } as const;
const ULI = { kind: 'discord-user', id: 'u1', displayName: 'Uli' } as const;
const AT = '2026-11-21T10:00:00.000Z';

function presence() {
  const events: ConversationMembershipEvent[] = [];
  let now = 0;
  const p = new BotPresence({
    channelId: 'de.byte5.channel.discord',
    emit: (e) => void events.push(e),
    log: () => undefined,
    now: () => now,
  });
  return { p, events, advance: (ms: number) => void (now += ms) };
}

describe('bot presence', () => {
  it('the first group message of a conversation reports the bot present there, with the author', () => {
    const { p, events } = presence();
    p.observe('c1', 'g1', SELF, ULI, AT);
    assert.deepEqual(events, [
      {
        kind: 'bot_present',
        channelId: 'de.byte5.channel.discord',
        channelType: 'discord',
        conversationId: 'c1',
        conversationType: 'group',
        members: [SELF],
        addedBy: ULI,
        occurredAt: AT,
      },
    ]);
  });

  it('is not repeated for every message, but again after the re-emit interval', () => {
    const { p, events, advance } = presence();
    p.observe('c1', 'g1', SELF, ULI, AT);
    advance(1_000);
    p.observe('c1', 'g1', SELF, ULI, AT);
    p.observe('c2', 'g1', SELF, ULI, AT);
    assert.deepEqual(events.map((e) => e.conversationId), ['c1', 'c2']);
    advance(BOT_PRESENT_REEMIT_MS);
    p.observe('c1', 'g1', SELF, ULI, AT);
    assert.equal(events.length, 3);
  });

  it('a failing kernel is logged, never thrown into the message', () => {
    const logs: string[] = [];
    const p = new BotPresence({
      channelId: 'x',
      emit: () => {
        throw new Error('hub down');
      },
      log: (_l, m) => void logs.push(m),
    });
    assert.doesNotThrow(() => p.observe('c1', 'g1', SELF, undefined, AT));
    assert.equal(logs.length, 1);
  });
});

describe('server joins and leaves', () => {
  it('reach the observed conversations of that server, a join only where the person can see the channel', () => {
    const { p, events } = presence();
    p.observe('c1', 'g1', SELF, ULI, AT);
    p.observe('c2', 'g1', SELF, ULI, AT);
    p.observe('c3', 'g2', SELF, ULI, AT);
    events.length = 0;

    const anna = { kind: 'discord-user', id: 'u9', displayName: 'Anna' };
    assert.equal(p.memberChanged('g1', anna, 'added', AT, (id) => id === 'c1'), 1);
    assert.deepEqual(events, [
      {
        kind: 'members_added',
        channelId: 'de.byte5.channel.discord',
        channelType: 'discord',
        conversationId: 'c1',
        conversationType: 'group',
        members: [anna],
        occurredAt: AT,
      },
    ]);
    events.length = 0;
    assert.equal(p.memberChanged('g1', anna, 'removed', AT), 2);
    assert.deepEqual(events.map((e) => [e.kind, e.conversationId]), [
      ['members_removed', 'c1'],
      ['members_removed', 'c2'],
    ]);
  });

  it('a server the bot was never observed in gets nothing', () => {
    const { p, events } = presence();
    assert.equal(p.memberChanged('g1', ULI, 'added', AT), 0);
    assert.deepEqual(events, []);
  });
});
