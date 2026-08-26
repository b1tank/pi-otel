# Contributing to pi-otel

Keep the extension passive, vendor-neutral, and compatible with OpenTelemetry semantic conventions. Do not add a backend-specific dependency to Pi core behavior.

Before submitting a change:

```bash
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

Add focused tests for signal shape, sanitization, configuration, failure classification, and exporter isolation. Never commit real prompts, tool output, credentials, headers, local paths, or production telemetry.

By contributing, you agree that your contribution is licensed under the MIT License.
