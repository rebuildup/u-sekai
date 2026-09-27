# ADR-0010: Version-aligned release publication (tag and GitHub Release)

- **Status**: accepted
- **Date**: 2026-09-27
- **Deciders**: project lead (@rebuildup)

## Context

A merged `release-x-y-z -> main` pull request already *is* the released
source state ([ADR-0003](./ADR-0003-public-main-protection.md)). What did
not exist is the artifact layer on top of that state: no tag, no GitHub
Release, and therefore no way for a consumer to name "the 0.1.0 source" as
a Git object. 0.1.0 was released with no tag and no Release at all.

Publishing by hand is not acceptable for three reasons:

- A hand-picked tag can disagree with `package.json#version`, which produces
  two conflicting definitions of "0.1.0".
- A hand-picked tag can point at a commit that is not the released state.
- Re-running by hand produces duplicate or conflicting artifacts, and nothing
  detects it.

The repository also lacks a single documented command for publication, and
the release gate has no defined source: ADR-0003 names
`release-source-check / release-source-check` as a required status check,
but the check that actually proves a commit is releasable is the `CI` job.

## Decision

Publication is performed by `scripts/verify-release.mjs`, which evaluates
pure rules from `scripts/release-rules.mjs` and, with `--apply`, creates one
Git tag and one GitHub Release. The rules are I/O-free so they are unit
tested; the CLI only gathers facts and renders the verdict.

### The version source of truth

`package.json#version`, read at the **target release commit**, is the only
version input. The CLI has no flag that sets the version, on purpose: a
command-line override would let a tag be published whose version differs from
`package.json#version`, which is exactly the condition the gate must refuse.

`scripts/check-version-sync.mjs` remains the pre-merge check for the same
field, and it additionally enforces that a `release-` ref matches the
version. The two are siblings over one value, not a second rule.

### Derived identifiers

| Artifact | Derivation from version `V` |
| --- | --- |
| Tag | `v<V>` |
| Release branch | `release-<V with dots as dashes>` |

The tag must match `^v\d+\.\d+\.\d+$` exactly: a mandatory `v` prefix,
stable semver, and no pre-release suffix and no extra segments. `0.1.0`,
`v0.1`, `v0.2.0-rc.1`, `release-0-2-0`, and `v0.2.0.1` are all refused.
The release branch is never configured independently; it is computed from
the version, and a mismatch is a refusal.

### The expected release commit

Because releases land with **merge commits only**, the released source state
for version `V` is the commit on `main` whose subject records the merge of
`release-<V>` (`Merge pull request #N from <owner>/release-<V>`). The gate
resolves that commit from `main` history and refuses any target that is not
it. When the release branch has since been deleted, the merge record remains
as the durable evidence; branch existence is the alternative evidence path,
not the only one. A `release-<V>` branch that still exists must additionally
be an ancestor of the target, so a branch that moved past the tagged state is
refused.

### Fail, never correct

Every rule is evaluated against facts that are never adjusted. The gate
reports the expected value next to the observed one and exits non-zero. It
never bumps a version, re-points a tag, moves a branch, rewrites a target
commit, or downgrades a required check to match reality. Correcting the
source and re-running is the only repair path.

### The release gate and its source

The gate is decided from **check runs on the target commit**, read from the
GitHub Checks API, restricted to the release state: a run counts only when
its check suite's head branch is `main` or `release-<V>`. Runs triggered by
anything else (for example a ticket branch push that happened to land on the
same SHA) are ignored, and every ignored run is printed. A run whose head
branch cannot be read stays **in** scope, because scoping an unknown run out
would silently relax the gate.

Each required check is decided by its **latest** run, the way GitHub decides
a required status check, so a re-run legitimately supersedes an earlier
failure.

The required-check list is a committed constant
(`DEFAULT_REQUIRED_RELEASE_CHECKS`), overridable with `--required-check` or
`RELEASE_REQUIRED_CHECKS`. An empty list is a refusal: a gate that checks
nothing is not a pass. An unreadable check-run list is a refusal, and a
required check that never ran is a refusal.

