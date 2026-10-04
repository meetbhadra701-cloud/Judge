# Event Context fixtures (synthetic)

Recorded extractions used by tests and the local demo through the **replay extractor**
(`createReplayExtractor` in `@judge-copilot/context`). All text is synthetic. None of it is
real event material.

A recording pairs source texts with the structured extraction an extractor produced for them.
Source references use each source's `ref` name. Replay matches a request only when its sources
exactly equal a recording's sources (authority plus SHA-256 of the normalized text), so replay
performs no semantic analysis.

| File                           | Scenario                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `a-clear-official-rubric.json` | explicit dates, weighted rubric, clear prior-work policy, one track                                 |
| `b-ambiguous-policy.json`      | prior work and judging format unstated (`unclear`), unweighted rubric                               |
| `c-conflicting-authority.json` | official rule vs. lower-authority judge note; the official rule wins and the conflict stays visible |
| `d-malformed-rubric.json`      | weights sum to 1.1: can be drafted, cannot lock                                                     |
| `e-multiple-tracks.json`       | overall rubric, two tracks with requirements, one track rubric                                      |
