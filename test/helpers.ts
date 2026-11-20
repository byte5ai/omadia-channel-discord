import type { PaceClock, SemanticAnswer } from '@omadia/channel-sdk';

export const MIRA = { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' } as const;
export const PAUL = { kind: 'agent', agentId: 'a-paul', slug: 'paul', displayName: 'Paul' } as const;

export function agentAnswer(speaker: typeof MIRA | typeof PAUL, text: string, extra: Partial<SemanticAnswer> = {}): SemanticAnswer {
  return { text, speaker, ...extra };
}

/** A manual clock: timers fire only when the test advances time. */
export function manualClock(): { clock: PaceClock; advance: (ms: number) => Promise<void> } {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
    setInterval: (fn, ms) => {
      const t = { at: now + ms, fn, every: ms, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.done = true;
    },
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  return { clock, advance };
}
