import {
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  type RepliableInteraction,
} from 'discord.js';

import type { IncomingTurn } from '@omadia/channel-sdk';

import { buildComponents, CUSTOM_ID_PREFIX } from './components.js';
import { type DiscordConfig, isAllowlisted, SLASH_COMMAND_NAME } from './config.js';
import { deliverInteraction } from './deliver.js';
import { channelKeyFor, DISCORD_CHANNEL_TYPE } from './inbound.js';
import type { PendingStore } from './pending.js';
import type { TurnRunner } from './turn.js';

const EXPIRED_TEXT =
  'Diese Auswahl ist abgelaufen. Bitte stelle die Frage erneut.';
const ERROR_TEXT = 'Es ist ein Fehler aufgetreten. Bitte versuche es erneut.';
const DENIED_TEXT = 'Dieser Bot ist hier nicht für dich freigeschaltet.';

export interface InteractionDeps {
  /** The platform channel id (`ctx.agentId`). */
  readonly channelId: string;
  readonly config: DiscordConfig;
  readonly pending: PendingStore;
  readonly runner: TurnRunner;
  readonly log: (message: string) => void;
}

function displayNameOf(user: { globalName: string | null; username: string }): string {
  return user.globalName ?? user.username;
}

function buildSlashTurn(
  channelId: string,
  query: string,
  interaction: ChatInputCommandInteraction,
): IncomingTurn {
  const guildId = interaction.guildId;
  return {
    channelId,
    conversationId: interaction.channelId,
    channelType: DISCORD_CHANNEL_TYPE,
    channelKey: channelKeyFor(interaction.channelId),
    userRef: {
      kind: 'discord-user',
      id: interaction.user.id,
      displayName: displayNameOf(interaction.user),
    },
    text: query,
    metadata: {
      guildId: guildId ?? undefined,
      channelId: interaction.channelId,
      command: interaction.commandName,
    },
  };
}

/** Resolve a clicked button / picked select option back into a turn. */
function resolveComponentTurn(
  interaction: Extract<Interaction, { customId: string }>,
  deps: InteractionDeps,
): IncomingTurn | null {
  const key = interaction.customId.slice(CUSTOM_ID_PREFIX.length + 1);
  const entry = deps.pending.get(key);
  if (!entry) return null;

  let text: string;
  if (entry.kind === 'submit') {
    text = entry.text;
  } else {
    const token = interaction.isStringSelectMenu()
      ? interaction.values[0]
      : undefined;
    const resolved = token ? entry.options[token] : undefined;
    if (!resolved) return null;
    text = resolved;
  }

  return {
    channelId: deps.channelId,
    conversationId: entry.turn.conversationId,
    channelType: entry.turn.channelType,
    channelKey: entry.turn.channelKey,
    userRef: {
      kind: 'discord-user',
      id: interaction.user.id,
      displayName: displayNameOf(interaction.user),
    },
    text,
    metadata: { via: 'component', guildId: entry.turn.guildId },
  };
}

/** Render an answer back onto a deferred interaction (editReply + follow-ups). */
async function respond(
  interaction: RepliableInteraction,
  turn: IncomingTurn,
  answer: Awaited<ReturnType<TurnRunner['runTurn']>>,
  deps: InteractionDeps,
): Promise<void> {
  if (!answer) {
    // NO_REPLY — remove the "thinking…" placeholder.
    await interaction.deleteReply().catch(() => undefined);
    return;
  }
  const components = buildComponents(answer, deps.pending, {
    conversationId: turn.conversationId,
    channelType: turn.channelType ?? DISCORD_CHANNEL_TYPE,
    channelKey: turn.channelKey ?? turn.conversationId,
    guildId: (turn.metadata as { guildId?: string } | undefined)?.guildId,
  });
  await deliverInteraction(interaction, answer, components, deps.log);
}

async function fail(
  interaction: RepliableInteraction,
  deps: InteractionDeps,
  err: unknown,
): Promise<void> {
  deps.log(`interaction failed: ${(err as Error).message}`);
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(ERROR_TEXT);
    } else {
      await interaction.reply({ content: ERROR_TEXT, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // Nothing more we can do.
  }
}

/**
 * The same gate messages pass (see `messageToTurn`), so `/ask` and buttons
 * can't route around `allow_dms`, `respond_in_guilds: off` or the allowlist.
 */
function permitted(interaction: RepliableInteraction, config: DiscordConfig): boolean {
  const guildId = interaction.guildId;
  if (guildId === null ? !config.respondToDms : config.guildPolicy === 'off') return false;
  return isAllowlisted(config, interaction.user.id, guildId);
}

async function deny(interaction: RepliableInteraction): Promise<void> {
  await interaction
    .reply({ content: DENIED_TEXT, flags: MessageFlags.Ephemeral })
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Route an inbound interaction. Slash commands and our own button/select
 * components are deferred immediately (Discord's 3s ack window), driven through
 * a fresh turn, and rendered back via the interaction's 15-min token.
 */
export async function handleInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== SLASH_COMMAND_NAME) return;
    if (!permitted(interaction, deps.config)) {
      await deny(interaction);
      return;
    }
    try {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const turn = buildSlashTurn(deps.channelId, query, interaction);
      const answer = await deps.runner.runTurn(turn);
      await respond(interaction, turn, answer, deps);
    } catch (err) {
      await fail(interaction, deps, err);
    }
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return;
    if (!permitted(interaction, deps.config)) {
      await deny(interaction);
      return;
    }
    try {
      await interaction.deferReply();
      const turn = resolveComponentTurn(interaction, deps);
      if (!turn) {
        await interaction.editReply(EXPIRED_TEXT);
        return;
      }
      const answer = await deps.runner.runTurn(turn);
      await respond(interaction, turn, answer, deps);
    } catch (err) {
      await fail(interaction, deps, err);
    }
  }
}
