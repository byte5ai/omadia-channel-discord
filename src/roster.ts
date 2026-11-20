import type {
  ChannelUserRef,
  ConversationParticipant,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { DISCORD_CHANNEL_TYPE } from './renderer.js';

/**
 * Who is in a Discord conversation, as honestly as the platform lets us say
 * (spec 2042 §5.2, kernel #2091). The kernel's audience floor is fail-closed:
 * it answers in a group only on a roster it can trust, so this provider never
 * claims more than it read.
 *
 *  - A DM is `complete`: the user and this bot.
 *  - A server channel is `complete` only when the operator enabled the
 *    privileged **Server Members** intent (otherwise Discord does not send us
 *    the member list at all) AND the server is small enough to list in one
 *    request; the roster is then everyone who can see the channel.
 *  - A very large server, or a member list that could not be read, is
 *    `partial` / `unknown` with the reason in `statusDetail`.
 */

/** Servers with more members than this are not listed in full (one fetch per refresh). */
export const MAX_LISTED_MEMBERS = 5_000;
/** How long a read roster is reused before the platform is asked again. */
export const ROSTER_TTL_MS = 5 * 60 * 1000;

export interface RosterMember {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly isBot: boolean;
}

/** What the connection learned about one conversation, independent of discord.js types. */
export type RosterSource =
  | { readonly type: 'direct'; readonly recipient?: RosterMember }
  | {
      readonly type: 'guild';
      /** The privileged Server Members intent is on, so members are listable. */
      readonly canListMembers: boolean;
      readonly memberCount: number;
      /** Everyone who can see the channel, from a (fresh) member list. */
      readonly viewers: () => Promise<readonly RosterMember[]>;
    }
  | { readonly type: 'unreadable'; readonly detail: string };

function participantOf(member: RosterMember): ConversationParticipant {
  const userRef: ChannelUserRef = {
    kind: 'discord-user',
    id: member.id,
    ...((member.displayName ?? member.username) ? { displayName: member.displayName ?? member.username } : {}),
  };
  return { userRef, isBot: member.isBot };
}

function dedupe(members: readonly RosterMember[]): RosterMember[] {
  const seen = new Map<string, RosterMember>();
  for (const m of members) seen.set(m.id, m);
  return [...seen.values()];
}

/** Read one conversation's roster. Never throws: a failure is an `unknown` roster. */
export async function readRoster(
  source: RosterSource,
  self: RosterMember,
  now: () => Date = () => new Date(),
): Promise<ConversationRoster> {
  const selfParticipant = participantOf(self);
  const readAt = now().toISOString();
  const base = { self: selfParticipant, readAt };

  if (source.type === 'unreadable') {
    return {
      conversationType: 'group',
      participants: [],
      ...base,
      partial: true,
      status: 'unknown',
      statusDetail: source.detail,
    };
  }

  if (source.type === 'direct') {
    const members = source.recipient ? [source.recipient, self] : [self];
    return {
      conversationType: 'direct',
      participants: dedupe(members).map(participantOf),
      ...base,
      partial: source.recipient === undefined,
      status: source.recipient ? 'complete' : 'partial',
      ...(source.recipient ? {} : { statusDetail: 'The other side of this direct message is not known yet.' }),
    };
  }

  if (!source.canListMembers) {
    return {
      conversationType: 'group',
      participants: [],
      ...base,
      partial: true,
      status: 'unknown',
      statusDetail:
        'Discord only sends the member list of a server to bots with the privileged "Server Members" intent. Enable it in the plugin settings and in the Developer Portal.',
    };
  }

  let viewers: RosterMember[];
  try {
    viewers = dedupe(await source.viewers());
  } catch (err) {
    return {
      conversationType: 'group',
      participants: [],
      ...base,
      partial: true,
      status: 'unknown',
      statusDetail: `The member list could not be read: ${(err as Error).message}`,
    };
  }
  const withSelf = dedupe([...viewers, self]);
  if (source.memberCount > MAX_LISTED_MEMBERS) {
    return {
      conversationType: 'group',
      participants: withSelf.map(participantOf),
      ...base,
      partial: true,
      status: 'partial',
      statusDetail: `The server has ${String(source.memberCount)} members, more than the ${String(MAX_LISTED_MEMBERS)} this channel lists; only members already known to the bot are listed.`,
    };
  }
  return {
    conversationType: 'group',
    participants: withSelf.map(participantOf),
    ...base,
    partial: false,
    status: 'complete',
  };
}

export interface DiscordRosterProviderDeps {
  /** Describe a conversation by its Discord channel id; `undefined` when the bot cannot see it. */
  describe: (conversationId: string) => Promise<RosterSource | undefined>;
  /** This bot, once connected. */
  self: () => RosterMember | undefined;
  /** The bot's routing key `discord-app:<appId>` (spec 2042 §5.3), once connected. */
  channelKey?: () => string | undefined;
  now?: () => Date;
  ttlMs?: number;
}

/** The {@link ConversationRosterProvider} of ONE bot: what that bot can see. */
export class DiscordRosterProvider implements ConversationRosterProvider {
  readonly channelType = DISCORD_CHANNEL_TYPE;
  readonly #cache = new Map<string, { at: number; roster: ConversationRoster }>();
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(private readonly deps: DiscordRosterProviderDeps) {
    this.#now = deps.now ?? (() => new Date());
    this.#ttlMs = deps.ttlMs ?? ROSTER_TTL_MS;
  }

  async getRoster(
    conversationId: string,
    opts?: ConversationRosterRequest,
  ): Promise<ConversationRoster | undefined> {
    const self = this.deps.self();
    if (!self) return undefined;
    // A roster is what ONE bot can see; a request on behalf of another
    // identity gets no answer, never this bot's view.
    if (opts?.asChannelKey !== undefined && !this.isOwnKey(opts.asChannelKey, self)) return undefined;

    const nowMs = this.#now().getTime();
    const cached = this.#cache.get(conversationId);
    if (cached && opts?.fresh !== true && nowMs - cached.at < this.#ttlMs) return cached.roster;

    const source = await this.deps.describe(conversationId);
    if (!source) return undefined;
    const roster = await readRoster(source, self, this.#now);
    // Only a read that reached the platform is worth reusing.
    if (roster.status !== 'unknown') this.#cache.set(conversationId, { at: nowMs, roster });
    return roster;
  }

  /** `discord-app:<appId>` (the routing key) or the bot user id. */
  private isOwnKey(asChannelKey: string, self: RosterMember): boolean {
    const key = asChannelKey.trim().toLowerCase();
    return key === self.id || key === this.deps.channelKey?.();
  }
}
