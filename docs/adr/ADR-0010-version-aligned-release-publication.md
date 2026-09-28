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

`--source-ref` is kept as the explicit spelling of "where to read the version",
and the `version-source-sha` rule requires it to resolve to the target release
commit. Mixing facts from two commits — reading the version from one commit and
tagging another — would make every version comparison meaningless, so a
`--source-ref` that resolves elsewhere is a refusal. Dropping the option instead
was the alternative; the rule was chosen because it keeps the fact explicit and
names both commits in the refusal.

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

A candidate must match the GitHub merge-commit **subject shape**, and the last
path segment of the head branch must equal the release branch. Anchoring the
shape is what makes the subject evidence rather than a mention: `docs: document
the release-0-2-0 rollback plan` and `Merge branch tmp; revert release-0-2-0`
resolve no release commit at all.

More than one qualifying merge is a **refusal**, not a "newest wins" pick. A
head branch can end with the release branch's name without being the release
branch — `docs/release-0-2-0` merged after `release-0-2-0` does — and a subject
alone cannot tell a re-merge from a different branch. Choosing the newest of
two commits that both claim to be the release of `V` is a guess about what a
public tag would point at, so the run refuses and names every candidate.

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

The constant must name checks the `CI` workflow actually defines.
`test/unit/release-verification.test.ts` parses the `jobs:` block of
`.github/workflows/ci.yml` (and of `release-source-check.yml` for the
merge-time contexts) and fails when a committed name is not an actual job
name, so renaming a CI job cannot leave a green gate that can never be
satisfied.

### Branch protection as a local-only cross-check

Branch protection on `main` is read as a cross-check, not as the gate source.
A registered required check that neither covers the release gate nor is a
merge-time pull request check means the gate is narrower than the
repository's own definition, and is a refusal.

**The cross-check is local-only and is not performed by the release-publish
workflow.** `GET /repos/{owner}/{repo}/branches/{ref}/protection` requires
Administration: read, and the workflow's `GITHUB_TOKEN` is granted only
`contents: write` and `checks: read`, so the read cannot succeed from CI. The
workflow therefore has no `require_protection_configured` input: from that
context the request could never be satisfied, and an input that can only ever
refuse is not an input.

Consequences, all of them fail-closed:

- The committed `DEFAULT_REQUIRED_RELEASE_CHECKS` is the **only** definition of
  the gate in CI. The run says so explicitly (`protection-sync` note:
  "the branch-protection cross-check was not performed").
