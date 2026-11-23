// Group channels: an honest roster (kernel #2091) with complete / partial / unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rosterStatusOf } from '@omadia/channel-sdk';

import { DiscordRosterProvider, MAX_LISTED_MEMBERS, readRoster, type RosterMember, type RosterSource, guildMembersOf } from '../src/roster.js';

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

  it('a member list shorter than the server is partial, never complete', async () => {
    const roster = await readRoster(
      { type: 'guild', canListMembers: true, memberCount: 4, viewers: async () => [ULI, MAX], listedCount: () => 3 }, BOT);
    assert.equal(rosterStatusOf(roster), 'partial');
    assert.equal(roster.partial, true);
    assert.match(roster.statusDetail ?? '', /3 of the server's 4/);
    const full = await readRoster(
      { type: 'guild', canListMembers: true, memberCount: 3, viewers: async () => [ULI, MAX], listedCount: () => 3 }, BOT);
    assert.equal(rosterStatusOf(full), 'complete');
  });

  it('a join within the cache lifetime: seen by a fresh query, and by any query once the join dropped the cache', async () => {
    let members = [ULI];
    let reads = 0;
    const provider = new DiscordRosterProvider({
      describe: async () => ({
        type: 'guild', canListMembers: true, memberCount: members.length + 1,
        viewers: async () => (reads += 1, members), listedCount: () => members.length + 1,
      }),
      self: () => BOT,
      now: () => new Date(0),
      ttlMs: 60_000,
    });
    assert.deepEqual(ids((await provider.getRoster('c1'))!), ['bot', 'u1']);
    members = [ULI, MAX];
    assert.deepEqual(ids((await provider.getRoster('c1'))!), ['bot', 'u1'], 'cached');
    const fresh = await provider.getRoster('c1', { fresh: true });
    assert.deepEqual(ids(fresh!), ['bot', 'u1', 'u2']);
    assert.equal(rosterStatusOf(fresh!), 'complete');
    members = [ULI];
    provider.invalidateAll();
    assert.deepEqual(ids((await provider.getRoster('c1'))!), ['bot', 'u1']);
    assert.equal(reads, 3);
  });

  it('a failed fresh query is unknown and is not cached: the next query asks again', async () => {
    let fail = true;
    let reads = 0;
    const provider = new DiscordRosterProvider({
      describe: async () => ({
        type: 'guild', canListMembers: true, memberCount: 2,
        viewers: async () => { reads += 1; if (fail) throw new Error('members chunk timed out'); return [ULI]; },
      }),
      self: () => BOT,
    });
    assert.equal(rosterStatusOf((await provider.getRoster('c1', { fresh: true }))!), 'unknown');
    fail = false;
    assert.equal(rosterStatusOf((await provider.getRoster('c1'))!), 'complete');
    assert.equal(reads, 2);
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

// discord#6 live run: Discord rate-limits the gateway's Request Guild Members
// (opcode 8) per server. A fresh roster read right after another one (the
// turn's audience, then the facilitation engine's fresh read) got the limit,
// the roster came back `unknown` and the facilitation ran on an open list.
describe('the member list of a server under the gateway rate limit', () => {
  const limited = (retryAfter: number) => Object.assign(new Error('Request with opcode 8 was rate limited.'), { data: { retry_after: retryAfter } });

  it('a member cache that holds every member is the list: no gateway request', async () => {
    let fetched = 0;
    const members = await guildMembersOf({ cache: { size: 3 }, fetch: async () => { fetched += 1; } }, () => 3, async () => undefined);
    assert.equal(fetched, 0);
    assert.equal(members, 'cache');
  });

  it('a short cache asks the gateway', async () => {
    const cache = { size: 1 };
    let fetched = 0;
    await guildMembersOf({ cache, fetch: async () => { fetched += 1; cache.size = 3; } }, () => 3, async () => undefined);
    assert.equal(fetched, 1);
  });

  it('a rate limit is waited out once, then the gateway is asked again', async () => {
    const cache = { size: 1 };
    const waits: number[] = [];
    let calls = 0;
    await guildMembersOf(
      { cache, fetch: async () => { calls += 1; if (calls === 1) throw limited(2.5); cache.size = 3; } },
      () => 3,
      async (ms) => { waits.push(ms); },
    );
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2500]);
  });

  it('a second rate limit, a long one or another failure is passed on (the roster is then unknown)', async () => {
    const twice = { cache: { size: 1 }, fetch: async () => { throw limited(1); } };
    await assert.rejects(guildMembersOf(twice, () => 3, async () => undefined), /rate limited/);
    let calls = 0;
    const long = { cache: { size: 1 }, fetch: async () => { calls += 1; throw limited(120); } };
    await assert.rejects(guildMembersOf(long, () => 3, async () => undefined), /rate limited/);
    assert.equal(calls, 1, 'a wait longer than a turn can bear is not taken');
    await assert.rejects(guildMembersOf({ cache: { size: 1 }, fetch: async () => { throw new Error('boom'); } }, () => 3, async () => undefined), /boom/);
  });
});
