# @judge-copilot/domain

**Layer 1.** The domain vocabulary every business package speaks. Types are inferred from
`@judge-copilot/schemas` and re-exported (one definition per concept), plus lifecycle
classifications (frozen Event Context statuses, terminal run/snapshot states) that the database
also enforces. Pure: no I/O, environment, database or model access.
