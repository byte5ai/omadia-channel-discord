// Spec 2042 criterion 30 (channel parity): choosing an agent, giving a
// contribution in a facilitation and answering a poll all work through plain
// text in Discord. Each is driven from a typed message through the turn to the
// rendered Discord text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemorySpeakerHistoryStore,
  type ChatAgent,
  type ChatTurnInput,
  type IncomingTurn,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { PendingChoices } from '../src/choices.js';
import { renderAnswer } from '../src/renderer.js';
import { planTurn, type TurnDeps } from '../src/turn.js';
import { MIRA, PAUL } from './helpers.js';

const SYSTEM = { kind: 'system' } as const;

function typed(text: string): IncomingTurn {
  return {
    channelId: 'de.byte5.channel.discord',
    conversationId: 'chan-1',
    channelType: 'discord',
    channelKey: 'chan-1',
    conversationType: 'group',
    userRef: { kind: 'discord-user', id: 'u1', displayName: 'Uli' },
    text,
    metadata: { guildId: 'g1', messageId: 'm1' },
  };
}

/** A kernel stand-in: its ChatAgent answers the commands as `system`, everything else as `reply`. */
function kernel(reply: (input: ChatTurnInput) => SemanticAnswer) {
  const seen: string[] = [];
  const agent = {
    chat: async (input: ChatTurnInput) => {
      seen.push(input.userMessage);
      if (input.userMessage === '/agent Mira') return { text: 'Mira ist jetzt dein Ansprechpartner.', speaker: SYSTEM };
      if (input.userMessage === '/agents') return { text: 'Du kannst wählen: Mira, Paul.', speaker: SYSTEM };
      return reply(input);
    },
  } as unknown as ChatAgent;
  const deps: TurnDeps = {
    services: { get: <T>(name: string) => (name === 'channelResolver' ? ({ resolve: () => ({ decision: 'bound', chatAgent: agent, speaker: MIRA }) } as T) : undefined) },
    defaultAgent: agent,
    choices: new PendingChoices(),
    log: () => undefined,
  };
  return { deps, seen };
}

/** One typed message in, the Discord text out. */
async function say(deps: TurnDeps, text: string): Promise<string> {
  const answer = await planTurn(deps, typed(text)).run();
  assert.ok(answer, 'an answer');
  return renderAnswer(answer, {
    conversationKey: 'discord:chan-1',
    speakerHistory: new InMemorySpeakerHistoryStore(),
  }).content;
}

describe('criterion 30: plain-text parity in Discord', () => {
  it('choosing an agent: /agent Mira and /agents are typed text and come back as plain system text', async () => {
    const { deps, seen } = kernel(() => ({ text: 'nein', speaker: MIRA }));
    assert.equal(await say(deps, '/agent Mira'), 'Mira ist jetzt dein Ansprechpartner.');
    assert.equal(await say(deps, '/agents'), 'Du kannst wählen: Mira, Paul.');
    assert.deepEqual(seen, ['/agent Mira', '/agents']);
  });

  it('a contribution in a facilitation: the colleague\'s words are attributed in the text', async () => {
    const { deps } = kernel(() => ({
      text: 'Ich fasse zusammen.',
      speaker: MIRA,
      contributions: [{ id: 'c1', speaker: PAUL, text: 'Ich schlage Dienstag vor.', status: 'delivered' }],
    }) as SemanticAnswer);
    const text = await say(deps, 'Was meint ihr?');
    assert.match(text, /Ich fasse zusammen\./);
    assert.match(text, /^Paul: Ich schlage Dienstag vor\.$/m);
  });

  it('answering a poll: a numbered question is answered by typing the number', async () => {
    const asked: ChatTurnInput[] = [];
    const { deps } = kernel((input) => {
      asked.push(input);
      return asked.length === 1
        ? ({
            text: 'Wann passt es?',
            speaker: MIRA,
            interactive: {
              kind: 'choice',
              question: 'Wann passt es?',
              options: [{ label: 'Montag', value: 'poll:p1:mon' }, { label: 'Dienstag', value: 'poll:p1:tue' }],
            },
          } as SemanticAnswer)
        : { text: 'Notiert: Dienstag.', speaker: MIRA };
    });
    const question = await say(deps, 'Plane den Termin');
    assert.match(question, /1\) Montag\n2\) Dienstag/);
    assert.equal(await say(deps, '2'), 'Notiert: Dienstag.');
    assert.equal(asked[1]?.userMessage, 'poll:p1:tue', 'the typed number stands for the option the agent offered');
  });
});
