// Native facilitators in Discord (byte5ai/omadia-channel-discord#6, spec 2043
// §5.3, §6.4), on a simulated transport: delivery per conversation (a
// facilitated channel hands over every message and starts no turn of its
// own, elsewhere the mention rules stay), presence, and edits, deletions,
// reactions and forwards as conversation events.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  type ConversationMembershipEvent,
  type ConversationMessageEvent,
  type IncomingTurn,
} from '@omadia/channel-sdk';
import type { Message, MessageReaction, PartialMessage, User } from 'discord.js';

import { buildCreatedEvent, discordBotChannelKey } from '../src/conversationEvents.js';
import { DiscordConnection, type DiscordConnectionDeps } from '../src/discordConnection.js';
import { ConversationLifecycle } from '../src/lifecycleEvents.js';
import { MIRA } from './helpers.js';

const BOT = '900000000000000001';
const KEY = discordBotChannelKey(BOT);
const FACILITATED = '700000000000000001';
const ELSEWHERE = '700000000000000002';

interface StubOptions {
  id?: string;
  content?: string;
  guild?: boolean;
  mentionsBot?: boolean;
  channelId?: string;
  authorId?: string;
  authorBot?: boolean;
  editedAt?: string | null;
  forwardOf?: string;
  replyTo?: string;
  webhookId?: string;
  system?: boolean;
}

function stubMessage(o: StubOptions = {}): Message {
  const guild = o.guild ?? true;
  return {
    id: o.id ?? 'msg-1',
    channelId: o.channelId ?? FACILITATED,
    guildId: guild ? 'g1' : null,
    guild: guild ? { preferredLocale: 'de' } : null,
    channel: { type: guild ? 0 : 1, send: async () => undefined, sendTyping: async () => undefined },
    partial: false,
    author: { id: o.authorId ?? 'u1', bot: o.authorBot ?? false, username: 'uli', globalName: 'Uli' },
    content: o.content ?? '1) Pizza 2) Sushi',
    createdTimestamp: Date.parse('2026-11-21T10:00:00Z'),
    editedTimestamp: o.editedAt ? Date.parse(o.editedAt) : null,
    reference: o.forwardOf ? { messageId: o.forwardOf, type: 1 } : o.replyTo ? { messageId: o.replyTo, type: 0 } : null,
    webhookId: o.webhookId ?? null,
    system: o.system ?? false,
    mentions: {
      users: { has: (id: string) => o.mentionsBot === true && id === BOT },
      repliedUser: null,
    },
    reply: async () => undefined,
  } as unknown as Message;
}

function connection(over: Partial<DiscordConnectionDeps> = {}) {
  const seen = { events: [] as ConversationMessageEvent[], membership: [] as ConversationMembershipEvent[], turns: 0 };
  const conn = new DiscordConnection({
    channelId: 'de.byte5.channel.discord',
    token: 'x',
    log: () => undefined,
    state: { status: 'connected' } as never,
    policy: { guildPolicy: 'mention', allowDms: true, ignoreBots: true, allowlist: new Set() },
    messageContentIntent: true,
    guildMembersIntent: false,
    enableSlashCommand: false,
    speakerHistory: new InMemorySpeakerHistoryStore(),
    planTurn: () => ({ speaker: MIRA, run: async () => (seen.turns += 1, { text: 'ok', speaker: MIRA }) }),
    emitConversationMessage: (e) => void seen.events.push(e),
    emitConversationEvent: (e) => void seen.membership.push(e),
    conversationDelivery: (conversationId, channelKey) =>
      conversationId === FACILITATED && channelKey === KEY ? 'all' : 'none',
    ...over,
  });
  const internals = conn as unknown as Record<string, unknown> & { client: Record<string, unknown> };
  Object.assign(internals, { botUserId: BOT, botKey: KEY });
  internals.client.user = { id: BOT, username: 'mira', globalName: 'Mira', bot: true };
  const receive = (m: Message) => (conn as unknown as { onMessageCreate(m: Message): Promise<void> }).onMessageCreate(m);
  return { conn, seen, receive };
}

