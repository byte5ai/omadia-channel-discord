import type { Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from 'discord.js';

import type { ConversationMessageEvent } from '@omadia/channel-sdk';

import { buildDeletedEvent, buildEditedEvent, buildReactionEvent } from './conversationEvents.js';
import { extractText } from './inbound.js';

/**
 * Edits, deletions and reactions as conversation events (#2043 §5.3): an
 * edited ballot counts in its latest revision, a deleted one not at all, and
 * a reaction is what a person did, stated by Discord. Like a new message,
 * each is emitted for every human the bot may hear (never for a bot, a
 * webhook or a system message, even with *Ignore bots* off); the kernel keeps it only
 * for a subscription of the receiving bot and drops it otherwise. No event
 * starts a turn.
 *
 * Revisions are a hint counted here per message (the kernel assigns the
 * stored revision itself), so a restart that starts counting again is
 * harmless.
 */

const MAX_TRACKED_REVISIONS = 5_000;

/** The person on the other side of an event, as far as the connection's access policy goes. */
export interface LifecyclePolicy {
  /** May the bot hear this author in this place (own bot, other bots, DMs, servers off, allowlist)? */
  hears(author: { id: string; bot: boolean }, guildId: string | null, isDirect: boolean): boolean;
}

export interface LifecycleDeps {
  readonly channelId: string;
  readonly botKey: () => string;
  readonly botUserId: () => string;
  readonly policy: LifecyclePolicy;
  readonly emit?: (event: ConversationMessageEvent) => void;
  readonly log: (level: 'info' | 'warn', message: string, context?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

type AnyMessage = Message | PartialMessage;

function isDirect(message: Pick<AnyMessage, 'guildId'>): boolean {
  return message.guildId === null;
}

export class ConversationLifecycle {
  readonly #revisions = new Map<string, number>();
  readonly #now: () => Date;

  constructor(private readonly deps: LifecycleDeps) {
    this.#now = deps.now ?? (() => new Date());
  }

  /** Discord's MESSAGE_UPDATE. Only a changed text is an edit (an embed resolving is not). */
  async edited(before: AnyMessage, after: AnyMessage): Promise<void> {
    if (!this.#ready()) return;
    const message = await this.#hydrate(after);
    if (!message || message.editedTimestamp === null || !this.#hears(message.author, message)) return;
    const text = extractText(message, this.deps.botUserId());
    if (!before.partial && before.content === message.content) return;
    const event = buildEditedEvent(
      this.deps.channelId,
      this.deps.botKey(),
      this.deps.botUserId(),
      message,
      text,
      this.#nextRevision(message.id),
    );
    this.#emit(event);
  }

  /** Discord's MESSAGE_DELETE: reported only when the cached message names its author. */
  deleted(message: AnyMessage): void {
    if (!this.#ready()) return;
    const author = message.author ?? null;
    if (!author) {
      this.deps.log('info', 'discord deletion not reported: the message was not cached, its author is unknown', {
        channel: message.channelId,
        message: message.id,
      });
      return;
    }
    if (!this.#hears(author, message)) return;
    const ref = {
      id: message.id,
      channelId: message.channelId,
      guild: message.guild,
      channel: message.channel,
      author,
      webhookId: message.webhookId,
      system: message.system,
    };
    this.#emit(buildDeletedEvent(this.deps.channelId, this.deps.botKey(), ref, this.#nextRevision(message.id), this.#now()));
  }

  /** Discord's MESSAGE_REACTION_ADD / _REMOVE by `user`. */
  async reaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, removed: boolean): Promise<void> {
    if (!this.#ready()) return;
    let who: User;
    try {
      who = user.partial ? await user.fetch() : user;
    } catch {
      return;
    }
    const message = reaction.message;
    if (!this.#hears(who, message)) return;
    this.#emit(
      buildReactionEvent(this.deps.channelId, this.deps.botKey(), message as Message, who, reaction.emoji, removed, this.#now()),
    );
  }

  #ready(): boolean {
    return this.deps.emit !== undefined && this.deps.botKey() !== '';
  }

  #hears(author: { id: string; bot: boolean }, message: Pick<AnyMessage, 'guildId'>): boolean {
    return this.deps.policy.hears(author, message.guildId, isDirect(message));
  }

  async #hydrate(message: AnyMessage): Promise<Message | undefined> {
    if (!message.partial) return message;
    try {
      return await message.fetch();
    } catch {
      return undefined;
    }
  }

  #nextRevision(messageId: string): number {
    const next = (this.#revisions.get(messageId) ?? 0) + 1;
    this.#revisions.delete(messageId);
    this.#revisions.set(messageId, next);
    if (this.#revisions.size > MAX_TRACKED_REVISIONS) {
      const oldest = this.#revisions.keys().next().value;
      if (oldest !== undefined) this.#revisions.delete(oldest);
    }
    return next;
  }

  #emit(event: ConversationMessageEvent | undefined): void {
    if (!event) return;
    try {
      this.deps.emit?.(event);
    } catch (err) {
      this.deps.log('warn', 'discord conversation event not emitted', { kind: event.kind, error: (err as Error).message });
    }
  }
}
