import {
  channelUserPrincipal,
  isNoReply,
  logNoReplyDrop,
  parsePrincipal,
  parseSessionScope,
  type AgentSpeaker,
  type ChannelResolveResult,
  type ChannelRouteContext,
  type ChatAgent,
  type IncomingTurn,
  type LogLevel,
  type SemanticAnswer,
  type SystemNotice,
  type TurnOrigin,
} from '@omadia/channel-sdk';

import { choiceOptionsOf, type PendingChoices } from './choices.js';
import { noticeAnswer, systemAnswer } from './delivery.js';
import { DISCORD_CHANNEL_TYPE } from './renderer.js';
import type { DiscordRoutineTurn } from './routines.js';

/**
 * One orchestrator turn of this channel: per-turn agent resolution through the
 * kernel's `channelResolver@1`, the choice replies of numbered questions, and
 * the chat call itself.
 *
 * The kernel decides which agent answers (INV-1) and carries out `/agent
 * <name>`, `/agent` and `/agents` itself, in the ChatAgent the resolver
 * returns. This module only passes on who asks (one principal form, from the
 * SDK), where, and the text, unchanged. It never parses a command and never
 * substitutes another agent when the kernel refuses (INV-7).
 */

export interface TurnDeps {
  /**
   * The full routing result for a conversation key (the SDK's
   * `resolveChannelRoute`): decision, the ChatAgent (also on a reject), notice
   * and speaker. `undefined` only on a host without a channel resolver.
   */
  route: (channelKey: string, context: ChannelRouteContext) => ChannelResolveResult | undefined;
  /**
   * The shared `chatAgent@1`, asked for ONLY when `route` is `undefined` (a
   * host with no channel resolver, where it is the deployment's one agent).
   * With a resolver it is never consulted: from the S1 contract on it refuses
   * every non-canvas turn, and a fallback to it would bypass routing.
   */
  singleton: () => ChatAgent | undefined;
  choices: PendingChoices;
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
  /**
   * Spec 2042 §5.3 — set for an agent's own bot: its key
   * `discord-app:<appId>` (undefined until the bot is connected). Every turn
   * is resolved on that key alone, and only an EXCLUSIVE answer (the key IS
   * the agent's identity) may answer: a bot named after one agent never
   * answers as another.
   */
  ownBotKey?: () => string | undefined;
  /**
   * Spec 2042 §5.12 — opens the kernel's routines scope for a person's turn,
   * so the agent may set triggers and routines that deliver back here
   * (through this bot). Absent = the kernel publishes no routines.
   */
  routineTurn?: DiscordRoutineTurn;
}

/** A turn whose agent is resolved but which has not run yet. */
export interface PlannedTurn {
  /**
   * The agent that will answer, known before the answer (name, avatar). The
   * connection acknowledges long work under this speaker. Absent when nobody
   * is known to answer: no agent's words are made up for it then.
   */
  readonly speaker?: AgentSpeaker;
  /**
   * Run the turn. Resolves to the answer to render, or null when the agent
   * emitted NO_REPLY (the connection then stays silent for a passive message).
   */
  run(): Promise<SemanticAnswer | null>;
}

const NO_AGENT_TEXT = 'Diesem Kanal ist kein Agent zugeordnet.';
const ROUTING_FAILED_TEXT = 'Der zuständige Agent ist gerade nicht erreichbar. Bitte versuche es später erneut.';
const REJECT_ANSWER_TEXT = 'Hier antwortet gerade kein Agent. Mit /agents siehst du, wen du wählen kannst.';
/** An agent's own bot the kernel does not know (any more) as that agent's identity. */
const UNOWNED_BOT_TEXT = 'Dieser Bot ist gerade keinem Agenten zugeordnet und antwortet deshalb nicht.';

/** The sender as a principal, the one form for every channel (`user:discord-user:<snowflake>`). */
export function principalOf(turn: IncomingTurn): string {
  return channelUserPrincipal(turn.userRef);
}

/** The sender's language for notice texts: `de` or `en`, else none (the kernel then writes German). */
export function localeOf(turn: IncomingTurn): 'de' | 'en' | undefined {
  const raw = (turn.metadata as { locale?: unknown } | undefined)?.locale;
  if (typeof raw !== 'string') return undefined;
  const language = raw.split(/[-_]/)[0]?.toLowerCase();
  return language === 'de' || language === 'en' ? language : undefined;
}

/**
 * Where the turn came from, for the kernel (conversation type for the audience
 * floor, the sender, the platform ids). Discord is not a context-memory channel
 * (`CONTEXT_MEMORY_CHANNEL_TYPES`), so the memory axes stay as before.
 */
function originOf(turn: IncomingTurn, sessionScope: string, principal: string): TurnOrigin & DmReplyOrigin {
  const typedPrincipal = parsePrincipal(principal);
  const metadata = turn.metadata as { messageId?: unknown; replyToMessageId?: unknown } | undefined;
  const messageId = metadata?.messageId;
  const replyTo = turn.conversationType === 'direct' ? metadata?.replyToMessageId : undefined;
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    scope: parseSessionScope(sessionScope),
    ...(typedPrincipal ? { principal: typedPrincipal } : {}),
    ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
    channelConversationId: turn.conversationId,
    ...(typeof messageId === 'string' ? { messageId } : {}),
    ...(typeof replyTo === 'string' ? { replyToMessageId: replyTo } : {}),
    speaker: {
      kind: turn.userRef.kind,
      id: turn.userRef.id,
      ...(turn.userRef.displayName ? { displayName: turn.userRef.displayName } : {}),
    },
  };
}

