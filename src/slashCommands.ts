import { SlashCommandBuilder, type Client } from 'discord.js';

import type { LogSink } from './discordConnection.js';

/** The slash command name + option key the InteractionCreate handler matches on. */
export const ASK_COMMAND_NAME = 'ask';
export const ASK_OPTION_NAME = 'frage';

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

/**
 * Register the `/ask` command GLOBALLY. Global registration scales to every
 * guild the bot is in (and DMs) without per-guild bookkeeping, at the cost of
 * up to ~1h propagation on the very first publish. Subsequent edits are fast.
 * Returns true on success so the admin UI can surface "slash command ready".
 */
export async function registerSlashCommands(client: Client<true>, log: LogSink): Promise<boolean> {
  try {
    await client.application.commands.set([buildAskCommand().toJSON()]);
    log('info', 'registered /ask slash command (global) — may take up to 1h to appear in all guilds');
    return true;
  } catch (err) {
    log('error', 'failed to register /ask slash command', { error: (err as Error).message });
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
