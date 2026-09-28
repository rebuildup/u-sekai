# ADR-0003: Public repository `main` protection / release-only integration

- **Status**: accepted
- **Date**: 2026-09-15
- **Deciders**: project lead (@rebuildup)

## Context

u-sekai is a **public** GitHub repository. The governance baseline
([`rebuildup/project-init@release-0-3-0`](https://github.com/rebuildup/project-init/tree/release-0-3-0))
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

> **Corrected 2026-09-28.** The approval count, the required status check, and
> the self-approval rationale below were retired as stale by the project-init
> 0.3.0 reconciliation. Read [Correction (2026-09-28)](#correction-2026-09-28)
> before applying any part of the 2026-09-15 decision. The original text is
> retained verbatim below so the superseded judgement stays auditable.

| Setting | Value |
| --- | --- |
| `enforce_admins` | enabled |
| `required_pull_request_reviews.required_approving_review_count` | 1 (superseded — see Correction) |
| `required_pull_request_reviews.dismiss_stale_reviews` | true |
| `required_pull_request_reviews.require_code_owner_reviews` | false |
| `allow_force_pushes` | disabled |
| `allow_deletions` | disabled |
| `required_conversation_resolution` | enabled |
| `required_status_checks.contexts` | `[release-source-check / release-source-check]` (superseded — see Correction) |

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

Negative / trade-offs:

- Required status check requires the workflow to have run at least once
  before it can be registered. We accepted this and pre-registered the
  check name based on the workflow definition.
  (Superseded — see Correction.)
- Self-approval is allowed when only one admin exists. This is acceptable
  for the current single-owner setup; new reviewers should be added when
  available.
  (**Incorrect premise** — see Correction.)

Operational:

- The release-source check workflow is in `.github/workflows/release-source-check.yml`.
- ~~The branch protection API call that registers the check is reproducible
  from the `protection-payload.json` artifact (gitignored in `.tmp/`).~~
  (Superseded — the check is not registered; see Correction.)
- ~~When the workflow definition changes (e.g. renamed job), update the
  protection's `required_status_checks.contexts` to match.~~
  (Superseded — `required_status_checks` is `null`; see Correction.)

## Alternatives considered

- ~~**Branch protection only without required check**: rejected — does not
  enforce the release-only path.~~ **Superseded** — the release-only path is
  not enforced by branch protection. It is enforced by a merge-executor
  preflight, and the residual UI-bypass limitation is recorded rather than
  papered over. See Correction.
- ~~**Repository rulesets with push restrictions**: partial — rulesets can
  restrict branch names but cannot fully constrain PR head branches without
  the workflow check.~~ **Superseded** — the underlying platform limitation is
  correct and is restated in the Correction, but the conclusion that a workflow
  check must therefore become a required status check is rejected.
- **No branch protection during research / design phase**: rejected —
  even before code exists, the repo is public and the contract should be
  established early.

## References

- [`.github/workflows/release-source-check.yml`](../../.github/workflows/release-source-check.yml)
- [`.github/CODEOWNERS`](../../.github/CODEOWNERS)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — branch / PR / release workflow
- [`CLAUDE.md`](../../CLAUDE.md) — Section 6 branch / release policy
- Upstream: <https://github.com/rebuildup/project-init/tree/release-0-3-0>

## Correction (2026-09-28)

This is a dated correction to an accepted decision, not a rewrite. Everything
above the Correction heading is the original 2026-09-15 text and is kept
verbatim so the superseded judgement stays auditable. The decision that `main`
is protected, that the release-only integration path is required, and that
direct edits, force pushes and deletions are prohibited in normal operation
**stands**. Three specifics are retired, and two things ADR-0003 never stated
are now stated.

### Cause

ADR-0003 was decided on 2026-09-15. The project-init 0.3.0 reconciliation
landed afterwards, on `release-0-2-0` via PR #27, and adopted upstream
`ADR-0016` (Accepted, `Superseded by: None`) as current policy. ADR-0003 was
never reconciled against it. Every item below is therefore a **stale decision
retired by the reconciliation**, not a deliberate u-sekai deviation: there is
no record of any decision, made after the reconciliation, to re-adopt any of
them.

### Intended configuration

```json
{
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "required_status_checks": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
```

`required_status_checks` is `null`, which is how the API expresses **status-check
protection disabled**. The endpoint takes `object or null` and documents
"Set to null to disable".

`null` and `{"strict": false, "contexts": []}` are different states and must not
be conflated. `null` disables status-check protection outright.
`{"strict": false, "contexts": []}` *enables* that protection with zero required
contexts. The intended state here is the former, because the policy is "no
required status checks", not "status-check protection on, requiring nothing".

`strict` is therefore **not applicable** while status-check protection is
disabled, and this ADR deliberately fixes no value for it. It becomes a
decision at the point status-check protection is ever introduced.

| Setting | Value |
| --- | --- |
| Require a pull request | enabled |
| `enforce_admins` | enabled |
| `required_pull_request_reviews.required_approving_review_count` | 0 |
| `required_pull_request_reviews.dismiss_stale_reviews` | true |
| `required_pull_request_reviews.require_code_owner_reviews` | false |
| `required_conversation_resolution` | enabled |
| `required_status_checks` | disabled (`null`) |
| `required_status_checks.strict` | N/A — only meaningful once status-check protection is enabled |
| `allow_force_pushes` | disabled |
| `allow_deletions` | disabled |

### 1. `required_approving_review_count: 1` was never achievable

The original rationale was that self-approval is allowed when only one admin
exists. That premise is false: a pull-request author cannot submit an
approving review on their own pull request. Measured on this repository:

| Observation | Result |
| --- | --- |
| Collaborators | one — `rebuildup`, `role_name: admin` |
| PR authors | `rebuildup` on every PR in the repository |
| `rebuildup` self-reviews on PR #12 | recorded by GitHub as `COMMENTED`, not `APPROVED` |
| `APPROVED` reviews across all 8 PRs | 0 |

Any `count >= 1` would make every release PR permanently unmergeable. This was
already decided upstream: `rebuildup/project-init` ADR-0016 Context states that
requiring approval in a single-developer repository can leave the author unable
to approve their own PR and therefore unable to merge, and §3 sets
`required approving review count = 0`.

**Intended for the single-owner phase: `0`.**

**Revisit trigger:** raise the count when a second collaborator with write
access exists. Until then `0` is the only satisfiable value, and a requirement
that can never be met gives no assurance while blocking all delivery. The
review guarantee is currently carried by CI, by the explicit merge
authorization boundary, and by the operating profile.

### 2. `required_status_checks` is retired, not adopted

ADR-0003 asserts that the governance baseline mandates a required status
check. Upstream ADR-0016 says the opposite:

- §3: `required status checks = none by default`, and non-existent check
  names, or names originating in other repositories, must not be pinned as
  required status checks.
- §4: branch protection cannot constrain a PR's head-branch pattern, and that
  must **not** be worked around by pinning a check name — the upstream text
  forbids fabricating a phantom check, and also forbids fixing even a real,
  repository-specific check name as portable policy.

[`organization/profiles/release-driven-solo.md`](../../organization/profiles/release-driven-solo.md)
restates both: the release-only path is a delivery rule, not a protection
setting, and a fixed universal required status check name is not assumed.

**Intended: `required_status_checks` stays disabled (`null`), and the release-only path is
enforced by a merge-executor preflight** — `base == main` and
`head == current release-*` verified immediately before the merge, combined
with explicit merge authorization and current-SHA validation evidence. That
combination is the actual authority gate for a release merge.

### 3. `.github/workflows/release-source-check.yml` is retained as diagnostic

The workflow is **not** deleted. It verifies that a PR into `main` originates
from a `release-` branch whose name matches `package.json#version`, and it was
confirmed working on the 0.2.0 release PR (#38), reporting for the first time
in this repository's history: `Head branch 'release-0-2-0' matches package.json
version '0.2.0'.`

Its role is **advisory evidence that the merge-executor preflight
corroborates**. Its name is not a mandatory governance identifier, and it is
not registered as a required check.

### 4. `strict` is not fixed while status-check protection is disabled

ADR-0003 was silent on `strict`. It is recorded here as **not applicable**,
because `strict` only has meaning once `required_status_checks` is a non-null
object, and the intended state is `null`.

This is deliberately not canonised as `strict: false`. Doing so would fix a
value for a setting that does not exist in the target configuration, and would
create pressure to enable status-check protection merely to give the value
somewhere to live. `strict` becomes a decision at the moment status-check
protection is introduced, on its own merits.

For the record, the reasoning that would apply then: `main` moves only through
release PRs in a single release stream, so the staleness `strict: true` guards
against is excluded by the operating model, while its failure mode is real — it
would block a release PR and force a `main -> release-0-2-0` merge into the
branch whose merge commit *is* the release artifact. So if status-check
protection is ever enabled, `strict: false` is the expected starting position,
revisited if parallel release streams appear.

### 5. Platform limitation, stated rather than overclaimed

A human merging from the GitHub UI can still open a PR from a non-`release-`
branch and merge it. The release-only path is therefore **not** fully
machine-enforced by GitHub, and no readiness review may report that it is.
Upstream ADR-0016 §4 requires this limitation to be recorded rather than
overclaimed. The mitigation is that an agent executing the merge always
preflights `head == current release-*` and refuses, and that
`release-source-check` reports the violation as evidence.

### Unchanged

Reaffirmed from the original decision: `main` is released/integrated source
state and is protected; a pull request is required; conversation resolution is
required; admin enforcement is on so the sole admin cannot bypass the rest;
force pushes and deletions are disabled; the release-only integration path is a
genuine requirement, and its inability to be expressed in branch protection is
a real platform limitation rather than an oversight.

## References

- Upstream `rebuildup/project-init` ADR-0016 (Accepted) §3 and §4 —
  <https://github.com/rebuildup/project-init/blob/main/docs/adr/ADR-0016.md>
- [`organization/profiles/release-driven-solo.md`](../../organization/profiles/release-driven-solo.md) —
  current release-driven Operating Model
- `.github/workflows/release-source-check.yml` — retained diagnostic
- Issue #36 — the branch-protection operator action this correction unblocks
