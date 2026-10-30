import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Client, Events, type Guild, type Message } from 'discord.js';

import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

import { type AdminStatus, createAdminRouter, type GuildSummary } from './admin/router.js';
import { fetchAppInfo, InvalidTokenError } from './app-info.js';
import { registerCommands, registerInGuild } from './commands.js';
import { buildComponents } from './components.js';
import { readConfig } from './config.js';
import { deliverReply } from './deliver.js';
import { attachListeners, createClient } from './discord-client.js';
import { DISCORD_CHANNEL_TYPE, messageToTurn } from './inbound.js';
import { handleInteraction } from './interactions.js';
import { createPendingStore } from './pending.js';
import { createTurnRunner } from './turn.js';

const ADMIN_PREFIX = '/api/discord/admin';
// Re-send the typing indicator below its ~10s lifetime so it persists on long turns.
const TYPING_REFRESH_MS = 8000;

function guildSummary(g: Guild): GuildSummary {
  return {
    id: g.id,
    name: g.name,
    memberCount: g.memberCount,
    iconUrl: g.iconURL({ size: 64 }) ?? undefined,
  };
}

/**
 * Channel entry point. Mounts the setup-wizard admin UI, then connects in the
 * background: read the application from the token (id, intents), open the
 * gateway with exactly the intents the portal allows, register `/ask` per
 * guild. `activate` never waits on Discord — the 10s budget can't be blown by
 * a slow login; progress and errors surface in the admin UI.
 */
export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  const log = (message: string): void => ctx.log(message);
  const config = await readConfig(ctx);

  const status: AdminStatus = {
    state: 'connecting',
    guilds: [],
    guildPolicy: config.guildPolicy,
    respondToDms: config.respondToDms,
    allowlistSize: config.allowlist.size,
  };
  const pending = createPendingStore();
  const runner = createTurnRunner(ctx, log);
  const typingTimers = new Set<ReturnType<typeof setInterval>>();
  let client: Client | null = null;
  let closed = false;

  const here = path.dirname(fileURLToPath(import.meta.url));
  core.registerRouter(
    ctx.agentId,
    ADMIN_PREFIX,
    createAdminRouter({
      status,
      uiAssetsPath: path.resolve(here, '../assets/admin-ui'),
    }),
  );

  async function handleMessage(c: Client, message: Message): Promise<void> {
    const botUserId = c.user?.id;
    if (!botUserId) return;

    const turn = messageToTurn(message, {
      channelId: ctx.agentId,
      botUserId,
      config,
    });
    if (!turn) return;
    status.lastTurnAt = new Date().toISOString();

    const channel = message.channel;
    if (!channel.isSendable()) return;

    void channel.sendTyping().catch(() => undefined);
    const typingTimer = setInterval(() => {
      void channel.sendTyping().catch(() => undefined);
    }, TYPING_REFRESH_MS);
    typingTimers.add(typingTimer);

    try {
      const answer = await runner.runTurn(turn);
      if (!answer) return; // NO_REPLY — stay silent.
      const rows = buildComponents(answer, pending, {
        conversationId: turn.conversationId,
        channelType: turn.channelType ?? DISCORD_CHANNEL_TYPE,
        channelKey: turn.channelKey ?? turn.conversationId,
        guildId: message.guildId ?? undefined,
      });
      await deliverReply(message, answer, rows, log);
    } finally {
      clearInterval(typingTimer);
      typingTimers.delete(typingTimer);
    }
  }

  async function connect(): Promise<void> {
    const app = await fetchAppInfo(config.botToken);
    if (closed) return;
    status.app = app;

    const c = createClient({ messageContent: app.messageContent });
    client = c;
    const syncGuilds = (): void => {
      if (c.isReady()) status.guilds = [...c.guilds.cache.values()].map(guildSummary);
    };

    attachListeners(c, {
      async onReady(ready) {
        status.state = 'ready';
        status.botTag = ready.user.tag;
        status.botId = ready.user.id;
        status.botAvatarUrl = ready.user.displayAvatarURL({ size: 128 });
        status.readyAt = new Date().toISOString();
        delete status.lastError;
        syncGuilds();
        log(
          `ready as ${ready.user.tag} in ${status.guilds.length} guild(s); ` +
            `message content intent ${app.messageContent ? 'on' : 'off'}`,
        );
        await registerCommands(ready, log);
      },
      onMessage(message) {
        void handleMessage(c, message).catch((err) =>
          log(`message handling failed: ${(err as Error).message}`),
        );
      },
      onInteraction(interaction) {
        if (interaction.isRepliable()) status.lastTurnAt = new Date().toISOString();
        void handleInteraction(interaction, {
          channelId: ctx.agentId,
          config,
          pending,
          runner,
          log,
        }).catch((err) => log(`interaction handling failed: ${(err as Error).message}`));
      },
      onError(error) {
        status.lastError = (error as Error).message;
        log(`gateway error: ${(error as Error).message}`);
      },
      onDisconnect() {
        if (status.state === 'ready') status.state = 'disconnected';
      },
      onResume() {
        status.state = 'ready';
      },
      log,
    });

    // Fresh invites show up in the wizard immediately and get /ask right away.
    c.on(Events.GuildCreate, (guild) => {
      syncGuilds();
      void registerInGuild(guild, log);
    });
    c.on(Events.GuildDelete, syncGuilds);

    await c.login(config.botToken);
  }

  void connect().catch((err: unknown) => {
    status.state = 'error';
    if (err instanceof InvalidTokenError) status.tokenInvalid = true;
    status.lastError = (err as Error).message;
    log(`connect failed: ${status.lastError}`);
  });

  log('activated; connecting to Discord in the background');

  return {
    async close(): Promise<void> {
      closed = true;
      for (const timer of typingTimers) clearInterval(timer);
      typingTimers.clear();
      pending.dispose();
      runner.dispose();
      await client
        ?.destroy()
        .then(() => undefined)
        .catch(() => undefined);
      // Our own REST agent (see createClient) — its sockets outlive the client.
      await client?.rest.agent
        ?.close()
        .then(() => undefined)
        .catch(() => undefined);
    },
  };
}
