import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Message,
  type PartialGuildMember,
} from 'discord.js';

import type {
  ConversationMembershipEvent,
  ConversationMessageEvent,
  IncomingTurn,
  LogLevel,
  PaceClock,
  SpeakerHistoryStore,
} from '@omadia/channel-sdk';

import {
  deliverEphemeral,
  deliverSlashResult,
  deliverToInteraction,
  deliverToMessage,
  systemAnswer,
  type DeliveryContext,
} from './delivery.js';
import {
  buildIncomingTurn,
  buildSlashTurn,
  extractText,
  isDirectMessage,
  mentionsBot,
} from './inbound.js';
import { buildCreatedEvent, discordAuthor, discordBotChannelKey } from './conversationEvents.js';
import { ConversationLifecycle } from './lifecycleEvents.js';
import { BotPresence } from './presence.js';
import type { ReadinessFacts } from './readiness.js';
import { acknowledgeAs, MESSAGE_PACE, runPaced, SLASH_PACE } from './pace.js';
import type { RosterMember, RosterSource } from './roster.js';
import type { ProactiveChannel, SendPort } from './sendProviders.js';
import type { PlannedTurn } from './turn.js';
import {
  AGENT_COMMAND_NAME,
  AGENT_OPTION_NAME,
  AGENTS_COMMAND_NAME,
  ASK_COMMAND_NAME,
  ASK_OPTION_NAME,
  commandAsText,
  registerSlashCommands,
} from './slashCommands.js';
import { patchState, type ChannelState } from './state.js';

export type LogSink = (level: LogLevel, message: string, context?: Record<string, unknown>) => void;

/** When the bot answers in server (guild) channels. */
export type GuildResponsePolicy = 'mention' | 'all' | 'off';

export interface AccessPolicy {
  guildPolicy: GuildResponsePolicy;
  allowDms: boolean;
  ignoreBots: boolean;
  /** Discord user-ids and/or guild-ids allowed to interact; empty = allow all. */
  allowlist: Set<string>;
}

export interface DiscordConnectionDeps {
  channelId: string;
  token: string;
  log: LogSink;
  state: ChannelState;
  policy: AccessPolicy;
  /** Request the privileged Message-Content gateway intent (needed for guild 'all' mode). */
  messageContentIntent: boolean;
  /** Request the privileged Server Members gateway intent (needed to list who is in a server channel). */
  guildMembersIntent: boolean;
  enableSlashCommand: boolean;
  /** Which agents spoke in which conversation (name-line decision, INV-4). */
  speakerHistory: SpeakerHistoryStore;
  /**
   * Tell the kernel about a received message (`core.emitConversationMessage`).
   * Absent on a kernel without the conversation-message registry: nothing is
   * emitted then. Fire-and-forget; the kernel drops what no subscription wants.
   */
  emitConversationMessage?: (event: ConversationMessageEvent) => void;
  /**
   * Like `emitConversationMessage`, but the kernel says whether it consumed the
   * message as the typed answer to an open question (`core.reportConversationMessage`).
   * Used for a message that would start a turn: a consumed answer starts none.
   * Absent: the message is emitted and the turn runs, as before.
   */
  reportConversationMessage?: (event: ConversationMessageEvent) => Promise<{ answeredCard: boolean }>;
  /** How long a turn waits for that report before it runs anyway. Default 1.5 s. */
  reportTimeoutMs?: number;
  /** Timer seam for the pace behaviour (tests). */
  paceClock?: PaceClock;
  /**
   * #2089 — what the kernel is handed of a conversation for this bot
   * (`core.conversationDelivery`, else `all` where `isAllMessagesSubscribed`
   * says so). `all`: a facilitation's process reads every human message and
   * drives every turn, so the bot starts none of its own there. Absent or
   * `addressed` / `none`: the mention rules apply as before.
   */
  conversationDelivery?: (conversationId: string, channelKey: string) => 'all' | 'addressed' | 'none';
  /** `core.emitConversationEvent`: `bot_present` and server joins / leaves (#330, #2043). */
  emitConversationEvent?: (event: ConversationMembershipEvent) => void;
  /** Somebody joined, left or got other roles, or a channel's permissions changed: who sees what changed. */
  onAudienceChanged?: () => void;
  /**
   * Resolve the agent of ONE turn: its speaker is known up front, and `run()`
   * drives the orchestrator turn. `run()` yields the answer to render, or null
   * when the orchestrator emitted NO_REPLY (the connection then stays silent
   * for a passive message / posts a minimal note for an explicit slash
   * command). May throw — the connection surfaces a friendly error to the
   * right target.
   */
  planTurn: (turn: IncomingTurn) => PlannedTurn;
  /**
   * Spec 2042 §5.3 — this connection is one agent's own bot: answers carry
   * no name line (Discord shows the bot's name and avatar).
   */
  agentBot?: boolean;
  /**
   * Is this Discord user one of this installation's own bots (the shared bot
   * or an agent's bot)? Their posts are never a turn, whatever `ignoreBots`
   * says: colleagues' bots answering each other would loop.
   */
  isSiblingBot?: (userId: string) => boolean;
}

