// Spec 2042 §5.8 Pace, criterion 10: typing, ONE acknowledgement, follow-up
// beyond the reply window, never a silent timeout. Uses the SDK's PaceClock seam.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemorySpeakerHistoryStore, paceAckText, type SemanticAnswer } from '@omadia/channel-sdk';

import { deliverToMessage } from '../src/delivery.js';
import { acknowledgeAs, acknowledgeUnlessPosted, MESSAGE_PACE, OwnPosts, runPaced, SLASH_PACE } from '../src/pace.js';
import { manualClock, MIRA } from './helpers.js';

function pending<T>() {
  let release: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (release = r));
  return { promise, release };
}

describe('Discord pace', () => {
  it('a message turn types from the start, refreshing every 8 s, and acknowledges exactly once', async () => {
    const { clock, advance } = manualClock();
    let typing = 0;
    const acks: string[] = [];
    const work = pending<string>();
    const run = runPaced(
      () => work.promise,
      MESSAGE_PACE,
      { typing: () => void (typing += 1), acknowledge: async (t) => void acks.push(t) },
      { clock, locale: 'en' },
    );
    assert.equal(typing, 1, 'typing starts with the turn');
    await advance(7_999);
    assert.deepEqual(acks, []);
    await advance(1);
    await advance(30_000);
    assert.deepEqual(acks, [paceAckText('en')], 'one acknowledgement, no progress chatter');
    assert.ok(typing >= 4, `typing refreshed (${String(typing)}x)`);
    work.release('done');
    const out = await run;
    assert.equal(out.acknowledged, true);
    assert.equal(out.deliverAsFollowUp, false, 'a channel message has no reply window');
    assert.equal(out.result, 'done');
  });

  it('a fast turn gets neither acknowledgement nor follow-up', async () => {
    const { clock } = manualClock();
    const acks: string[] = [];
    const out = await runPaced(async () => 'ok', MESSAGE_PACE, { acknowledge: async (t) => void acks.push(t) }, { clock });
    assert.deepEqual(acks, []);
    assert.equal(out.acknowledged, false);
  });

  it('a slash turn that outlives the interaction window is delivered as a follow-up', async () => {
    const { clock, advance } = manualClock();
    const acks: string[] = [];
    const work = pending<string>();
    const run = runPaced(() => work.promise, SLASH_PACE, { acknowledge: async (t) => void acks.push(t) }, { clock });
    await advance(15 * 60 * 1000);
    work.release('late');
    const out = await run;
    assert.equal(out.deliverAsFollowUp, true);
    assert.equal(acks.length, 1);
  });

  it('the answer lands after the acknowledgement has settled', async () => {
    const { clock, advance } = manualClock();
    const order: string[] = [];
    const ack = pending<void>();
    const work = pending<string>();
    const run = runPaced(
      () => work.promise,
      MESSAGE_PACE,
      { acknowledge: async () => { await ack.promise; order.push('ack'); } },
      { clock },
    ).then((r) => { order.push('result'); return r; });
    await advance(8_000);
    work.release('x');
    await Promise.resolve();
    ack.release();
    await run;
    assert.deepEqual(order, ['ack', 'result']);
  });

  it('a failing acknowledgement or typing call is reported and never fails the turn', async () => {
    const { clock, advance } = manualClock();
    const errors: string[] = [];
    const work = pending<number>();
    const run = runPaced(
      () => work.promise,
      MESSAGE_PACE,
      { typing: () => { throw new Error('typing'); }, acknowledge: async () => { throw new Error('ack'); } },
      { clock, onHookError: (hook) => errors.push(hook) },
    );
    await advance(8_000);
    work.release(1);
    const out = await run;
    assert.equal(out.result, 1);
    assert.ok(errors.includes('typing') && errors.includes('ack'));
  });

  it('a failing turn rejects (the connection turns it into a system notice)', async () => {
    const { clock } = manualClock();
    await assert.rejects(
      runPaced(async () => { throw new Error('boom'); }, MESSAGE_PACE, { acknowledge: async () => undefined }, { clock }),
      /boom/,
    );
  });
});

describe('acknowledgement under the agent\'s name (spec 2042 §5.8)', () => {
  it('goes out as the resolved agent\'s own words, never as system', async () => {
    const { clock, advance } = manualClock();
    const posted: SemanticAnswer[] = [];
    const work = pending<string>();
    const run = runPaced(
      () => work.promise,
      MESSAGE_PACE,
      { acknowledge: acknowledgeAs(MIRA, async (answer) => void posted.push(answer)) },
      { clock, locale: 'de' },
    );
    await advance(8_000);
    work.release('x');
    await run;
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0]?.speaker, MIRA);
    assert.equal(posted[0]?.text, paceAckText('de'));
  });

  it('rendered into the conversation it carries the agent\'s name line when several agents speak', async () => {
    const history = new InMemorySpeakerHistoryStore();
    history.record('discord:c1', 'a-paul');
    const sent: string[] = [];
    const message = { reply: async (p: { content: string }) => void sent.push(p.content), channel: {} };
    const post = acknowledgeAs(MIRA, (answer) =>
      deliverToMessage(message as never, answer, { conversationKey: 'discord:c1', speakerHistory: history, log: () => undefined }),
    );
    await post(paceAckText('de'));
    assert.equal(sent[0], `Mira: ${paceAckText('de')}`);
  });

  it('without a known speaker nothing is posted (no words made up for nobody)', async () => {
    const posted: SemanticAnswer[] = [];
    await acknowledgeAs(undefined, async (answer) => void posted.push(answer))('x');
    assert.deepEqual(posted, []);
  });
});

// discord#6 live run: a facilitator's turn posts its handshake and the vote
// through the bot itself; the acknowledgement then came AFTER them ("On it.
// This will take a moment." below the result). Once the bot has said
// something in the conversation during the turn, there is nothing to announce.
describe('no acknowledgement after the bot already posted in the turn', () => {
  it('the bot posted in the channel since the turn started: the acknowledgement is left out', async () => {
    const posts = new OwnPosts();
    const acks: string[] = [];
    const turnStartedAt = 1_000;
    posts.record('chan-1', 1_500);
    await acknowledgeUnlessPosted(() => posts.since('chan-1', turnStartedAt), async (text) => { acks.push(text); })('On it.');
    assert.deepEqual(acks, []);
  });

  it('an older post, or one in another channel, does not count: the acknowledgement goes out', async () => {
    const posts = new OwnPosts();
    const acks: string[] = [];
    posts.record('chan-1', 900);
    posts.record('chan-2', 1_500);
    await acknowledgeUnlessPosted(() => posts.since('chan-1', 1_000), async (text) => { acks.push(text); })('On it.');
    assert.deepEqual(acks, ['On it.']);
  });

  it('the latest post of a channel is kept, an earlier one never overwrites it', () => {
    const posts = new OwnPosts();
    posts.record('chan-1', 2_000);
    posts.record('chan-1', 1_200);
    assert.equal(posts.since('chan-1', 1_500), true);
  });
});