/**
 * Since channel-sdk 0.3.11 (omadia#2157): on a PRIVATE turn the id of the
 * message the DM replies to, in the id format of `messageId` (and of the
 * `messageId` this bot reports for its own sends), so a reply to a reminder
 * DM matches the reminder. Declared here structurally until the SDK type
 * carries it; an older kernel ignores the extra field.
 */
interface DmReplyOrigin {
  readonly replyToMessageId?: string;
}

/** What the resolver decided for a turn. */
type Route =
  /** The agent that will answer (bound), or the resolver's ChatAgent that answers a reject with its notice. */
  | { readonly kind: 'agent'; readonly agent: ChatAgent; readonly isRejected: boolean; readonly speaker?: AgentSpeaker; readonly notice?: SystemNotice }
  /** Nobody can take the text: a `system` answer, no agent involved. */
  | { readonly kind: 'notice'; readonly answer: SemanticAnswer };

/**
 * Resolve the agent for a turn, under the NARROWEST conversation key: the
 * Discord channel id, which for a thread is the thread's own id (S1: the
 * agent selection hangs on the `channelKey` of this call plus the principal,
 * and a binding lies under the same key). There is no second probe for the
 * server: a selection made with `/agent` must belong to the conversation it
 * was made in, and a probe of the guild key would store it server-wide.
 *
 * A `reject` carries the resolver's ChatAgent too: it answers with the
 * kernel's `system` notice and carries out `/agent`, so a user can still
 * choose an agent. Only a host without a resolver uses the shared singleton.
 */
export function resolveRoute(deps: TurnDeps, turn: IncomingTurn): Route {
  const locale = localeOf(turn);
  const context = { principal: principalOf(turn), ...(locale ? { locale } : {}) };
  const ownBotKey = deps.ownBotKey ? deps.ownBotKey() ?? '' : undefined;
  let result: ChannelResolveResult | undefined;
  try {
    result = deps.route(ownBotKey ?? turn.conversationId, context);
  } catch (err) {
    deps.log('error', 'discord agent resolution failed', { error: (err as Error).message });
    return { kind: 'notice', answer: systemAnswer(ROUTING_FAILED_TEXT) };
  }
  if (ownBotKey !== undefined && result?.exclusive !== true) {
    // The kernel does not know this bot as an agent's identity (removed, or
    // not registered yet): its name belongs to an agent, so nobody else answers.
    deps.log('warn', 'discord agent bot is no agent\'s identity; turn refused', { botKey: ownBotKey });
    return { kind: 'notice', answer: systemAnswer(UNOWNED_BOT_TEXT) };
  }
  if (!result) {
    const singleton = deps.singleton();
    return singleton
      ? { kind: 'agent', agent: singleton, isRejected: false }
      : { kind: 'notice', answer: systemAnswer(NO_AGENT_TEXT) };
  }
  if (result.decision === 'bound') {
    if (!result.chatAgent) {
      deps.log('error', 'discord agent resolution failed', { error: 'resolver answered bound without a chatAgent' });
      return { kind: 'notice', answer: systemAnswer(ROUTING_FAILED_TEXT) };
    }
    return {
      kind: 'agent',
      agent: result.chatAgent,
      isRejected: false,
      ...(result.speaker ? { speaker: result.speaker } : {}),
    };
  }
  // Without a ChatAgent (a platform before the contract) the channel says why itself.
  if (!result.chatAgent) {
    return { kind: 'notice', answer: result.notice ? noticeAnswer(result.notice) : systemAnswer(NO_AGENT_TEXT) };
  }
  return {
    kind: 'agent',
    agent: result.chatAgent,
    isRejected: true,
    ...(result.notice ? { notice: result.notice } : {}),
  };
}

/**
 * The answer of a rejected route is always a `system` message (INV-7): the
 * resolver's ChatAgent speaks as `system` for it, and anything else it
 * returns is replaced by the notice, never shown as an agent's answer.
 */
function rejectedAnswer(answer: SemanticAnswer, notice: SystemNotice | undefined, deps: TurnDeps): SemanticAnswer {
  if (answer.speaker?.kind === 'system') return answer;
  deps.log('error', 'discord reject answered under a non-system speaker; replaced by the notice');
  return notice ? noticeAnswer(notice) : systemAnswer(REJECT_ANSWER_TEXT);
}

/**
 * Resolve the agent of a turn now and return what runs it. The agent is known
 * before it answers, so the connection can acknowledge long work in its name.
 */
export function planTurn(deps: TurnDeps, turn: IncomingTurn): PlannedTurn {
  const route = resolveRoute(deps, turn);
  if (route.kind === 'notice') return { run: async () => route.answer };

  return {
    ...(route.speaker ? { speaker: route.speaker } : {}),
    run: async () => {
      const choiceKey = `${turn.conversationId}:${turn.userRef.id}`;
      const userMessage = deps.choices.resolve(choiceKey, turn.text);
      const sessionScope = `discord:${turn.conversationId}`;
      const chat = (): Promise<SemanticAnswer> =>
        route.agent.chat({
          userMessage,
          sessionScope,
          userId: turn.userRef.id,
          origin: originOf(turn, sessionScope, principalOf(turn)),
        });
      // The routines scope wraps the whole turn: who asks, and where a
      // trigger or routine the agent sets now delivers later.
      const answer = await (deps.routineTurn
        ? deps.routineTurn({ userId: turn.userRef.id, conversationId: turn.conversationId })(chat)
        : chat());
      if (isNoReply(answer)) {
        logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
        return null;
      }
      if (route.isRejected) return rejectedAnswer(answer, route.notice, deps);
      deps.choices.remember(choiceKey, choiceOptionsOf(answer));
      return answer;
    },
  };
}