/** A slow report never delays a turn longer than this; the answer is then unknown, i.e. no answer. */
const REPORT_TIMEOUT_MS = 1_500;

const ERROR_TEXT = 'Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
const NOT_ALLOWED_TEXT = 'Du darfst diesen Bot hier nicht verwenden.';
const NO_ANSWER_TEXT = 'Keine Antwort.';

/**
 * Owns the long-lived Discord Gateway (discord.js) client: login → ready →
 * reconnect-on-drop. Drives the shared {@link ChannelState} so the admin UI
 * can render connection status + the invite URL, routes inbound messages,
 * slash commands and button clicks into orchestrator turns, and renders the
 * answers back to Discord.
 */
export class DiscordConnection {
  private readonly client: Client;
  private botUserId = '';
  private botKey = '';
  private intentionalClose = false;
  private readonly presence: BotPresence;
  private readonly lifecycle: ConversationLifecycle;

  constructor(private readonly deps: DiscordConnectionDeps) {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      // People's reactions as conversation events (#2043); not privileged.
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ];
    if (deps.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
    if (deps.guildMembersIntent) intents.push(GatewayIntentBits.GuildMembers);

    this.client = new Client({
      intents,
      // DM channels + their messages are uncached — without these partials the
      // gateway never emits MessageCreate for direct messages. Reactions, users
      // and members: so edits, deletions and reactions on uncached messages
      // and a leave of an uncached member still arrive.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
    });

    this.presence = new BotPresence({
      channelId: deps.channelId,
      ...(deps.emitConversationEvent ? { emit: deps.emitConversationEvent } : {}),
      log: deps.log,
    });
    this.lifecycle = new ConversationLifecycle({
      channelId: deps.channelId,
      botKey: () => this.botKey,
      botUserId: () => this.botUserId,
      policy: { hears: (author, guildId, isDirect) => this.hears(author, guildId, isDirect) },
      ...(deps.emitConversationMessage ? { emit: deps.emitConversationMessage } : {}),
      log: deps.log,
    });

    this.client.once(Events.ClientReady, (c) => this.onReady(c));
    this.client.on(Events.MessageCreate, (m) => void this.onMessageCreate(m));
    this.client.on(Events.MessageUpdate, (before, after) => void this.lifecycle.edited(before, after).catch((err: unknown) => this.logEventError('edit', err)));
    this.client.on(Events.MessageDelete, (m) => this.lifecycle.deleted(m));
    this.client.on(Events.MessageReactionAdd, (r, u) => void this.lifecycle.reaction(r, u, false).catch((err: unknown) => this.logEventError('reaction', err)));
    this.client.on(Events.MessageReactionRemove, (r, u) => void this.lifecycle.reaction(r, u, true).catch((err: unknown) => this.logEventError('reaction', err)));
    this.client.on(Events.GuildMemberAdd, (m) => this.onMemberChanged(m, 'added'));
    this.client.on(Events.GuildMemberRemove, (m) => this.onMemberChanged(m, 'removed'));
    this.client.on(Events.GuildMemberUpdate, () => this.deps.onAudienceChanged?.());
    this.client.on(Events.ChannelUpdate, () => this.deps.onAudienceChanged?.());
    this.client.on(Events.GuildRoleUpdate, () => this.deps.onAudienceChanged?.());
    this.client.on(Events.InteractionCreate, (i) => void this.onInteractionCreate(i));
    this.client.on(Events.Error, (err) => {
      this.deps.log('error', 'discord client error', { error: err.message });
      patchState(this.deps.state, { status: 'error', lastError: err.message });
    });
    this.client.on(Events.Warn, (msg) => this.deps.log('warn', `[discord] ${msg}`));
    this.client.on(Events.ShardDisconnect, (_e, id) => {
      this.deps.log('warn', 'discord shard disconnected', { shard: id });
      if (!this.intentionalClose) patchState(this.deps.state, { status: 'connecting' });
    });
    this.client.on(Events.ShardReconnecting, (id) => {
      this.deps.log('info', 'discord shard reconnecting', { shard: id });
      if (!this.intentionalClose) patchState(this.deps.state, { status: 'connecting' });
    });
    this.client.on(Events.ShardResume, () => {
      patchState(this.deps.state, { status: 'connected', lastError: null });
    });
  }

