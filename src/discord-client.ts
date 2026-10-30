import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  Partials,
} from 'discord.js';
import { Agent } from 'undici';

/**
 * Lifecycle + event callbacks the plugin wires into the gateway client. All
 * are invoked defensively — a throwing handler is routed to `onError`, never
 * left to crash the gateway.
 */
export interface ClientCallbacks {
  onReady(client: Client<true>): void | Promise<void>;
  onMessage(message: Message): void;
  onInteraction(interaction: Interaction): void;
  onError(error: unknown): void;
  onDisconnect?(): void;
  onResume?(): void;
  log(message: string): void;
}

/**
 * Build the discord.js gateway client.
 *
 * `MessageContent` is a PRIVILEGED intent and only requested when the portal
 * has it switched on (see `AppInfo.messageContent`) — asking for it while it
 * is off makes the gateway refuse the login (close code 4014). Without it the
 * bot still receives the text of DMs and of messages that @mention it.
 * `Partials.Channel`/`Message` are required to receive DM events, which arrive
 * uncached.
 *
 * REST gets its own undici `Agent`. Without one, the bundled undici sends
 * through the process-wide global dispatcher, which is whichever undici loaded
 * first — on the host that is the middleware's newer undici, and it rejects
 * the multipart FormData our copy builds ("body must be a FormData created by
 * this undici package instance"), so every message with files failed there.
 */
export function createClient(opts: { messageContent: boolean }): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ];
  if (opts.messageContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({
    intents,
    partials: [Partials.Channel, Partials.Message],
    rest: { agent: new Agent() },
  });
}

/** Attach all listeners ONCE (never inside `ready`, to avoid duplicates). */
export function attachListeners(client: Client, cb: ClientCallbacks): void {
  // `ClientReady` fires on (re)identify; keep the handler idempotent.
  client.on(Events.ClientReady, (ready) => {
    void Promise.resolve(cb.onReady(ready)).catch((err) => cb.onError(err));
  });

  client.on(Events.MessageCreate, (message) => {
    try {
      cb.onMessage(message);
    } catch (err) {
      cb.onError(err);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    try {
      cb.onInteraction(interaction);
    } catch (err) {
      cb.onError(err);
    }
  });

  client.on(Events.Error, (err) => cb.onError(err));
  client.on(Events.ShardError, (err) => cb.onError(err));
  client.on(Events.Warn, (msg) => cb.log(`gateway warn: ${msg}`));
  if (cb.onDisconnect) client.on(Events.ShardDisconnect, () => cb.onDisconnect?.());
  if (cb.onResume) client.on(Events.ShardResume, () => cb.onResume?.());
}
