# Changelog

## 2.0.0

Rewrite. Replaces 0.1.x in place: same plugin id, same setup keys
(`discord_bot_token`, `respond_in_guilds`, `allow_dms`, `allowlist`), same
binding keys (Discord channel id, then guild id) and the same
`discord:<channelId>` session scope, so tokens, bindings and conversation
memory carry over.

- **Setup: token only.** Application ID, bot name and the Message Content
  intent are read from `GET /applications/@me`; the intent is requested only
  when the portal has it on (a mismatch used to fail the login). Removed
  setup fields: `message_content_intent`, `enable_slash_command`,
  `ignore_bots` (now always on).
- **Setup wizard** as the plugin page: bot identity, invite button, joined
  servers, first conversation; warnings with deep links (invalid token,
  missing intent for "every message").
- **`/ask` per server**, registered instantly on every guild and on newly
  joined ones; a leftover global `/ask` from 0.1.x is removed.
- **Components V2 answers**: text displays, `---` as separators, galleries,
  file cards, buttons/select menus last; packed within the per-message limits
  (40 components, 4000 chars, 10 files). Falls back to plain text if Discord
  rejects a payload.
- **Tables as images** (`packages/table-render`): markdown tables become a PNG
  in the omadia UI design system (transparent ground, Archivo, status as a
  coloured dot) plus a CSV file; two-column tables become `**key:** value`
  lines, very wide ones per-row cards. Replaces 0.1.3's width-aware code
  blocks.
- **Images are uploaded**, not handed to Discord's proxy, so diagrams from a
  local, VPN-only or short-lived signed URL show up.
- **Chat history persists** per channel in `ctx.memory` (last 12 turns) and
  survives restarts and updates; RAM only without a memory provider.
- **Allowlist and DM/guild policy also gate `/ask` and buttons.**
- Answers never ping (`allowedMentions: { parse: [] }`) and reply to the
  question without pinging the asker.
- Fix: discord.js REST gets its own undici `Agent`. On a host whose newer
  undici owns the global dispatcher, every message with files failed with
  "body must be a FormData created by this undici package instance".

## 0.1.5

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-discord` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
