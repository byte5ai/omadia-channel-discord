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
