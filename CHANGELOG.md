# Changelog

## 0.1.5

- Declare the capabilities this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-discord` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` under
  `requires:` (provided by `@omadia/orchestrator`); `channelResolver@1`
  under `optional_requires:` (kernel-published, absence survivable).
