// Agent addressing (spec 2042 §5.3, INV-1/INV-7, S1 contract) and the turn's hand-over to the kernel.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { channelUserPrincipal, NO_REPLY_SENTINEL, type ChatAgent, type ChatTurnInput, type IncomingTurn, type SemanticAnswer, type SystemNotice } from '@omadia/channel-sdk';

import { PendingChoices } from '../src/choices.js';
import { planTurn, type TurnDeps } from '../src/turn.js';
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

const runTurn = (d: TurnDeps, t: IncomingTurn) => planTurn(d, t).run();

function deps(services: Record<string, unknown>, agent: ChatAgent, extra: Partial<TurnDeps> = {}): TurnDeps {
  return {
    route: (key, context) =>
      (services.channelResolver as { resolve: (t: string, k: string, c: unknown) => never } | undefined)?.resolve('discord', key, context),
    singleton: () => agent,
    choices: new PendingChoices(),
    log: () => undefined,
    ...extra,
  };
}

const SYSTEM = { kind: 'system' } as const;
const REJECT_NOTICE: SystemNotice = { code: 'agent_disabled', text: 'Mira ist deaktiviert.', locale: 'de' };

/** A resolver that records its lookups and answers with `result`. */
function resolverOf(result: (key: string) => unknown) {
  const seen: { type: string; key: string; context: unknown }[] = [];
  return {
    seen,
    service: {
      resolve: (type: string, key: string, context: unknown) => (seen.push({ type, key, context }), result(key)),
    },
  };
}

/** The ChatAgent the kernel hands back: it records every text it is given and answers as `system` or an agent. */
function recordingAgent(answer: SemanticAnswer) {
  const texts: string[] = [];
  const agent = { chat: async (input: ChatTurnInput) => (texts.push(input.userMessage), answer) } as unknown as ChatAgent;
  return { agent, texts };
}

describe('agent commands go through as plain text (spec 2042 criterion 30)', () => {
  for (const command of ['/agent Mira', '/agent', '/agents']) {
    it(`"${command}" reaches the resolver's ChatAgent unchanged; the channel parses nothing`, async () => {
      const kernel = recordingAgent({ text: 'Mira ist jetzt dein Ansprechpartner.', speaker: SYSTEM });
      const services: Record<string, unknown> = {
        channelResolver: { resolve: () => ({ decision: 'bound', chatAgent: kernel.agent, speaker: MIRA }) },
      };
      let singletonAsked = 0;
      const d: TurnDeps = { ...deps(services, fakeAgent().agent), singleton: () => (singletonAsked += 1, undefined) };
      const answer = await runTurn(d, turn(command));
      assert.deepEqual(kernel.texts, [command]);
      assert.deepEqual(answer?.speaker, SYSTEM);
      assert.equal(singletonAsked, 0, 'no fallback to the shared chatAgent while a resolver is there');
    });
  }

  it('a native slash command stands for exactly its typed text', async () => {
    const kernel = recordingAgent({ text: 'ok', speaker: MIRA });
    const resolver = resolverOf(() => ({ decision: 'bound', chatAgent: kernel.agent, speaker: MIRA }));
    await runTurn(deps({ channelResolver: resolver.service }, fakeAgent().agent), turn('/agent Mira', { metadata: { via: 'slash', guildId: null } }));
    assert.deepEqual(kernel.texts, ['/agent Mira']);
  });
});

