import type { ChannelReadinessIssue, ChannelReadinessReport } from '@omadia/plugin-api';
import type { ChannelReadinessProvider } from '@omadia/channel-sdk';

import { DISCORD_CHANNEL_TYPE } from './renderer.js';

/**
 * Can ONE bot moderate a Discord conversation (#2043 §6.4, kernel #2091)?
 * The kernel asks before it subscribes a facilitator's process to every
 * message of a conversation (`conversationMessages@2`, mode `all`) and
 * refuses with `not_ready` when this says no. So the report is honest: it
 * says `ready` only when every human message there reaches the kernel as an
 * event with its text, and names each thing that is missing otherwise.
 *
 * What Discord needs for that:
 *  - the bot is connected and can see the channel (it is on the server);
 *  - the privileged **Message Content** intent: without it Discord withholds
 *    the text of every message that does not mention the bot;
 *  - server channels are not switched off (`respond_in_guilds: off`), and the
 *    allowlist does not filter people out of this server;
 *  - View Channel and Read Message History to read, Send Messages (in a
 *    thread: Send Messages in Threads) to post.
 * A direct message is not a group: nothing to facilitate there.
 */

/** What the connection knows about one conversation, independent of discord.js types. */
export type ReadinessFacts =
  | { readonly kind: 'offline'; readonly detail: string }
  | { readonly kind: 'not_visible' }
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'guild_channel';
      readonly isThread: boolean;
      readonly canView: boolean;
      readonly canReadHistory: boolean;
      readonly canSend: boolean;
      /** The server is on the allowlist, or the allowlist is empty. */
      readonly serverAllowlisted: boolean;
    };

/** The installation-wide settings that decide what a bot can read in servers. */
export interface ReadinessSettings {
  readonly messageContentIntent: boolean;
  readonly guildsSwitchedOff: boolean;
}

const issue = (code: ChannelReadinessIssue['code'], message: string): ChannelReadinessIssue => ({ code, message });

function report(
  parts: { installed: boolean; canReadAllMessages: boolean; canPost: boolean; verified?: boolean },
  missing: readonly ChannelReadinessIssue[],
): ChannelReadinessReport {
  return {
    ready: missing.length === 0,
    installed: parts.installed,
    canReadAllMessages: parts.canReadAllMessages,
    canPost: parts.canPost,
    missing,
    ...(parts.verified === false ? { verified: false } : {}),
  };
}

/** What keeps the bot from reading every message of a server channel it can see. */
function readIssues(facts: Extract<ReadinessFacts, { kind: 'guild_channel' }>, settings: ReadinessSettings): ChannelReadinessIssue[] {
  const missing: ChannelReadinessIssue[] = [];
  if (settings.guildsSwitchedOff) {
    missing.push(issue('consent_missing', 'Server channels are switched off in the Discord plugin settings ("Behaviour in servers" = off).'));
  }
  if (!settings.messageContentIntent) {
    missing.push(
      issue(
        'consent_missing',
        'The privileged Message Content intent is off: Discord withholds the text of messages that do not mention the bot. Enable it in the Developer Portal (Bot, Privileged Gateway Intents) and tick "Request message-content intent" in the plugin settings.',
      ),
    );
  }
  if (!facts.serverAllowlisted) {
    missing.push(issue('consent_missing', 'The plugin allowlist does not contain this server, so messages of people not on the allowlist are not read.'));
  }
  if (!facts.canView || !facts.canReadHistory) {
    missing.push(issue('consent_missing', 'The bot lacks View Channel or Read Message History in this channel.'));
  }
  return missing;
}

/** The readiness of one bot in one conversation. Pure: the connection gathers the facts. */
export function readinessReport(facts: ReadinessFacts, settings: ReadinessSettings): ChannelReadinessReport {
  switch (facts.kind) {
    case 'offline':
      return report(
        { installed: false, canReadAllMessages: false, canPost: false, verified: false },
        [issue('cannot_post', `The Discord bot is not connected: ${facts.detail}`)],
      );
    case 'not_visible':
      return report({ installed: false, canReadAllMessages: false, canPost: false }, [
        issue('app_not_installed', 'The bot cannot see this channel: invite it to the server (invite link on the plugin admin page) and give it access to the channel.'),
      ]);
    case 'direct':
      return report({ installed: true, canReadAllMessages: true, canPost: true }, [
        issue('unsupported_conversation', 'A direct message is not a group conversation; facilitation runs in a server channel or thread.'),
      ]);
    case 'guild_channel': {
      const missing = readIssues(facts, settings);
      const canRead = missing.length === 0;
      if (!facts.canSend) {
        missing.push(
          issue('cannot_post', facts.isThread ? 'The bot lacks Send Messages in Threads here.' : 'The bot lacks Send Messages in this channel.'),
        );
      }
      return report({ installed: true, canReadAllMessages: canRead, canPost: facts.canSend }, missing);
    }
  }
}

/** One bot's side of the check: its facts about a conversation. */
export interface ReadinessSource {
  readinessFacts(conversationId: string): Promise<ReadinessFacts>;
}

/** The bot behind `asChannelKey`, or undefined when no such bot runs here (never another bot). */
export type ReadinessLookup = (asChannelKey: string) => ReadinessSource | undefined;

/** The channel's readiness provider: answers for exactly the bot `asChannelKey` names. Never throws. */
export function createDiscordReadinessProvider(lookup: ReadinessLookup, settings: ReadinessSettings): ChannelReadinessProvider {
  return {
    channelType: DISCORD_CHANNEL_TYPE,
    async check(conversationId, opts) {
      const key = opts.asChannelKey.trim().toLowerCase();
      const source = lookup(key);
      if (!source) {
        return report({ installed: false, canReadAllMessages: false, canPost: false }, [
          issue('no_identity', `No Discord bot '${opts.asChannelKey}' runs in this installation.`),
        ]);
      }
      try {
        return readinessReport(await source.readinessFacts(conversationId), settings);
      } catch (err) {
        return readinessReport({ kind: 'offline', detail: err instanceof Error ? err.message : String(err) }, settings);
      }
    },
  };
}
