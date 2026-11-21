# AGENTS.md — omadia-channel-discord

Notes for coding agents working in this repository.

## Rules

- **No version bumps in PRs.** Leave `package.json` / `manifest.yaml`
  `version` alone and add changes under `## Unreleased` in `CHANGELOG.md`;
  the release coordinator picks the version and publishes.
- Kernel-initiated sends go through exactly the bot `asChannelKey` names
  (`src/sendProviders.ts`); an unknown key is `unreachable`, never another bot.
  Outcomes are returned, never thrown.
- Only `src/delivery.ts` emits messages (spec 2042 criterion 5, guarded by
  `test/emitters.test.ts`).
- Tests resolve `@omadia/channel-sdk` / `@omadia/plugin-api` from a built
  omadia checkout (`OMADIA_REPO`, see `test/sdk-resolve-hooks.mjs`).

## Decisions

### Bot reactions (spec 2043 §5.14, ADR 0027, byte5ai/omadia#2151)

The conversation provider declares `supports.reactions: true` and implements
`react()`: the kernel's `acknowledge` is a 👍 set with Discord's
[Create Reaction](https://discord.com/developers/docs/resources/message#create-reaction)
(`PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`,
emoji URL-encoded, 204 on success; needs READ_MESSAGE_HISTORY and, for the
first reaction with that emoji, ADD_REACTIONS). The message is addressed by
`conversationId` = Discord channel (or thread) id and `messageId` = Discord
message id, as `buildCreatedEvent` reports them. The plugin itself never
reacts on its own; the only reaction path is `SendPort.addOwnReaction`, called
from `sendProviders.ts`. Error mapping: 404 → `no_binding`, 403 →
`not_permitted`, 429 / other → `channel_error` with Discord's message.
Contract: channel-sdk 0.3.9, plugin-api 1.82.0.

### Native facilitators: readiness, delivery, presence (spec 2043 §6.4, issue #6)

Context: the kernel subscribes a facilitator's process to every message of a
conversation only when the channel registered a readiness provider that says
`ready`, and only for a conversation a channel reported the bot in
(`bot_present` / `bot_added`). Discord withholds the text of unaddressed
messages without the privileged Message Content intent and has no
per-channel membership or "bot added to channel" event.

Decision: `src/readiness.ts` reports `ready` only when every human message of
the channel reaches the kernel with its text (Message Content intent, servers
not off, server allowlisted, View Channel + Read Message History) and the bot
can post; each gap is a named `missing` entry. `src/presence.ts` emits
`bot_present` on the first group message per channel and every 12 h, and
server joins / leaves to the channels the bot was seen in. Under
`conversationDelivery = all` the bot emits and starts no turn (the engine
drives every turn, as in Teams); `addressed` / `none` keep the mention rules.
Edits, deletions (only with a cached author, never guessed), reactions and
forwards are conversation events (`src/lifecycleEvents.ts`).

Consequence: a facilitator in Discord needs its own bot with the Message
Content intent (and Server Members for a roster); somebody has to write in a
channel before a facilitation can subscribe it. Join / leave events after a
restart reach only channels seen again since.

### No native Discord polls

Context: `supports.poll` makes the kernel hand over `message.poll` and expect
`card_answer` events with `{ optionId }`. A Discord poll answer carries only
its position and label; mapping a vote to omadia's option id needs a record
that survives a restart, and this plugin has no durable store (only the
vault). Spec 2043 §9 criterion 1 requires a restart between votes to change
nothing, and a Discord poll cannot express a ranked vote.

Decision: the plugin does not declare `poll` (and does not request the
GuildMessagePolls intent). The kernel posts polls as numbered text, keeps the
open question itself and turns typed replies into answers.

Consequence: votes are typed (`2`), restart-safe, and work for every method.
Native polls would need a kernel-side record of native polls (option ids by
platform message id and answer position) or a durable plugin key-value store.
