// The audience of a server-channel turn (kernel audience floor, #2043 / discord#6):
// the bot hands the kernel WHO is in the channel, as it sees it, on every group turn.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput, ConversationRoster, IncomingTurn } from '@omadia/channel-sdk';

import { chatParticipantsOf, type ChatParticipantsProvider } from '../src/audience.js';
import { PendingChoices } from '../src/choices.js';
import { planTurn, type TurnDeps } from '../src/turn.js';
import { MIRA } from './helpers.js';

const SELF = { userRef: { kind: 'discord-user', id: 'bot-1', displayName: 'Nora' }, isBot: true };

function roster(status: ConversationRoster['status'], extra: Partial<ConversationRoster> = {}): ConversationRoster {
  return {
    conversationType: 'group',
    participants: [
      { userRef: { kind: 'discord-user', id: 'u1', displayName: 'Uli' }, isBot: false },
      { userRef: { kind: 'discord-user', id: 'u2', displayName: 'Ute' }, isBot: false },
      { userRef: { kind: 'discord-user', id: 'bot-2', displayName: 'Theo' }, isBot: true },
      SELF,
    ],
    self: SELF,
    readAt: '2026-11-23T12:00:00.000Z',
    partial: status !== 'complete',
    status,
    ...extra,
  } as ConversationRoster;
}

function turn(over: Partial<IncomingTurn> = {}): IncomingTurn {
  return {
    channelId: 'de.byte5.channel.discord',
    conversationId: 'chan-1',
    channelType: 'discord',
    channelKey: 'chan-1',
    conversationType: 'group',
    userRef: { kind: 'discord-user', id: 'u1', displayName: 'Uli' },
    text: 'Bitte moderiere eine Abstimmung',
    metadata: { guildId: 'g1', messageId: 'm1' },
    ...over,
  };
}

describe('the participants of a server channel, as the kernel audience floor reads them', () => {
  it('a complete roster lists the people, never a bot, and promises to be complete', async () => {
    const provider = chatParticipantsOf(async () => roster('complete'), 'chan-1');
    assert.equal(provider.completeRoster, true);
    const people = await provider();
    assert.deepEqual(
      people.map((p) => [p.channelUserId, p.displayName]),
      [
        ['u1', 'Uli'],
        ['u2', 'Ute'],
      ],
    );
    assert.deepEqual(people[0], { channelUserId: 'u1', aadObjectId: null, displayName: 'Uli', email: null, userPrincipalName: null });
  });

  for (const status of ['partial', 'unknown'] as const) {
    it(`a ${status} roster is no audience: empty, never a subset`, async () => {
      assert.deepEqual(await chatParticipantsOf(async () => roster(status), 'chan-1')(), []);
    });
  }

  it('no roster (the bot cannot see the channel) and a failed read are empty', async () => {
    assert.deepEqual(await chatParticipantsOf(async () => undefined, 'chan-1')(), []);
    assert.deepEqual(
      await chatParticipantsOf(async () => {
        throw new Error('gateway down');
      }, 'chan-1')(),
      [],
    );
  });
});

describe('a group turn runs with its participants installed (the floor would refuse every tool otherwise)', () => {
  function setup() {
    const installed: ChatParticipantsProvider[] = [];
    let insideScope = false;
    const seenInside: boolean[] = [];
    const agent = {
      chat: async (_input: ChatTurnInput) => (seenInside.push(insideScope), { text: 'ok', speaker: MIRA }),
    } as unknown as ChatAgent;
    const d: TurnDeps = {
      route: () => ({ decision: 'bound', chatAgent: agent, speaker: MIRA }) as never,
      singleton: () => agent,
      choices: new PendingChoices(),
      log: () => undefined,
      audience: {
        participants: (conversationId) => chatParticipantsOf(async () => roster('complete'), conversationId),
        runWith: async (participants, fn) => {
          installed.push(participants);
          insideScope = true;
          try {
            return await fn();
          } finally {
            insideScope = false;
          }
        },
      },
    };
    return { d, installed, seenInside };
  }

  it('a server-channel turn calls the agent inside the participants scope', async () => {
    const { d, installed, seenInside } = setup();
    await planTurn(d, turn()).run();
    assert.equal(installed.length, 1);
    assert.deepEqual(seenInside, [true]);
    assert.deepEqual((await installed[0]!()).map((p) => p.channelUserId), ['u1', 'u2']);
  });

  it('a direct message needs no roster scope (the kernel reads it as a one-reader room)', async () => {
    const { d, installed, seenInside } = setup();
    await planTurn(d, turn({ conversationType: 'direct' })).run();
    assert.equal(installed.length, 0);
    assert.deepEqual(seenInside, [false]);
  });
});
