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

## Structured Reasoner output (ADR-0008)

`src/reasoner/structured.ts` is the only place a raw provider payload
becomes a typed domain value. It covers all three structured outputs
(`action`, `selfReport`, `observerFindings`) and classifies every failure
into exactly one of four kinds:

| Failure kind | Raised as | Retried |
| --- | --- | --- |
| `providerTransport` — network error, timeout, non-2xx HTTP | `StructuredOutputError` | only when transient: no status, 429, or 5xx |
| `providerParse` — no JSON object in the assistant text | `StructuredOutputError` | yes |
| `contractValidation` — JSON violates the declared contract | `StructuredOutputError` | yes |
| `capabilityViolation` — parsed action attempts a privileged primitive | `CapabilityViolation` | never |

Key rules:

- A `capabilityViolation` requires a recognised privileged `kind`
  (`selectorClick`, `evaluateJs`, `getDomTree`,
  `readInternalMetadata`). Every other structural defect — unknown `kind`,
  missing discriminator, wrong field type, out-of-range value — is
  `contractValidation`. `CapabilityViolation` is never reused for a parse
  or contract failure.
- Recovery is bounded: `{ maxAttempts: 2, retryOn, backoffMs: 250,
  maxTotalMs: 30_000, attemptTimeoutMs: 15_000 }`, with `maxAttempts`
  clamped to `[1, 8]`. Exhaustion terminates with
  `terminationReason: 'reasonerFailure'`, never with a silent fallback
  action and never with `capabilityViolation`.
- Runtime validation is the enforcement mechanism. System prompts
  document the contract for the model; the marker constants that select
  which contract applies are imported from the boundary so the two
  cannot drift, but prompt wording is not the source of truth.
- Each failed attempt is persisted as a `reasoner.failure` event
  carrying `failureKind`, provider, `attempt` / `maxAttempts`,
  `retryable`, `willRetry`, and `recoveryOutcome`
  (`recovered` | `exhausted`) — so retry-success and retry-exhaustion are
  distinguishable from `events.ndjson` alone. `BehavioralEvidence`
  surfaces the same data as `reasonerFailures`.
- Diagnostics are bounded and credential-free: excerpts are capped at
  200 characters with credential shapes redacted, and no HTTP header,
  request body, or API key is ever persisted.

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
