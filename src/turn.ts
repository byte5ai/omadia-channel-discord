import {
  CHANNEL_RESOLVER_SERVICE,
  channelUserPrincipal,
  isNoReply,
  logNoReplyDrop,
  parsePrincipal,
  parseSessionScope,
  type AgentSpeaker,
  type ChannelBindingResolver,
  type ChannelResolveResult,
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
  services: { get<T>(name: string): T | undefined };
  /** The agent of a host without a channel resolver (single-agent / pre-US7). */
  defaultAgent: ChatAgent;
  choices: PendingChoices;
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
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

/** The sender as a principal, the one form for every channel (`user:discord-user:<snowflake>`). */
export function principalOf(turn: IncomingTurn): string {
  return channelUserPrincipal(turn.userRef);
}

function localeOf(turn: IncomingTurn): string | undefined {
  const raw = (turn.metadata as { locale?: unknown } | undefined)?.locale;
  if (typeof raw !== 'string') return undefined;
  const language = raw.split('-')[0]?.toLowerCase();
  return language ? language : undefined;
}

/**
 * Where the turn came from, for the kernel (conversation type for the audience
 * floor, the sender, the platform ids). Discord is not a context-memory channel
 * (`CONTEXT_MEMORY_CHANNEL_TYPES`), so the memory axes stay as before.
 */
function originOf(turn: IncomingTurn, sessionScope: string, principal: string): TurnOrigin {
  const typedPrincipal = parsePrincipal(principal);
  const messageId = (turn.metadata as { messageId?: unknown } | undefined)?.messageId;
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    scope: parseSessionScope(sessionScope),
    ...(typedPrincipal ? { principal: typedPrincipal } : {}),
    ...(turn.conversationType ? { conversationType: turn.conversationType } : {}),
    channelConversationId: turn.conversationId,
    ...(typeof messageId === 'string' ? { messageId } : {}),
    speaker: {
      kind: turn.userRef.kind,
      id: turn.userRef.id,
      ...(turn.userRef.displayName ? { displayName: turn.userRef.displayName } : {}),
    },
  };
}

/** What the resolver decided for a turn. */
type Route =
  /** The agent that will answer (bound), or the resolver's ChatAgent that answers a reject with its notice. */
  | { readonly kind: 'agent'; readonly agent: ChatAgent; readonly isRejected: boolean; readonly speaker?: AgentSpeaker; readonly notice?: SystemNotice }
  /** Nobody can take the text: a `system` answer, no agent involved. */
  | { readonly kind: 'notice'; readonly answer: SemanticAnswer };

/**
 * Resolve the agent for a turn. `channelKeys` are tried most specific first
 * (conversation, then guild): a `bound` decision wins at once. When none
 * binds, the FIRST key's reject stands, so `/agent` stores the selection for
 * the conversation, and its ChatAgent answers with the kernel's `system`
 * notice. Hosts without a resolver use the default agent.
 */
export function resolveRoute(
  deps: TurnDeps,
  turn: IncomingTurn,
  channelKeys: ReadonlyArray<string | null | undefined>,
): Route {
  const resolver = deps.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  if (!resolver) return { kind: 'agent', agent: deps.defaultAgent, isRejected: false };
  const locale = localeOf(turn);
  const context = { principal: principalOf(turn), ...(locale ? { locale } : {}) };

  let firstReject: ChannelResolveResult | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = resolver.resolve(DISCORD_CHANNEL_TYPE, key, context);
      if (result.decision === 'bound') {
        if (!result.chatAgent) throw new Error('resolver answered bound without a chatAgent');
        return {
          kind: 'agent',
          agent: result.chatAgent,
          isRejected: false,
          ...(result.speaker ? { speaker: result.speaker } : {}),
        };
      }
      firstReject ??= result;
    }
  } catch (err) {
    deps.log('error', 'discord agent resolution failed', { error: (err as Error).message });
    return { kind: 'notice', answer: systemAnswer(ROUTING_FAILED_TEXT) };
  }
  if (!firstReject) return { kind: 'agent', agent: deps.defaultAgent, isRejected: false };
  // `chatAgent` is set on a reject too: it answers with the notice and carries
  // out `/agent`, so a user can still choose an agent. Without it (a platform
  // before the contract) the channel says why itself.
  if (firstReject.chatAgent) {
    return {
      kind: 'agent',
      agent: firstReject.chatAgent,
      isRejected: true,
      ...(firstReject.notice ? { notice: firstReject.notice } : {}),
    };
  }
  return {
    kind: 'notice',
    answer: firstReject.notice ? noticeAnswer(firstReject.notice) : systemAnswer(NO_AGENT_TEXT),
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
  const guildId = (turn.metadata as { guildId?: string | null } | undefined)?.guildId;
  const route = resolveRoute(deps, turn, [turn.conversationId, guildId]);
  if (route.kind === 'notice') return { run: async () => route.answer };

  return {
    ...(route.speaker ? { speaker: route.speaker } : {}),
    run: async () => {
      const choiceKey = `${turn.conversationId}:${turn.userRef.id}`;
      const userMessage = deps.choices.resolve(choiceKey, turn.text);
      const sessionScope = `discord:${turn.conversationId}`;
      const answer = await route.agent.chat({
        userMessage,
        sessionScope,
        userId: turn.userRef.id,
        origin: originOf(turn, sessionScope, principalOf(turn)),
      });
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
