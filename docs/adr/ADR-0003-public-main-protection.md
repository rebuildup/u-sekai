# ADR-0003: Public repository `main` protection / release-only integration

- **Status**: accepted
- **Date**: 2026-09-15
- **Deciders**: project lead (@rebuildup)

## Context

u-sekai is a **public** GitHub repository. The pinned upstream policy
([`rebuildup/project-init@release-0-1-1`](https://github.com/rebuildup/project-init/tree/release-0-1-1))
mandates that, in public repositories:

- `main` must be protected via branch protection / ruleset.
- Direct push / direct web edit / force push / deletion must be prohibited
  in normal operation.
- `main` must be updated only through `release-x-y-z -> main` release PRs.
- When GitHub's built-in branch protection cannot constrain the PR head
  branch pattern, a required status check must validate
  `base == main AND head matches release-` and the intended target release.

This rule protects:

- Released source state from accidental edits.
- The workflow contract: every change to `main` goes through review and the
  weekly release process.

## Decision

u-sekai enforces the following on `main` of `rebuildup/u-sekai`:

| Setting | Value |
| --- | --- |
| `enforce_admins` | enabled |
| `required_pull_request_reviews.required_approving_review_count` | 1 |
| `required_pull_request_reviews.dismiss_stale_reviews` | true |
| `required_pull_request_reviews.require_code_owner_reviews` | false |
| `allow_force_pushes` | disabled |
| `allow_deletions` | disabled |
| `required_conversation_resolution` | enabled |
| `required_status_checks.contexts` | `[release-source-check / release-source-check]` |

A GitHub Actions workflow at
[`.github/workflows/release-source-check.yml`](../../.github/workflows/release-source-check.yml)
implements the release-source check. It runs on every PR targeting `main`
and fails if the head branch is not a `release-<major>-<minor>-<patch>`
branch.

[`.github/CODEOWNERS`](../../.github/CODEOWNERS) provides default reviewer
mapping for the project-lead.

## Consequences

Positive:

- Direct edits to `main` are mechanically blocked.
- All `main` updates go through PR review and the release workflow.
- The release-source check guarantees the canonical path.

Negative / trade-offs:

- Required status check requires the workflow to have run at least once
  before it can be registered. We accepted this and pre-registered the
  check name based on the workflow definition.
- Self-approval is allowed when only one admin exists. This is acceptable
  for the current single-owner setup; new reviewers should be added when
  available.

Operational:

- The release-source check workflow is in `.github/workflows/release-source-check.yml`.
- The branch protection API call that registers the check is reproducible
  from the `protection-payload.json` artifact (gitignored in `.tmp/`).
- When the workflow definition changes (e.g. renamed job), update the
  protection's `required_status_checks.contexts` to match.

## Alternatives considered

- **Branch protection only without required check**: rejected — does not
  enforce the release-only path.
- **Repository rulesets with push restrictions**: partial — rulesets can
  restrict branch names but cannot fully constrain PR head branches without
  the workflow check.
- **No branch protection during research / design phase**: rejected —
  even before code exists, the repo is public and the contract should be
  established early.

## References

- [`.github/workflows/release-source-check.yml`](../../.github/workflows/release-source-check.yml)
- [`.github/CODEOWNERS`](../../.github/CODEOWNERS)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch / PR / release workflow
- [`CLAUDE.md`](../../CLAUDE.md) — Section 6 branch / release policy
- Upstream: <https://github.com/rebuildup/project-init/tree/release-0-1-1>