describe('delivery per conversation', () => {
  it('in a facilitated channel every message is handed over, with or without a mention, and no turn starts', async () => {
    const { seen, receive } = connection();
    await receive(stubMessage({ id: 'm1', content: '1) Pizza 2) Sushi' }));
    await receive(stubMessage({ id: 'm2', content: 'status?', mentionsBot: true }));
    assert.deepEqual(seen.events.map((e) => [e.messageId, e.addressedToBot ?? false]), [
      ['m1', false],
      ['m2', true],
    ]);
    assert.equal(seen.turns, 0, 'the facilitation drives every turn here');
  });

  it('in a channel that is not facilitated the mention rules stay: a mention runs its turn, other talk does not', async () => {
    const { seen, receive } = connection();
    await receive(stubMessage({ channelId: ELSEWHERE, id: 'm3' }));
    assert.equal(seen.turns, 0);
    await receive(stubMessage({ channelId: ELSEWHERE, id: 'm4', mentionsBot: true }));
    assert.equal(seen.turns, 1);
  });

  it('addressed mode (a facilitation following up) keeps the ordinary mention turn', async () => {
    const { seen, receive } = connection({ conversationDelivery: () => 'addressed' });
    await receive(stubMessage({ mentionsBot: true }));
    assert.equal(seen.turns, 1);
  });

  it('a direct message is never swallowed by a subscription; a failing lookup counts as none', async () => {
    const dm = connection({ conversationDelivery: () => 'all' });
    await dm.receive(stubMessage({ guild: false, channelId: FACILITATED }));
    assert.equal(dm.seen.turns, 1);
    const broken = connection({
      conversationDelivery: () => {
        throw new Error('cache gone');
      },
    });
    await broken.receive(stubMessage({ mentionsBot: true }));
    assert.equal(broken.seen.turns, 1);
  });

  it('another bot of the installation in the same channel keeps its own mention gate', async () => {
    const { seen, receive } = connection({
      conversationDelivery: (_c, channelKey) => (channelKey === 'discord-app:someone-else' ? 'all' : 'none'),
    });
    await receive(stubMessage({ mentionsBot: true }));
    assert.equal(seen.turns, 1);
  });
});

describe('bots and webhooks with Ignore bots off', () => {
  const listening = { guildPolicy: 'mention', allowDms: true, ignoreBots: false, allowlist: new Set<string>() } as const;
  const WEBHOOK = { authorId: '600000000000000001', authorBot: true, webhookId: '600000000000000001' };

  it('in a facilitated channel a webhook, a bot or a system message is no ballot: not handed over, no turn', async () => {
    const { seen, receive } = connection({ policy: { ...listening, allowlist: new Set() } });
    await receive(stubMessage({ id: 'w1', content: '1', ...WEBHOOK }));
    await receive(stubMessage({ id: 'b1', content: '2', authorId: 'b-other', authorBot: true, mentionsBot: true }));
    await receive(stubMessage({ id: 's1', content: 'Uli pinned a message', system: true }));
    await receive(stubMessage({ id: 'h1', content: '1' }));
    assert.deepEqual(seen.events.map((e) => e.messageId), ['h1']);
    assert.equal(seen.turns, 0);
  });

  it('a webhook does not name the person who added the bot', async () => {
    const { seen, receive } = connection({ policy: { ...listening, allowlist: new Set() } });
    await receive(stubMessage({ ...WEBHOOK }));
    assert.equal(seen.membership[0]?.kind, 'bot_present');
    assert.equal(seen.membership[0]?.kind === 'bot_present' ? seen.membership[0].addedBy : 'x', undefined);
  });

  it('in a channel that is not facilitated a bot that mentions the bot still runs its turn, as before', async () => {
    const { seen, receive } = connection({ policy: { ...listening, allowlist: new Set() } });
    await receive(stubMessage({ channelId: ELSEWHERE, authorId: 'b-other', authorBot: true, mentionsBot: true }));
    await receive(stubMessage({ channelId: ELSEWHERE, id: 'w2', mentionsBot: true, ...WEBHOOK }));
    assert.equal(seen.turns, 2);
    assert.deepEqual(seen.events, [], 'no conversation record of a non-person');
  });

  it('no event is built for a bot\'s or a webhook\'s message, edit, deletion or reaction', async () => {
    const events: ConversationMessageEvent[] = [];
    const l = new ConversationLifecycle({
      channelId: 'c',
      botKey: () => KEY,
      botUserId: () => BOT,
      policy: { hears: () => true },
      emit: (e) => void events.push(e),
      log: () => undefined,
    });
    assert.equal(buildCreatedEvent('c', KEY, BOT, stubMessage({ ...WEBHOOK }), '1'), undefined);
    assert.equal(buildCreatedEvent('c', KEY, BOT, stubMessage({ authorBot: true }), '1'), undefined);
    await l.edited(stubMessage({ content: 'a' }), stubMessage({ content: 'b', editedAt: '2026-11-21T10:05:00Z', ...WEBHOOK }));
    l.deleted(stubMessage({ ...WEBHOOK }));
    const reaction = { message: stubMessage({ id: 'm9' }), emoji: { name: '👍', id: null } } as unknown as MessageReaction;
    await l.reaction(reaction, { id: 'b2', bot: true, partial: false, username: 'b' } as unknown as User, false);
    assert.deepEqual(events, []);
  });
});

