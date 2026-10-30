import { randomUUID } from 'node:crypto';

/**
 * Enough of the originating message to rebuild an `IncomingTurn` when the user
 * later clicks a button / picks a select option. The clicking user's identity
 * comes from the interaction itself, not from here.
 */
export interface PendingTurnContext {
  readonly conversationId: string;
  readonly channelType: string;
  readonly channelKey: string;
  /** Second binding key after the channel (see `turn.ts`). */
  readonly guildId?: string;
}

/**
 * What a component's `custom_id` resolves to:
 *  - `submit` (a button): a fixed message to submit as the next turn.
 *  - `select` (a string-select): a token→message map, since Discord caps each
 *    option `value` at 100 chars and choice values can be longer.
 */
export type PendingEntry =
  | { readonly kind: 'submit'; readonly text: string; readonly turn: PendingTurnContext }
  | {
      readonly kind: 'select';
      readonly options: Readonly<Record<string, string>>;
      readonly turn: PendingTurnContext;
    };

export interface PendingStore {
  /** Store an entry and return a short opaque key to put in a `custom_id`. */
  put(entry: PendingEntry): string;
  /** Resolve a key, or `undefined` if unknown / expired. */
  get(key: string): PendingEntry | undefined;
  /** Stop the sweeper and drop all entries (called from `close()`). */
  dispose(): void;
}

// Below Discord's 15-min interaction-token window, so we never present a
// component whose follow-up turn can't be delivered.
const DEFAULT_TTL_MS = 14 * 60 * 1000;
const DEFAULT_MAX = 5000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export function createPendingStore(
  ttlMs: number = DEFAULT_TTL_MS,
  max: number = DEFAULT_MAX,
): PendingStore {
  const entries = new Map<string, { entry: PendingEntry; expiresAt: number }>();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of entries) {
      if (value.expiresAt <= now) entries.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweeper.
  sweeper.unref();

  return {
    put(entry) {
      const key = randomUUID();
      entries.set(key, { entry, expiresAt: Date.now() + ttlMs });
      // Bound memory: evict the oldest (Map is insertion-ordered) over the cap.
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return key;
    },
    get(key) {
      const value = entries.get(key);
      if (!value) return undefined;
      if (value.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return value.entry;
    },
    dispose() {
      clearInterval(sweeper);
      entries.clear();
    },
  };
}
