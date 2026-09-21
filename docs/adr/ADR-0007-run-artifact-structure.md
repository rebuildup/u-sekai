# ADR-0007: Run artifact structure and writing guarantees

- **Status**: accepted
- **Date**: 2026-09-21
- **Deciders**: project lead (@rebuildup)

## Context

The release scope mandates "run ごとに再確認可能な artifact を残してくだ
さい". Subjective reports, objective evidence, and human summaries must
all live in the artifact, distinguishable from each other.

Without an explicit on-disk layout, two implementations could collide on
naming, lose ordering, or conflate participant memory with observer
inspection.

## Decision

Each `Run` writes a self-contained directory at the location given by
`--out` (default `runs/<runId>`):

```text
runs/<runId>/
  manifest.json
  participants.json
  events.ndjson
  observations/
    <participantId>/
      step-001.json
      ...
  screenshots/
    <participantId>/
      step-001.png
      ...
  self-report/
    <participantId>.json
  observer-report.json
  result.json
  summary.md
```

Files:

- `manifest.json` records: `runId`, `seed`, `experimentPath`, `reasoner`
  (`provider`, `modelId`, but **not** API key), target URL, capabilities per
  participant, `startedAt`, `endedAt`, `terminationReason`, runtime /
  package version.
- `participants.json` records the per-participant profile (capability
  triple, persona prompt, in-run memory config).
- `events.ndjson` is append-only, one event per line, with stable event
  types: `step.start`, `step.end`, `action`, `action.result`,
  `observation.captured`, `reasoner.request`, `reasoner.response`,
  `capability.violation`, `termination`, `selfReport.prompt`,
  `selfReport.response`, `observer.prompt`, `observer.response`.
- `observations/<participantId>/<step>.json` is the filtered observation
  the participant saw.
- `screenshots/<participantId>/<step>.png` is the screenshot attached to
  that observation when the adapter captured one.
- `self-report/<participantId>.json` is the participant's structured
  reflection (see [`src/domain/self-report.ts`](../../src/domain/self-report.ts)).
- `observer-report.json` is the independent observer's findings.
- `result.json` is a single machine-readable summary of the run, never a
  scalar UX score.
- `summary.md` is a human-readable mirror that must agree with
  `result.json` to within one numeric column; any disagreement is logged
  rather than hidden.

Writing guarantees:

- Files are flushed and `fsync`-ed at end-of-run.
- `events.ndjson` is line-delimited so partial reads remain coherent.
- No part of the artifact contains a `process.env.ANTHROPIC_API_KEY`
  value; provider config is referenced by name only.
- If the run is interrupted, the artifact directory may be incomplete,
  but `manifest.json.endedAt` is unset and `events.ndjson` ends with the
  last successful event type; `result.json` is **not** written in that
  case.

## Consequences

Positive:

- A reviewer can diff two runs without re-running them.
- The artifact stays self-describing; future tools can index it without
  having to call back to the runtime.

Negative / trade-offs:

- Disk writes per step add latency. The cost is acceptable at 0.1.0 scale.

Operational:

- Tests assert the artifact layout for a scripted run.

## Alternatives considered

- **Streaming everything to a single file**: rejected — loses the
  capability / participant partitioning.
- **Database**: rejected — adds an extra runtime dependency for a
  research-grade MVP.

## References

- [Issue #15](../../.github/../issues/15)
- [Issue #19](../../.github/../issues/19)
