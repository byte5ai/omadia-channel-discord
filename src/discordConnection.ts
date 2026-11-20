import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from 'discord.js';

import type {
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
import { buildCreatedEvent, discordBotChannelKey } from './conversationEvents.js';
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
  /** Timer seam for the pace behaviour (tests). */
  paceClock?: PaceClock;
  /**
   * Resolve the agent of ONE turn: its speaker is known up front, and `run()`
   * drives the orchestrator turn. `run()` yields the answer to render, or null
   * when the orchestrator emitted NO_REPLY (the connection then stays silent
   * for a passive message / posts a minimal note for an explicit slash
   * command). May throw — the connection surfaces a friendly error to the
   * right target.
   */
  planTurn: (turn: IncomingTurn) => PlannedTurn;
}

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

  constructor(private readonly deps: DiscordConnectionDeps) {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ];
    if (deps.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
    if (deps.guildMembersIntent) intents.push(GatewayIntentBits.GuildMembers);

    this.client = new Client({
      intents,
      // DM channels + their messages are uncached — without these partials the
      // gateway never emits MessageCreate for direct messages.
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (c) => this.onReady(c));
    this.client.on(Events.MessageCreate, (m) => void this.onMessageCreate(m));
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

      const text = extractText(message, this.botUserId);
      // Before the mention gate: a typed reply to a question need not mention the bot.
      this.emitCreated(message, text);

      if (!dm) {
        const policy = this.deps.policy.guildPolicy;
        if (policy === 'mention' && !mentionsBot(message, this.botUserId)) return;
      }
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

  /** Report a received message to the kernel; a failing report never disturbs the turn. */
  private emitCreated(message: Message, text: string | undefined): void {
    const emit = this.deps.emitConversationMessage;
    if (!emit || !this.botKey) return;
    try {
      const event = buildCreatedEvent(this.deps.channelId, this.botKey, this.botUserId, message, text);
      if (event) emit(event);
    } catch (err) {
      this.deps.log('warn', 'discord conversation event not emitted', { error: (err as Error).message });
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
        await guild.members.fetch();
        return [...viewChannel.members.values()].map((m) => toRosterMember(m.user, m.displayName));
      },
    };
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
    PermissionFlagsBits.ReadMessageHistory
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
