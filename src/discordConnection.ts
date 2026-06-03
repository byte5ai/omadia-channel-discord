import {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type BaseMessageOptions,
  type Interaction,
  type Message,
} from 'discord.js';

import type { IncomingTurn, LogLevel, SemanticAnswer } from '@omadia/channel-sdk';

import { buildIncomingTurn, extractText, isDirectMessage, mentionsBot } from './inbound.js';
import type { InteractionRegistry } from './interactions.js';
import { chunkContent, renderAnswer, type DiscordRenderResult } from './renderer.js';
import { ASK_COMMAND_NAME, ASK_OPTION_NAME, registerSlashCommands } from './slashCommands.js';
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
  enableSlashCommand: boolean;
  registry: InteractionRegistry;
  /**
   * Drive ONE orchestrator turn. Returns the answer to render, or null when
   * the orchestrator emitted NO_REPLY (the connection then stays silent for a
   * passive message / posts a minimal note for an explicit slash command).
   * May throw — the connection surfaces a friendly error to the right target.
   */
  runTurn: (turn: IncomingTurn) => Promise<SemanticAnswer | null>;
}

const ACK_EMOJI = '👀';
const ERROR_TEXT = '⚠️ Entschuldigung, dabei ist ein Fehler aufgetreten. Bitte versuche es erneut.';
const EXPIRED_TEXT = '⌛ Dieser Button ist abgelaufen. Bitte stelle die Frage erneut.';

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
  private intentionalClose = false;

  constructor(private readonly deps: DiscordConnectionDeps) {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ];
    if (deps.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);

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
        if (policy === 'mention' && !mentionsBot(message, this.botUserId)) return;
      }

      if (!this.isAllowlisted(message.author.id, message.guildId)) {
        this.deps.log('info', 'discord message dropped (not allowlisted)', {
          user: message.author.id,
          guild: message.guildId,
        });
        return;
      }

      const text = extractText(message, this.botUserId);
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

      // ACK first (OpenClaw-style) so the user sees it was picked up.
      void message.react(ACK_EMOJI).catch(() => {});
      void this.sendTyping(message);

      const turn = buildIncomingTurn(this.deps.channelId, message, text);
      const answer = await this.deps.runTurn(turn);
      if (!answer) return; // NO_REPLY — stay silent on a passive message

      const result = renderAnswer(answer, {
        conversationId: message.channelId,
        registry: this.deps.registry,
      });
      await this.replyToMessage(message, result);
    } catch (err) {
      this.deps.log('error', 'error handling discord message', {
        error: (err as Error).message,
        channel: message.channelId,
      });
      await this.replyToMessage(message, textResult(ERROR_TEXT)).catch(() => {});
    }
  }

  private async onInteractionCreate(interaction: Interaction): Promise<void> {
    // /ask slash command
    if (interaction.isChatInputCommand() && interaction.commandName === ASK_COMMAND_NAME) {
      const question = interaction.options.getString(ASK_OPTION_NAME, true);
      if (!this.isAllowlisted(interaction.user.id, interaction.guildId)) {
        await interaction.reply({ content: EXPIRED_TEXT, ephemeral: true }).catch(() => {});
        return;
      }
      await interaction.deferReply();
      const turn: IncomingTurn = {
        channelId: this.deps.channelId,
        conversationId: interaction.channelId ?? `dm:${interaction.user.id}`,
        userRef: {
          kind: 'discord-user',
          id: interaction.user.id,
          displayName: interaction.user.globalName ?? interaction.user.username,
        },
        text: question,
        metadata: {
          via: 'slash',
          guildId: interaction.guildId ?? null,
          discordChannelId: interaction.channelId ?? null,
        },
      };
      await this.runAndEditInteraction(interaction, turn);
      return;
    }

    // Button click (choice option / follow-up)
    if (interaction.isButton() && this.deps.registry.owns(interaction.customId)) {
      const payload = this.deps.registry.take(interaction.customId);
      if (!payload) {
        await interaction.reply({ content: EXPIRED_TEXT, ephemeral: true }).catch(() => {});
        return;
      }
      await interaction.deferReply();
      const turn: IncomingTurn = {
        channelId: this.deps.channelId,
        conversationId: payload.conversationId,
        userRef: {
          kind: 'discord-user',
          id: interaction.user.id,
          displayName: interaction.user.globalName ?? interaction.user.username,
        },
        text: payload.prompt,
        metadata: { via: 'button', guildId: interaction.guildId ?? null },
      };
      await this.runAndEditInteraction(interaction, turn);
    }
  }

  /** Shared path for slash-command + button interactions: run the turn and
   *  edit the deferred reply with the rendered answer (or a friendly error). */
  private async runAndEditInteraction(
    interaction: { editReply: (o: BaseMessageOptions) => Promise<unknown>; followUp: (o: BaseMessageOptions) => Promise<unknown>; channelId: string | null; user: { id: string } },
    turn: IncomingTurn,
  ): Promise<void> {
    try {
      const answer = await this.deps.runTurn(turn);
      if (!answer) {
        await interaction.editReply({ content: '🤐 (keine Antwort)' });
        return;
      }
      const result = renderAnswer(answer, {
        conversationId: turn.conversationId,
        registry: this.deps.registry,
      });
      const payloads = buildPayloads(result);
      if (payloads.length === 0) {
        await interaction.editReply({ content: '🤐 (keine Antwort)' });
        return;
      }
      await interaction.editReply(payloads[0]!);
      for (const extra of payloads.slice(1)) await interaction.followUp(extra);
    } catch (err) {
      this.deps.log('error', 'error handling discord interaction', { error: (err as Error).message });
      await interaction.editReply({ content: ERROR_TEXT }).catch(() => {});
    }
  }

  /** Send a rendered result back into the channel a message came from. The
   *  first chunk is a reply (threaded to the user's message); any overflow
   *  chunks are plain channel sends; embeds + buttons ride the last chunk. */
  private async replyToMessage(message: Message, result: DiscordRenderResult): Promise<void> {
    const payloads = buildPayloads(result);
    if (payloads.length === 0) return;
    const channel = message.channel;
    const sendable = 'send' in channel ? (channel as { send: (o: BaseMessageOptions) => Promise<unknown> }) : null;
    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i]!;
      if (i === 0) {
        await message.reply(payload);
      } else if (sendable) {
        await sendable.send(payload);
      }
    }
  }

  private async sendTyping(message: Message): Promise<void> {
    try {
      const channel = message.channel;
      if ('sendTyping' in channel) {
        await (channel as { sendTyping: () => Promise<void> }).sendTyping();
      }
    } catch {
      /* typing is cosmetic — ignore failures */
    }
  }

  private isAllowlisted(userId: string, guildId: string | null): boolean {
    const allow = this.deps.policy.allowlist;
    if (allow.size === 0) return true;
    if (allow.has(userId)) return true;
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
    PermissionFlagsBits.AddReactions
  ).toString();
  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    scope: 'bot applications.commands',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Turn a rendered result into one or more Discord message payloads, attaching
 *  embeds + components to the LAST chunk only (Discord renders them once). */
