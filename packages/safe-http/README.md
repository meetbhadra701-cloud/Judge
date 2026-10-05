# packages/safe-http — SSRF-safe HTTP client

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

The only code that opens network connections for source capture. Per hop (the URL and every
redirect target): scheme/credential/port checks, IP-literal and internal-name refusal, DNS
resolution with **every** answer checked against a real IP/CIDR parser (`ipaddr.js`), and a
connection **pinned** to the validated address (custom `lookup`, original Host header and SNI).
Redirects are followed manually (≤ 5, no https→http downgrade); caller headers are dropped across
origins; no cookies, no proxy, `identity` encoding only; total timeout, body limit and
content-type allowlist. Failures are sanitized categories with allow-listed metadata.

`createFixtureNetwork` is an in-memory resolver + transport for tests and the explicitly enabled
development fixture mode (refused in production); the real policy still runs in front of it.
