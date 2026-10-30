import type { MemoryAccessor } from '@omadia/plugin-api';

export type PriorTurn = { userMessage: string; assistantAnswer: string };

export interface HistoryStore {
  /** The last turns of a conversation, oldest first (empty if none). */
  get(conversationId: string): Promise<PriorTurn[]>;
  /** Append a turn and persist the trimmed list. Never throws. */
  record(conversationId: string, entry: PriorTurn): Promise<void>;
  dispose(): void;
}

const PER_CONVERSATION = 12;
// RAM cache bound; persisted conversations beyond it are re-read on demand.
const MAX_CACHED = 1000;
const DIR = 'history';

function pathFor(conversationId: string): string {
  // Discord ids are digits; anything else is flattened so it stays one file.
  return `${DIR}/${conversationId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

function parse(raw: string): PriorTurn[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (t): t is PriorTurn =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as PriorTurn).userMessage === 'string' &&
        typeof (t as PriorTurn).assistantAnswer === 'string',
    )
    .slice(-PER_CONVERSATION);
}

/**
 * Per-channel chat history replayed as `priorTurns`. Kept in the plugin's own
 * `ctx.memory` scope (one JSON file per Discord channel), so a conversation
 * keeps its thread across plugin restarts and updates. Without a memory
 * provider it degrades to RAM only (the behaviour before 2.0).
 *
 * The stored answers are what the user saw — with Privacy Guard that means
 * real values; the orchestrator re-masks replayed `priorTurns` before the
 * model sees them (omadia#361).
 */
export function createHistoryStore(
  memory: MemoryAccessor | undefined,
  log: (message: string) => void,
): HistoryStore {
  const cache = new Map<string, PriorTurn[]>();
  // One chain per conversation: read-append-write runs strictly in order, so
  // two people answered at once in one channel both stay in the history.
  const chains = new Map<string, Promise<void>>();

  function remember(conversationId: string, list: PriorTurn[]): void {
    cache.delete(conversationId);
    cache.set(conversationId, list);
    while (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function load(conversationId: string): Promise<PriorTurn[]> {
    if (!memory) return [];
    const path = pathFor(conversationId);
    const exists = await memory
      .exists(path)
      .then((e) => e)
      .catch(() => false);
    if (!exists) return [];
    return memory
      .readFile(path)
      .then(parse)
      .catch((err: unknown) => {
        log(`history read failed (${path}): ${(err as Error).message}`);
        return [];
      });
  }

  async function get(conversationId: string): Promise<PriorTurn[]> {
    const cached = cache.get(conversationId);
    if (cached) return cached;
    const list = await load(conversationId);
    remember(conversationId, list);
    return list;
  }

  async function append(conversationId: string, entry: PriorTurn): Promise<void> {
    const list = [...(await get(conversationId)), entry].slice(-PER_CONVERSATION);
    remember(conversationId, list);
    if (!memory) return;
    const path = pathFor(conversationId);
    await memory
      .writeFile(path, JSON.stringify(list))
      .then(() => undefined)
      .catch((err: unknown) => {
        log(`history write failed (${path}): ${(err as Error).message}`);
      });
  }

  return {
    get,

    async record(conversationId, entry) {
      const previous = chains.get(conversationId) ?? Promise.resolve();
      const next = previous.then(() => append(conversationId, entry));
      chains.set(conversationId, next);
      await next;
      if (chains.get(conversationId) === next) chains.delete(conversationId);
    },

    dispose() {
      cache.clear();
    },
  };
}
