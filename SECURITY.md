# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not disclose vulnerability details, credentials, prompts, tool output, source code, or raw telemetry in a public issue.

Include the affected commit, Pi version, platform, configuration, reproduction steps, and expected impact.

## Sensitive telemetry

Content capture is disabled by default. When enabled, exported telemetry may include prompts, responses, system instructions, tool arguments, command output, file contents, and local paths. Treat the configured OTLP destination as sensitive storage. Export failures are passive and must never change Pi behavior.