function buildPayloads(result: DiscordRenderResult): BaseMessageOptions[] {
  const chunks = chunkContent(result.content);
  const hasSidecars = result.embeds.length > 0 || result.components.length > 0;
  if (chunks.length === 0) {
    return hasSidecars ? [withSidecars({}, result, true)] : [];
  }
  return chunks.map((content, i) =>
    withSidecars({ content }, result, i === chunks.length - 1),
  );
}

function withSidecars(
  base: BaseMessageOptions,
  result: DiscordRenderResult,
  attach: boolean,
): BaseMessageOptions {
  if (!attach) return base;
  return {
    ...base,
    ...(result.embeds.length > 0 ? { embeds: result.embeds } : {}),
    ...(result.components.length > 0
      ? { components: result.components as ActionRowBuilder<ButtonBuilder>[] }
      : {}),
  };
}

function textResult(content: string): DiscordRenderResult {
  return { content, embeds: [] as EmbedBuilder[], components: [] as ActionRowBuilder<ButtonBuilder>[] };
}

/** Make discord.js login failures actionable in the admin UI. */
function describeLoginError(message: string): string {
  if (/disallowed intents/i.test(message)) {
    return 'Login abgelehnt: privilegiertes Intent nicht aktiviert. Deaktiviere "Message-Content-Intent" in den Plugin-Einstellungen ODER aktiviere es im Developer Portal → Bot → Privileged Gateway Intents.';
  }
  if (/token/i.test(message)) {
    return 'Login fehlgeschlagen: ungültiger Bot-Token. Prüfe den Token im Developer Portal (ggf. "Reset Token") und installiere das Plugin neu.';
  }
  return message;
}
