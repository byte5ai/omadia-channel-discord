// Readiness (#2043 §6.4, kernel #2091): the kernel subscribes a facilitator's
// process to every message of a Discord channel only when its bot can really
// read every message there. The report names each thing that is missing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';

import { DiscordBotFleet } from '../src/agentBots.js';
import {
  createDiscordReadinessProvider,
  readinessReport,
  type ReadinessFacts,
  type ReadinessSettings,
  type ReadinessSource,
} from '../src/readiness.js';
import type { SendProviderDeps } from '../src/sendProviders.js';

const READY_SETTINGS: ReadinessSettings = { messageContentIntent: true, guildsSwitchedOff: false };
const OPEN_CHANNEL: ReadinessFacts = {
  kind: 'guild_channel',
  isThread: false,
  canView: true,
  canReadHistory: true,
  canSend: true,
  serverAllowlisted: true,
};

const codes = (r: { missing: readonly { code: string }[] }) => r.missing.map((m) => m.code);

describe('readiness of one bot in one conversation', () => {
  it('a server channel with the Message Content intent and all permissions is ready', () => {
    const report = readinessReport(OPEN_CHANNEL, READY_SETTINGS);
    assert.deepEqual(report, { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] });
  });

  it('without the Message Content intent it is not ready: Discord withholds unaddressed text', () => {
    const report = readinessReport(OPEN_CHANNEL, { ...READY_SETTINGS, messageContentIntent: false });
    assert.equal(report.ready, false);
    assert.equal(report.canReadAllMessages, false);
    assert.equal(report.canPost, true);
    assert.deepEqual(codes(report), ['consent_missing']);
    assert.match(report.missing[0]?.message ?? '', /Message Content/);
  });

  it('servers switched off, a server off the allowlist and missing read permissions are each named', () => {
    const report = readinessReport(
      { ...OPEN_CHANNEL, serverAllowlisted: false, canReadHistory: false },
      { ...READY_SETTINGS, guildsSwitchedOff: true },
    );
    assert.equal(report.ready, false);
    assert.equal(report.missing.length, 3);
    assert.ok(report.missing.some((m) => /switched off/.test(m.message)));
    assert.ok(report.missing.some((m) => /allowlist/.test(m.message)));
    assert.ok(report.missing.some((m) => /Read Message History/.test(m.message)));
  });

  it('a bot that may read but not post is not ready either (cannot_post), and a thread names its own permission', () => {
    const report = readinessReport({ ...OPEN_CHANNEL, isThread: true, canSend: false }, READY_SETTINGS);
    assert.equal(report.ready, false);
    assert.equal(report.canReadAllMessages, true);
    assert.equal(report.canPost, false);
    assert.deepEqual(codes(report), ['cannot_post']);
    assert.match(report.missing[0]?.message ?? '', /in Threads/);
  });

  it('a channel the bot cannot see is not installed; a DM is no group; an offline bot is unverified', () => {
    assert.deepEqual(codes(readinessReport({ kind: 'not_visible' }, READY_SETTINGS)), ['app_not_installed']);
    assert.deepEqual(codes(readinessReport({ kind: 'direct' }, READY_SETTINGS)), ['unsupported_conversation']);
    const offline = readinessReport({ kind: 'offline', detail: 'status connecting' }, READY_SETTINGS);
    assert.equal(offline.ready, false);
    assert.equal(offline.verified, false);
    assert.match(offline.missing[0]?.message ?? '', /not connected/);
  });
});

describe('the readiness provider', () => {
  const source = (facts: ReadinessFacts | Error): ReadinessSource => ({
    readinessFacts: async () => {
      if (facts instanceof Error) throw facts;
      return facts;
    },
  });

  it('answers for exactly the bot the key names; an unknown key is no_identity, never another bot', async () => {
    const asked: string[] = [];
    const provider = createDiscordReadinessProvider((key) => {
      asked.push(key);
      return key === 'discord-app:222' ? source(OPEN_CHANNEL) : undefined;
    }, READY_SETTINGS);
    assert.equal(provider.channelType, 'discord');
    assert.equal((await provider.check('c1', { asChannelKey: ' Discord-App:222 ' })).ready, true);
    const unknown = await provider.check('c1', { asChannelKey: 'discord-app:999' });
    assert.equal(unknown.ready, false);
    assert.deepEqual(codes(unknown), ['no_identity']);
    assert.deepEqual(asked, ['discord-app:222', 'discord-app:999']);
  });

  it('a failing check is returned as not ready, never thrown', async () => {
    const provider = createDiscordReadinessProvider(() => source(new Error('gateway gone')), READY_SETTINGS);
    const report = await provider.check('c1', { asChannelKey: 'discord-app:222' });
    assert.equal(report.ready, false);
    assert.match(report.missing[0]?.message ?? '', /gateway gone/);
  });

  it('the fleet hands out the readiness of the default bot and of agent bots by key', () => {
    const deps = {
      port: {} as never,
      speakerHistory: new InMemorySpeakerHistoryStore(),
      log: () => undefined,
      isAllowed: () => true,
      allowDms: true,
    } satisfies SendProviderDeps;
    const own = source(OPEN_CHANNEL);
    const fleet = new DiscordBotFleet({
      channelKey: () => 'discord-app:111',
      sendDeps: deps,
      roster: { channelType: 'discord', getRoster: async () => undefined },
      readiness: own,
      token: 'x',
    });
    assert.equal(fleet.readinessFor('discord-app:111'), own);
    assert.equal(fleet.readinessFor('discord-app:999'), undefined);
    assert.equal(fleet.readinessFor(''), undefined);
  });
});