  /** Kick off login without blocking — ready/registration can exceed the 10s
   *  activate budget, so the gateway drives state transitions in the
   *  background. discord.js auto-reconnects internally on transient drops. */
  start(): void {
    patchState(this.deps.state, { status: 'connecting' });
    this.client.login(this.deps.token).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log('error', 'discord login failed', { error: message });
      patchState(this.deps.state, { status: 'error', lastError: describeLoginError(message) });
    });
  }

  private onReady(client: Client<true>): void {
    this.botUserId = client.user.id;
    this.botKey = discordBotChannelKey(client.application?.id ?? client.user.id);
    const inviteUrl = buildInviteUrl(client.user.id);
    patchState(this.deps.state, {
      status: 'connected',
      lastError: null,
      inviteUrl,
      me: {
        id: client.user.id,
        username: client.user.username,
        tag: client.user.tag,
        guildCount: client.guilds.cache.size,
      },
    });
    this.deps.log('info', 'Discord connected', {
      tag: client.user.tag,
      id: client.user.id,
      guilds: client.guilds.cache.size,
    });

    if (this.deps.enableSlashCommand) {
      void registerSlashCommands(client, this.deps.log).then((ok) =>
        patchState(this.deps.state, { slashCommandReady: ok }),
      );
    }
  }

  private deliveryContext(conversationKey: string): DeliveryContext {
    return {
      conversationKey: `discord:${conversationKey}`,
      speakerHistory: this.deps.speakerHistory,
      log: this.deps.log,
      ...(this.deps.agentBot ? { nativeIdentity: true } : {}),
    };
  }

  private async onMessageCreate(message: Message): Promise<void> {
    try {
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return; // could not hydrate a partial (e.g. deleted) — nothing to do
        }
      }

      // Never react to our own messages (loop guard).
      if (message.author.id === this.botUserId) return;
      if (this.deps.policy.ignoreBots && message.author.bot) return;
      if (message.author.bot && this.deps.isSiblingBot?.(message.author.id)) return;

      const dm = isDirectMessage(message);
      if (dm) {
        if (!this.deps.policy.allowDms) return;
      } else {
        const policy = this.deps.policy.guildPolicy;
        if (policy === 'off') return;
      }

      // Not allowlisted: no turn, and nothing is told to the kernel either.
      if (!this.isAllowlisted(message.author.id, message.guildId)) {
        if (dm || this.deps.policy.guildPolicy === 'all' || mentionsBot(message, this.botUserId)) {
          this.deps.log('info', 'discord message dropped (not allowlisted)', {
            user: message.author.id,
            guild: message.guildId,
          });
        }
        return;
      }

      if (!dm && message.guildId) this.observePresence(message);

      const text = extractText(message, this.botUserId);
      // A facilitation reads every message here and drives every turn: the
      // message is handed over, the bot starts no turn of its own.
      if (!dm && this.deliveryOf(message.channelId) === 'all') {
        await this.reportCreated(message, text, false);
        return;
      }
      // Before the mention gate: a typed reply to a question need not mention the bot.
      const startsTurn = dm || this.deps.policy.guildPolicy === 'all' || mentionsBot(message, this.botUserId);
      const isAnswer = await this.reportCreated(message, text, startsTurn);
      if (isAnswer) {
        // The kernel took it as the typed answer to an open question: no turn,
        // no acknowledgement, no reply from the agent.
        this.deps.log('info', 'discord message was the answer to an open question', {
          channel: message.channelId,
          user: message.author.id,
        });
        return;
      }
      if (!startsTurn) return;
      if (!text) {
        // In guild 'all' mode without the privileged Message-Content intent the
        // body is redacted — make that visible rather than silently dropping.
        this.deps.log('info', 'discord message skipped: no text content', {
          channel: message.channelId,
          contentIntent: this.deps.messageContentIntent,
          dm,
        });
        return;
      }

      this.deps.log('info', 'discord message received', {
        channel: message.channelId,
        user: message.author.id,
        dm,
      });

      const turn = buildIncomingTurn(this.deps.channelId, message, text);
      const ctx = this.deliveryContext(message.channelId);
      const planned = this.deps.planTurn(turn);
      const paced = await runPaced(
        () => planned.run(),
        MESSAGE_PACE,
        {
          typing: () => this.sendTyping(message),
          acknowledge: acknowledgeAs(planned.speaker, (answer) => deliverToMessage(message, answer, ctx)),
        },
        this.paceOptions(turn),
      );
      if (!paced.result) return; // NO_REPLY — stay silent on a passive message

      await deliverToMessage(message, paced.result, ctx);
    } catch (err) {
      this.deps.log('error', 'error handling discord message', {
        error: (err as Error).message,
        channel: message.channelId,
      });
      await deliverToMessage(
        message,
        systemAnswer(ERROR_TEXT),
        this.deliveryContext(message.channelId),
      ).catch(() => {});
    }
  }

  /** The kernel's delivery mode for this bot here; `none` on doubt, never `all` without a statement. */
  private deliveryOf(conversationId: string): 'all' | 'addressed' | 'none' {
    if (!this.deps.conversationDelivery || !this.botKey) return 'none';
    try {
      const mode = this.deps.conversationDelivery(conversationId, this.botKey);
      return mode === 'all' || mode === 'addressed' ? mode : 'none';
    } catch (err) {
      this.deps.log('warn', 'discord delivery lookup failed', { error: (err as Error).message, channel: conversationId });
      return 'none';
    }
  }

  /** A group message reached this bot: tell the kernel the bot is in that conversation. */
  private observePresence(message: Message): void {
    const self = this.client.user;
    if (!self || !message.guildId) return;
    this.presence.observe(
      message.channelId,
      message.guildId,
      discordAuthor(self),
      discordAuthor(message.author),
      new Date(message.createdTimestamp).toISOString(),
    );
  }

  /** A person joined or left a server: the roster cache is stale, and the observed conversations hear of it. */
  private onMemberChanged(member: GuildMember | PartialGuildMember, change: 'added' | 'removed'): void {
    try {
      this.deps.onAudienceChanged?.();
      if (member.user.bot) return;
      const occurredAt = new Date().toISOString();
      const visibleTo = (conversationId: string): boolean => {
        if (change === 'removed') return true;
        const channel = this.client.channels.cache.get(conversationId);
        if (!channel || channel.isDMBased()) return false;
        return channel.permissionsFor(member as GuildMember)?.has(PermissionFlagsBits.ViewChannel) === true;
      };
      this.presence.memberChanged(member.guild.id, discordAuthor(member.user), change, occurredAt, visibleTo);
    } catch (err) {
      this.logEventError('membership', err);
    }
  }

  private logEventError(what: string, err: unknown): void {
    this.deps.log('warn', `discord ${what} event not handled`, { error: err instanceof Error ? err.message : String(err) });
  }

  /**
   * May this bot hear `author` here: never itself or a sibling bot, other
   * bots only without *Ignore bots*, DMs only when allowed, servers unless
   * switched off, and only people (or servers) on the allowlist.
   */
  hears(author: { id: string; bot: boolean }, guildId: string | null, isDirect: boolean): boolean {
    if (author.id === this.botUserId) return false;
    if (author.bot && (this.deps.policy.ignoreBots || this.deps.isSiblingBot?.(author.id))) return false;
    if (isDirect ? !this.deps.policy.allowDms : this.deps.policy.guildPolicy === 'off') return false;
    return this.isAllowlisted(author.id, guildId);
  }

  /**
   * Tell the kernel about a received message. Returns true when the kernel
   * consumed it as the typed answer to an open question (only asked for a
   * message that would start a turn). Never throws and never holds the turn
   * longer than the report timeout.
   */
  private async reportCreated(message: Message, text: string | undefined, startsTurn: boolean): Promise<boolean> {
    const { reportConversationMessage: report, emitConversationMessage: emit } = this.deps;
    if ((!report && !emit) || !this.botKey) return false;
    let event: ConversationMessageEvent | undefined;
    try {
      event = buildCreatedEvent(this.deps.channelId, this.botKey, this.botUserId, message, text);
    } catch (err) {
      this.deps.log('warn', 'discord conversation event not built', { error: (err as Error).message });
      return false;
    }
    if (!event) return false;
    if (startsTurn && report) return this.awaitReport(() => report(event), message.channelId);
    try {
      emit?.(event);
    } catch (err) {
      this.deps.log('warn', 'discord conversation event not emitted', { error: (err as Error).message });
    }
    return false;
  }

  /** The report's verdict, or false when it fails or takes longer than the timeout. */
  private async awaitReport(report: () => Promise<{ answeredCard: boolean }>, channelId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deps.reportTimeoutMs ?? REPORT_TIMEOUT_MS);
    });
    try {
      const verdict = await Promise.race([Promise.resolve().then(report), timedOut]);
      if (verdict === 'timeout') {
        this.deps.log('warn', 'discord conversation report timed out; the turn runs', { channel: channelId });
        return false;
      }
      return verdict.answeredCard === true;
    } catch (err) {
      this.deps.log('warn', 'discord conversation report failed; the turn runs', {
        error: (err as Error).message,
        channel: channelId,
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    const text = this.slashCommandText(interaction);
    if (text === undefined) return;

    const ctx = this.deliveryContext(interaction.channelId ?? `dm:${interaction.user.id}`);
    if (!this.isAllowlisted(interaction.user.id, interaction.guildId)) {
      await deliverEphemeral(interaction, systemAnswer(NOT_ALLOWED_TEXT), ctx).catch(() => {});
      return;
    }
    await interaction.deferReply(); // Discord shows "<bot> is thinking…" itself
    const turn = buildSlashTurn(this.deps.channelId, interaction, text);
    await this.runAndEditInteraction(interaction, turn);
  }

  /**
   * The message a native command stands for, or undefined for a command that
   * is not ours. `/agent …` and `/agents` are NOT interpreted here: the text
   * goes to the kernel like anything typed, which carries it out.
   */
  private slashCommandText(interaction: ChatInputCommandInteraction): string | undefined {
    switch (interaction.commandName) {
      case ASK_COMMAND_NAME:
        return interaction.options.getString(ASK_OPTION_NAME, true);
      case AGENT_COMMAND_NAME:
        return commandAsText(AGENT_COMMAND_NAME, interaction.options.getString(AGENT_OPTION_NAME));
      case AGENTS_COMMAND_NAME:
        return commandAsText(AGENTS_COMMAND_NAME, null);
      default:
        return undefined;
    }
  }

  /** Run the turn of a slash command and put the answer into the deferred reply (or a friendly error). */
  private async runAndEditInteraction(
    interaction: ChatInputCommandInteraction,
    turn: IncomingTurn,
  ): Promise<void> {
    const ctx = this.deliveryContext(turn.conversationId);
    try {
      const planned = this.deps.planTurn(turn);
      const paced = await runPaced(
        () => planned.run(),
        SLASH_PACE,
        {
          acknowledge: acknowledgeAs(planned.speaker, (answer) => deliverToInteraction(interaction, answer, ctx)),
        },
        this.paceOptions(turn),
      );
      const answer = paced.result ?? systemAnswer(NO_ANSWER_TEXT);
      await deliverSlashResult(interaction, answer, paced, ctx);
    } catch (err) {
      this.deps.log('error', 'error handling discord interaction', { error: (err as Error).message });
      await deliverToInteraction(interaction, systemAnswer(ERROR_TEXT), ctx).catch(() => {});
    }
  }

  private paceOptions(turn: IncomingTurn): {
    locale?: string;
    clock?: PaceClock;
    onHookError: (hook: 'typing' | 'ack', error: unknown) => void;
  } {
    const locale = (turn.metadata as { locale?: unknown } | undefined)?.locale;
    return {
      ...(typeof locale === 'string' ? { locale } : {}),
      ...(this.deps.paceClock ? { clock: this.deps.paceClock } : {}),
      onHookError: (hook, error) =>
        this.deps.log('warn', `discord pace ${hook} failed`, { error: (error as Error).message }),
    };
  }

  /** The channel's own pace indicator (spec §5.8), instead of a reaction on the user's message. */
  private async sendTyping(message: Message): Promise<void> {
    const channel = message.channel;
    if ('sendTyping' in channel) await (channel as { sendTyping: () => Promise<void> }).sendTyping();
  }

  /**
   * What this bot can tell about who is in a conversation, for the roster
   * provider. `undefined` when the bot cannot see the channel.
   */
  async describeConversation(conversationId: string): Promise<RosterSource | undefined> {
    let channel;
    try {
      channel = await this.client.channels.fetch(conversationId);
    } catch {
      return undefined;
    }
    if (!channel) return undefined;
    if (channel.type === ChannelType.DM) {
      const recipient = channel.recipient ? toRosterMember(channel.recipient) : undefined;
      return { type: 'direct', ...(recipient ? { recipient } : {}) };
    }
    if (channel.isThread() && channel.type === ChannelType.PrivateThread) {
      return { type: 'unreadable', detail: 'Members of a private thread are not listed.' };
    }
    const viewChannel = channel.isThread() ? channel.parent : channel;
    if (!viewChannel || viewChannel.isDMBased() || !('members' in viewChannel)) {
      return { type: 'unreadable', detail: 'This kind of channel has no member list.' };
    }
    const guild = viewChannel.guild;
    return {
      type: 'guild',
      canListMembers: this.deps.guildMembersIntent,
      memberCount: guild.memberCount,
      viewers: async () => {
        // Over the Gateway, never from the cache: a fresh query sees a join at once.
        await guild.members.fetch();
        return [...viewChannel.members.values()].map((m) => toRosterMember(m.user, m.displayName));
      },
      listedCount: () => guild.members.cache.size,
    };
  }

  /**
   * What this bot can tell about moderating a conversation, for the
   * readiness provider (`readiness.ts` turns it into the report).
   */
  async readinessFacts(conversationId: string): Promise<ReadinessFacts> {
    const self = this.client.user;
    if (!self || this.deps.state.status !== 'connected') {
      return { kind: 'offline', detail: this.deps.state.lastError ?? `status ${this.deps.state.status}` };
    }
    let channel;
    try {
      channel = await this.client.channels.fetch(conversationId);
    } catch {
      return { kind: 'not_visible' };
    }
    if (!channel) return { kind: 'not_visible' };
    if (channel.isDMBased()) return { kind: 'direct' };
    const permissions = channel.permissionsFor(self);
    const isThread = channel.isThread();
    const has = (flag: bigint): boolean => permissions?.has(flag) === true;
    return {
      kind: 'guild_channel',
      isThread,
      canView: has(PermissionFlagsBits.ViewChannel),
      canReadHistory: has(PermissionFlagsBits.ReadMessageHistory),
      canSend: has(isThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages),
      serverAllowlisted: this.deps.policy.allowlist.size === 0 || this.deps.policy.allowlist.has(channel.guildId),
    };
  }

  /** The bot's routing key `discord-app:<appId>`, once connected. */
  channelKey(): string | undefined {
    return this.botKey || undefined;
  }

  /** Can this bot see (and so post into) the conversation? For "who can be heard here". */
  async canSee(conversationId: string): Promise<boolean> {
    try {
      return (await this.client.channels.fetch(conversationId)) !== null;
    } catch {
      return false;
    }
  }

  /** This bot as a roster member, once connected. */
  self(): RosterMember | undefined {
    const user = this.client.user;
    return user ? toRosterMember(user) : undefined;
  }

  /**
   * Where the kernel's proactive sends (a notification, a post into a
   * channel) go: the same client, so they share the bot's token and rate state.
   */
  sendPort(): SendPort {
    return {
      channel: (channelId) => this.proactiveChannel(channelId),
      directChannel: async (userId) => toProactiveChannel(await (await this.client.users.fetch(userId)).createDM()),
      // Create Reaction as this client's bot; resolves on Discord's 204, rejects with the API error.
      addOwnReaction: async (route) => {
        await this.client.rest.put(route);
      },
    };
  }

  private async proactiveChannel(channelId: string): Promise<ProactiveChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw unknownChannel();
    return toProactiveChannel(channel);
  }

  /** The channel's access policy: may this user (or, without one, this server) interact with the bot? */
  isAllowlisted(userId: string | undefined, guildId: string | null): boolean {
    const allow = this.deps.policy.allowlist;
    if (allow.size === 0) return true;
    if (userId && allow.has(userId)) return true;
    if (guildId && allow.has(guildId)) return true;
    return false;
  }

  /** Release the client (ChannelHandle.close, ~5s budget). */
  async close(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.client.destroy();
    } catch {
      /* noop */
    }
  }
}

