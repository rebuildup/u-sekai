# ADR-0002: English-primary language policy (override of upstream)

- **Status**: accepted
- **Date**: 2026-09-15
- **Deciders**: project lead (@rebuildup)

## Context

The governance baseline ([`rebuildup/project-init@release-0-3-0`](https://github.com/rebuildup/project-init/tree/release-0-3-0))
defaults to Japanese for:

- Internal development docs
- GitHub Issue title / body
- PR title / body / review discussion

u-sekai is internationally oriented. The project's launch plan involves
Product Hunt and similar channels, where the audience is primarily
English-speaking. Japanese-only documentation creates friction for
international contributors and reviewers.

However, the 19 Skills under `.claude/skills/` are direct copies of the
upstream-authored Skills. Translating them risks semantic drift relative to
the governance baseline, and the rebuildup policy treats Skills as the
canonical policy contract.

## Decision

u-sekai **overrides** the upstream language convention as follows:

| Concern | Upstream default | u-sekai override |
| --- | --- | --- |
| `README.md` / `CONTRIBUTING.md` / u-sekai-authored docs | Japanese | **English** |
| GitHub Issue title / body | Japanese | **English** |
| PR title / body / review discussion | Japanese | **English** |
| `.claude/skills/*.md` (upstream-authored Skills) | Japanese | **Japanese — deliberate exception** |
| Source code | English | English (no change) |
| Commit messages | English | English (no change) |
| Branch names | identifier / version only | identifier / version only (no change) |

The Skills exception is recorded because Skills are the canonical policy
contract; translating them risks divergence from the governance baseline.
Translation policy is tracked in research issue **R-09** ([#11](https://github.com/rebuildup/u-sekai/issues/11)).

## Consequences

Positive:

- International contributors can read project docs without translation.
- README is launch-ready.
- Source code, commit messages, and other invariants stay consistent with upstream.

Negative / trade-offs:

- Skills remain in Japanese. International contributors who want to read them
  rely on machine translation or bilingual contributors. This is acceptable
  for the research / design phase and is a known follow-up.
- A future decision to translate Skills must preserve operational
  semantics with the governance baseline.

Operational:

- Any deviation from this override must be documented in a new ADR.
- The Skills exception is recorded in [`docs/rebuildup-pin.md`](../rebuildup-pin.md)
  and [`CLAUDE.md`](../../CLAUDE.md) Section 7.

## Alternatives considered

- **Translate Skills immediately**: rejected — semantic drift risk; the
  Skills are the policy contract, not user-facing documentation.
- **Use bilingual docs (English + Japanese for everything)**: rejected —
  maintenance cost; the audience is primarily English-speaking for launch.
- **Adopt upstream's default (Japanese for internal docs)**: rejected —
  misaligned with launch plan.

## References

- [`docs/rebuildup-pin.md`](../rebuildup-pin.md) — override table
- [`CLAUDE.md`](../../CLAUDE.md) — Section 7 language policy
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — language convention
- Research issue R-09 ([#11](https://github.com/rebuildup/u-sekai/issues/11))