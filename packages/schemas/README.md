# @judge-copilot/schemas

**Layer 0.** Foundational Zod schemas: `Score10`, `Ratio`, `Uuid`, `Slug`, `Identifier`,
`DottedIdentifier`, and the domain vocabularies (`VerificationLevel`, `EvidenceKind`,
`EvidenceOrigin`, `QuestionMode`, `UnknownType`, `AssessmentKind`, `SourceSnapshotStatus`,
`EventContextStatus`, `AnalysisRunState`, `AnalysisRunFailureCategory`).

Each vocabulary also exports its values tuple (`*_VALUES`), which the database uses to
generate CHECK constraints. Changing a value is an architecture change.
