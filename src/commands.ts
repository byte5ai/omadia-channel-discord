import {
  type Client,
  type Guild,
  type RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

import { SLASH_COMMAND_NAME } from './config.js';

/** The `/ask` command: one required free-text `query` option. */
export function buildCommandData(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName(SLASH_COMMAND_NAME)
    .setDescription('Stelle dem Assistenten eine Frage')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Deine Frage an den Assistenten')
        .setRequired(true),
    )
    .toJSON();
}

/**
 * Per-guild registration is instant (global takes up to an hour), so the
 * command is put on every guild the bot is in — on ready and whenever it
 * joins a new one. No scope setting needed.
 */
export async function registerInGuild(
  guild: Guild,
  log: (message: string) => void,
): Promise<void> {
  await guild.commands
    .set([buildCommandData()])
    .then(() => log(`registered /${SLASH_COMMAND_NAME} in ${guild.name}`))
    .catch((err: unknown) =>
      log(`failed to register /${SLASH_COMMAND_NAME} in ${guild.name}: ${(err as Error).message}`),
    );
}

export async function registerCommands(
  client: Client<true>,
  log: (message: string) => void,
): Promise<void> {
  // 0.1.x could register /ask globally; a leftover global command would show
  // up twice next to the per-guild one.
  await client.application.commands
    .set([])
    .then(() => undefined)
    .catch((err: unknown) =>
      log(`failed to clear global commands: ${(err as Error).message}`),
    );
  for (const guild of client.guilds.cache.values()) {
    await registerInGuild(guild, log);
  }
}
