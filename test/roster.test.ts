// Group channels: an honest roster (kernel #2091) with complete / partial / unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rosterStatusOf } from '@omadia/channel-sdk';

import { DiscordRosterProvider, MAX_LISTED_MEMBERS, readRoster, type RosterMember, type RosterSource } from '../src/roster.js';

const BOT: RosterMember = { id: 'bot', username: 'omadia', isBot: true };
const ULI: RosterMember = { id: 'u1', username: 'uli', displayName: 'Uli', isBot: false };
const MAX: RosterMember = { id: 'u2', username: 'max', isBot: false };

const ids = (r: { participants: readonly { userRef: { id: string } }[] }) => r.participants.map((p) => p.userRef.id).sort();

describe('roster', () => {
  it('a DM is complete: the user and this bot', async () => {
    const roster = await readRoster({ type: 'direct', recipient: ULI }, BOT);
    assert.equal(roster.conversationType, 'direct');
    assert.equal(rosterStatusOf(roster), 'complete');
    assert.deepEqual(ids(roster), ['bot', 'u1']);
    assert.equal(roster.self?.userRef.id, 'bot');
  });

  it('a server channel without the Server Members intent is unknown, with the reason', async () => {
    let asked = false;
    const source: RosterSource = {
      type: 'guild', canListMembers: false, memberCount: 10,
      viewers: async () => { asked = true; return [ULI]; },
    };
    const roster = await readRoster(source, BOT);
    assert.equal(rosterStatusOf(roster), 'unknown');
    assert.equal(roster.partial, true);
    assert.deepEqual(roster.participants, []);
    assert.match(roster.statusDetail ?? '', /Server Members/);
    assert.equal(asked, false);
  });

  it('with the intent a small server channel is complete: everyone who can see it, plus the bot', async () => {
    const roster = await readRoster({ type: 'guild', canListMembers: true, memberCount: 3, viewers: async () => [ULI, MAX] }, BOT);
    assert.equal(rosterStatusOf(roster), 'complete');
    assert.equal(roster.conversationType, 'group');
    assert.deepEqual(ids(roster), ['bot', 'u1', 'u2']);
  });

  it('a very large server is partial, never complete', async () => {
    const roster = await readRoster(
      { type: 'guild', canListMembers: true, memberCount: MAX_LISTED_MEMBERS + 1, viewers: async () => [ULI] }, BOT);
    assert.equal(rosterStatusOf(roster), 'partial');
    assert.match(roster.statusDetail ?? '', /more than/);
  });

  it('a member list that fails to load is unknown, not an empty complete roster', async () => {
    const roster = await readRoster(
      { type: 'guild', canListMembers: true, memberCount: 3, viewers: async () => { throw new Error('timeout'); } }, BOT);
    assert.equal(rosterStatusOf(roster), 'unknown');
    assert.deepEqual(roster.participants, []);
    assert.match(roster.statusDetail ?? '', /timeout/);
  });

  it('the provider caches a read, bypasses on fresh, and answers only for its own identity', async () => {
    let reads = 0;
    let t = 0;
    const provider = new DiscordRosterProvider({
      describe: async () => ({ type: 'guild', canListMembers: true, memberCount: 2, viewers: async () => (reads += 1, [ULI]) }),
      self: () => BOT,
      now: () => new Date(t),
      ttlMs: 1_000,
    });
    const first = await provider.getRoster('c1');
    await provider.getRoster('c1');
    assert.equal(reads, 1);
    t = 500;
    assert.equal((await provider.getRoster('c1'))?.readAt, first?.readAt, 'a cached answer keeps the original read time');
    await provider.getRoster('c1', { fresh: true });
    assert.equal(reads, 2);
    t = 5_000;
    await provider.getRoster('c1');
    assert.equal(reads, 3);
    assert.equal(await provider.getRoster('c1', { asChannelKey: 'someone-else' }), undefined);
    assert.ok(await provider.getRoster('c1', { asChannelKey: 'bot' }));
    assert.equal(provider.channelType, 'discord');
  });

  it('a conversation the bot cannot see has no roster', async () => {
    const provider = new DiscordRosterProvider({ describe: async () => undefined, self: () => BOT });
    assert.equal(await provider.getRoster('gone'), undefined);
  });
});
