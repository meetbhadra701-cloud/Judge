# packages/devpost — Devpost project-page snapshot adapter

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

Reads one public `https://devpost.com/software/{slug}` page through the SSRF-safe client (no
login, cookies or JavaScript) and parses title, tagline, the standard sections, built-with tags,
submitted hackathons/labels and GitHub/video/demo links deterministically. Missing sections stay
null; an unrecognizable or truncated page becomes `partial`. Links are recorded as data only and
never fetched. Artifacts: `submission.json` and `submission.txt`.
