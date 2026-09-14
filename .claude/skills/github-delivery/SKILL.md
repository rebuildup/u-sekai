---
name: github-delivery
description: GitHub Issue / PR / weekly release / Draft PR lifecycle / merge authorization policy for u-sekai. Use when opening issues, declaring dependencies, planning sprints, creating PRs, or operating the release workflow.
---

# github-delivery

## Purpose

Align u-sekai's GitHub workflow with the pinned rebuildup policy:

- **GitHub Issues** are the durable implementation / dependency SoT.
- **Weekly release sprint + `release-x-y-z` branch** model.
- **Published remote head + Draft PR** is mandatory for every active durable ticket branch.
- **Stacked PRs** are reserved for linear hard dependencies.
- **Merge authorization** is a separate state from PR readiness (mandatory rule).

## Issues

### When to open an Issue

- Independent, plannable, reviewable work item → open an Issue.
- Short-lived nested subtask → keep inside an Issue body / parent Issue discussion.

### Required fields (in the body)

- Purpose / background
- The question (what is unknown / what must be decided)
- Acceptance criteria (for research / design phase: "conclusion captured in docs" etc.)
- Scope / non-scope
- Dependencies (numbered references to other Issues)
- Target release / target phase (e.g. `research-phase-1`)
- Estimated effort (any unit: SP / small-medium-large)

### How to open

- Use one of `.github/ISSUE_TEMPLATE/`:
  - `research-question.md` — open questions / comparisons
  - `investigation.md` — concrete investigation steps
- Title and body in **English**.

### Dependencies

- Hard dependencies declared in the Issue body and recorded in the GitHub Issue dependency graph.
- Branch parent-child relationships alone do **not** represent dependencies.

## Branch / PR (policy)

> Note: this repository is not yet in implementation phase. Currently, the primary PR targets are docs / template / Skill improvements. Implementation PRs adopt the stricter rules below.

### Branch names

- Ticket branches are **Issue number only**: `42`.
- No `issue/` prefix, slug, or title.
- Descriptive responsibility lives in the Issue / PR.

### Draft PR mandatory (active durable ticket branch)

When implementation starts, the canonical start procedure is:

1. Create the durable branch
2. Create the first meaningful commit
3. Publish that commit to the canonical remote
4. Verify the remote branch head SHA matches the first meaningful commit SHA
5. Immediately create a Draft PR
6. Set Issue linkage, assignee, reviewer / CODEOWNERS, established labels, target release, stack context, validation state
7. Continue implementation

The only exception: a release branch that is **zero-diff** from `main` does not require a Draft release PR until the first meaningful integrated difference appears.

### PR metadata

At minimum, evaluate and set on PR creation:

- Linked Issue
- Accountable assignee
- Reviewer / CODEOWNERS-derived reviewer
- Repository-established labels
- Acceptance criteria
- Implementation summary
- Validation results / status
- Known blockers / limitations
- Target release
- Stack trunk / immediate predecessor / successor context when applicable

If no meaningful separate reviewer exists, do **not** self-assign as reviewer just to fill the field. State the absence and the alternate review path (CI / explicit final review) in the PR body.

## Weekly release sprint (policy)

- Normal sprint = **one week**.
- One sprint = one target semantic version = one `release-<major>-<minor>-<patch>` branch.
- Create the release branch from `main` at sprint start.
- Zero-diff release branch → no Draft release PR required. After first meaningful difference → Draft release PR required.
- After public-repo enablement: `release-x-y-z -> main` release PR is the **only** canonical path to `main`.

## Merge authorization vs. PR readiness (mandatory)

This is the rule most often missed.

- **Quality / readiness** of a PR is one state.
- **Merge authorization** is a separate state held by the user.
- An agent may perform merge / squash / rebase / stacked landing / auto-merge enablement **only** when the user has explicitly authorized merge/landing for the identified PR or a clearly bounded PR set.
- Generic completion cues ("review this", "fix the conflict", "CI is green", "approval received", "Ready", "handle this PR") are **not** merge authorization.
- Without explicit authorization, stop at **ready-to-merge** and report: PR identity, current head SHA, gate state, blockers.
- Do **not** carry authorization to other PRs. If head / base / target release / scope changes materially after authorization, re-validate.

## Research / design phase specifics

- Research question Issues often **have no PR** (literature review / discussion only).
- When docs / ADR / candidate-selection needs updating, open a PR.
- The release branch / `main` protection / required check workflows are **not yet enabled**. When they are, this Skill and `CONTRIBUTING.md` are updated in the same change.

## Do not

- Rely on closing keywords alone to close Issues; manual close is required for non-default-branch integration.
- Use stacked PR merely to split one Issue into multiple PRs.
- Invent meaningless labels.
- Self-assign as reviewer to fill the field.
- Mark a stacked ticket Done after an intermediate merge into the predecessor branch. Wait for landing on the target release trunk.