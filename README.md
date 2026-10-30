# @omadia/channel-discord

A **Discord bot channel** for the [Omadia](https://github.com/byte5ai/omadia)
harness platform. It opens a discord.js Gateway connection, turns Discord
messages, `/ask` and button clicks into orchestrator turns, and answers with
Discord Components V2: text, separators, images, files, buttons. Markdown
tables arrive as images, because Discord cannot render them.

[Deutsch](README.de.md)

## Setup

1. <https://discord.com/developers/applications> → **New Application** → **Bot** → **Reset Token** → copy.
2. Omadia → install the plugin → paste the token as **Discord Bot Token**.
3. Open the plugin page. The setup wizard shows the bot, gives you the
   **invite button**, lists the servers it joined and ticks off the first
   conversation.

That is all: the Application ID, the invite link and the `/ask` command are
derived from the token. The **Message Content Intent** (portal → Bot) is only
needed for *Behaviour in servers: Respond to every message*; the wizard warns
and links there if it is missing.

| Setup field | Default | |
|---|---|---|
| `discord_bot_token` | — | Bot token (vault) |
| `respond_in_guilds` | `mention` | `mention` (an @mention or a reply to the bot), `all` (every message; needs the intent), `off` (DMs only) |
| `allow_dms` | `true` | Answer 1:1 direct messages |
| `allowlist` | empty | Comma-separated user and/or guild ids; empty = everyone. Applies to messages, `/ask` and buttons |

## How answers look

- **Tables** become a PNG in the omadia UI design system: transparent
  background, so it sits in any Discord theme; Archivo; numbers right-aligned;
  ✅/⚠️/❌ shown as a coloured status dot. A **CSV** is attached for copying, and
  the table text is the image description. Two-column tables become
  `**key:** value` lines, very wide ones per-row cards, long ones a new image
  every 20 rows. See [`packages/table-render`](packages/table-render/README.md).
- **Images** (e.g. diagrams) are downloaded and uploaded by the plugin, so
  local or short-lived URLs work too.
- `---` becomes a separator. Long answers are split within Discord's limits.
  Follow-ups and choices become buttons or a select menu.
- Answers never ping anyone. The first message replies to the question
  without pinging the asker.

## Routing and memory

- Each turn goes to the Agent bound to the Discord **channel id**, else the
  **guild id**, else the default orchestrator (`channelResolver@1`).
- The last 12 turns per channel are replayed as chat history and persisted in
  the plugin's `ctx.memory`, so a conversation survives restarts and updates.
  The orchestrator masks the replayed answers before the model sees them.

## Upgrading from 0.1.x

2.0.0 replaces 0.1.x in place. Token, `respond_in_guilds`, `allow_dms`,
`allowlist`, bindings and the `discord:<channel>` session scope carry over.
Dropped settings: `message_content_intent` (detected from the token),
`enable_slash_command` (`/ask` is always registered, per server, instantly)
and `ignore_bots` (other bots are always ignored). See
[CHANGELOG](CHANGELOG.md).

## Develop

```bash
npm install                       # workspace: plugin + packages/table-render
npm run typecheck
npm run preview                   # offline: render dev/scenarios.mjs → dev/out/, validate V2 payloads + limits
npm run build                     # esbuild bundle → out/omadia-channel-discord-<version>.zip
DISCORD_BOT_TOKEN=… npm run dev   # real Discord + scripted orchestrator, wizard on :8787
```

With `npm run dev`, send a scenario keyword from `dev/scenarios.mjs`
(`tabelle`, `lang`, `kunde`, `matrix`, `projekte`, `status`, `bild`,
`auswahl`, `menu`, `code`, `noreply`) as a mention, DM or `/ask`. Optional env:
`DISCORD_RESPOND_IN_GUILDS`, `DISCORD_ALLOW_DMS`, `DISCORD_ALLOWLIST`, `PORT`.

Checks you can bundle and run with esbuild (see the file headers):

- `dev/history-check.ts`: the chat history survives restarts, is trimmed to 12
  turns, keeps order under concurrent turns and falls back to RAM.
- `dev/host-undici-check.ts`: reproduces a host whose newer undici owns the
  global dispatcher and checks that file uploads still go through. That is
  why `createClient` gives REST its own `Agent`.

`@omadia/table-render` is bundled into `dist/plugin.js`. The build needs the
`.woff`/`.wasm` binary loaders and the aliased `createRequire` banner in
`scripts/build-zip.mjs`. `@omadia/*` SDK packages and `express` are host
peers and stay external.

## Layout

```
src/
  plugin.ts          activate(): admin UI, background connect, wiring
  config.ts          setup fields, allowlist
  app-info.ts        GET /applications/@me → id, name, intent flag; invite URL
  discord-client.ts  discord.js client: intents the portal allows, own REST agent
  commands.ts        /ask per guild; clears 0.1's global command
  inbound.ts         Discord message → IncomingTurn (gating, mention strip)
  interactions.ts    /ask + button/select handling (same gate)
  turn.ts            bound agent per turn → SemanticAnswer
  history.ts         per-channel chat history in ctx.memory
  render.ts          SemanticAnswer → Components V2 payloads (packer, limits)
  markdown.ts        rules → separators, ####+ → bold, image lines → galleries
  deliver.ts         reply / interaction delivery with plain-text fallback
  components.ts      follow-ups / choices → buttons & select menus
  pending.ts         short-TTL custom_id → choice store
  admin/router.ts    GET /api/status for the wizard
assets/admin-ui/     setup wizard
packages/table-render/  markdown tables → PNG / text shapes + CSV
dev/                 run.mjs (live), preview.mjs (offline), scenarios, checks
```

## License

MIT
