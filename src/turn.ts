import {
  isNoReply,
  logNoReplyDrop,
  makePrincipal,
  formatPrincipal,
  parseSessionScope,
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
 * One orchestrator turn of this channel: agent selection commands, the choice
 * replies of numbered questions, per-turn agent resolution through the
 * kernel's `channelResolver@1`, and the chat call itself.
 *
 * The kernel decides which agent answers (INV-1): this module only passes on
 * who asks and where. When nothing answers it says so with a `system` notice
 * (INV-7); it never substitutes another agent.
 */

/** Service name the kernel publishes its agent-selection service under (`@omadia/channel-sdk` `AGENT_SELECTION_SERVICE`). */
export const AGENT_SELECTION_SERVICE_NAME = 'agentSelection';
export const CHANNEL_RESOLVER_SERVICE_NAME = 'channelResolver';

/**
 * Structural views of the kernel services, consumed without new SDK imports so
 * the plugin keeps loading on a host whose `@omadia/channel-sdk` predates them.
 */
export interface AgentCommandLike {
  readonly kind: 'select' | 'clear' | 'list';
}

export interface AgentSelectionServiceLike {
  handle(
    command: AgentCommandLike,
    context: {
      readonly channelType: string;
      readonly conversationKey: string;
      readonly principal: string;
      readonly locale?: string;
    },
  ): Promise<SystemNotice>;
}

interface ChannelResolverLike {
  resolve(
    channelType: string,
    channelKey: string,
    context?: { readonly principal?: string; readonly locale?: string },
  ): {
    readonly decision: 'bound' | 'fallback' | 'reject';
    readonly chatAgent?: ChatAgent;
    readonly notice?: SystemNotice;
  };
}

export interface TurnDeps {
  services: { get<T>(name: string): T | undefined };
  /** The agent of a host without a channel resolver (single-agent / pre-US7). */
  defaultAgent: ChatAgent;
  choices: PendingChoices;
  /** The SDK's `parseAgentCommand`, when the host's SDK has it. */
  parseAgentCommand?: (text: string) => AgentCommandLike | undefined;
  log: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
}

const NO_AGENT_TEXT = 'Diesem Kanal ist kein Agent zugeordnet.';
const ROUTING_FAILED_TEXT = 'Der zuständige Agent ist gerade nicht erreichbar. Bitte versuche es später erneut.';

/** The sender as a principal, `user:discord-user:<id>` (the platform id the kernel's `resolveIdentity` builds). */
export function principalOf(turn: IncomingTurn): string | undefined {
  const principal = makePrincipal('user', `${turn.userRef.kind}:${turn.userRef.id}`);
  return principal ? formatPrincipal(principal) : undefined;
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
function originOf(turn: IncomingTurn, sessionScope: string): TurnOrigin {
  const principal = makePrincipal('user', `${turn.userRef.kind}:${turn.userRef.id}`);
  const messageId = (turn.metadata as { messageId?: unknown } | undefined)?.messageId;
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    scope: parseSessionScope(sessionScope),
    ...(principal ? { principal } : {}),
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

type Route =
  | { readonly kind: 'agent'; readonly agent: ChatAgent }
  | { readonly kind: 'notice'; readonly answer: SemanticAnswer };

/**
 * Resolve the agent for a turn. `channelKeys` are tried most specific first
 * (conversation, then guild): a `bound` decision wins at once. A `reject` is a
 * refusal with the kernel's `system` notice, never a silent fallback to the
 * default agent. Hosts without a resolver use the default agent.
 */
export function resolveRoute(
  deps: TurnDeps,
  turn: IncomingTurn,
  channelKeys: ReadonlyArray<string | null | undefined>,
): Route {
  const resolver = deps.services.get<ChannelResolverLike>(CHANNEL_RESOLVER_SERVICE_NAME);
  if (!resolver) return { kind: 'agent', agent: deps.defaultAgent };
  const principal = principalOf(turn);
  const locale = localeOf(turn);
  const context = { ...(principal ? { principal } : {}), ...(locale ? { locale } : {}) };

  let legacyFallback: ChatAgent | undefined;
  let rejection: SystemNotice | 'no_notice' | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const decision = resolver.resolve(DISCORD_CHANNEL_TYPE, key, context);
      if (decision.decision === 'bound' && decision.chatAgent) return { kind: 'agent', agent: decision.chatAgent };
      // Hosts before #2055 still answer `fallback`: a platform default Agent.
      if (decision.decision === 'fallback' && decision.chatAgent) legacyFallback ??= decision.chatAgent;
      if (decision.decision === 'reject') rejection ??= decision.notice ?? 'no_notice';
    }
  } catch (err) {
    deps.log('error', 'discord agent resolution failed', { error: (err as Error).message });
    return { kind: 'notice', answer: systemAnswer(ROUTING_FAILED_TEXT) };
  }
  if (legacyFallback) return { kind: 'agent', agent: legacyFallback };
  if (rejection) {
    return {
      kind: 'notice',
      answer: rejection === 'no_notice' ? systemAnswer(NO_AGENT_TEXT) : noticeAnswer(rejection),
    };
  }
  return { kind: 'agent', agent: deps.defaultAgent };
}

/**
 * `/agent <name>`, `/agent`, `/agents`: carried out by the kernel's
 * management layer, parsed with the SDK's own parser. Without the kernel
 * service (an older host) the text is not a command here and flows on as an
 * ordinary message.
 */
async function handleAgentCommand(deps: TurnDeps, turn: IncomingTurn): Promise<SemanticAnswer | undefined> {
  const service = deps.services.get<AgentSelectionServiceLike>(AGENT_SELECTION_SERVICE_NAME);
  const command = deps.parseAgentCommand?.(turn.text);
  const principal = principalOf(turn);
  if (!service || !command || !principal) return undefined;
  const locale = localeOf(turn);
  const notice = await service.handle(command, {
    channelType: DISCORD_CHANNEL_TYPE,
    conversationKey: turn.conversationId,
    principal,
    ...(locale ? { locale } : {}),
  });
  return noticeAnswer(notice);
}

/**
 * Drive one turn. Returns the answer to render, or null when the agent
 * emitted NO_REPLY (the connection then stays silent for a passive message).
 */
export async function runTurn(deps: TurnDeps, turn: IncomingTurn): Promise<SemanticAnswer | null> {
  const command = await handleAgentCommand(deps, turn);
  if (command) return command;

  const guildId = (turn.metadata as { guildId?: string | null } | undefined)?.guildId;
  const route = resolveRoute(deps, turn, [turn.conversationId, guildId]);
  if (route.kind === 'notice') return route.answer;

  const choiceKey = `${turn.conversationId}:${turn.userRef.id}`;
  const userMessage = deps.choices.resolve(choiceKey, turn.text);
  const sessionScope = `discord:${turn.conversationId}`;
  const answer = await route.agent.chat({
    userMessage,
    sessionScope,
    userId: turn.userRef.id,
    origin: originOf(turn, sessionScope),
  });
  if (isNoReply(answer)) {
    logNoReplyDrop(turn.channelId, { conversationId: turn.conversationId });
    return null;
  }
  deps.choices.remember(choiceKey, choiceOptionsOf(answer));
  return answer;
}
