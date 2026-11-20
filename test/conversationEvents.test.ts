// Received messages as conversation events (#2086): a typed reply to a question the
// kernel posted as numbered text needs the reply, its reply target and whether the
// bot was addressed. No emission without the kernel's registry.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, type ConversationMessageEvent } from '@omadia/channel-sdk';
import type { Message } from 'discord.js';

import { buildCreatedEvent, discordBotChannelKey, isAddressedToBot } from '../src/conversationEvents.js';
import { DiscordConnection, type DiscordConnectionDeps } from '../src/discordConnection.js';
import { MIRA } from './helpers.js';

const BOT = '900000000000000001';

interface StubOptions {
  content?: string;
  guild?: boolean;
  mentionsBot?: boolean;
  repliesToMessage?: string;
  repliedUserId?: string;
  channelId?: string;
}

function stubMessage(o: StubOptions = {}): Message {
  const guild = o.guild ?? true;
  return {
    id: 'msg-2',
    channelId: o.channelId ?? 'chan-1',
    guildId: guild ? 'g1' : null,
    guild: guild ? { preferredLocale: 'de' } : null,
    channel: { type: guild ? 0 : 1, send: async () => undefined, sendTyping: async () => undefined },
    partial: false,
    author: { id: 'u1', bot: false, username: 'uli', globalName: 'Uli' },
    content: o.content ?? '2',
    createdTimestamp: Date.parse('2026-11-20T10:00:00Z'),
    reference: o.repliesToMessage ? { messageId: o.repliesToMessage } : null,
    mentions: {
      users: { has: (id: string) => o.mentionsBot === true && id === BOT },
      repliedUser: o.repliedUserId ? { id: o.repliedUserId } : null,
    },
    reply: async () => undefined,
  } as unknown as Message;
}

describe('the created event of a received message', () => {
  const build = (o: StubOptions = {}, text: string | undefined = '2') =>
    buildCreatedEvent('de.byte5.channel.discord', discordBotChannelKey(BOT), BOT, stubMessage(o), text);

  it('names the channel, conversation, message, author and receiving identity', () => {
    const event = build({ channelId: 'thread-9' });
    assert.deepEqual(event, {
      channelId: 'de.byte5.channel.discord',
      channelType: 'discord',
      conversationId: 'thread-9',
      conversationType: 'group',
      receivedByChannelKey: `@${BOT}`,
      messageId: 'msg-2',
      revision: 0,
      kind: 'created',
      author: { kind: 'discord-user', id: 'u1', displayName: 'Uli' },
      text: '2',
      occurredAt: '2026-11-20T10:00:00.000Z',
    });
  });

  it('a reply carries the message it answers', () => {
    assert.equal(build({ repliesToMessage: 'msg-1' })?.replyToMessageId, 'msg-1');
    assert.equal(build()?.replyToMessageId, undefined);
  });

  it('a mention, a reply that pings the bot, and a DM are addressed to it; other talk is not', () => {
    assert.equal(build({ mentionsBot: true })?.addressedToBot, true);
    assert.equal(build({ repliesToMessage: 'msg-1', repliedUserId: BOT })?.addressedToBot, true);
    assert.equal(build({ guild: false })?.addressedToBot, true);
    assert.equal(build({ guild: false })?.conversationType, 'direct');
    assert.equal(build()?.addressedToBot, undefined);
    assert.equal(isAddressedToBot(stubMessage({ repliedUserId: 'someone-else' }), BOT), false);
  });

  it('has nothing to report without text', () => {
    assert.equal(buildCreatedEvent('c', discordBotChannelKey(BOT), BOT, stubMessage(), undefined), undefined);
  });
});

describe('emission by the connection', () => {
  function connection(emit?: (e: ConversationMessageEvent) => void, over: Partial<DiscordConnectionDeps> = {}) {
    const conn = new DiscordConnection({
      channelId: 'de.byte5.channel.discord',
      token: 'x',
      log: () => undefined,
      state: { status: 'connecting' } as never,
      policy: { guildPolicy: 'mention', allowDms: true, ignoreBots: true, allowlist: new Set() },
      messageContentIntent: false,
      guildMembersIntent: false,
      enableSlashCommand: false,
      speakerHistory: new InMemorySpeakerHistoryStore(),
      planTurn: () => ({ speaker: MIRA, run: async () => ({ text: 'ok', speaker: MIRA }) }),
      ...(emit ? { emitConversationMessage: emit } : {}),
      ...over,
    });
    Object.assign(conn as unknown as Record<string, unknown>, { botUserId: BOT, botKey: discordBotChannelKey(BOT) });
    return (message: Message) => (conn as unknown as { onMessageCreate(m: Message): Promise<void> }).onMessageCreate(message);
  }

  it('a reply that does not mention the bot is still reported (the mention gate comes after)', async () => {
    const events: ConversationMessageEvent[] = [];
    await connection((e) => void events.push(e))(stubMessage({ repliesToMessage: 'msg-1' }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.replyToMessageId, 'msg-1');
    assert.equal(events[0]?.addressedToBot, undefined);
  });

  it('a mention is reported as addressed and also runs its turn', async () => {
    const events: ConversationMessageEvent[] = [];
    let turns = 0;
    const run = connection((e) => void events.push(e), {
      planTurn: () => ({ speaker: MIRA, run: async () => (turns += 1, { text: 'ok', speaker: MIRA }) }),
    });
    await run(stubMessage({ mentionsBot: true }));
    assert.equal(events[0]?.addressedToBot, true);
    assert.equal(turns, 1);
  });

  it('without the kernel registry nothing is emitted and the turn is unaffected', async () => {
    let turns = 0;
    const run = connection(undefined, {
      planTurn: () => ({ speaker: MIRA, run: async () => (turns += 1, { text: 'ok', speaker: MIRA }) }),
    });
    await run(stubMessage({ mentionsBot: true }));
    assert.equal(turns, 1);
  });

  it('nothing is reported for a person off the allowlist, or in a server the bot is switched off in', async () => {
    const events: ConversationMessageEvent[] = [];
    await connection((e) => void events.push(e), {
      policy: { guildPolicy: 'mention', allowDms: true, ignoreBots: true, allowlist: new Set(['someone-else']) },
    })(stubMessage({ mentionsBot: true }));
    await connection((e) => void events.push(e), {
      policy: { guildPolicy: 'off', allowDms: true, ignoreBots: true, allowlist: new Set() },
    })(stubMessage({ mentionsBot: true }));
    assert.deepEqual(events, []);
  });

  it('a failing emit never disturbs the turn', async () => {
    let turns = 0;
    const run = connection(
      () => {
        throw new Error('hub down');
      },
      { planTurn: () => ({ speaker: MIRA, run: async () => (turns += 1, { text: 'ok', speaker: MIRA }) }) },
    );
    await run(stubMessage({ mentionsBot: true }));
    assert.equal(turns, 1);
  });
});
