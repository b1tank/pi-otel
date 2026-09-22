# Sprint plan

Scope: “these” refers to the remaining priorities identified immediately before this sprint.

## Prioritized tasks

1. [x] Safely migrate existing `pi-otel` settings by adding only missing known defaults; preserve user values and unrelated settings.
2. [ ] Complete signal-specific OTLP endpoint/header resolution and validate unsupported signal/protocol configuration independently.
3. [ ] Add focused tests for settings precedence, capture gates, and exporter disablement.
4. [x] Evaluated subprocess parent-trace propagation; no generic supported hook is exposed to inject environment variables into arbitrary tools/subagents safely, so record as deferred.
5. [x] Smoke-tested Pi 0.87.0 / Node 24.19.0 with a local OTLP HTTP receiver. Extension startup/shutdown exported logs, traces, and metrics; completion of a mock provider turn remains blocked by Pi ignoring `OPENAI_BASE_URL` for the built-in provider in this setup.

## Hiccups & Notes

- Initial typecheck caught a missing recursive helper return annotation; fixed before commit.
- Subagent propagation deferred: Pi exposes tool lifecycle events, but no general subprocess environment mutation hook. Wrapping arbitrary commands would be unsafe and provider-specific.
- Smoke test reached the local collector on `/v1/logs`, `/v1/traces`, and `/v1/metrics`; mock generation failed because the built-in provider contacted OpenAI and rejected the dummy key. No real credentials were used.
- `npm run build` is not defined: the package runs raw TypeScript. Used `npm run typecheck` and `npm test` as the build/regression checks instead.

- Starting tree contains uncommitted implementation changes from earlier work in this conversation. Preserve and carry those changes forward; avoid overwriting them.
- Manual smoke test may be blocked by unavailable collector/provider credentials or CLI setup; do not delay remaining work.