describe('routing (S1 contract)', () => {
  it('a reject still hands the text to the ChatAgent it returns, which answers with the notice as system', async () => {
    const kernel = recordingAgent({ text: REJECT_NOTICE.text, speaker: SYSTEM, systemNotice: REJECT_NOTICE });
    const dflt = fakeAgent();
    const resolver = resolverOf(() => ({ decision: 'reject', chatAgent: kernel.agent, notice: REJECT_NOTICE }));
    const plan = planTurn(deps({ channelResolver: resolver.service }, dflt.agent), turn('/agent Mira'));
    assert.equal(plan.speaker, undefined, 'nobody acknowledges long work on a reject');
    const answer = await plan.run();
    assert.equal(answer?.text, REJECT_NOTICE.text);
    assert.deepEqual(answer?.speaker, SYSTEM);
    assert.deepEqual(kernel.texts, ['/agent Mira'], 'so a user can still choose an agent');
    assert.equal(dflt.inputs.length, 0, 'never the default agent (INV-7)');
  });

  it('a reject answered under an agent speaker is replaced by the notice, never shown as an agent answer', async () => {
    const misbehaving = recordingAgent({ text: 'Ich antworte trotzdem.', speaker: MIRA });
    const resolver = resolverOf(() => ({ decision: 'reject', chatAgent: misbehaving.agent, notice: REJECT_NOTICE }));
    const logged: string[] = [];
    const d = deps({ channelResolver: resolver.service }, fakeAgent().agent, { log: (_l, m) => void logged.push(m) });
    const answer = await runTurn(d, turn('hallo'));
    assert.equal(answer?.text, REJECT_NOTICE.text);
    assert.deepEqual(answer?.speaker, SYSTEM);
    assert.ok(logged.some((m) => /non-system speaker/.test(m)));
  });

  it('a reject without a ChatAgent (platform before the contract) is the notice as a system message', async () => {
    const dflt = fakeAgent();
    const resolver = resolverOf(() => ({ decision: 'reject', notice: REJECT_NOTICE }));
    const answer = await runTurn(deps({ channelResolver: resolver.service }, dflt.agent), turn('hallo'));
    assert.equal(answer?.text, REJECT_NOTICE.text);
    assert.deepEqual(answer?.speaker, SYSTEM);
    assert.equal(dflt.inputs.length, 0);
  });

  it('a reject without chatAgent and notice still says so as a system message', async () => {
    const dflt = fakeAgent();
    const resolver = resolverOf(() => ({ decision: 'reject' }));
    const answer = await runTurn(deps({ channelResolver: resolver.service }, dflt.agent), turn('hallo'));
    assert.deepEqual(answer?.speaker, SYSTEM);
    assert.equal(dflt.inputs.length, 0);
  });

  it('a resolver that throws is a system text, not a silent fallback', async () => {
    const { agent, inputs } = fakeAgent();
    const resolver = { resolve: () => { throw new Error('db down'); } };
    const answer = await runTurn(deps({ channelResolver: resolver }, agent), turn('hallo'));
    assert.deepEqual(answer?.speaker, SYSTEM);
    assert.equal(inputs.length, 0);
  });

  it('a bound decision exposes the agent that will answer, before it answers', async () => {
    const bound = recordingAgent({ text: 'hi', speaker: MIRA });
    const resolver = resolverOf(() => ({ decision: 'bound', chatAgent: bound.agent, speaker: MIRA }));
    const plan = planTurn(deps({ channelResolver: resolver.service }, fakeAgent().agent), turn('hallo'));
    assert.deepEqual(plan.speaker, MIRA);
    assert.equal(bound.texts.length, 0, 'planning runs no turn');
    assert.equal((await plan.run())?.text, 'hi');
  });

  it('resolves under the narrowest key only: the channel, never the server (selection stays per conversation)', async () => {
    const bound = recordingAgent({ text: 'von B', speaker: MIRA });
    const resolver = resolverOf(() => ({ decision: 'bound', chatAgent: bound.agent, speaker: MIRA }));
    const answer = await runTurn(deps({ channelResolver: resolver.service }, fakeAgent().agent), turn('hallo'));
    assert.equal(answer?.text, 'von B');
    assert.deepEqual(resolver.seen, [{ type: 'discord', key: 'chan-1', context: { principal: 'user:discord-user:u1', locale: 'de' } }]);
  });

  it('a thread is its own conversation: its own channel id is the key', async () => {
    const resolver = resolverOf(() => ({ decision: 'reject', chatAgent: fakeAgent().agent }));
    await runTurn(
      deps({ channelResolver: resolver.service }, fakeAgent().agent),
      turn('hallo', { conversationId: 'thread-9', channelKey: 'thread-9', metadata: { guildId: 'g1', messageId: 'm2' } }),
    );
    assert.deepEqual(resolver.seen.map((c) => c.key), ['thread-9']);
  });

  it('with nothing bound, /agent is answered by the conversation key\'s ChatAgent', async () => {
    const channelAgent = recordingAgent({ text: 'gewählt', speaker: SYSTEM });
    const resolver = resolverOf(() => ({ decision: 'reject', chatAgent: channelAgent.agent }));
    await runTurn(deps({ channelResolver: resolver.service }, fakeAgent().agent), turn('/agent Mira'));
    assert.deepEqual(channelAgent.texts, ['/agent Mira']);
  });

  it('no resolver (host without a registry): the shared agent answers, the one case it is asked', async () => {
    const { agent } = fakeAgent({ text: 'default', speaker: MIRA });
    assert.equal((await runTurn(deps({}, agent), turn('hallo')))?.text, 'default');
  });

  it('no resolver and no shared agent: a system text, never silence', async () => {
    const { agent } = fakeAgent();
    const answer = await runTurn({ ...deps({}, agent), singleton: () => undefined }, turn('hallo'));
    assert.deepEqual(answer?.speaker, SYSTEM);
  });
});

