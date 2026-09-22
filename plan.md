# Remaining work

Core configuration, bootstrap/migration, OTLP signal resolution, capture gates, and the prompt/tool/response export flow are implemented and tested.

## Open items

- [ ] Add a concise README verification walkthrough using an OTLP collector.
- [ ] Extend the Pi 0.87.x smoke test to cover retry, compaction, session switch, and shutdown behavior beyond the existing prompt/tool/response flow.
- [ ] Revisit subagent parent-trace propagation only if Pi exposes a safe, supported subprocess/environment handoff. Do not wrap arbitrary tools to implement this.
