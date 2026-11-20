import { SlashCommandBuilder, type Client } from 'discord.js';

import type { LogSink } from './discordConnection.js';

/** The slash commands + option keys the InteractionCreate handler matches on. */
export const ASK_COMMAND_NAME = 'ask';
export const ASK_OPTION_NAME = 'frage';
export const AGENT_COMMAND_NAME = 'agent';
export const AGENT_OPTION_NAME = 'name';
export const AGENTS_COMMAND_NAME = 'agents';

/** Build the `/ask <frage>` command definition. */
export function buildAskCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(ASK_COMMAND_NAME)
    .setDescription('Stelle dem Omadia-Assistenten eine Frage.')
    .setDMPermission(true);
  cmd.addStringOption((opt) =>
    opt.setName(ASK_OPTION_NAME).setDescription('Deine Frage an den Assistenten.').setRequired(true),
  );
  return cmd;
}

/** Build the `/agent [name]` command: choose the agent you talk to here. */
export function buildAgentCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(AGENT_COMMAND_NAME)
    .setDescription('Wähle den Agenten, mit dem du hier sprichst (ohne Name: Auswahl aufheben).')
    .setDMPermission(true);
  cmd.addStringOption((opt) =>
    opt.setName(AGENT_OPTION_NAME).setDescription('Name des Agenten.').setRequired(false),
  );
  return cmd;
}

/** Build the `/agents` command: which agents can I choose here? */
export function buildAgentsCommand(): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(AGENTS_COMMAND_NAME)
    .setDescription('Zeige die Agenten, die du hier wählen kannst.')
    .setDMPermission(true);
}

/**
 * The text a native command stands for as a message. The plugin never parses
 * it: `/agent Mira`, `/agent` and `/agents` are handed on exactly like typed
 * text and the kernel's management layer carries them out.
 */
export function commandAsText(commandName: string, argument: string | null): string {
  const arg = argument?.trim();
  return arg ? `/${commandName} ${arg}` : `/${commandName}`;
}

/**
 * Register the commands GLOBALLY. Global registration scales to every guild
 * the bot is in (and DMs) without per-guild bookkeeping, at the cost of up to
 * ~1h propagation on the very first publish. Subsequent edits are fast.
 * Returns true on success so the admin UI can surface "slash command ready".
 */
export async function registerSlashCommands(client: Client<true>, log: LogSink): Promise<boolean> {
  try {
    await client.application.commands.set([
      buildAskCommand().toJSON(),
      buildAgentCommand().toJSON(),
      buildAgentsCommand().toJSON(),
    ]);
    log('info', 'registered /ask, /agent and /agents slash commands (global) — may take up to 1h to appear in all guilds');
    return true;
  } catch (err) {
    log('error', 'failed to register slash commands', { error: (err as Error).message });
    return false;
  }
}

/** Remove all global application commands (used on uninstall/close if desired). */
export async function clearSlashCommands(client: Client<true>, log: LogSink): Promise<void> {
  try {
    await client.application.commands.set([]);
    log('info', 'cleared global slash commands');
  } catch (err) {
    log('warn', 'failed to clear slash commands', { error: (err as Error).message });
  }
}