describe('locale of the sender', () => {
  const locales = async (metadata: Record<string, unknown>) => {
    const resolver = resolverOf(() => ({ decision: 'reject', chatAgent: fakeAgent().agent }));
    await runTurn(deps({ channelResolver: resolver.service }, fakeAgent().agent), turn('hallo', { metadata }));
    return (resolver.seen[0]?.context as { locale?: string }).locale;
  };

  it('is the language of the interaction or the server, as de or en', async () => {
    assert.equal(await locales({ locale: 'de' }), 'de');
    assert.equal(await locales({ locale: 'en-US' }), 'en');
    assert.equal(await locales({ locale: 'en-GB' }), 'en');
  });

  it('is left out when unknown or not one the notices speak (no guess)', async () => {
    assert.equal(await locales({}), undefined);
    assert.equal(await locales({ locale: 'fr' }), undefined);
  });
});

describe('principal form (spec 2042 §5.3)', () => {
  it('is user:discord-user:<snowflake>, lowercase, as the SDK builds it', async () => {
    const resolver = resolverOf(() => ({ decision: 'bound', chatAgent: fakeAgent().agent, speaker: MIRA }));
    await runTurn(
      deps({ channelResolver: resolver.service }, fakeAgent().agent),
      turn('hallo', { userRef: { kind: 'discord-user', id: '123456789012345678', displayName: 'Uli' } }),
    );
    assert.deepEqual(resolver.seen[0]?.context, { principal: 'user:discord-user:123456789012345678', locale: 'de' });
    assert.equal(
      (resolver.seen[0]?.context as { principal: string }).principal,
      channelUserPrincipal({ kind: 'discord-user', id: '123456789012345678' }),
    );
  });

  it('is the verified e-mail when the sender carries one', async () => {
    const resolver = resolverOf(() => ({ decision: 'bound', chatAgent: fakeAgent().agent, speaker: MIRA }));
    await runTurn(
      deps({ channelResolver: resolver.service }, fakeAgent().agent),
      turn('hallo', { userRef: { kind: 'discord-user', id: 'u1', email: 'Uli@Example.com' } }),
    );
    assert.equal((resolver.seen[0]?.context as { principal: string }).principal, 'user:uli@example.com');
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

  it('on a DM names the message it replies to (a reminder DM), in the id format of messageId', async () => {
    const { agent, inputs } = fakeAgent();
    await runTurn(
      deps({}, agent),
      turn('erledigt', { conversationType: 'direct', metadata: { messageId: 'm2', replyToMessageId: '800000000000000009' } }),
    );
    const origin = inputs[0]?.origin as { replyToMessageId?: string; messageId?: string } | undefined;
    assert.equal(origin?.replyToMessageId, '800000000000000009');
    assert.equal(origin?.messageId, 'm2');
  });

  it('names no reply target on a group turn, nor on a DM that replies to nothing', async () => {
    const { agent, inputs } = fakeAgent();
    await runTurn(deps({}, agent), turn('hallo', { metadata: { messageId: 'm1', replyToMessageId: 'm0' } }));
    await runTurn(deps({}, agent), turn('hallo', { conversationType: 'direct', metadata: { messageId: 'm3' } }));
    assert.deepEqual(inputs.map((i) => 'replyToMessageId' in (i.origin ?? {})), [false, false]);
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
