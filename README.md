<div align="center">

# @omadia/plugin-channel-discord

### Talk to your omadia agents from Discord.

A signed omadia plugin that connects a Discord bot to your agent team. It routes direct messages, server mentions, and a slash command to your agents and posts the reply back on the same thread.

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

**One bot per agent (own name and avatar in Discord).** Next to the bot in its setup, the plugin runs one bot per agent (spec 2042 §5.3). Discord has no API to create bots, so for each agent: create an Application in the Developer Portal named like the agent, add a bot, enable the same privileged intents as for the channel's own bot, invite it to your servers (`bot applications.commands` is not needed, the agent bot has no slash commands), and paste its token in omadia under **Operator → Agents → the agent → Channels → Own bots → Discord**. omadia hands the token to this plugin once; the plugin checks it with Discord, keeps it in its own vault (`agent_bot_token_<appId>`), connects the bot and reports the routing key `discord-app:<appId>`. Then everyone who mentions or DMs that bot talks to exactly that agent (`/agent` there says whose bot it is), the agent's answers and omadia's posts in its name go out through its bot without a name line, and a bot omadia does not know as an agent's identity answers only with a short system notice. An agent's bot answers when it is mentioned, replied to or sent a DM, also with *respond in guilds = all* (otherwise every agent bot in a channel would answer the same message), and never takes a post of another bot of this installation as a turn, whatever *Ignore bots* says. If Discord is unreachable when omadia starts, agent bots reconnect in the background. Removing the bot on the agent page disconnects it and deletes its token. Agents without a bot of their own are reached through the shared bot with `/agent`; with several agents in a conversation the shared bot puts a short name line ("Paul: …") before an answer where the speaker would otherwise be unclear, and a colleague's contribution appears as "Paul: …" in the text.

