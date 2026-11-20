// Spec 2042 §5.8 Pace, criterion 10: typing, ONE acknowledgement, follow-up
// beyond the reply window, never a silent timeout. Uses the SDK's PaceClock seam.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paceAckText } from '@omadia/channel-sdk';

import { MESSAGE_PACE, runPaced, SLASH_PACE } from '../src/pace.js';
import { manualClock } from './helpers.js';

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
