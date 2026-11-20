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

Connects a Discord bot (via the discord.js Gateway) to omadia. It picks up direct messages, `@mentions` in servers, and the slash commands `/ask`, `/agent` and `/agents`, forwards each one to the omadia agent that serves the conversation, and returns the reply on the same thread.

Answers read like a colleague's message: plain text, no status line, buttons or reaction on your message. While an agent works the bot shows "typing…"; if work takes clearly longer the agent says so once, in its own name, and a slow slash command is answered as a normal message instead of failing.

## Reaching an agent

**One installation is one Discord bot** (one Discord application, one token). All your agents are reached through that bot. Choosing is explicit:

| You type | What happens |
| --- | --- |
| `/agent Mira` (or the slash command) | Mira becomes your agent in this conversation. omadia confirms once with a system message. Only agents available to you in Discord can be chosen. |
| `/agents` | Lists the agents you can choose here. |
| `/agent` | Clears your choice; the conversation's binding or default applies again. |

The choice is stored by omadia per user and conversation, so it survives a restart, and two people in one channel can talk to different agents. The choice hangs on the narrowest conversation: the channel id, or the thread's own id inside a thread (never the server), plus you. A choice made in a channel does not carry into its threads, and an operator binds an agent to a channel or thread id, not to a whole server. The plugin passes the text on unchanged (the slash commands stand for exactly the text you would type); omadia carries the commands out and answers. Typed as a plain message, `/agent` alone clears the choice and `/agents` shows the list.

**One bot per agent (own name and avatar in Discord) is not supported yet.** Discord has no API to create bots, so every agent would cost you its own Application in the Developer Portal, its own token, its own invite to each server and its own gateway connection and intent settings, and this plugin takes exactly one token and has no binding key per bot. If you need it today, the choice via `/agent` is the way. With several agents in a conversation the bot puts a short name line ("Paul: …") before an answer where the speaker would otherwise be unclear, never on every message of a one-agent conversation; a colleague's contribution appears as "Paul: …" in the text.

The bot also tells omadia your language (the language of a slash command, else the server's preferred language, as German or English) so the system messages come in it; in a DM without a slash command nothing is known and they are German.

If no agent is bound to a channel, the agent is disabled or not available to you, the bot answers with a system message that says so, never with another agent.

## Notifications from omadia

omadia can also write to you on its own initiative (a reminder, an escalation): as a direct message to one person, or as a post into a channel the bot can see. These arrive as plain system messages from the bot; because this is one bot, they are never sent as an individual agent. Direct messages respect *Allow DMs* and the allowlist. Polls and question cards are not drawn natively in Discord: omadia asks them as a numbered text question in the message, and you answer by replying to that message (or, in a DM or when only one question is open, by addressing the bot) with the number. omadia reads that reply as the answer. For this the bot reports the messages it can read in a conversation to omadia, under the identity key `discord-app:<application-id>` (the id of your Discord application); omadia keeps them only for a conversation an agent moderates and drops all others. A message that is the answer to an open question is not also answered by the agent: the bot waits up to 1.5 s for omadia's verdict and then carries on as usual. In a server the bot sees a message without a mention only with the privileged Message Content intent.

## Server channels (groups)

omadia answers in a group only when it knows who is in the channel. Discord sends the member list only to bots with the privileged **Server Members intent**: turn it on in the Developer Portal (Bot, Privileged Gateway Intents) and tick *Request server-members intent* in the plugin settings. Without it the roster of a server channel is "unknown" and the bot answers in direct messages only. Direct messages need no intent. Servers with more than 5,000 members are reported as partial, so omadia treats them as unknown too.

## How it works in omadia

A channel plugin (`kind: channel`) for omadia core 1.75 or newer (placeholder floor; the final version is set at release). The omadia kernel activates it from `manifest.yaml`, then it opens the Discord Gateway connection. Each inbound message goes to the orchestrator chat agent, and the response comes back to Discord. The channel needs an LLM provider assigned to the orchestrator first, otherwise there is no agent to answer.

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
| Request server-members intent | boolean | Needed so omadia knows who is in a server channel and answers there. |
| Register slash commands | boolean | `/ask`, `/agent`, `/agents`. |
| Ignore other bots | boolean | |
| Allowed IDs | string | Optional allowlist. |

## Build from source

```bash
npm install
npm run build   # esbuild bundle into dist/ and the upload zip in out/
npm run typecheck
npm test        # node --test; needs a built omadia checkout, see below
```

`@omadia/plugin-api` and `@omadia/channel-sdk` are provided by the omadia host at runtime (optional peer deps). To typecheck, point the `paths` of the tsconfig at a built omadia checkout. The tests resolve both packages from `OMADIA_REPO` (the checkout root, default `../`; build `middleware/packages/harness-channel-sdk` and `plugin-api` first). See [byte5ai/omadia](https://github.com/byte5ai/omadia) for the layout.

## License

[MIT](LICENSE), byte5 GmbH