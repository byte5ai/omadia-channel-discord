# Changelog

## Unreleased

Bot reactions (spec 2043 §5.14, byte5ai/omadia#2061, ADR 0027). Needs the
kernel of byte5ai/omadia#2151 (channel-sdk 0.3.9, plugin-api 1.82.0) to be
used; an older kernel never calls it, so `compat.core` stays as it is.

- **A thumbs-up instead of an echo**: the conversation send provider declares
  `supports.reactions: true` and implements `react()`. `acknowledge` becomes
  👍 through Discord's Create Reaction
  (`PUT /channels/{channel.id}/messages/{message.id}/reactions/%F0%9F%91%8D/@me`,
  204 on success), addressed by the channel id and message id the plugin
  reported in its inbound conversation-message events.
- **As exactly the bot `asChannelKey` names** (the installation's or an
  agent's own bot); an unknown or missing key is `not_permitted`, never
  another bot. Respects the server allowlist.
- **Never throws**: 404 / unknown message or channel → `no_binding`; 403 /
  missing access, missing permissions, reaction blocked → `not_permitted`;
  429 or a rate-limit rejection and any other failure → `channel_error`,
  always with Discord's own message.
- **Invite link asks for Add Reactions** (next to Read Message History, which
  it already had). Bots invited earlier need the permission granted in the
  server, or a new invite.

## 0.3.0

An agent's own Discord bot (byte5ai/omadia#2042, spec §5.3, §8 item 20).
Needs a kernel with `registerAgentIdentityProvider` (S7); on an older kernel
the plugin runs its own bot only, as before.

- **One bot per agent** next to the installation's own bot: the plugin
  registers an `AgentIdentityProvider` (field: bot token). The token is checked
  with `GET /oauth2/applications/@me`, stored in the plugin vault as
  `agent_bot_token_<appId>`, and the bot connects to the Gateway (no slash
  commands). Boot reconnects every stored bot; removal disconnects it and
  deletes the token. New permission `secrets.runtime_write`.
- **An agent bot resolves on its own key `discord-app:<appId>`** and answers
  only when the kernel reports the key as that agent's identity (`exclusive`);
  otherwise a system notice, never another agent. No name line.
- **Sends and rosters per bot**: the providers declare `asChannelKey` and post
  through exactly the bot named (unknown key: unreachable); `presentIn` tells
  the kernel which agent bots can see a channel.
- **Triggers and routines deliver through the bot they were set on** (spec
  2042 §5.12): every turn opens the kernel's routines scope
  (`routinesIntegration@1`, optional) with a delivery ref naming the conversation and,
  on an agent's own bot, that bot (`asChannelKey`); the proactive send posts
  through exactly that bot (no name line on an agent's bot, named like an
  answer on the installation's). A bot that no longer runs here is an error.
  These turns never become a person's Conductor reminder target
  (`conductorBinding: false`), and the proactive send is removed when the
  channel closes.
- **`compat.core` `>=1.79.0 <2.0`**: needs the kernel with agent channel
  identities (plugin-api 1.79.0, S7).

## 0.2.0

Agents as virtual employees (omadia epic #2042, issue #5). Needs the omadia
kernel of #2045 / #2086 / #2087 (speaker, decoration registry, AI disclosure
setting); do not publish before that kernel runs.

- Answers are rendered by the channel SDK's plain-text renderer: a name line
  only where the speaker would be unclear (several agents in one conversation),
  colleagues' contributions as "Mira: ...", `system` notices as their own text,
  cards as numbered text. A typed number answers a numbered question.
- Removed every undeclared decoration: the eyes reaction on each received
  message (typing indicator instead), choice and follow-up buttons, the
  "you can also ask" list, the disclaimer line and the privacy receipt. The
  AI disclosure line stays, as the kernel folds it into the text by the
  operator's frequency setting. The invite URL no longer asks for the Add
  Reactions permission (existing invites keep it).
- New slash commands `/agent [name]` and `/agents`. The channel passes the text
  (`/agent Mira`, `/agent` clears the choice, `/agents` lists) on unchanged,
  like anything typed; the ChatAgent the kernel's channel resolver returns
  carries it out and answers with a `system` notice. The channel has no
  `agentSelection` call, no command parser and no `optional_requires` entry
  for it (S1 contract, kernel #2055 / epic #2042).
- Routing follows the S1 contract: `reject` (there is no `fallback`) still
  hands the text to the ChatAgent the resolver returns, which answers with the
  kernel's `system` notice, so `/agent` works even with nothing bound; an
  answer to a reject that is not from `system` is replaced by the notice. A
  channel resolver that throws is a `system` text, never another agent. With
  nothing bound, `/agent` is answered by the conversation's key (its own
  selection), not the server's.
- The agent is resolved under the NARROWEST conversation key only, through the
  SDK's `resolveChannelRoute`: the channel id, the thread's own id in a thread.
  The earlier second probe of the server id is gone (S1: the selection hangs on
  the `channelKey` of the resolve call, and a probe of the server would store
  `/agent` server-wide): a binding made on a whole server no longer applies,
  bind the channel or thread instead. The shared `chatAgent@1` is asked only on
  a host with no channel resolver; with one it is never used, also not after a
  reject (S1: it refuses non-canvas turns).
- The sender's language (`de`/`en`) goes to the resolver: the slash command's
  locale, else the server's preferred locale; a DM without a slash command has
  none and is left out, so notices come in German.
- The sender is `channelUserPrincipal({kind: 'discord-user', id})` from the SDK
  (`user:discord-user:<snowflake>`, or `user:<email>` when the channel ever
  carries a verified address), the one principal form for every channel, in
  the resolver context and in the turn origin.
- An answer without a speaker is no longer sent with a warning: the kernel
  stamps every answer (INV-4), so a missing speaker is a contract violation.
  The text is not posted (fail closed, nobody can be named for it); the user
  gets a `system` notice and the log an error.
- Pace: typing indicator refreshed every 8 s, one acknowledgement after 8 s of
  work, and a slash command that outlives its 15 minute interaction token is
  answered as a normal channel message. The acknowledgement is the resolved
  agent's own words and goes out under its speaker, no longer as `system`
  (without a known speaker nothing is posted).
- Kernel-initiated sends: a targeted-send provider (DM to one person, by
  `user:discord-user:<id>`) and a conversation-send provider (post into a
  channel or thread), plain text. They declare no own identity (one bot), no
  poll and no question card (the kernel posts those as numbered text itself); a
  request naming an identity, a poll or a card is refused with a named outcome
  and nothing is posted. The id of the posted Discord message is reported as
  `messageId`. DMs respect *Allow DMs* and the allowlist.
- Received messages are reported to the kernel as `created` events through
  `core.emitConversationMessage` (feature-detected): conversation = channel id
  (a thread's own id), author `discord-user`, text without the bot mention,
  `replyToMessageId` for a reply, `addressedToBot` for a mention, a reply that
  pings the bot, or a DM, receiving identity `discord-app:<application-id>`. Sent before
  the mention gate (a typed answer need not mention the bot) and not for a
  person off the allowlist or in a server the bot is switched off in. The
  kernel stores them only for a subscription and turns a typed reply to a
  numbered question into the `card_answer` (kernel #2086).
- A message that would start a turn is reported with
  `core.reportConversationMessage` and awaited before the turn: when the kernel
  consumed it as the typed answer to an open question (`answeredCard`), no turn
  starts (no acknowledgement, no agent reply). The wait is capped at 1.5 s; a
  timeout or error is logged and the turn runs as before. Without the method
  the message is emitted and the turn runs, as before.
- Group channels: the turn states `conversationType` (`direct` / `group`) and
  the sender in its origin, and the plugin registers a conversation roster
  provider (DM complete; server channel complete with the new
  `guild_members_intent` setting, otherwise unknown; servers over 5,000
  members partial).
- New setting `guild_members_intent` (privileged Server Members intent).
- `compat.core` is `>=1.75.0 <2.0`, a placeholder floor for the kernel release
  with the S1 routing contract; the release session sets the final version.
- One bot per agent is not supported; the README says why and what it would
  cost an operator.
- Tests (`npm test`, `node --test` with `tsx`).

## 0.1.5

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-discord` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
