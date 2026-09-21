# u-sekai architecture

```
                   ExperimentDefinition (JSON)
                                |
                                v
                          runExperiment
              +------------+----------+------------+
              |            |          |            |
              v            v          v            v
        (participant 1)        (participant 2) ...
        +-- runParticipant --+    +-- runParticipant --+
        |   capability       |    |   capability       |
        |   runtime loop     |    |   runtime loop     |
        |   self-report      |    |   self-report      |
        +---------+----------+    +---------+----------+
                  \                       /
                   \                     /
                    v                   v
                EvidenceRecorder (in-memory during run)
                          |
                          v
                  Observer (separate context)
                          |
                          v
                  RunResult + artifact tree on disk
```

## Capability model (ADR-0006)

Three orthogonal axes, enforced at the runtime layer:

- `observation`: `visual` (default) or `visualPlusAria`.
- `action`: `visualOnly` (the only value in the current functional MVP). Six human-facing
  primitives: `clickByCoords`, `tapByCoords`, `typeText`, `scroll`,
  `wait`, `finish`.
- `memory`: `fullHistory` or `limitedRecent{N}`.

Each axis is checked in its own module; a violation is recorded as a
typed event in `events.ndjson` (see `evidence-events`).

## Reasoner boundary (ADR-0005)

The participant runtime never imports a third-party LLM SDK. Provider
adapters live under `src/reasoner/providers/` and translate domain
`ReasonerRequest` -> provider-native JSON. CI uses
`scriptedReasoner`, which is fully deterministic.

## Artifact layout (ADR-0007)

See README "Output artifact" section.

## Non-facts that we explicitly reject

- A participant can never reach a privileged action shape
  (`selectorClick`, `evaluateJs`, `getDomTree`, ...) — the runtime
  refuses before any adapter call.
- Synthetic Users are not real users. The current observation layer is
  not a substitute for usability testing with human participants.
- We do not silently fold three signals (participant / observer /
  evidence) into a single scalar. They live in three separate files.