describe('a reply', () => {
  it('names the message it replies to in the event and in a DM turn', async () => {
    const event = buildCreatedEvent('c', KEY, BOT, stubMessage({ replyTo: '800000000000000009' }), 'erledigt');
    assert.equal(event?.replyToMessageId, '800000000000000009');
    const seenTurns: IncomingTurn[] = [];
    const { receive } = connection({
      planTurn: (t) => (seenTurns.push(t), { run: async () => null }),
    });
    await receive(stubMessage({ guild: false, channelId: 'dm-1', replyTo: '800000000000000009' }));
    assert.equal((seenTurns[0]?.metadata as { replyToMessageId?: string }).replyToMessageId, '800000000000000009');
  });
});

describe('presence', () => {
  it('a group message reports the bot present in that channel once; a DM reports nothing', async () => {
    const { seen, receive } = connection();
    await receive(stubMessage({ id: 'm1' }));
    await receive(stubMessage({ id: 'm2' }));
    await receive(stubMessage({ guild: false, channelId: 'dm-1' }));
    assert.deepEqual(seen.membership.map((e) => [e.kind, e.conversationId, e.channelType, e.conversationType]), [
      ['bot_present', FACILITATED, 'discord', 'group'],
    ]);
    assert.deepEqual(seen.membership[0]?.members, [{ kind: 'discord-user', id: BOT, displayName: 'Mira' }]);
    assert.equal(seen.membership[0]?.kind === 'bot_present' ? seen.membership[0].addedBy?.id : undefined, 'u1');
  });

  it('nothing is reported from a server off the allowlist or switched off', async () => {
    const off = connection({ policy: { guildPolicy: 'off', allowDms: true, ignoreBots: true, allowlist: new Set() } });
    await off.receive(stubMessage());
    const listed = connection({ policy: { guildPolicy: 'mention', allowDms: true, ignoreBots: true, allowlist: new Set(['g9']) } });
    await listed.receive(stubMessage());
    assert.deepEqual([...off.seen.membership, ...listed.seen.membership], []);
  });
});

describe('a forwarded message', () => {
  it('is marked forwarded and names no reply target: somebody else\'s ballot is not the forwarder\'s', () => {
    const event = buildCreatedEvent('c', KEY, BOT, stubMessage({ forwardOf: 'orig-1' }), '1');
    assert.equal(event?.forwarded, true);
    assert.equal(event?.replyToMessageId, undefined);
  });
});

