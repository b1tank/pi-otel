# Sprint plan

Scope: “these” refers to the remaining priorities identified immediately before this sprint.

## Prioritized tasks

1. [x] Safely migrate existing `pi-otel` settings by adding only missing known defaults; preserve user values and unrelated settings.
2. [ ] Complete signal-specific OTLP endpoint/header resolution and validate unsupported signal/protocol configuration independently.
3. [ ] Add focused tests for settings precedence, capture gates, and exporter disablement.
4. [x] Evaluated subprocess parent-trace propagation; no generic supported hook is exposed to inject environment variables into arbitrary tools/subagents safely, so record as deferred.
5. [x] Completed a real Pi 0.87.0 / Node 24.19.0 turn against a temporary local OpenAI-compatible mock provider and OTLP/HTTP receiver. The mock returned a `read` tool call and a final answer; Pi exited successfully and exported logs, traces, and metrics.

## Hiccups & Notes

- Initial typecheck caught a missing recursive helper return annotation; fixed before commit.
- Subagent propagation deferred: Pi exposes tool lifecycle events, but no general subprocess environment mutation hook. Wrapping arbitrary commands would be unsafe and provider-specific.
- First smoke attempt used the built-in OpenAI provider and failed with the dummy key; workaround was an isolated `$PI_CODING_AGENT_DIR/models.json` custom provider pointed at a local mock server.
- Successful smoke: two provider requests (tool call + final answer), output `E2E-LOCAL-OK`, no stderr, and nonempty exports at `/v1/logs` (14,212 B), `/v1/traces` (14,026 B), `/v1/metrics` (7,160 B). No external credentials or collector were needed.
- `npm run build` is not defined: the package runs raw TypeScript. Used `npm run typecheck` and `npm test` as the build/regression checks instead.

- Starting tree contains uncommitted implementation changes from earlier work in this conversation. Preserve and carry those changes forward; avoid overwriting them.
- Manual smoke test may be blocked by unavailable collector/provider credentials or CLI setup; do not delay remaining work.
