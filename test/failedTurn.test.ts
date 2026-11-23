// Spec 2042 §6 criterion 10: a turn that fails ends in a notice for the person
// — in a message, after a pace acknowledgement as well as without one, and in
// a slash command — never in silence and never under the agent's name.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, paceAckText, type PaceClock, type SemanticAnswer } from '@omadia/channel-sdk';
import type { Interaction, Message } from 'discord.js';

import { discordBotChannelKey } from '../src/conversationEvents.js';
import { DiscordConnection, type DiscordConnectionDeps } from '../src/discordConnection.js';
import { manualClock, MIRA } from './helpers.js';

const BOT = '900000000000000001';
const ERROR_TEXT = 'Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';

function stubMessage(replies: string[]): Message {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    guildId: null,
    guild: null,
    channel: {
      type: 1,
      send: async (p: { content?: string }) => void replies.push(p.content ?? ''),
      sendTyping: async () => undefined,
    },
    partial: false,
    author: { id: 'u1', bot: false, username: 'uli', globalName: 'Uli' },
    content: 'lange arbeit',
    createdTimestamp: Date.parse('2026-11-20T10:00:00Z'),
    reference: null,
    mentions: { users: { has: () => false }, repliedUser: null },
    reply: async (p: { content?: string }) => void replies.push(p.content ?? ''),
  } as unknown as Message;
}

function connection(run: () => Promise<SemanticAnswer>, clock?: PaceClock, logs: string[] = []) {
  const conn = new DiscordConnection({
    channelId: 'de.byte5.channel.discord',
    token: 'x',
    log: (_level, message) => void logs.push(message),
    state: { status: 'connected' } as never,
    policy: { guildPolicy: 'mention', allowDms: true, ignoreBots: true, allowlist: new Set() },
    messageContentIntent: true,
    guildMembersIntent: false,
    enableSlashCommand: true,
    speakerHistory: new InMemorySpeakerHistoryStore(),
    planTurn: () => ({ speaker: MIRA, run }),
    ...(clock ? { paceClock: clock } : {}),
  } as DiscordConnectionDeps);
  Object.assign(conn as unknown as Record<string, unknown>, { botUserId: BOT, botKey: discordBotChannelKey(BOT) });
  return conn;
}

const receive = (conn: DiscordConnection, m: Message) =>
  (conn as unknown as { onMessageCreate(m: Message): Promise<void> }).onMessageCreate(m);

describe('a failing turn ends in a system notice (criterion 10)', () => {
  it('a message turn that throws is answered with the error text, not left in silence', async () => {
    const replies: string[] = [];
    const logs: string[] = [];
    await receive(connection(async () => { throw new Error('model down'); }, undefined, logs), stubMessage(replies));
    assert.deepEqual(replies, [ERROR_TEXT]);
    assert.ok(logs.some((m) => /error handling discord message/.test(m)), 'logged for the operator');
  });

  it('after the acknowledgement the failure still reaches the person: ack, then the notice', async () => {
    const { clock, advance } = manualClock();
    const replies: string[] = [];
    let fail: () => void = () => undefined;
    const run = () => new Promise<SemanticAnswer>((_resolve, reject) => { fail = () => reject(new Error('model down')); });
    const done = receive(connection(run, clock), stubMessage(replies));
    await new Promise((resolve) => setImmediate(resolve)); // the turn is planned and running
    await advance(8_001);
    fail();
    await done;
    assert.deepEqual(replies, [paceAckText('de'), ERROR_TEXT]);
  });

  it('a slash command that throws edits its placeholder into the error text', async () => {
    const calls: string[] = [];
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'ask',
      options: { getString: () => 'frage' },
      user: { id: 'u1', username: 'uli', globalName: 'Uli' },
      guildId: null,
      channelId: 'chan-1',
      locale: 'de',
      deferReply: async () => void calls.push('defer'),
      editReply: async (p: { content?: string }) => void calls.push(`edit:${p.content ?? ''}`),
      followUp: async (p: { content?: string }) => void calls.push(`follow:${p.content ?? ''}`),
    } as unknown as Interaction;
    const conn = connection(async () => { throw new Error('model down'); });
    await (conn as unknown as { onInteractionCreate(i: Interaction): Promise<void> }).onInteractionCreate(interaction);
    assert.deepEqual(calls, ['defer', `edit:${ERROR_TEXT}`]);
  });
});
