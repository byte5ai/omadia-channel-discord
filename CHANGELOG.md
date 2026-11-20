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
- New slash commands `/agent [name]` and `/agents`. The text (`/agent Mira`,
  `/agent`, `/agents`) is carried out by the kernel's agent-selection service
  (kernel #2055) and confirmed by a `system` notice. Without that service the
  text flows on as an ordinary message.
- Routing is fail-loud: a binding the kernel rejects (agent disabled, deleted,
  not available to the sender, nothing bound) is answered with the kernel's
  `system` notice instead of falling back to the default agent. The sender
  (`user:discord-user:<id>`) and locale are passed to `channelResolver`.
- Pace: typing indicator refreshed every 8 s, one acknowledgement after 8 s of
  work, and a slash command that outlives its 15 minute interaction token is
  answered as a normal channel message.
- Group channels: the turn states `conversationType` (`direct` / `group`) and
  the sender in its origin, and the plugin registers a conversation roster
  provider (DM complete; server channel complete with the new
  `guild_members_intent` setting, otherwise unknown; servers over 5,000
  members partial).
- New setting `guild_members_intent` (privileged Server Members intent).
- One bot per agent is not supported; the README says why and what it would
  cost an operator.
- Tests (`npm test`, `node --test` with `tsx`).

## 0.1.5

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-discord` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
