# ADR-0006: Capability model — observation / action / memory as runtime-enforced boundaries

- **Status**: accepted
- **Date**: 2026-09-21
- **Deciders**: project lead (@rebuildup)

## Context

The release scope demands that two Synthetic Users on the same environment
be different **at the runtime layer**, not just at the prompt layer. In
particular:

- A Synthetic User must not be able to "see" privileged DOM, ARIA tree,
  full document HTML, hidden metadata, or selector-path internals unless its
  capability profile explicitly grants it.
- A Synthetic User must only be able to issue the narrow set of
  human-facing action primitives its capability profile grants.
- The Reasoner input to each step must be derived from a memory window the
  participant runtime controls (full vs. limited recent), independently of
  what the Reasoner might claim to "remember".

The decision has to live in code as well as in prompts; a "forget it"
prompt is explicitly called out as insufficient.

## Decision

We adopt a three-axis capability model. Each participant profile carries
an explicit value on every axis, and the participant runtime checks every
axis per step.

| Axis | Values | Enforced where |
| --- | --- | --- |
| Observation | `visual`, `visualPlusAria`, `fullDom` | `src/capability/observation-filter.ts` |
| Action | `visualOnly` (coords / type / scroll / wait / finish) | `src/capability/action-allowlist.ts` |
| Memory | `fullHistory`, `limitedRecent{N}` | `src/capability/memory-controller.ts` |

Rules:

- The browser adapter produces **two** observation views: a participant view
  (already filtered) and an observer view (full). The participant runtime
  only ever sees the participant view.
- The action allowlist is checked before any primitive reaches the
  adapter. Violations throw `CapabilityViolation`.
- The memory controller is the **only** path that builds the Reasoner
  request. Reasoners see the request, never the underlying event log.
- The same Reasoner provider can be used for two participants configured
  with different capability profiles; differences are observable in the
  per-step Reasoner request payload (asserted by tests).

## Consequences

Positive:

- "Two participants, two real differences" is provable by inspecting the
  per-step Reasoner request payload rather than relying on a prompt-level
  claim.
- Capability violations are machine-detectable, so we can record them as
  evidence, not just log lines.

Negative / trade-offs:

- We have to keep two parallel observation views (participant / observer),
  which doubles some serialisation. The cost is small at 0.1.0 scale and
  is isolated to the adapter layer.
- More capabilities (e.g. `highContrastTheme`, `motionReduced`,
  `keyboardOnly`) are deliberately deferred; the model is extensible but
  we do not pre-build slots.

Operational:

- A capability violation thrown by the participant runtime is recorded as
  a typed event in `events.ndjson` and used to terminate the loop with
  `terminationReason: 'capabilityViolation'`.

## Alternatives considered

- **Pure prompt-only enforcement**: rejected — explicitly excluded by the
  release scope.
- **Capability as a runtime sandbox (WASM, microkernel)**: out of scope at
  0.1.0; revisit if advanced safety analysis is required.
- **Capability per-step negotiation**: rejected — too dynamic; the release
  scope calls for stable profiles.

## References

- [Issue #16](../../.github/../issues/16)
- [Issue #17](../../.github/../issues/17)
- [Issue #18](../../.github/../issues/18)