describe('edits, deletions and reactions', () => {
  function lifecycle(hears = true) {
    const events: ConversationMessageEvent[] = [];
    const logs: string[] = [];
    const l = new ConversationLifecycle({
      channelId: 'de.byte5.channel.discord',
      botKey: () => KEY,
      botUserId: () => BOT,
      policy: { hears: (author) => hears && author.id !== BOT && !author.bot },
      emit: (e) => void events.push(e),
      log: (_l, m) => void logs.push(m),
      now: () => new Date('2026-11-21T11:00:00Z'),
    });
    return { l, events, logs };
  }

  it('an edited ballot is reported with its new text and a rising revision', async () => {
    const { l, events } = lifecycle();
    const before = stubMessage({ content: '1) Pizza' });
    await l.edited(before, stubMessage({ content: '1) Sushi', editedAt: '2026-11-21T10:05:00Z' }));
    await l.edited(before, stubMessage({ content: '1) Tacos', editedAt: '2026-11-21T10:06:00Z' }));
    assert.deepEqual(events.map((e) => [e.kind, e.text, e.revision, e.occurredAt]), [
      ['edited', '1) Sushi', 1, '2026-11-21T10:05:00.000Z'],
      ['edited', '1) Tacos', 2, '2026-11-21T10:06:00.000Z'],
    ]);
    assert.equal(events[0]?.author.id, 'u1');
  });

  it('an update without a text change (an embed resolving) is no edit; nor is one Discord did not mark edited', async () => {
    const { l, events } = lifecycle();
    const same = stubMessage({ content: 'x', editedAt: '2026-11-21T10:05:00Z' });
    await l.edited(stubMessage({ content: 'x' }), same);
    await l.edited({ partial: true } as PartialMessage, stubMessage({ content: 'y', editedAt: null }));
    assert.deepEqual(events, []);
  });

  it('nobody the bot may not hear (its own posts, other bots) produces an event', async () => {
    const { l, events } = lifecycle();
    await l.edited(stubMessage({ content: 'a' }), stubMessage({ content: 'b', authorBot: true, editedAt: '2026-11-21T10:05:00Z' }));
    l.deleted(stubMessage({ authorId: BOT }));
    assert.deepEqual(events, []);
  });

  it('a deletion names the author only when the message was cached; an uncached one is logged, not guessed', () => {
    const { l, events, logs } = lifecycle();
    l.deleted(stubMessage({ id: 'm7' }));
    l.deleted({ ...stubMessage({ id: 'm8' }), author: null, partial: true } as unknown as PartialMessage);
    assert.deepEqual(events.map((e) => [e.kind, e.messageId, e.author.id, e.text]), [['deleted', 'm7', 'u1', undefined]]);
    assert.ok(logs.some((m) => /author is unknown/.test(m)));
  });

  it('a reaction is reported as the reacting person did it, added or removed', async () => {
    const { l, events } = lifecycle();
    const reaction = { message: stubMessage({ id: 'm9' }), emoji: { name: '👍', id: null } } as unknown as MessageReaction;
    const anna = { id: 'u2', bot: false, partial: false, username: 'anna', globalName: 'Anna' } as unknown as User;
    await l.reaction(reaction, anna, false);
    await l.reaction(reaction, anna, true);
    assert.deepEqual(events.map((e) => [e.kind, e.messageId, e.author.id, e.reaction]), [
      ['reaction', 'm9', 'u2', { name: '👍', removed: false }],
      ['reaction', 'm9', 'u2', { name: '👍', removed: true }],
    ]);
  });

  it('without the kernel registry nothing is emitted', async () => {
    const l = new ConversationLifecycle({
      channelId: 'c',
      botKey: () => KEY,
      botUserId: () => BOT,
      policy: { hears: () => true },
      log: () => undefined,
    });
    await assert.doesNotReject(l.edited(stubMessage(), stubMessage({ content: 'b', editedAt: '2026-11-21T10:05:00Z' })));
  });
});
