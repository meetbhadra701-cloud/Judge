# packages/deployment — deployment observation adapter

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

One SSRF-safe GET of a declared deployment URL. Any safely obtained HTTP response — including 404
and 500 — is a `captured` observation with `metadata.httpStatus`. Transport/DNS/TLS/timeout
problems are `failed`; policy refusals are `rejected`. Records the final URL, redirects,
allow-listed headers, content type, page metadata and bounded visible text. No JavaScript, forms,
subresources, credentials, cookies or screenshots (a sandboxed browser stays deferred).
