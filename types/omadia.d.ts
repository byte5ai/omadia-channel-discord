/**
 * Ambient declarations for the host-provided `@omadia/*` peer packages.
 *
 * These packages are private workspace packages (not on npm) and are provided
 * by the host at runtime; the esbuild bundle keeps them `external`. For a
 * STANDALONE typecheck (without the full middleware workspace installed) we
 * declare exactly the surface this channel consumes — mirroring the boilerplate
 * "duplicate the contract locally, no cross-import" rule. Source of truth:
 * `middleware/packages/harness-channel-sdk/src/` + `.../plugin-api/src/`.
 */

declare module '@omadia/plugin-api' {
  export interface SecretsAccessor {
    get(key: string): Promise<string | undefined>;
    require(key: string): Promise<string>;
    keys(): Promise<string[]>;
  }
  export interface ConfigAccessor {
    get<T = unknown>(key: string): T | undefined;
    require<T = unknown>(key: string): T;
  }
  /** Plugin-scoped file store (`/memories/agents/<agentId>/…`). */
  export interface MemoryAccessor {
    readFile(relPath: string): Promise<string>;
    writeFile(relPath: string, content: string): Promise<void>;
    exists(relPath: string): Promise<boolean>;
  }
  export interface ServicesAccessor {
    get<T = unknown>(name: string): T | undefined;
  }
  export interface PluginContext {
    readonly agentId: string;
    readonly secrets: SecretsAccessor;
    readonly config: ConfigAccessor;
    readonly services: ServicesAccessor;
    /** Present when the manifest declares memory and a provider is active. */
    readonly memory?: MemoryAccessor;
    log(...args: unknown[]): void;
    // The real context exposes many more accessors (memory, routes, services…);
    // this channel only uses the above.
    readonly [extra: string]: unknown;
  }
}

declare module '@omadia/channel-sdk' {
  import type { PluginContext } from '@omadia/plugin-api';

  export type ChannelUserKind =
    | 'teams-aad'
    | 'slack-user'
    | 'discord-user'
    | 'whatsapp-phone'
    | 'telegram-chat'
    | 'custom';

  export interface ChannelUserRef {
    kind: ChannelUserKind;
    id: string;
    displayName?: string;
    email?: string;
  }

  export interface IncomingAttachment {
    kind: 'image' | 'file' | 'audio' | 'video';
    url: string;
    mediaType: string;
    name?: string;
    sizeBytes?: number;
    bytesBase64?: string;
  }

  export interface IncomingTurn {
    channelId: string;
    conversationId: string;
    channelType?: string;
    channelKey?: string;
    userRef: ChannelUserRef;
    text: string;
    attachments?: IncomingAttachment[];
    metadata?: Record<string, unknown>;
    rawEvent?: unknown;
  }

  export interface VerifierBadge {
    status: 'verified' | 'partial' | 'corrected' | 'failed';
    hint?: string;
  }

  export interface OutgoingAttachment {
    kind: 'image' | 'file';
    url: string;
    altText: string;
    mediaType?: string;
    sizeBytes?: number;
    producer?: string;
    cacheHit?: boolean;
  }

  export interface FollowUpOption {
    label: string;
    prompt: string;
  }

  export interface OutgoingChoiceCard {
    kind: 'choice';
    question: string;
    rationale?: string;
    options: Array<{ label: string; value: string }>;
  }
  export interface OutgoingSlotPicker {
    kind: 'slots';
    question: string;
    subjectHint?: string;
    slots: Array<{
      slotId: string;
      start: string;
      end: string;
      timeZone: string;
      label: string;
      confidence: number;
    }>;
  }
  export interface OutgoingTopicAsk {
    kind: 'topic';
    question: string;
    topics: Array<{ label: string; value: string; hint?: string }>;
  }
  export interface OutgoingRoutineList {
    kind: 'routine_list';
    filter: 'all' | 'active' | 'paused';
    totals: { all: number; active: number; paused: number };
    routines: Array<{
      id: string;
      name: string;
      cron: string;
      prompt: string;
      status: 'active' | 'paused';
      lastRunAt: string | null;
      lastRunStatus: 'ok' | 'error' | 'timeout' | null;
    }>;
  }
  export type OutgoingInteractive =
    | OutgoingChoiceCard
    | OutgoingSlotPicker
    | OutgoingTopicAsk
    | OutgoingRoutineList;

  export interface SemanticAnswer {
    text: string;
    verifier?: VerifierBadge;
    disclaimer?: string;
    attachments?: OutgoingAttachment[];
    followUps?: FollowUpOption[];
    interactive?: OutgoingInteractive;
    // Other optional sidecars (privacyReceipt, recalled, surface…) are ignored.
    [extra: string]: unknown;
  }

  export interface ChatTurnAttachment {
    kind: 'image' | 'file' | 'audio' | 'video';
    url: string;
    mediaType: string;
    name?: string;
    sizeBytes?: number;
    bytesBase64?: string;
  }

  export interface ChatTurnInput {
    userMessage: string;
    sessionScope?: string;
    userId?: string;
    priorTurns?: Array<{ userMessage: string; assistantAnswer: string }>;
    attachments?: ChatTurnAttachment[];
    [extra: string]: unknown;
  }

  export interface ChatAgent {
    chat(input: ChatTurnInput): Promise<SemanticAnswer>;
  }

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  export interface CoreApi {
    registerRouter(channelId: string, prefix: string, router: unknown): void;
    registerRoute(
      channelId: string,
      method: HttpMethod,
      path: string,
      handler: unknown,
    ): void;
    log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
    [extra: string]: unknown;
  }

  export interface ChannelHandle {
    close(): Promise<void>;
  }

  export function isNoReply(
    answer: { text: string } | null | undefined,
  ): boolean;
  export function logNoReplyDrop(
    channel: string,
    meta?: Record<string, unknown>,
  ): void;
  export function getChatAgent(ctx: PluginContext): ChatAgent | undefined;
  export const CHANNEL_RESOLVER_SERVICE: 'channelResolver';
  export interface ChannelBindingResolver {
    resolve(
      channelType: string,
      channelKey: string,
    ): {
      readonly decision: 'bound' | 'fallback' | 'reject';
      readonly chatAgent?: ChatAgent;
    };
  }
}
