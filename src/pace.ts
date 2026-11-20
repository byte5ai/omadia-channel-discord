import {
  runPacedTurn,
  type AgentSpeaker,
  type ChannelPaceProfile,
  type PaceClock,
  type SemanticAnswer,
} from '@omadia/channel-sdk';

import { agentAcknowledgement } from './delivery.js';

/**
 * Pace of a Discord turn (spec 2042 §5.8, criterion 10): the typing
 * indicator while work runs, ONE short acknowledgement when it takes clearly
 * longer than a normal answer, and a follow-up message instead of a dead
 * interaction when the work outlives Discord's reply window. The timing
 * belongs to the SDK (`runPacedTurn`); this module only names Discord's
 * numbers and joins the hooks to the Discord primitives.
 */

/** Discord shows "typing…" for ~10 s per call; refresh a little earlier. */
const TYPING_INTERVAL_MS = 8_000;
const ACK_THRESHOLD_MS = 8_000;
/**
 * A deferred interaction's token lives 15 minutes; past this (with a minute of
 * margin) the answer is a normal channel message, not an edit of the reply.
 */
const INTERACTION_REPLY_WINDOW_MS = 14 * 60 * 1000;

/** A message in a channel: typing indicator, acknowledgement as a reply, no reply window. */
export const MESSAGE_PACE: ChannelPaceProfile = Object.freeze({
  ackThresholdMs: ACK_THRESHOLD_MS,
  typingIntervalMs: TYPING_INTERVAL_MS,
});

/** A slash command: Discord's own "thinking…" is the indicator; the token has a window. */
export const SLASH_PACE: ChannelPaceProfile = Object.freeze({
  ackThresholdMs: ACK_THRESHOLD_MS,
  replyWindowMs: INTERACTION_REPLY_WINDOW_MS,
});

export interface PaceTarget {
  /** Show the typing indicator; omit where the surface has its own. */
  typing?: () => Promise<void> | void;
  /** Post the one acknowledgement. */
  acknowledge: (text: string) => Promise<void>;
}

/**
 * The acknowledgement hook for a turn whose agent is `speaker`: the pace text
 * is that agent's words, posted under its name (spec 2042 §5.8), never as
 * `system`. Without a known speaker nothing is posted: no agent's words are
 * made up for nobody, and the typing indicator still shows the work.
 */
export function acknowledgeAs(
  speaker: AgentSpeaker | undefined,
  post: (answer: SemanticAnswer) => Promise<unknown>,
): PaceTarget['acknowledge'] {
  return async (text) => {
    if (speaker) await post(agentAcknowledgement(text, speaker));
  };
}

export interface PacedRun<T> {
  readonly result: T;
  readonly acknowledged: boolean;
  readonly deliverAsFollowUp: boolean;
}

/**
 * Run `work` with Discord pace. Resolves only after a posted acknowledgement
 * has settled, so the answer always lands after it. Rejects when `work` does;
 * a failing typing/ack hook is reported to `onHookError` and never fails the turn.
 */
export async function runPaced<T>(
  work: () => Promise<T>,
  profile: ChannelPaceProfile,
  target: PaceTarget,
  opts: {
    locale?: string;
    clock?: PaceClock;
    onHookError?: (hook: 'typing' | 'ack', error: unknown) => void;
  } = {},
): Promise<PacedRun<T>> {
  let ackSettled: Promise<void> = Promise.resolve();
  const outcome = await runPacedTurn(
    work,
    profile,
    {
      ...(target.typing ? { sendTyping: target.typing } : {}),
      sendAck: (text) => {
        const posted = target.acknowledge(text);
        ackSettled = posted.catch(() => undefined);
        return posted;
      },
      ...(opts.onHookError ? { onHookError: opts.onHookError } : {}),
    },
    { ...(opts.locale ? { locale: opts.locale } : {}), ...(opts.clock ? { clock: opts.clock } : {}) },
  );
  await ackSettled;
  return {
    result: outcome.result,
    acknowledged: outcome.acknowledged,
    deliverAsFollowUp: outcome.deliverAsFollowUp,
  };
}