/** Build the OAuth2 install URL the operator uses to add the bot to a server. */
function buildInviteUrl(clientId: string): string {
  const permissions = (
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.EmbedLinks |
    PermissionFlagsBits.ReadMessageHistory |
    // Reactions as a quiet acknowledgement (spec 2043 §5.14).
    PermissionFlagsBits.AddReactions
  ).toString();
  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    scope: 'bot applications.commands',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Discord's own "unknown channel" REST error code, for a channel the bot cannot see. */
const DISCORD_UNKNOWN_CHANNEL = 10003;

function unknownChannel(): Error {
  return Object.assign(new Error('unknown channel'), { code: DISCORD_UNKNOWN_CHANNEL });
}

/** A fetched channel as a place to post into; one that cannot take messages is an unknown channel. */
function toProactiveChannel(channel: unknown): ProactiveChannel {
  const candidate = channel as { send?: unknown; guildId?: unknown; isSendable?: () => boolean };
  if (typeof candidate.send !== 'function' || (candidate.isSendable && !candidate.isSendable())) {
    throw unknownChannel();
  }
  return {
    send: (o) => (candidate.send as (o: unknown) => Promise<unknown>).call(channel, o),
    guildId: typeof candidate.guildId === 'string' ? candidate.guildId : null,
  };
}

/** A discord.js user as a roster member. */
function toRosterMember(
  user: { id: string; username: string; globalName?: string | null; bot: boolean },
  displayName?: string,
): RosterMember {
  const name = displayName ?? user.globalName ?? undefined;
  return { id: user.id, username: user.username, ...(name ? { displayName: name } : {}), isBot: user.bot };
}

/** Make discord.js login failures actionable in the admin UI. */
function describeLoginError(message: string): string {
  if (/disallowed intents/i.test(message)) {
    return 'Login abgelehnt: privilegiertes Intent nicht aktiviert. Deaktiviere "Message-Content-Intent" bzw. "Server-Mitglieder-Intent" in den Plugin-Einstellungen ODER aktiviere sie im Developer Portal → Bot → Privileged Gateway Intents.';
  }
  if (/token/i.test(message)) {
    return 'Login fehlgeschlagen: ungültiger Bot-Token. Prüfe den Token im Developer Portal (ggf. "Reset Token") und installiere das Plugin neu.';
  }
  return message;
}