The bot also tells omadia your language (the language of a slash command, else the server's preferred language, as German or English) so the system messages come in it; in a DM without a slash command nothing is known and they are German.

If no agent is bound to a channel, the agent is disabled or not available to you, the bot answers with a system message that says so, never with another agent.

## Notifications from omadia

omadia can also write to you on its own initiative (a reminder, an escalation): as a direct message to one person, or as a post into a channel the bot can see. They go out through the bot omadia names: the agent's own bot when it has one, otherwise the shared bot. Direct messages respect *Allow DMs* and the allowlist. Polls and question cards are not drawn natively in Discord: omadia asks them as a numbered text question in the message, and you answer by replying to that message (or, in a DM or when only one question is open, by addressing the bot) with the number. omadia reads that reply as the answer. For this the bot reports the messages it can read in a conversation to omadia, under the identity key `discord-app:<application-id>` (the id of your Discord application); omadia keeps them only for a conversation an agent moderates and drops all others. A message that is the answer to an open question is not also answered by the agent: the bot waits up to 1.5 s for omadia's verdict and then carries on as usual. In a server the bot sees a message without a mention only with the privileged Message Content intent.

**Triggers and routines.** An agent can set a trigger or a routine in a conversation ("remind me tomorrow at 9", a weekly report). Every turn opens omadia's routines scope (`routinesIntegration@1`, only with a database), which is what offers the agent these tools here, and the delivery later goes out through the bot the conversation runs through: the agent's own bot without a name line, the shared bot named like an answer. A bot that was removed or given to another agent delivers nothing. When you answer a reminder DM with Discord's *Reply*, omadia learns which message you replied to and can match your answer to that reminder.

**Reactions instead of an echo.** Where omadia only needs to show that it took a message in (a facilitator recording a contribution), it sets a 👍 on that message instead of posting a reply, as exactly the bot omadia names: the agent's own bot or the shared bot, never another one. This uses Discord's [Create Reaction](https://discord.com/developers/docs/resources/message#create-reaction) and needs the bot permissions **Add Reactions** and **Read Message History** in that channel. The invite link on the plugin's admin page asks for both (with View Channel, Send Messages and Embed Links); a bot invited with an older link needs Add Reactions granted in the server settings, or re-invited. Without the permission omadia gets "not permitted" back and nothing is set.

## Server channels (groups)

omadia answers in a group only when it knows who is in the channel. Discord sends the member list only to bots with the privileged **Server Members intent**: turn it on in the Developer Portal (Bot, Privileged Gateway Intents) and tick *Request server-members intent* in the plugin settings. Without it the roster of a server channel is "unknown" and the bot answers in direct messages only. Direct messages need no intent. Servers with more than 5,000 members are reported as partial, so omadia treats them as unknown too. Every turn in a server channel hands omadia this list (the people, not the bots) as the room's audience: omadia allows a tool only when everyone in the room may use it, so without a complete list a group turn may use no tool at all, starting a facilitation included.

## Facilitators (moderated groups)

A facilitator agent (spec 2043) moderates a server channel or thread: it collects contributions and votes, keeps status and reminds people. In Discord it works like this:

- **Its own bot.** A facilitator needs a bot of its own (see *One bot per agent* above). Two facilitators post as two distinct bots, also in two different channels.
- **Every message, only where it moderates.** While a facilitation holds a message subscription for a channel, its bot hands every human message there to omadia (also the ones that do not mention it) and starts no answer of its own: the facilitation answers. In every other channel the mention rules stay. omadia asks the plugin first whether the bot can do this in that channel (readiness); the answer names what is missing: the **Message Content intent** (without it Discord withholds the text of messages that do not mention the bot), server channels switched off, a server that is not on the allowlist, or the permissions View Channel, Read Message History and Send Messages (in a thread: Send Messages in Threads).
- **Only people count.** A message, edit or reaction by a bot or a webhook, and a system message (a join, a pin), is never a contribution or a vote, whatever *Ignore bots* says: a webhook can post under any name. In a moderated channel the bot does not hand such a message over at all; elsewhere a bot that mentions the bot gets its answer as before when *Ignore bots* is off.
- **Presence.** omadia lets a facilitation listen in a channel only once the bot was seen there. The bot reports this with the first message it receives in a channel (and again every 12 hours), so somebody has to write there first, for example the message that starts the facilitation.
- **Edits, deletions, reactions.** An edited message is reported with its new text (an edited ballot counts in its latest revision), a forwarded message is marked as forwarded (it is not the forwarder's ballot), and reactions are reported with who set them. This needs the intents Guild Message Reactions and Direct Message Reactions, which the plugin requests itself (they are not privileged).
- **Who is there.** With the Server Members intent the bot lists everyone who can see the channel. A query omadia marks as fresh asks Discord again instead of using the five-minute cache, and a join, leave or role change drops the cache. The roster is `complete` only when Discord listed as many members as the server has; a shorter list is `partial`, a failed one `unknown`, both with the reason and the time of the read.
- **Joins and leaves.** With the Server Members intent, a person who joins or leaves the server is reported to omadia for the channels of that server the bot was seen in (a join only where the person can see the channel).
- **Votes as text.** Polls go out as a numbered text question; people answer by replying with the number, without mentioning the bot. omadia keeps the open question, so a restart in between changes nothing. The facilitator may confirm a ballot with a 👍.

**What Discord cannot do, and the closest behaviour:**

| Requirement | Gap in Discord | What happens instead |
| --- | --- | --- |
| Native polls | A Discord poll answer carries no data of its own, only its position and label. Matching a vote back to omadia's option needs a record that survives a restart, which this plugin does not keep; a Discord poll can also not express a ranked vote. | The plugin does not declare polls. omadia posts every poll as numbered text and reads typed replies as the answer; the open question is kept by omadia, so it is restart-safe. |
| Reading unaddressed messages | Only with the privileged Message Content intent. | Without it the readiness report says so and omadia refuses the subscription with that reason, which the facilitator can say in the chat; the bot then hears only messages that mention it (a reply that pings it counts) and DMs. |
| Who is in a channel | Only with the privileged Server Members intent; Discord has no membership per channel, only server members and channel permissions. | Without the intent the roster is `unknown`. Servers above 5,000 members are `partial`. |
| Join and leave events | Only server-wide (GUILD_MEMBER_ADD / REMOVE, Server Members intent); permission changes give no event. | Events go to the channels the bot was seen in since its last start; a permission change only drops the roster cache, so the next roster query is right. |
| "Bot added to channel" | Discord sends no such event for a channel. | Presence is reported on the first message the bot receives there. |
| Deletions | Discord's delete event names neither the author nor who deleted. | A deletion is reported only for a message the bot still had in its cache (author known); otherwise it is logged and not reported. |

## How it works in omadia

A channel plugin (`kind: channel`) for omadia core 1.79 or newer. The omadia kernel activates it from `manifest.yaml`, then it opens the Discord Gateway connection. Each inbound message goes to the agent runtime, and the response comes back to Discord. The channel needs an LLM provider assigned to the agent runtime first, otherwise there is no agent to answer.

## Install

1. Install from the [plugin hub](https://hub.omadia.ai) in the omadia admin UI.
2. Open the plugin setup page and fill in the fields below. There is no API key: the channel uses the setup tokens.
3. Assign a model to the agent runtime first, or the channel has no agent to answer with.

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