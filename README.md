# @omadia/channel-discord

A **Discord channel** for [Omadia](https://omadia.ai). It links a Discord bot
to your Omadia orchestrator: the bot logs into the Discord **Gateway** with a
bot token, and from then on every direct message, every `@mention` in a server,
and every `/ask` slash command is routed through your agents.

Built on [discord.js](https://discord.js.org) v14 (the standard Node Discord
library). No webhook host required — the Gateway is a long-lived WebSocket, the
same model as the WhatsApp channel and the OpenClaw Discord integration this is
modeled on.

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Long-lived WebSocket to the Discord Gateway via discord.js (`channel.transport.kind: websocket`). No inbound webhook. |
| Auth | A **bot token** from the Discord Developer Portal, collected once at install as a vault secret (`setup.fields` `type: secret`) and read via `ctx.secrets`. |
| Status UI | Connection status, bot identity and the OAuth2 invite URL are surfaced through the standard admin-UI iframe (`admin_ui_path`) — `assets/admin-ui/index.html` polls a status endpoint. |
| Inbound | `MessageCreate` / `InteractionCreate` → `IncomingTurn` → the orchestrator's `ChatAgent` (`src/inbound.ts`, `src/discordConnection.ts`). |
| Outbound | The orchestrator's `SemanticAnswer` is rendered to a native Discord message; choice-cards & follow-ups become **buttons**, image attachments become **embeds** (`src/renderer.ts`). |
| Lifecycle | `export async function activate(ctx, core): Promise<ChannelHandle>` — the kernel's dynamic channel resolver picks up the bare `activate` export. |

Source map:

```
src/
├── plugin.ts             # activate(ctx, core) — wires everything together
├── discordConnection.ts  # discord.js client lifecycle: login → ready → route → send
├── inbound.ts            # native message/interaction → IncomingTurn
├── renderer.ts           # SemanticAnswer → Discord message (markdown + buttons + embeds)
├── interactions.ts       # bounded custom_id → replay-prompt registry for buttons
├── slashCommands.ts      # /ask slash command definition + global registration
├── adminRouter.ts        # /api/discord-channel/admin — status + invite URL
└── state.ts              # shared connection state
assets/admin-ui/index.html # status / invite page (single file)
```

---

## Discord setup (one-time)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy the token (you paste it into the plugin at install).
3. Leave the **Privileged Gateway Intents** *off* for the default scope (DMs + `@mentions` + `/ask` all work without them). Only enable **Message Content Intent** if you set *“respond in guilds: all”*.
4. Install the plugin (below), open its admin UI, and use the **invite link** to add the bot to your server.

## Build & install

Requires Node ≥ 20 (this repo pins the version in `.nvmrc`).

```bash
nvm use
npm install
npm run typecheck   # tsc gate (see "Typecheck" below)
npm run build       # esbuild-bundles discord.js into dist/plugin.js, then zips
# → out/omadia-channel-discord-0.1.0.zip
```

Install the resulting ZIP into Omadia:

- **Local / smoke:** Admin-UI → *Store → Lokal → Upload* → drop the `.zip`.
- **Hub:** publish to the registry, then *Store → Hub → Jetzt installieren*
  (see the Omadia plugin docs).

After install, open the plugin's admin UI (Store detail page → Admin iframe, or
directly `…/api/discord-channel/admin/index.html`), copy the **invite link**, and
add the bot to a server.

### Setup fields

| Field | Default | Purpose |
|---|---|---|
| `discord_bot_token` | _(required, secret)_ | The bot token from the Developer Portal. Vault-stored. |
| `respond_in_guilds` | `mention` | When to answer in servers: `mention` (only when `@`-mentioned), `all` (every message — needs the Message-Content intent), `off` (DMs only). |
| `allow_dms` | `true` | Answer in 1:1 direct messages. |
| `message_content_intent` | `false` | Request the privileged Message-Content intent (only for `respond_in_guilds: all`). Must also be enabled in the portal. |
| `enable_slash_command` | `true` | Register the global `/ask` slash command. |
| `ignore_bots` | `true` | Ignore messages from other bots/webhooks (loop guard). |
| `allowlist` | _(empty)_ | Comma-separated Discord user-ids and/or guild-ids allowed to interact (empty = all). |

---

## Behaviour

- **What it answers.** Direct messages, `@mentions` in server channels (configurable),
  and the `/ask` slash command. Its own messages and (optionally) other bots are
  ignored.
- **ACK reaction.** Every accepted message gets an immediate 👀 reaction
  (OpenClaw-style) plus a typing indicator, so the sender sees it was picked up
  before the answer lands.
- **Buttons.** Choice-cards, slot-pickers, topic-asks and follow-up suggestions
  render as Discord buttons; clicking one replays the corresponding prompt as a
  new turn. Long answers are split across the 2000-char message limit.
- **No privileged intent by default.** Discord delivers message content for DMs,
  `@mentions` and the bot's own messages even without the Message-Content intent,
  so the default scope works with zero portal toggles.

## Why discord.js is bundled

A plugin's compiled code can only `import` packages that already exist in the
**host's** `node_modules` (the host resolves a plugin's bare specifiers against
its own tree). `@omadia/*` and `express` are host-provided, so they stay
`peerDependencies` and are marked **external**. discord.js is *not* host-provided,
so `scripts/build-zip.mjs` **esbuild-bundles it into `dist/plugin.js`**. Optional
native acceleration modules (`zlib-sync`, `bufferutil`, voice codecs) are kept
external — discord.js loads them via try/catch, so an absent module degrades
gracefully.

### Typecheck

`tsconfig.json` resolves the `@omadia/channel-sdk` / `@omadia/plugin-api` types
via `paths`; point them at wherever you have the Omadia SDK type declarations
built (these packages aren't published to npm). The esbuild build itself doesn't
need them — both are `external` at runtime, provided by the host.

## Limitations & caveats

- **Text + buttons + embeds.** Inbound media is surfaced as text; outbound files
  are surfaced as links, images as embeds.
- **One bot per install.** A single Gateway connection per plugin instance.
- **Global slash command propagation.** `/ask` is registered globally; on the
  very first publish it can take up to ~1h to appear in every server.
- **Token is sensitive.** Anyone who can read it can impersonate the bot. It is
  vault-stored and never shown again after install — rotate it in the Developer
  Portal if it leaks.

## License

MIT © byte5 GmbH
