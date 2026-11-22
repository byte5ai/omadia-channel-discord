import type { ChannelUserRef, ConversationMembershipEvent } from '@omadia/channel-sdk';

import { DISCORD_CHANNEL_TYPE } from './renderer.js';

/**
 * Where this bot is, as the kernel needs to know it (#2043, #330):
 *
 *  - `bot_present`: an inbound group message is transport-verified proof that
 *    the bot is in that conversation. The kernel refuses a message
 *    subscription (`not_present`) for a conversation no channel ever reported
 *    a bot in, so without this no facilitator could subscribe a Discord
 *    channel. Emitted on the first message per conversation and again after
 *    {@link BOT_PRESENT_REEMIT_MS}, so the kernel's 24 h eligibility window
 *    does not outlive a long-running process's only emit.
 *  - `members_added` / `members_removed`: a person joined or left the server
 *    (Discord's GUILD_MEMBER_ADD / REMOVE, only with the privileged Server
 *    Members intent). Discord has no membership per channel: a server member
 *    is in every channel they may view. The events go to the conversations
 *    of that server this bot was observed in (the ones a facilitation can
 *    run in), a join only where the new member can view the channel.
 */

export const BOT_PRESENT_REEMIT_MS = 12 * 60 * 60 * 1000;
/** Conversations remembered per bot; the oldest is forgotten first. */
export const MAX_TRACKED_CONVERSATIONS = 2_000;

export interface PresenceDeps {
  /** The emitting channel plugin's catalog id. */
  readonly channelId: string;
  /** `core.emitConversationEvent`; absent on an older kernel. */
  readonly emit?: (event: ConversationMembershipEvent) => void;
  readonly log: (level: 'warn', message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

interface Observed {
  readonly guildId: string;
  readonly emittedAt: number;
}

/** One bot's knowledge of the group conversations it was seen in. */
export class BotPresence {
  readonly #observed = new Map<string, Observed>();
  readonly #now: () => number;

  constructor(private readonly deps: PresenceDeps) {
    this.#now = deps.now ?? Date.now;
  }

  /**
   * A message in a group conversation reached this bot: it is there. Emits
   * `bot_present` (with the message's author as `addedBy`, best effort) unless
   * it was emitted for this conversation within the re-emit interval.
   */
  observe(conversationId: string, guildId: string, self: ChannelUserRef, author: ChannelUserRef | undefined, occurredAt: string): void {
    const now = this.#now();
    const previous = this.#observed.get(conversationId);
    if (previous && now - previous.emittedAt < BOT_PRESENT_REEMIT_MS) return;
    this.#remember(conversationId, { guildId, emittedAt: now });
    this.#emit({
      kind: 'bot_present',
      channelId: this.deps.channelId,
      channelType: DISCORD_CHANNEL_TYPE,
      conversationId,
      conversationType: 'group',
      members: [self],
      ...(author ? { addedBy: author } : {}),
      occurredAt,
    });
  }

  /** The conversations of a server this bot was observed in. */
  conversationsIn(guildId: string): readonly string[] {
    return [...this.#observed.entries()].filter(([, o]) => o.guildId === guildId).map(([id]) => id);
  }

  /**
   * A person joined (`added`) or left the server: one membership event per
   * observed conversation of that server that `visibleTo` accepts.
   * Returns how many events went out.
   */
  memberChanged(
    guildId: string,
    member: ChannelUserRef,
    change: 'added' | 'removed',
    occurredAt: string,
    visibleTo: (conversationId: string) => boolean = () => true,
  ): number {
    let emitted = 0;
    for (const conversationId of this.conversationsIn(guildId)) {
      if (!visibleTo(conversationId)) continue;
      this.#emit({
        kind: change === 'added' ? 'members_added' : 'members_removed',
        channelId: this.deps.channelId,
        channelType: DISCORD_CHANNEL_TYPE,
        conversationId,
        conversationType: 'group',
        members: [member],
        occurredAt,
      });
      emitted += 1;
    }
    return emitted;
  }

  #remember(conversationId: string, observed: Observed): void {
    this.#observed.delete(conversationId);
    this.#observed.set(conversationId, observed);
    if (this.#observed.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = this.#observed.keys().next().value;
      if (oldest !== undefined) this.#observed.delete(oldest);
    }
  }

  /** Fire-and-forget: a failing kernel never breaks the message that carried it. */
  #emit(event: ConversationMembershipEvent): void {
    if (!this.deps.emit) return;
    try {
      this.deps.emit(event);
    } catch (err) {
      this.deps.log('warn', 'discord membership event not emitted', {
        kind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
