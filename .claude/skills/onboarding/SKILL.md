---
name: onboarding
description: Onboarding and repository-controlled knowledge design for u-sekai. Use when designing / auditing docs so that a fresh contributor or fresh agent can reconstruct project state without chat history or private memory.
---

# onboarding

## Purpose

Make sure a fresh contributor or fresh agent in u-sekai can — without chat history or private memory:

- Understand the project
- Distinguish what is decided from what is undecided
- Decide their next action (open an Issue / join discussion / improve docs)

**using only repository-controlled docs**.

## Required reachability

Within **3 hops** from a fresh clone, the following must be reachable:

1. Project purpose / non-goals / current phase
2. Active research targets (Issue list) and their dependencies
3. Decided items (`docs/adr/` when present) vs. undecided items (`docs/research-issues/`)
4. How to contribute / join the discussion
5. Branch / PR / release workflow (at minimum: "docs / Issue / template improvements are the current target")
6. Project-local policy for AI coding agents

## Required docs (currently present)

| File | Role |
| --- | --- |
| `README.md` | project purpose / non-goals / current phase |
| `CONTRIBUTING.md` | contribution policy / Issue workflow / language policy / merge authorization |
| `CLAUDE.md` | dispatcher for AI agents, with progressive disclosure to Skills |
| `.claude/skills/` | per-topic Skills (only what the phase needs) |
| `docs/research-issues/` | draft research questions |
| `docs/rebuildup-pin.md` | pinned rebuildup/project-init source |
| `.github/ISSUE_TEMPLATE/` | Issue templates |

## Do not

- Leave empty placeholders ("TBD", "implemented later", "see chat") as if they were decisions.
- Describe undecided items as "planned specification".
- Depend on hidden knowledge (private memory / chat history / machine-specific configuration).
- Start an ADR before the conclusion is settled. ADRs are decisions, not investigation journals.
- Introduce CI / linter / formatter / type-check while implementation has not started.

## Currently NOT created (intentional)

> The list below is "create when needed", not "create now". Create each only via an explicit Issue.

- `docs/architecture.md` — once architecture decisions land
- `docs/development.md` — once development workflow is established
- `docs/troubleshooting.md` — once operational learnings accumulate
- `docs/release.md` — once the release workflow is enabled
- `docs/security.md` — once the security workflow is enabled
- `docs/adr/ADR-XXXX.md` — once the first ADR is warranted

## Doc-update responsibility

- A related Issue / PR must update related docs in the **same ticket**.
- Do not split doc updates into separate Issues (they get forgotten).
- Mention "docs updated" in the PR description when relevant.

## International audience

u-sekai is internationally oriented. Public-facing docs are written in English. See [`docs/rebuildup-pin.md`](../../docs/rebuildup-pin.md) for the language override against the pinned upstream policy.