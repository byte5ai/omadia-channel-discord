<div align="center">

# @omadia/plugin-channel-discord

### Talk to your omadia agents from Discord.

A signed omadia plugin that connects a Discord bot to your agent team. It routes direct messages, server mentions, and a slash command into the omadia orchestrator and posts the reply back on the same thread.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Main repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin hub**](https://hub.omadia.ai) · [**What it does**](#what-it-does) · [**Install**](#install)

🇩🇪 Diese Anleitung gibt es auch [auf Deutsch](./README.de.md).

</div>

---

omadia is a self-hostable agentic OS: compose multi-agent teams from signed plugins, run them on your own machine, and get an auditable trail for every action. This plugin adds Discord as a way to reach those agents. Main repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## What it does

Connects a Discord bot (via the discord.js Gateway) to omadia. It picks up direct messages, `@mentions` in servers, and a `/ask` slash command, forwards each one to the omadia orchestrator, and returns the reply on the same thread.

## How it works in omadia

A channel plugin (`kind: channel`). The omadia kernel activates it from `manifest.yaml`, then it opens the Discord Gateway connection. Each inbound message goes to the orchestrator chat agent, and the response comes back to Discord. The channel needs an LLM provider assigned to the orchestrator first, otherwise there is no agent to answer.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI.
2. Open the plugin setup page and fill in the fields below. There is no API key: the channel uses the setup tokens.
3. Assign an LLM provider to the orchestrator first, or the channel has no agent to answer with.

## Configuration

| Field | Type | Notes |
| --- | --- | --- |
| Discord Bot Token | secret | From the Discord developer portal. |
| Guild behaviour | enum | How the bot reacts in servers. |
| Allow DMs | boolean | |
| Request message-content intent | boolean | Needed to read message text in servers. |
| Register /ask slash command | boolean | |
| Ignore other bots | boolean | |
| Allowed IDs | string | Optional allowlist. |

## Build from source

```bash
npm install
npm run build   # tsc, emits dist/
npm test        # validates manifest.yaml against core's invariants
```

`@omadia/plugin-api` is provided by the omadia host at runtime (optional peer dep). Link it from a local omadia checkout to build. See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH