# ADR-0008: Reasoner structured-output failure taxonomy and bounded recovery

- **Status**: accepted
- **Date**: 2026-09-22
- **Deciders**: project lead (@rebuildup)

## Context

The Reasoner speaks JSON. At 0.1.0 the runtime trusted that contract in
three different ways at once, and all three failed silently:

- `src/reasoner/providers/anthropic.ts` coerced any extracted JSON object
  into a `ParticipantAction` with a bare cast. An unparseable turn became
  a `refusal`; an unparseable self-report or observer turn escaped as a
  bare `Error`.
- `src/participant/runtime.ts` recorded a `capability.violation` event
  whenever the response kind was not `action`, and again whenever
  `isParticipantAction()` returned false. `isParticipantAction()` only
  sniffed the `kind` string, so `{"kind":"teleport"}` and
  `{"kind":"clickByCoords","x":"left","y":2}` were both reported as
  participant capability violations.
- `src/observer/runtime.ts` and the self-report path coerced arbitrary
  content into reports (`unparseable finding`, `severity: 'info'`,
  `observer declined to produce findings`, `selfReport unavailable`)
  without recording any evidence.

A provider glitch was therefore indistinguishable, in the artifact and
in `result.json`, from a Synthetic User trying to reach a privileged
primitive. That distinction is the core of the capability model
([ADR-0006](ADR-0006-capability-model-observation-action-memory.md)):
a capability violation is a statement about the *participant*, and it must
not be forgeable by a malformed response.

## Decision

### 1. One boundary, one taxonomy

`src/reasoner/structured.ts` is the only place a raw provider payload
becomes a typed domain value. It covers all three structured outputs —
`action`, `selfReport`, `observerFindings` — and classifies every failure
into exactly one of four mutually exclusive kinds:

| Failure kind | Meaning | Recoverable |
| --- | --- | --- |
| `providerTransport` | The provider itself failed: network error, timeout, non-2xx HTTP. | Only for transient conditions (see 3). |
| `providerParse` | A response arrived but no JSON object could be extracted from the assistant text. | Yes. |
| `contractValidation` | JSON was extracted but violates the declared contract for that response kind. | Yes. |
| `capabilityViolation` | The parsed action itself attempts a privileged primitive. | No. |

The first three are raised as `StructuredOutputError`, a new domain error
carrying `failureKind`. `capabilityViolation` continues to be raised as
`CapabilityViolation` (ADR-0006). `CapabilityViolation` is never reused
for a parse or contract failure, and `StructuredOutputError` is never
raised for a capability violation.

### 2. Only a genuinely capability-violating action produces `capabilityViolation`

A parsed object is a `capabilityViolation` **only** when its `kind` is one
of the four recognised privileged primitives: `selectorClick`,
`evaluateJs`, `getDomTree`, `readInternalMetadata`. A privileged `kind`
stays a violation even when its payload is malformed, because the intent
is unambiguous.

Every other structural defect — an unknown `kind`, a missing `kind`
discriminator, a wrong response kind, a missing required field, a
stringly-typed coordinate, an out-of-range value, an unknown enum member —
is `contractValidation`. `isParticipantAction()` was replaced by a real
schema check (`describeParticipantActionDefect`) rather than a `kind`
string sniff, and `admitParticipantAction()` gives the runtime an explicit
three-way answer: `admitted` / `capabilityViolation` / `contractInvalid`.

Runtime validation is the enforcement mechanism. System prompts are
documentation for the model, not the source of truth, and were not
strengthened to compensate. The prompt markers that select which contract
applies now live in the boundary module and are imported by the
system-prompt builders, so prompt text and contract selection cannot
drift apart.

### 3. Bounded recovery

Recovery is a policy, not a loop:

```ts
{ maxAttempts: 2, retryOn: ['providerTransport', 'providerParse', 'contractValidation'],
  backoffMs: 250, maxTotalMs: 30_000, attemptTimeoutMs: 15_000 }
```

- `maxAttempts` counts the first attempt. It is clamped to `[1, 8]`, so a
  misconfigured policy cannot create an unbounded loop.
- `providerParse` and `contractValidation` are always retried.
- `providerTransport` is retried only when genuinely transient: no HTTP
  status (network error or timeout), HTTP 429, or HTTP 5xx. A 4xx such as
  400 / 401 / 403 / 404 is a deterministic client error and fails
  immediately.
- `capabilityViolation` is never retried, regardless of `retryOn`.
- `maxTotalMs` bounds the whole sequence and `attemptTimeoutMs` bounds
  one attempt, so a pathological provider cannot stall a run. The
  per-attempt budget is enforced with an `AbortSignal` handed to the
  Reasoner, not by promise races.
- Exhaustion is a terminal, correctly classified outcome. There is no
  silent fallback action.

The deterministic `scriptedReasoner` emits contract-valid content, so it
never triggers a retry and CI behaviour is unchanged.

### 4. Typed, persisted evidence

`RunEvent` gains `reasoner.failure`, one event per failed attempt:

```text
type, runId, ts, outputKind, channel, failureKind, provider, modelId,
attempt, maxAttempts, retryable, willRetry, recoveryOutcome, message,
participantId?, stepIndex?, httpStatus?, excerpt?
```

`recoveryOutcome` is `recovered` when a later attempt in the same
sequence succeeded and `exhausted` otherwise, so **retry-success and
retry-exhaustion are distinguishable from `events.ndjson` alone** — no
correlation with surrounding events is required.

`TerminationEvent.reason` and `ParticipantRuntimeResult.terminationReason`
gain `reasonerFailure`: a terminal state for an exhausted or
non-retryable Reasoner failure, distinct from `capabilityViolation`. The
existing `finish`, `stepBudgetExceeded`, `capabilityViolation`, and
`error` values are unchanged.

`BehavioralEvidence` gains `reasonerFailures`, so a run's real failure
mode is diagnosable from `result.json` without re-reading the event log.
`runtimeErrors` keeps its meaning: runtime-enforced capability violations
only.

Unavailable reports are self-describing rather than silent. An observer
that cannot produce findings reports the failure kind and states that the
run produced no usability signal. A self-report that cannot be produced
sets `freeText` to say it was a provider/contract failure after N
attempts, explicitly not participant silence, and still writes a
`selfReport.response` event.

### 5. Diagnostics stay bounded and credential-free

No HTTP header, request body, or API key is ever persisted. A provider
error body is kept only as an excerpt capped at 200 characters, with
control characters stripped and credential shapes redacted: labelled
fields (`x-api-key: …`, `authorization: …`), `sk-…` keys,
`Bearer`/`Basic` tokens, hyphen/underscore-joined opaque tokens of key
length, and long unbroken alphanumerics. Provider errors therefore
cannot echo a credential into the artifact. The API key is still read
only from `process.env`, or from an explicit injection point used by
tests.

## Consequences

Positive:

- A malformed response can no longer forge a capability violation, in
  evidence or in `result.json`.
- A real-model run that degrades because of a provider problem is
  diagnosable from the artifact alone, and distinguishable from a run
  that degraded because a participant tried to exceed its capabilities.
- Exhaustion is a bounded, correct, explicit terminal state rather than a
  silent substitution.
- The provider boundary stays HTTP-only and provider-neutral (ADR-0005);
  a new provider reuses the taxonomy instead of inventing a mapping.

Negative / trade-offs:

- Strict validation makes a real model that omits a required field fail
  the turn instead of degrading. That is intentional: the alternative is
  silently invented data in the report, which would be worse research
  evidence. Recovery retries once before giving up.
- Observer findings and self-reports lost their silent coercion. A
  malformed finding is now a visible contract failure rather than an
  `unparseable finding` placeholder.
- The taxonomy adds one error type and one event type to the domain
  surface.

Operational:

- The event type and the `reasonerFailure` termination reason are part of
  the artifact contract in
  [ADR-0007](ADR-0007-run-artifact-structure.md) and are listed in
  `docs/architecture.md`.
- Provider adapters are testable hermetically through an injected
  transport; CI never needs a credential.
- Manual live smoke against a real API is the only way to observe the
  path end to end with real model output, and it still requires
  `ANTHROPIC_API_KEY`.

## Alternatives considered

- **Treat every unusable response as a capability violation**: rejected —
  this is the defect being fixed. It makes the capability model
  unauditable.
- **Unbounded retry with backoff**: rejected — a failing provider would
  stall a run indefinitely and a 401 would be retried forever.
- **Prompt-only enforcement ("reply with valid JSON only")**: rejected —
  it cannot produce typed evidence and cannot be relied on.
- **A schema library (zod, valibot) for the contracts**: rejected at
  0.2.0 — the three contracts are small, the dependency would be the
  only runtime one, and hand-written checks keep the failure message
  useful in the artifact. Revisit if the contract surface grows.
- **One `RunEvent` variant for a whole recovery sequence**: rejected — it
  would hide the per-attempt count that distinguishes recovered from
  exhausted.
- **Dropping the reasoner's `refusal` variant**: rejected for now — a
  refusal on the action channel is now a recoverable
  `contractValidation`, but the variant remains part of the domain union
  for third-party Reasoners.

## References

- [Issue #24](../../.github/../issues/24)
- [Issue #23](../../.github/../issues/23)
- [`ADR-0005`](ADR-0005-llm-http-only-no-sdk-lock-in.md) — HTTP-only
  provider boundary.
- [`ADR-0006`](ADR-0006-capability-model-observation-action-memory.md) —
  capability model and the three runtime-enforced axes.
- [`ADR-0007`](ADR-0007-run-artifact-structure.md) — artifact layout and
  the `events.ndjson` event contract.
