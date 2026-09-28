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
  request body, or API key is ever persisted. Redaction is tuned so a
  message can still name the offending field.

## Two adapter paths (ADR-0009)

| | `HttpAdapter` | `PlaywrightAdapter` |
| --- | --- | --- |
| Page | fetched over HTTP, parsed as text | real Chromium page |
| Screenshot | none | PNG per step |
| Viewport / focus | synthetic constants | measured live viewport and `document.activeElement` |
| Region `selector` | synthetic region id (documented as such) | a CSS path the page resolves back to the same element, else omitted |
| Bounding boxes | synthetic, by element order | measured from the live layout |
| Used by | `npm test`, `ci.yml` | `npm run test:browser`, `browser-smoke.yml` |

Both produce the same privileged `ObserverObservation`, so the
participant runtime cannot tell them apart; only the observer view
differs. An action the page cannot perform is reported through
`ActionResult.code` (`out_of_bounds`, `selector_not_found`, `timeout`,
`unknown`) rather than as a silent success, and `observedAfter` is always
re-read from the live page after the action settles.

Browser tests live in `test/browser/**` under a separate Vitest profile
(`test/vitest.browser.config.ts`) and are excluded from `npm test`, so the
default suite stays fast and runnable with no browser installed. Install
and CI requirements: [`docs/browser-runtime.md`](./browser-runtime.md).

## Artifact layout (ADR-0007, ADR-0009)

See README "Output artifact" section. Screenshots are real PNG files under
`screenshots/<participantId>/step-NNN.png`; the observation JSON records
`screenshot: { path, sha256, byteLength }` and never inlines the bytes.
`visual.screenshotPng` is in-memory only and `visual.screenshotHash` is a
real SHA-256 over the captured bytes, so the recorded hash and the file on
disk must agree.

## Non-facts that we explicitly reject

- A participant can never reach a privileged action shape
  (`selectorClick`, `evaluateJs`, `getDomTree`, ...) — the runtime
  refuses before any adapter call.
- A participant view is a mechanical projection of the observer view, not
  a filtered copy of it. `assertNoPrivilegedLeak` checks that every key
  belongs to the participant schema and that every value equals its
  projection, so a renamed field, a nested extra, or content taken from
  the wrong source is a typed `capability.violation` rather than a leak.
- A green check that did not run is not coverage. The browser gate fails
  loudly when the browser runtime is missing instead of skipping.
- Synthetic Users are not real users. The current observation layer is
  not a substitute for usability testing with human participants.
- We do not silently fold three signals (participant / observer /
  evidence) into a single scalar. They live in three separate files.
