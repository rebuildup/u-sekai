# aude-skills governance baseline

This document records the **governance baseline** of [`rebuildup/aude-skills`](https://github.com/rebuildup/aude-skills) (formerly `rebuildup/project-init`) used to reconcile the project-local Constitution / Operating Model.

The baseline is intentionally separate from Agent Skills distribution. Constitution / Operating Model changes are reviewed as governance changes; Agent Skills continuously track the current `rebuildup/aude-skills` source through `bunx skills` unless a future ADR explicitly freezes a Skill.

## Governance baseline

| Field | Value |
| --- | --- |
| Repository | <https://github.com/rebuildup/aude-skills> |
| Published tag | `0.3.0` (integrated from `release-0-3-0`) |
| Baseline commit SHA | `57fb4a2e5abe6f52e4fd9cb2cb88234496e47d4b` |
| Local clone | `.tmp/project-init/`(re-cloneable from the URL above) |
| Gitignore status | `.tmp/` is gitignored |

## Why the governance baseline is fixed

- Constitution / Operating Model changes can alter organizational authority and therefore are not silently imported.
- `0.3.0` resolves to the governance commit adopted by u-sekai.
- Agent Skills are **not pinned by this baseline**. Presence is not freshness evidence; `skills-lock.json` plus `bunx skills update -p -y` is the continuous-update path.

## Governance baseline refresh / verify

Clone to `.tmp/project-init/` when it is absent. For an existing checkout, verify its HEAD first and use a separate destination if a fresh copy is needed.

```bash
git clone --branch 0.3.0 --depth 1 \
  https://github.com/rebuildup/aude-skills.git \
  .tmp/project-init
```

Verify the pinned SHA inside the clone:

```bash
git -C .tmp/project-init rev-parse HEAD
# expected: 57fb4a2e5abe6f52e4fd9cb2cb88234496e47d4b
```

If the local clone's HEAD SHA differs from the pinned SHA above, the checkout does not match the reviewed governance commit. Do not silently use the new SHA — file an Issue to evaluate the change and update this document explicitly.

## u-sekai overrides of upstream policy

The upstream policy at the `0.3.0` tag specifies a language convention (internal docs in Japanese, GitHub Issues/PRs in Japanese). **u-sekai deliberately overrides that convention** because the project's target audience is international (Product Hunt and similar channels).

| Concern | Upstream default | u-sekai override |
| --- | --- | --- |
| Public-facing docs (README, CONTRIBUTING) | Japanese | **English** |
| Issue title / body | Japanese | **English** |
| PR title / body / review discussion | Japanese | **English** |
| Internal development docs (CLAUDE.md, u-sekai-authored docs) | Japanese | **English** |
| `.claude/skills/*.md` (upstream-authored Skills, copied as-is) | Japanese | **Japanese — deliberate exception** |
| Source code | English | English (no change) |
| Commit messages | English | English (no change) |
| Branch names | identifier / version only | identifier / version only (no change) |

> **Note on the Skills exception**: u-sekai keeps upstream-authored Skills verbatim in Japanese to avoid semantic drift. They are installed and updated from the current `rebuildup/aude-skills` source with `bunx skills`; the governance baseline above does not freeze them. Translation remains tracked in R-09.

Other upstream rules (weekly sprint, `release-x-y-z` branches, `<issue-number>` ticket branches, GitHub Issue dependency graph as canonical dependency SoT, public-repository `main` protection, merge authorization separation from PR readiness, etc.) are followed as-is.

Any future deviation from this override should be documented as a new ADR in `docs/adr/`.

## When to upgrade the governance baseline

Trigger an upgrade discussion when:

- A newer stable `aude-skills` release contains organizational changes that materially improve this project.
- A security advisory or a breaking change on `main` makes the current pin unsafe.
- A new Skill in the upstream is needed for the current phase (e.g. implementation phase begins and we want `quality-gate` / `sandbox-runtime` / `agent-recovery`).

Process:

1. Open a GitHub Issue describing the upstream change and the rationale.
2. Decide whether to upgrade the pin or fork-and-customize a specific Skill.
3. If upgrading: update this document and reconcile the Constitution / Operating Model. Skills continue through their independent `bunx skills` lifecycle.