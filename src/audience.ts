import type { ConversationRoster } from '@omadia/channel-sdk';

/**
 * The audience of a server-channel turn, for the kernel's audience floor
 * (spec 2043, discord#6). The floor bounds a turn's tools to what everyone in
 * the room may do and reads the room from the turn context's
 * `chatParticipants`; without it every tool of a group turn is refused
 * ("this channel does not tell omadia who is in the conversation"). The
 * roster registry the plugin also feeds is read by the kernel for the
 * facilitation engine's own turns only, not for a person's turn.
 *
 * Structural mirror of the kernel's `ChatParticipant` /
 * `ChatParticipantsProvider` (harness-orchestrator `chatParticipants.ts`),
 * like the Teams and Telegram channels declare it.
 */
export interface ChatParticipant {
  channelUserId: string;
  aadObjectId: string | null;
  displayName: string;
  email: string | null;
  userPrincipalName: string | null;
}

export type ChatParticipantsProvider = (() => Promise<ChatParticipant[]>) & {
  /** A non-empty answer lists EVERY person in the channel, never a subset. */
  readonly completeRoster?: boolean;
};

/** The kernel's `turnContext` service, the one method this channel uses. */
export interface TurnContextModule {
  runWithChatParticipants<T>(chatParticipants: ChatParticipantsProvider, fn: () => Promise<T>): Promise<T>;
}

/**
 * The people of one channel as this bot sees it. Only a `complete` roster is
 * an answer; a partial or unknown one, a channel the bot cannot see and a
 * failed read are an empty list, which the kernel reads as an unknown room.
 * Bots are not readers whose rights bound the room (another omadia agent's
 * bot included): they are left out, as the Teams roster lists people only.
 */
export function chatParticipantsOf(
  read: (conversationId: string) => Promise<ConversationRoster | undefined>,
  conversationId: string,
): ChatParticipantsProvider {
  const list = async (): Promise<ChatParticipant[]> => {
    let roster: ConversationRoster | undefined;
    try {
      roster = await read(conversationId);
    } catch {
      return [];
    }
    if (!roster || roster.status !== 'complete') return [];
    return roster.participants
      .filter((participant) => !participant.isBot)
      .map((participant) => ({
        channelUserId: participant.userRef.id,
        aadObjectId: null,
        displayName: participant.userRef.displayName ?? participant.userRef.id,
        email: null,
        userPrincipalName: null,
      }));
  };
  return Object.assign(list, { completeRoster: true } as const);
}
