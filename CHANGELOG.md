# Changelog

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
  poll and no question card; a request naming an identity, a poll or a card is
  refused with a named outcome and nothing is posted. DMs respect *Allow DMs*
  and the allowlist.
- Group channels: the turn states `conversationType` (`direct` / `group`) and
  the sender in its origin, and the plugin registers a conversation roster
  provider (DM complete; server channel complete with the new
  `guild_members_intent` setting, otherwise unknown; servers over 5,000
  members partial).
- New setting `guild_members_intent` (privileged Server Members intent).
- `compat.core` is `>=1.74.0 <2.0`, a placeholder floor for the kernel release
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
