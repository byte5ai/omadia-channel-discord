import type { PluginContext } from '@omadia/plugin-api';

/** When the bot answers in server channels (0.1.5's `respond_in_guilds`). */
export type GuildPolicy = 'mention' | 'all' | 'off';

/**
 * Normalized view of the plugin's setup fields. Field keys are 0.1.5's, so an
 * in-place upgrade keeps its token, policy and allowlist. Everything Discord
 * can tell us about the application (id, name, intents) is fetched at runtime
 * instead of asked for — see `app-info.ts`. Booleans arrive as strings from
 * the install drawer, so they are coerced.
 */
export interface DiscordConfig {
  readonly botToken: string;
  readonly guildPolicy: GuildPolicy;
  readonly respondToDms: boolean;
  /** User and/or guild ids allowed to use the bot; empty = everyone. */
  readonly allowlist: ReadonlySet<string>;
}

/** Fixed: one less thing to configure, and `/ask` is what users expect. */
export const SLASH_COMMAND_NAME = 'ask';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
  }
  return undefined;
}

function parseGuildPolicy(ctx: PluginContext): GuildPolicy {
  const raw = ctx.config.get<string>('respond_in_guilds');
  if (raw === 'mention' || raw === 'all' || raw === 'off') return raw;
  // Pre-release 2.0 builds stored a `require_mention` boolean instead.
  return asBool(ctx.config.get('require_mention')) === false ? 'all' : 'mention';
}

function parseAllowlist(raw: unknown): Set<string> {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return new Set(
    list
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
}

export async function readConfig(ctx: PluginContext): Promise<DiscordConfig> {
  // 0.1.5's key first; pre-release 2.0 builds used `bot_token`.
  const token =
    (await ctx.secrets.get('discord_bot_token')) ?? (await ctx.secrets.get('bot_token'));
  if (!token || token.trim().length === 0) {
    throw new Error('discord_bot_token is not set');
  }
  return {
    botToken: token.trim(),
    guildPolicy: parseGuildPolicy(ctx),
    respondToDms:
      asBool(ctx.config.get('allow_dms')) ?? asBool(ctx.config.get('respond_to_dms')) ?? true,
    allowlist: parseAllowlist(ctx.config.get('allowlist')),
  };
}

/** 0.1.5 semantics: allowed if the list is empty, or names the user or the guild. */
export function isAllowlisted(
  config: DiscordConfig,
  userId: string,
  guildId: string | null,
): boolean {
  if (config.allowlist.size === 0) return true;
  if (config.allowlist.has(userId)) return true;
  return guildId !== null && config.allowlist.has(guildId);
}
