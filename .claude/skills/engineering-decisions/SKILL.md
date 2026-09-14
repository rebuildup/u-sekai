---
name: engineering-decisions
description: Decision precedence and user-escalation policy for u-sekai. Use when making engineering decisions during the research / design phase, especially when the implementation language / framework / runtime is still undecided.
---

# engineering-decisions

## Purpose

State u-sekai's development-decision precedence and the conditions under which user escalation is required vs. when autonomous reversible decisions are appropriate. The research / design phase explicitly allows — and often requires — **deferring** decisions, which is itself a valid outcome.

## Decision precedence

1. **project-wide policy / canonical architecture / invariant**
   - `CLAUDE.md` / `CONTRIBUTING.md` / `README.md` / `docs/adr/` (when present)
   - Pinned rebuildup policy at `docs/rebuildup-pin.md`
2. **design / specification / explicit task instruction**
   - GitHub Issue body / user instruction / templates
3. **coherent existing implementation majority**
   - Currently a minority in this repository
4. **current official framework / runtime / SDK guidance**
   - Applies once language is decided
5. established ecosystem convention
6. local best judgment

Within the same level, prefer the more specific and newer canonical source.

## Self-evident decisions — do not escalate

Proceed autonomously when:

- The precedence yields one (or effectively one) answer
- The decision is reversible and local
- Acceptance criteria do not change
- No new public / external contract is being established
- Security / privacy / cost / release scope is not materially changed

## User escalation — only when a real decision remains

Escalate to the user only when:

- Canonical sources conflict and product semantics change
- Acceptance criteria allow materially different user-visible behavior
- The operation is irreversible / destructive
- A public / external API contract is being fixed
- Security / privacy / compliance risk must be accepted
- A meaningful cost increase is involved
- Release scope / date is changing
- An explicit design-first approval gate is requested

When asking, investigate discoverable facts first and present options, impact, and a recommendation.

## Additional rules for the research / design phase

- **Prefer "investigate one more layer" over "decide faster"**.
- Do not describe undecided items as "planned specification" in `README.md` / `docs/`.
- Compare candidates in Issues; record the conclusion as an ADR only when the **evidence** (not the choice) is settled.
- Do not write an ADR just because a single candidate was selected; ADRs require the rationale to be defensible.
- When implementation begins, re-evaluate the "current official framework / runtime / SDK guidance" level of the precedence and adopt whatever is appropriate for the chosen language.