- An unanswered read is never reported as a fact. A 404 that does not name the
  missing section, a 403, or a transport failure is reported as *unreadable*,
  and only a response that names the absent section ("Required status checks not
  enabled") is reported as "none registered".
- Locally, `node scripts/verify-release.mjs --cross-check-protection` performs
  the cross-check with an operator credential that can read it.
- `--require-protection-configured` escalates the outcome to a refusal, and
  without `--cross-check-protection` it is itself refused: the request is
  undecidable, and an undecidable request is never reported as a satisfied one.


### Trigger

Publication is a `workflow_dispatch`-only workflow
(`.github/workflows/release-publish.yml`) whose `dry_run` input defaults to
`true`.

The switch is read **fail-closed**: only the exact string `false` adds
`--apply`, and an unset, empty, or unexpectedly spelled value
(`0`, `1`, `yes`, `TRUE`) stays a dry run. The workflow form coerces booleans,
but `gh workflow run -f dry_run=<value>` and the REST dispatch endpoint accept
arbitrary strings, and a publish switch that fails open turns a typo into a
public tag.

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
  cannot appear. The same applies to a stray **git tag** for the same version:
  Releases are listed with pagination and tags are scanned too, so an
  inventory that could not be read completely is a refusal rather than an
  assumed absence. Answering "is there a duplicate?" with "no" after failing
  to read the list would be the fail-open direction for a question about what
  already exists publicly.
- After any `--apply`, the tag and the Release are re-read and the run fails
  if the result is not the intended one.
- Each artifact is re-read immediately before it is created, so two concurrent
  publishing runs converge on one tag and one Release instead of racing into a
  second artifact.
- A partially completed `--apply` is recoverable by re-running. The failure
  message names whether the tag now exists, states that the script never
  deletes, moves, or re-points a tag and never deletes a Release, and says that
  re-running creates only the missing Release.

### Release notes

The Release notes are generated by GitHub from the merged pull requests
(`--generate-notes`). The artifact is therefore reproducible from durable
repository history, not from any agent's transient context, and it is identical
for whoever performs the backfill.

## Consequences

Positive:

- "0.1.0" has exactly one definition: `package.json#version` at the released
  commit, with the tag and the Release as derived artifacts.
- A version/SHA mismatch is caught before anything public is created, and the
  refusal names both values.
- The gate cannot pass by absence: an absent, unreadable, or empty check is a
  refusal.
- The gate cannot pass by ambiguity: more than one merge commit claiming to be
  the release of `V` is a refusal, not a newest-wins pick.
- Backfill and future releases use the same code path.

Negative / trade-offs:

- The rules depend on GitHub merge-commit subjects, so the repository must
  keep merge-commit landing. This is already a fixed decision in ADR-0003 and
  in the operating profile.
- A release branch that was merged twice, or a different branch whose name ends
  with the release branch's name, refuses publication. Resolving it is a
  human decision (re-land, or rename), and the refusal lists the candidates.
- The workflow cannot cross-check branch protection, so the committed release
  gate is the only definition of the gate in CI. The cross-check is available
  locally and is expected before a real publish.
- Publishing a public tag is effectively irreversible; the gate does not
  attempt to un-publish. **Tag immutability is a convention here, not an
  enforced property**: the tag created is lightweight and GitHub tag protection
  is not enabled, so nothing prevents a human from moving or deleting it. The
  gate's response to a moved tag is a loud refusal (`tag-idempotency`), never
  a silent re-point.

Operational:

- `scripts/release-rules.mjs` is pure; `test/unit/release-verification.test.ts`
  covers every rule, including the negative cases.
- The CLI's own fact-gathering and argument handling (`parseArgs`,
  `parsePackageVersion`, `isNotFound`, `mapCheckRuns`, `protectionContextsFrom`,
  `resolveCommitish`, `scanConflictingReleaseArtifacts`, `assertPublished`) are
  unit tested in the same file, because the anti-false-green arguments rest on
  their internal tri-state decisions.
- `scripts/**` is type-checked by `tsconfig.json` with `allowJs` /
  `checkJs`, and the types of the rules module are derived from JSDoc in the
  implementation. There is no hand-written declaration file beside it: a
  parallel `.d.mts` can drift from the `.mjs` silently, which would widen the
  gate while every test stayed green.
- The CLI reads `gh` from the environment; no credential is stored in the
  repository.
- If the `CI` job name changes, `DEFAULT_REQUIRED_RELEASE_CHECKS` must change
  with it, and the same for `PR_TIME_CHECK_CONTEXTS` when the
  `release-source-check` workflow is renamed. Both are enforced by a test that
  parses the workflow files, so the change fails CI rather than waiting for a
  release.

## Alternatives considered

- **`release: published` as the trigger**: rejected — it makes the Release the
  source of the release and removes the human authority boundary.
- **Automatic version bump and tag on merge to `main`**: rejected — out of
  scope for this issue, and it would auto-correct a version mismatch instead
  of surfacing it.
- **Reading branch protection from the workflow**: rejected — the token cannot
  read it, and treating the failed read as "nothing is required" would let the
  cross-check pass by being unable to run. Granting Administration: read to a
  publishing token was also rejected, as a publish job does not need it.
- **Signed annotated tags and GitHub tag protection**: deferred. The current
  tag is lightweight and unprotected, so immutability is a convention rather
  than an enforced property; enforcing it is a separate decision.
- **npm registry publication**: out of scope; `package.json` is `private`.

## References

- [Issue #22](https://github.com/rebuildup/u-sekai/issues/22)
- [ADR-0003: Public repository `main` protection](./ADR-0003-public-main-protection.md)
- [`docs/release-process.md`](../release-process.md)
- [`scripts/release-rules.mjs`](../../scripts/release-rules.mjs)
- [`scripts/verify-release.mjs`](../../scripts/verify-release.mjs)
- [`.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml)
