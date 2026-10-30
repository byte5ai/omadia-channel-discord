import {
  CHANNEL_RESOLVER_SERVICE,
  type ChannelBindingResolver,
  type ChatAgent,
  type ChatTurnInput,
  getChatAgent,
  type IncomingTurn,
  isNoReply,
  logNoReplyDrop,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { createHistoryStore } from './history.js';
import { DISCORD_CHANNEL_TYPE } from './inbound.js';

const UNAVAILABLE_TEXT =
  'Der Assistent ist gerade nicht verfügbar. Bitte versuche es später erneut.';
const ERROR_TEXT = 'Es ist ein Fehler aufgetreten. Bitte versuche es erneut.';

export interface TurnRunner {
  /**
   * Drive one orchestrator turn. Returns the answer to render, or `null` when
   * the model deliberately stayed silent (NO_REPLY) and nothing should be sent.
   */
  runTurn(turn: IncomingTurn): Promise<SemanticAnswer | null>;
  dispose(): void;
}

/**
 * Per-turn Agent resolution, identical to 0.1.5 so bindings made there keep
 * working: the operator binds a Discord channel id or a guild id. Keys are
 * tried most-specific first — a `bound` decision wins at once, a `fallback`
 * is used only if no key is bound — then the default orchestrator. A resolver
 * error never drops the turn.
 */
function resolveAgent(
  ctx: PluginContext,
  channelType: string,
  keys: ReadonlyArray<string | undefined>,
): ChatAgent | undefined {
  const resolver = ctx.services.get<ChannelBindingResolver>(CHANNEL_RESOLVER_SERVICE);
  let fallback: ChatAgent | undefined;
  if (resolver) {
    try {
      for (const key of keys) {
        if (!key) continue;
        const result = resolver.resolve(channelType, key);
        if (result.decision === 'bound' && result.chatAgent) return result.chatAgent;
        if (result.decision === 'fallback' && result.chatAgent) fallback ??= result.chatAgent;
      }
    } catch {
      // Fall through to the default agent.
    }
  }
  return fallback ?? getChatAgent(ctx);
}

/**
 * Create the per-turn runner shared by message and interaction handling. Replays
 * the channel's recent history (persisted in `ctx.memory`, see `history.ts`)
 * for follow-up coherence and resolves the bound agent **per turn** (US7), so
 * each Discord channel/server reaches the Agent the operator bound to it —
 * never a cached singleton.
 */
export function createTurnRunner(
  ctx: PluginContext,
  log: (message: string) => void,
): TurnRunner {
  const history = createHistoryStore(ctx.memory, log);
  log(`chat history: ${ctx.memory ? 'persisted in ctx.memory' : 'RAM only (no memory provider)'}`);

  return {
    async runTurn(turn) {
      const channelType = turn.channelType ?? DISCORD_CHANNEL_TYPE;
      const channelKey = turn.channelKey ?? turn.conversationId;
      const guildId = (turn.metadata as { guildId?: string } | undefined)?.guildId;

      const agent = resolveAgent(ctx, channelType, [channelKey, guildId]);
      if (!agent) {
        log(`no orchestrator for ${channelType}/${channelKey}`);
        return { text: UNAVAILABLE_TEXT };
      }

      const input: ChatTurnInput = {
        userMessage: turn.text,
        // 0.1.5's scope, so conversation memory survives the upgrade.
        sessionScope: `discord:${turn.conversationId}`,
        userId: turn.userRef.id,
      };
      const priorTurns = await history.get(turn.conversationId);
      if (priorTurns.length > 0) input.priorTurns = priorTurns;
      if (turn.attachments && turn.attachments.length > 0) {
        // IncomingAttachment is structurally a ChatTurnAttachment.
        input.attachments = turn.attachments;
      }

      let answer: SemanticAnswer;
      try {
        answer = await agent.chat(input);
      } catch (err) {
        log(`turn failed: ${(err as Error).message}`);
        return { text: ERROR_TEXT };
      }

      if (isNoReply(answer)) {
        logNoReplyDrop('discord', { conversationId: turn.conversationId });
        return null;
      }

      await history.record(turn.conversationId, {
        userMessage: turn.text,
        assistantAnswer: answer.text,
      });
      return answer;
    },

    dispose() {
      history.dispose();
    },
  };
}
