// Agent addressing (spec 2042 §5.3, INV-1/INV-7) and the turn's hand-over to the kernel.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_REPLY_SENTINEL, type ChatAgent, type ChatTurnInput, type IncomingTurn, type SemanticAnswer, type SystemNotice } from '@omadia/channel-sdk';

import { PendingChoices } from '../src/choices.js';
import { runTurn, type TurnDeps } from '../src/turn.js';
import { MIRA } from './helpers.js';

function fakeAgent(answer: SemanticAnswer = { text: 'ok', speaker: MIRA }) {
  const inputs: ChatTurnInput[] = [];
  const agent = { chat: async (input: ChatTurnInput) => (inputs.push(input), answer) } as unknown as ChatAgent;
  return { agent, inputs };
}

function turn(text: string, over: Partial<IncomingTurn> = {}): IncomingTurn {
  return {
    channelId: 'de.byte5.channel.discord',
    conversationId: 'chan-1',
    channelType: 'discord',
    channelKey: 'chan-1',
    conversationType: 'group',
    userRef: { kind: 'discord-user', id: 'u1', displayName: 'Uli' },
    text,
    metadata: { guildId: 'g1', messageId: 'm1', locale: 'de-DE' },
    ...over,
  };
}

function deps(services: Record<string, unknown>, agent: ChatAgent, extra: Partial<TurnDeps> = {}): TurnDeps {
  return {
    services: { get: <T>(name: string) => services[name] as T | undefined },
    defaultAgent: agent,
    choices: new PendingChoices(),
    log: () => undefined,
    ...extra,
  };
}

const NOTICE: SystemNotice = { code: 'agent_selected', text: 'Mira ist jetzt dein Ansprechpartner.', locale: 'de' };
const parse = (text: string) => (/^\/agents?\b/.test(text) ? ({ kind: 'select' } as const) : undefined);

describe('agent commands', () => {
  it('/agent <name> goes to the kernel selection service and is answered as a system notice', async () => {
    const calls: unknown[] = [];
    const { agent, inputs } = fakeAgent();
    const d = deps(
      { agentSelection: { handle: async (c: unknown, ctx: unknown) => (calls.push({ c, ctx }), NOTICE) } },
      agent,
      { parseAgentCommand: parse },
    );
    const answer = await runTurn(d, turn('/agent Mira'));
    assert.deepEqual(answer?.speaker, { kind: 'system' });
    assert.equal(answer?.text, NOTICE.text);
    assert.equal(inputs.length, 0, 'no agent turn for a command');
    assert.deepEqual(calls[0], {
      c: { kind: 'select' },
      ctx: { channelType: 'discord', conversationKey: 'chan-1', principal: 'user:discord-user:u1', locale: 'de' },
    });
  });

  it('without the kernel service the text flows on like any message (older kernel)', async () => {
    const { agent, inputs } = fakeAgent();
    const answer = await runTurn(deps({}, agent, { parseAgentCommand: parse }), turn('/agent Mira'));
    assert.equal(answer?.text, 'ok');
    assert.equal(inputs[0]?.userMessage, '/agent Mira');
  });
});

describe('routing', () => {
  it('a reject is the kernel notice as system text, never the default agent (INV-7)', async () => {
    const { agent, inputs } = fakeAgent();
    const notice: SystemNotice = { code: 'agent_disabled', text: 'Mira ist deaktiviert.', locale: 'de' };
    const resolver = { resolve: () => ({ decision: 'reject', notice }) };
    const answer = await runTurn(deps({ channelResolver: resolver }, agent), turn('hallo'));
    assert.equal(answer?.text, notice.text);
    assert.deepEqual(answer?.speaker, { kind: 'system' });
    assert.equal(inputs.length, 0);
  });

  it('a reject without notice (older kernel) is still a system text', async () => {
    const { agent, inputs } = fakeAgent();
    const answer = await runTurn(deps({ channelResolver: { resolve: () => ({ decision: 'reject' }) } }, agent), turn('hallo'));
    assert.deepEqual(answer?.speaker, { kind: 'system' });
    assert.equal(inputs.length, 0);
  });

  it('a resolver that throws is a system text, not a silent fallback', async () => {
    const { agent, inputs } = fakeAgent();
    const resolver = { resolve: () => { throw new Error('db down'); } };
    const answer = await runTurn(deps({ channelResolver: resolver }, agent), turn('hallo'));
    assert.deepEqual(answer?.speaker, { kind: 'system' });
    assert.equal(inputs.length, 0);
  });

  it('tries the conversation before the guild and passes sender and locale', async () => {
    const bound = fakeAgent({ text: 'von B', speaker: MIRA });
    const seen: unknown[] = [];
    const resolver = {
      resolve: (type: string, key: string, context: unknown) => {
        seen.push({ type, key, context });
        return key === 'g1' ? { decision: 'bound', chatAgent: bound.agent } : { decision: 'reject' };
      },
    };
    const d = fakeAgent();
    const answer = await runTurn(deps({ channelResolver: resolver }, d.agent), turn('hallo'));
    assert.equal(answer?.text, 'von B');
    assert.deepEqual(seen, [
      { type: 'discord', key: 'chan-1', context: { principal: 'user:discord-user:u1', locale: 'de' } },
      { type: 'discord', key: 'g1', context: { principal: 'user:discord-user:u1', locale: 'de' } },
    ]);
    assert.equal(d.inputs.length, 0);
  });

  it('no resolver (single-agent host): the default agent answers', async () => {
    const { agent } = fakeAgent({ text: 'default', speaker: MIRA });
    assert.equal((await runTurn(deps({}, agent), turn('hallo')))?.text, 'default');
  });
});

describe('hand-over to the kernel', () => {
  it('states conversation type, sender and platform ids in the turn origin', async () => {
    const { agent, inputs } = fakeAgent();
    await runTurn(deps({}, agent), turn('hallo'));
    const input = inputs[0]!;
    assert.equal(input.sessionScope, 'discord:chan-1');
    assert.equal(input.userId, 'u1');
    assert.equal(input.origin?.channelType, 'discord');
    assert.equal(input.origin?.conversationType, 'group');
    assert.equal(input.origin?.channelConversationId, 'chan-1');
    assert.equal(input.origin?.messageId, 'm1');
    assert.deepEqual(input.origin?.principal, { kind: 'user', userId: 'discord-user:u1' });
  });

  it('NO_REPLY stays silent', async () => {
    const silent = fakeAgent({ text: NO_REPLY_SENTINEL });
    assert.equal(await runTurn(deps({}, silent.agent), turn('hallo')), null);
  });

  it('a numbered reply replays what the option stands for', async () => {
    const card: SemanticAnswer = {
      text: 'Welche?',
      speaker: MIRA,
      interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'wert-a' }, { label: 'B', value: 'wert-b' }] },
    } as SemanticAnswer;
    const inputs: ChatTurnInput[] = [];
    const agent = {
      chat: async (input: ChatTurnInput) => (inputs.push(input), inputs.length === 1 ? card : { text: 'ok', speaker: MIRA }),
    } as unknown as ChatAgent;
    const d = deps({}, agent);
    await runTurn(d, turn('zeig mir was'));
    await runTurn(d, turn('2'));
    assert.equal(inputs[1]?.userMessage, 'wert-b');
    await runTurn(d, turn('2'));
    assert.equal(inputs[2]?.userMessage, '2', 'the question is closed after one reply');
  });
});
