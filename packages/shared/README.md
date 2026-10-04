# @judge-copilot/shared

**Layer 0.** Runtime infrastructure used by the apps:

- `parseEnv` / `BaseEnv` / `ConfigError` — Zod-validated environment config that never echoes
  invalid values;
- `createLogger` / `Logger` — structured JSON logging (pino-compatible) with secret redaction and
  an allow-listed error serializer;
- `handleShutdownSignals` — one-shot SIGINT/SIGTERM handling with a hard deadline.
