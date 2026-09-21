# ADR-0005: LLM provider boundary is HTTP-only (no SDK lock-in inside the domain)

- **Status**: accepted
- **Date**: 2026-09-21
- **Deciders**: project lead (@rebuildup)

## Context

The release scope states: "Specific LLM provider を u-sekai の domain model
そのものにはしないでください。" The Reasoner is a load-bearing concept; it
must remain substitutable so we can:

- ship a deterministic scripted Reasoner for CI,
- run a real Reasoner against at least one HTTP API for live smoke,
- swap providers later without rewriting the participant runtime.

If the domain or participant runtime directly imports a proprietary SDK,
both the dependency tree and the conceptual model get locked in.

## Decision

Reasoner interactions are defined behind a small interface in
`src/reasoner/interface.ts`. No file inside `src/domain/` may import any
third-party LLM SDK, Playwright, or any future provider-specific package.

Provider adapters live under `src/reasoner/providers/`:

| Provider | Transport | Notes |
| --- | --- | --- |
| `scripted.ts` | in-process | Deterministic scripted Reasoner used by CI. |
| `anthropic.ts` | `fetch` to `POST https://api.anthropic.com/v1/messages` | Reads `process.env.ANTHROPIC_API_KEY` at construction time only. |

Rules:

- Providers translate domain `ReasonerRequest` -> provider-native JSON, then
  translate the response back to `ReasonerResponse` without leaking
  provider-specific shapes upward.
- API keys, model ids, and other provider config are read from
  environment variables. They never appear in the artifact output.
- A Reasoner that needs tool use / function calling exposes an internal
  `tools` schema but never forwards provider-specific tool names; callers
  identify tools by u-sekai ids.

## Consequences

Positive:

- Domain layer stays vendor-neutral. Swapping the Anthropic provider for an
  OpenAI-compatible one is a new file under `src/reasoner/providers/`.
- Tests never touch the network when they use the scripted provider.
- Provider SDK lock-in does not leak into the artifact schema.

Negative / trade-offs:

- We re-implement the parts of the API our adapters need (HTTP request
  shape, retry policy, error mapping). This is bounded because the adapter
  surface is small.
- Manual smoke against a real API requires `ANTHROPIC_API_KEY` to be
  present; CI never has it.

Operational:

- `.eslintrc/eslint.config.js` enforces `no-restricted-imports` inside
  `src/domain/**` and inside `src/capability/**`.
- `.github/workflows/ci.yml` does **not** set `ANTHROPIC_API_KEY`.
- A separate workflow `manual-live-smoke.yml` is `workflow_dispatch` only
  and expects the secret to be configured.

## Alternatives considered

- **Adopt `@anthropic-ai/sdk` directly**: rejected — locks in a vendor and
  risks domain-layer drift.
- **Adopt a unified LLM client library** (`ai`, `langchain`, etc.):
  rejected — same vendor-lock concern, plus extra abstraction overhead.
- **Generate SDK bindings from OpenAPI**: rejected at 0.1.0 — single
  provider is enough; revisit in 0.2.x if needed.

## References

- [Issue #16](../../.github/../issues/16)
- [Issue #18](../../.github/../issues/18)
- [`CLAUDE.md`](../../CLAUDE.md) Section 3 (no premature adoption).
