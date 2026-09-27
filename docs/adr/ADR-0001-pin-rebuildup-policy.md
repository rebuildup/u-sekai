# ADR-0001: Use `project-init@release-0-3-0` as the governance baseline while Skills track current upstream

- **Status**: accepted
- **Date**: 2026-09-15
- **Updated**: 2026-09-25 — reconciled to `release-0-3-0`
- **Deciders**: project lead (@rebuildup)

## Context

u-sekai needs a project-local AI coding agent policy and a weekly release
sprint / Draft PR / stacked PR workflow. The [`rebuildup/project-init`](https://github.com/rebuildup/project-init)
repository is a maintained meta-policy that captures these rules.

The upstream project evolves on `main`. Constitution / Operating Model
changes can alter authority and workflow semantics, so those changes need an
explicit project reconciliation. Agent Skills are different: they are
progressively disclosed operational playbooks and should receive upstream
fixes continuously unless a Skill is explicitly frozen.

## Decision

u-sekai uses the following revision as its **governance baseline**:

| Field | Value |
| --- | --- |
| Branch / ref | `release-0-3-0` |
| Baseline commit SHA | `57fb4a2e5abe6f52e4fd9cb2cb88234496e47d4b` |
| Local clone | `.tmp/project-init/`(gitignored) |
| Refresh command | `git clone --branch release-0-3-0 --depth 1 https://github.com/rebuildup/project-init.git .tmp/project-init` |

The pin is recorded in [`docs/rebuildup-pin.md`](../rebuildup-pin.md).

Agent Skills are not frozen to this revision. They are managed project-locally
through `bunx skills`, tracked by `skills-lock.json`, installed into
`.agents/skills/` and `.claude/skills/`, and normally refreshed with
`bunx skills update -p -y`.

## Consequences

Positive:

- Governance changes remain reviewable against a known baseline.
- Skill fixes and new operational guidance do not wait for a governance-version bump.
- `skills-lock.json` records the installed Skill source/content state without turning it into a permanent freeze.

Negative / trade-offs:

- Governance baseline upgrades remain explicit.
- Skill updates can still require reconciliation when project-local customization exists.

Operational:

- Do not silently replace the governance baseline.
- For Skills, use the project-local Skills CLI lifecycle instead of copying from the baseline clone.
- See [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`CLAUDE.md`](../../CLAUDE.md), and `mise.toml`.

## Alternatives considered

- **Track `main` for governance automatically**: rejected — authority changes would drift silently.
- **Freeze Skills with governance**: rejected — blocks continuous Skill fixes/updates.
- **Track a floating tag**: rejected — tags can be moved.
- **Fork upstream**: rejected — unnecessary divergence; the upstream project
  already accepts well-argued changes.

## References

- [`docs/rebuildup-pin.md`](../rebuildup-pin.md)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- [`CLAUDE.md`](../../CLAUDE.md) (Section 8 — Skill discovery)
- Upstream: <https://github.com/rebuildup/project-init/tree/release-0-3-0>