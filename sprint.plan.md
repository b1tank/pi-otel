# Sprint plan

Scope: “these” refers to the remaining priorities identified immediately before this sprint.

## Prioritized tasks

1. [x] Safely migrate existing `pi-otel` settings by adding only missing known defaults; preserve user values and unrelated settings.
2. [ ] Complete signal-specific OTLP endpoint/header resolution and validate unsupported signal/protocol configuration independently.
3. [ ] Add focused tests for settings precedence, capture gates, and exporter disablement.
4. [x] Evaluated subprocess parent-trace propagation; no generic supported hook is exposed to inject environment variables into arbitrary tools/subagents safely, so record as deferred.
5. [ ] Perform a Pi 0.87.x + OTLP collector smoke test if the environment permits; record any unavailable prerequisites.

## Hiccups & Notes

- Initial typecheck caught a missing recursive helper return annotation; fixed before commit.
- Subagent propagation deferred: Pi exposes tool lifecycle events, but no general subprocess environment mutation hook. Wrapping arbitrary commands would be unsafe and provider-specific.

- Starting tree contains uncommitted implementation changes from earlier work in this conversation. Preserve and carry those changes forward; avoid overwriting them.
- Manual smoke test may be blocked by unavailable collector/provider credentials or CLI setup; do not delay remaining work.
