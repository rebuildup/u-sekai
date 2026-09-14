# ADR-0001: Pin `rebuildup/project-init@release-0-1-1` as the canonical reference policy

- **Status**: accepted
- **Date**: 2026-09-15
- **Deciders**: project lead (@rebuildup)

## Context

u-sekai needs a project-local AI coding agent policy and a weekly release
sprint / Draft PR / stacked PR workflow. The [`rebuildup/project-init`](https://github.com/rebuildup/project-init)
repository is a maintained meta-policy that captures these rules.

The upstream project evolves on `main`. Pinning prevents silent drift;
referencing `main` directly means today's decisions could shift under our
feet tomorrow. The rebuildup policy itself says "explicit version pin / freeze"
is what justifies referencing a fixed revision instead of auto-reconciling
with upstream changes.

## Decision

u-sekai pins `rebuildup/project-init` at:

| Field | Value |
| --- | --- |
| Branch / ref | `release-0-1-1` |
| Pinned commit SHA | `48432a736c47f6630b8a813081e59316392c51dc` |
| Local clone | `.tmp/project-init/`(gitignored) |
| Refresh command | `git clone --branch release-0-1-1 --depth 1 https://github.com/rebuildup/project-init.git .tmp/project-init` |

The pin is recorded in [`docs/rebuildup-pin.md`](../rebuildup-pin.md).

The 14 Skills under `.claude/skills/` are direct copies from this pinned
source. They are reconciled by re-running the refresh command and re-copying
when the pin is bumped.

## Consequences

Positive:

- Reproducible bootstrap. A fresh agent can clone the pin and reconcile
  Skills against a known SHA.
- Upstream changes do not silently affect u-sekai.
- New contributors can read the pin record to understand which policy
  revision this repository follows.

Negative / trade-offs:

- We must manually upgrade the pin. New upstream improvements (e.g. new
  Skills, new ADRs) require an explicit decision.
- Drift accumulates between pin upgrades; periodic reviews are needed.

Operational:

- When the local clone's HEAD SHA differs from the pinned SHA, do **not**
  silently use the new SHA. Open an Issue to evaluate the change and
  update the pin record explicitly.
- See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`CLAUDE.md`](../../CLAUDE.md)
  for the refresh procedure and the discipline around it.

## Alternatives considered

- **Track `main`**: rejected — silent drift; reproducibility broken.
- **Track a floating tag**: rejected — tags can be moved.
- **Fork upstream**: rejected — unnecessary divergence; the upstream project
  already accepts well-argued changes.

## References

- [`docs/rebuildup-pin.md`](../rebuildup-pin.md)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- [`CLAUDE.md`](../../CLAUDE.md) (Section 8 — Skill discovery)
- Upstream: <https://github.com/rebuildup/project-init/tree/release-0-1-1>