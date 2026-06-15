# @omadia/channel-discord

Connects a Discord bot to omadia, so people can talk to their agents from Discord. It routes direct messages, `@mentions`, and a `/ask` slash command into the omadia orchestrator and streams the reply back on the same thread.

omadia is a self-hostable agentic OS: you build, run, and audit multi-agent AI teams from signed plugins. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia). A channel is how a messaging platform reaches those agents.

## What it does

- Bridges Discord to the omadia orchestrator over a discord.js Gateway bot.
- Handles DMs, `@mentions` in servers, and the `/ask` slash command.
- Filters by guild behaviour, DM allowance, and an optional allowlist of IDs.

## How it works in omadia

This is a channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`; the plugin opens the Discord Gateway connection, forwards each inbound message to the orchestrator's chat agent, and returns the agent's response. It needs an LLM provider assigned to the orchestrator first, otherwise there is no agent to answer.

## Install

Install from the omadia hub at [hub.omadia.ai](https://hub.omadia.ai) (omadia admin, plugins, install), or upload the built ZIP directly. Then open the plugin's setup page and fill in the fields below.

## Configuration

| Setup field | Type | Notes |
|-------------|------|-------|
| Discord Bot Token | secret | From the Discord developer portal. |
| Guild behaviour | enum | How the bot reacts inside servers. |
| Allow DMs | boolean | Answer direct messages. |
| Request message-content intent | boolean | Needed to read message text in servers. |
| Register `/ask` slash command | boolean | Adds the `/ask` command. |
| Ignore other bots | boolean | Skip messages from bots. |
| Allowed IDs | string | Optional allowlist of users or channels. |

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
```

The plugin compiles against the omadia workspace packages it declares as peer deps. Link them from a local omadia checkout before building. See [byte5ai/omadia](https://github.com/byte5ai/omadia).

## License

MIT, byte5 GmbH