`release-source-check / release-source-check` is deliberately **not** in that
list. It is a `pull_request`-time check on the release pull request head, so
it produces no check run on the release merge commit; it is enforced by branch
protection at merge time and is classified as a merge-time check.

Branch protection on `main` is read as a cross-check, not as the gate source.
A registered required check that neither covers the release gate nor is a
merge-time pull request check means the gate is narrower than the
repository's own definition, and is a refusal.

When branch protection registers no required status check at all, that is
reported as a `protection-sync` note rather than a silent pass, and
`--require-protection-configured` escalates the note to a refusal.

### Trigger

Publication is a `workflow_dispatch`-only workflow
(`.github/workflows/release-publish.yml`) whose `dry_run` input defaults to
`true`.

`release: published` is rejected because it would make the GitHub Release
the source of the release, contradicting `package.json#version` as the source
of truth. `push` to `main` is rejected because it races CI — the gate must
already be green — and because publishing a public tag is effectively
irreversible and must follow an explicit human act. `workflow_dispatch`
always runs the workflow and the script from the default branch, so an older
release can be backfilled with current tooling.

Publication never requires a direct source change to `main`: it creates a ref
and a Release, and `main` stays protected.

### Idempotency

Re-running must be safe, so the pre-existing state is evaluated as evidence
rather than as an obstacle:

- Tag absent → create it. Tag present at the target commit → reuse. Tag
  present anywhere else → refusal, never a force-move.
- Release absent → create it. Release present, published, non-prerelease, at
  the target commit → `already-published`, a no-op. A draft, a pre-release,
  or a different commit → refusal, because silently promoting or re-pointing
  it would be a correction.
- A different GitHub Release already carrying the same version (for example
  `0.2.0` next to `v0.2.0`) → refusal, so a second artifact for one version
  cannot appear.
- After any `--apply`, the tag and the Release are re-read and the run fails
  if the result is not the intended one.

## Consequences

Positive:

- "0.1.0" has exactly one definition: `package.json#version` at the released
  commit, with the tag and the Release as derived artifacts.
- A version/SHA mismatch is caught before anything public is created, and the
  refusal names both values.
- The gate cannot pass by absence: an absent, unreadable, or empty check is a
  refusal.
- Backfill and future releases use the same code path.

Negative / trade-offs:

- The rules depend on GitHub merge-commit subjects, so the repository must
  keep merge-commit landing. This is already a fixed decision in ADR-0003 and
  in the operating profile.
- A re-merged release branch resolves to its newest merge, which is reported
  as a note rather than a refusal.
- Publishing a public tag is effectively irreversible; the gate does not
  attempt to un-publish.

Operational:

- `scripts/release-rules.mjs` is pure; `test/unit/release-verification.test.ts`
  covers every rule, including the negative cases.
- The CLI reads `gh` from the environment; no credential is stored in the
  repository.
- If the `CI` job name changes, `DEFAULT_REQUIRED_RELEASE_CHECKS` must change
  with it, and the same for `PR_TIME_CHECK_CONTEXTS` when the
  `release-source-check` workflow is renamed.

## Alternatives considered

- **`release: published` as the trigger**: rejected — it makes the Release the
  source of the release and removes the human authority boundary.
- **Automatic version bump and tag on merge to `main`**: rejected — out of
  scope for this issue, and it would auto-correct a version mismatch instead
  of surfacing it.
- **Signed annotated tags**: deferred. The current tag is lightweight; a
  signing requirement is a separate decision.
- **npm registry publication**: out of scope; `package.json` is `private`.

## References

- [Issue #22](https://github.com/rebuildup/u-sekai/issues/22)
- [ADR-0003: Public repository `main` protection](./ADR-0003-public-main-protection.md)
- [`docs/release-process.md`](../release-process.md)
- [`scripts/release-rules.mjs`](../../scripts/release-rules.mjs)
- [`scripts/verify-release.mjs`](../../scripts/verify-release.mjs)
- [`.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml)
