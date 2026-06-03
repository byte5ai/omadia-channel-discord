/**
 * Bounded registry mapping a Discord button `custom_id` to the prompt text it
 * should replay as a new user turn. Discord caps `custom_id` at 100 chars, and
 * a follow-up / choice label can be longer than that, so we never encode the
 * prompt into the id itself — we mint a short opaque id and look the payload
 * back up when the button is clicked.
 *
 * The map is purely in-memory and ephemeral (it does not survive a restart);
 * a stale button click after a redeploy simply finds nothing and is answered
 * with a gentle "expired" notice by the connection. Entries are evicted FIFO
 * once the map grows past {@link MAX_ENTRIES}.
 */

export interface PendingInteraction {
  /** The conversation (channel) the button belongs to — guards cross-chat replay. */
  conversationId: string;
  /** Text to feed the orchestrator as if the user had typed it. */
  prompt: string;
}

const MAX_ENTRIES = 1_000;
const CUSTOM_ID_PREFIX = 'omadia';

export class InteractionRegistry {
  private readonly entries = new Map<string, PendingInteraction>();
  private seq = 0;

  /** Register a payload and return the `custom_id` to put on the button. */
  register(payload: PendingInteraction): string {
    const id = `${CUSTOM_ID_PREFIX}:${(this.seq++).toString(36)}`;
    this.entries.set(id, payload);
    if (this.entries.size > MAX_ENTRIES) {
      // Map preserves insertion order — drop the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return id;
  }

  /** True for ids this plugin minted (so we ignore other plugins' buttons). */
  owns(customId: string): boolean {
    return customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
  }

  /** Look up (and consume) a payload. One-shot: a button is spent on click. */
  take(customId: string): PendingInteraction | undefined {
    const payload = this.entries.get(customId);
    if (payload) this.entries.delete(customId);
    return payload;
  }
}
