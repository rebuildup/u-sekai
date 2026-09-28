/**
 * Pure release-publication rules for u-sekai (Issue #22, ADR-0010).
 *
 * This module performs no I/O on purpose: every rule is a pure function of the
 * facts gathered by `scripts/verify-release.mjs`, so the release gate can be
 * unit-tested without network access or credentials.
 *
 * Policy: **fail, never correct.** Each check reports what was expected next to
 * what was observed, and a violation never rewrites anything to make a
 * publication succeed.
 *
 * The types below are declared with JSDoc so that `tsc --checkJs` derives them
 * from this implementation. There is deliberately no hand-written declaration
 * file next to it: a parallel `.d.mts` can drift from the `.mjs` silently and
 * widen the gate while every test stays green (ADR-0010).
 */

/**
 * A check run on the target commit, reduced to what the gate decides from.
 *
 * @typedef {object} CheckRun
 * @property {string} name Check-run name as reported by the GitHub Checks API.
 * @property {string} status e.g. `completed`, `in_progress`, `queued`, `pending`.
 * @property {string | null} conclusion e.g. `success`, `failure`, `neutral`, or `null` while running.
 * @property {string | null} [headBranch] Head branch of the owning check suite; `null` when unknown.
 * @property {string | null} [startedAt]
 * @property {string | null} [completedAt]
 * @property {string | number | null} [id]
 * @property {string | null} [url]
 */

/**
 * The release commit resolved from `main` history for one version.
 *
 * @typedef {object} ExpectedReleaseSha
 * @property {string | null} sha Newest qualifying merge commit; `null` when there is none.
 * @property {string | null} subject Merge-commit subject of that commit.
 * @property {number} candidates How many merge commits qualify.
 * @property {readonly string[]} candidateShas Every qualifying merge commit, newest first.
 */

/** @typedef {{ sha: string }} ExistingTag */

/**
 * @typedef {object} ExistingRelease
 * @property {string} sha Commit the release ships, resolved from the tag it references.
 * @property {string | null} [targetCommitish] Raw `target_commitish`, kept for the printed note.
 * @property {boolean} draft
 * @property {boolean} prerelease
 */

/**
 * Whether this run attempted the branch-protection cross-check at all.
 *
 * `'not-performed'` is the CI default: `GITHUB_TOKEN` cannot read branch
 * protection, so an unanswered request there is reported as *not performed*
 * rather than as the fact "nothing is required".
 *
 * @typedef {'performed' | 'not-performed'} ProtectionCheck
 */

/**
 * @typedef {object} ReleaseEvaluationInput
 * @property {string} repo `owner/name` of the GitHub repository.
 * @property {string} sourceRef Ref the version source of truth was read from.
 * @property {string} sourceSha Commit `sourceRef` resolves to.
 * @property {string} mainRef Ref that holds the released source state.
 * @property {string} packageVersion Value read from `package.json#version`.
 * @property {string} tagName Tag to publish.
 * @property {string} releaseBranch Intended release branch.
 * @property {string} targetSha Resolved target commit.
 * @property {ExpectedReleaseSha} expectedReleaseSha
 * @property {boolean} remoteHasTargetSha
 * @property {readonly string[]} remoteContainingRefs Remote-tracking refs that contain the target commit.
 * @property {boolean} targetOnMain
 * @property {boolean} releaseBranchExists
 * @property {string | null} releaseBranchTip
 * @property {boolean | null} releaseBranchTipIsAncestor
 * @property {readonly string[]} requiredChecks Check names that must be `completed` / `success`.
 * @property {string} [gateSource] Where `requiredChecks` came from, for the printed verdict.
 * @property {ProtectionCheck} protectionCheck
 * @property {readonly string[] | null} protectionContexts Status checks registered on `main`; `null` when unreadable.
 * @property {boolean} requireProtectionConfigured Refuse when the protected branch registers no required check.
 * @property {boolean} checkRunsReadable False when the check runs could not be read at all.
 * @property {readonly CheckRun[]} [checkRuns]
 * @property {readonly string[]} applicableBranches Branches whose check runs form the release state.
 * @property {ExistingTag | null} existingTag
 * @property {ExistingRelease | null} existingRelease
 * @property {boolean} conflictingReleaseTagsReadable False when Releases or tags could not be listed completely.
 * @property {readonly string[]} conflictingReleaseTags Other Releases carrying the same version.
 * @property {readonly string[]} conflictingTagRefs Other git tags carrying the same version.
 */

/**
 * @typedef {object} ReleaseCheck
 * @property {string} rule
 * @property {boolean} ok
 * @property {string} message
 */

/**
 * @typedef {object} ReleaseViolation
 * @property {string} rule
 * @property {string} message
 */

/**
 * @typedef {object} ReleaseNote
 * @property {string} rule
 * @property {string} message
 */

/**
 * @typedef {object} ReleaseEvaluation
 * @property {boolean} ok
 * @property {'publish' | 'already-published' | 'refused'} verdict
 * @property {readonly ReleaseCheck[]} checks
 * @property {readonly ReleaseViolation[]} violations
 * @property {readonly ReleaseNote[]} notes
 * @property {readonly string[]} plan
 */

/**
 * @typedef {object} MergeCommit
 * @property {string} sha
 * @property {readonly string[]} parents
 * @property {string} subject
 */

/**
 * @callback RecordCheck
 * @param {string} rule
 * @param {boolean} ok
 * @param {string} expected
 * @param {string} observed
 * @returns {void}
 */

/**
 * @callback RecordNote
 * @param {string} rule
 * @param {string} message
 * @returns {void}
 */

/**
 * @typedef {object} EvaluationContext
 * @property {ReleaseEvaluationInput} input
 * @property {RecordCheck} record
 * @property {RecordNote} note
 */

/** Stable semver `x.y.z`, matching `scripts/check-version-sync.mjs`. */
export const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Release tag shape: exactly `v<major>.<minor>.<patch>`.
 *
 * The `v` prefix is mandatory, the version must be stable semver, and
 * pre-release suffixes (`v0.2.0-rc.1`) as well as extra segments
 * (`v0.2.0.1`) are rejected. The `v`-less form (`0.2.0`) and the
 * branch-shaped form (`release-0-2-0`) are rejected too.
 */
export const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;

/**
 * The merge-commit subject shape GitHub generates when a pull request is
 * merged through the web UI or `gh pr merge`:
 * `Merge pull request #<n> from <owner>/<head-branch>`.
 *
 * The shape is the point. A subject that merely *mentions* the release branch
 * (`docs: document the release-0-2-0 rollback plan`,
 * `Merge branch tmp; revert release-0-2-0`) is not evidence that the release
 * branch was merged, so it must never resolve the release commit.
 */
export const GITHUB_MERGE_SUBJECT_PATTERN = /^Merge pull request #(\d+) from ([^\s/]+)\/(.+)$/;

/**
 * Default release gate for a published release.
 *
 * These are check-run *names* as reported by the GitHub Checks API
 * (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`). GitHub renders the
 * same check as the status context `CI / lint + typecheck + build + test`,
 * that is `<workflow name> / <job name>`.
 *
 * Keep this list in sync with the `jobs.<id>.name` values in
 * `.github/workflows/ci.yml`; `test/unit/release-verification.test.ts` parses
 * that file and fails when a name here is not an actual CI job name, so the
 * list cannot drift silently. The registered
 * `required_status_checks` on `main` are cross-checked by the local-only
 * `--cross-check-protection` mode (ADR-0010).
 *
 * `release-source-check / release-source-check` is deliberately absent: it is a
 * `pull_request`-time check on the release PR head, so it never produces a
 * check run on the release merge commit. Its evidence lives on the pull request
 * and is enforced at merge time by branch protection, which is why it is listed
 * in `PR_TIME_CHECK_CONTEXTS` instead.
 *
 * Replace the list explicitly with repeated `--required-check` flags or with the
 * `RELEASE_REQUIRED_CHECKS` environment variable (comma separated).
 */
export const DEFAULT_REQUIRED_RELEASE_CHECKS = Object.freeze([
  'lint + typecheck + build + test',
]);

/**
 * Checks enforced at merge time on the release pull request. They have no check
 * run on the release merge commit and are therefore never part of the release
 * gate. Keep in sync with `.github/workflows/release-source-check.yml` and with
 * the `required_status_checks` registered on `main`.
 *
 * GitHub reports a required check in two shapes depending on how it was
 * registered: the check-run name (`release-source-check`) in
 * `required_status_checks.checks[].context`, and the composite status context
 * (`release-source-check / release-source-check`) in the legacy
 * `required_status_checks.contexts`. `coversCheckName` accepts both so a
 * correctly registered merge-time check is never mistaken for an uncovered one.
 */
export const PR_TIME_CHECK_CONTEXTS = Object.freeze([
  'release-source-check / release-source-check',
]);

/**
 * The bare check-run names of those merge-time checks, derived from the list
 * above so the two cannot drift.
 */
const PR_TIME_CHECK_NAMES = Object.freeze(
  PR_TIME_CHECK_CONTEXTS.map((context) => context.split(' / ').at(-1) ?? context),
);

/**
 * Whether a registered status check context names `name`, in either the
 * check-run-name shape or the `<workflow> / <job>` shape.
 *
 * @param {string} context
 * @param {string} name
 * @returns {boolean}
 */
function coversCheckName(context, name) {
  return context === name || context.endsWith(` / ${name}`);
}

/**
 * Whether a registered context is a merge-time pull request check.
 *
 * @param {string} context
 * @returns {boolean}
 */
function isPrTimeContext(context) {
  return (
    PR_TIME_CHECK_CONTEXTS.includes(context) ||
    PR_TIME_CHECK_NAMES.some((name) => coversCheckName(context, name))
  );
}

/**
 * `0.2.0` -> `release-0-2-0`.
 *
 * @param {string} version
 * @returns {string}
 */
export function deriveReleaseBranchName(version) {
  return `release-${String(version).replaceAll('.', '-')}`;
}

/**
 * `v0.2.0` -> `{ version: '0.2.0' }`; anything else -> `null`.
 *
 * @param {string} tagName
 * @returns {{ version: string } | null}
 */
export function parseReleaseTag(tagName) {
  const match = RELEASE_TAG_PATTERN.exec(String(tagName));
  return match === null ? null : { version: match[1] ?? '' };
}

/**
 * Parse a GitHub merge-commit subject.
 *
 * @param {string} subject
 * @returns {{ prNumber: number, owner: string, headBranch: string } | null}
 */
export function parseGitHubMergeSubject(subject) {
  const match = GITHUB_MERGE_SUBJECT_PATTERN.exec(String(subject).trim());
  if (match === null) return null;
  const [, prNumber, owner, headBranch] = match;
  if (prNumber === undefined || owner === undefined || headBranch === undefined) return null;
  return { prNumber: Number(prNumber), owner, headBranch };
}

/**
 * Whether a commit is the merge commit that integrated the release branch.
 *
 * Two conditions, both required:
 *   1. it is a real merge commit (two or more parents), and
 *   2. its subject is the GitHub merge shape and the **last path segment** of
 *      the head branch equals the release branch.
 *
 * The last segment is compared because GitHub always prefixes the head branch
 * with its owner, so `rebuildup/release-0-2-0` names the branch
 * `release-0-2-0`. A head branch that merely ends with the same segment
 * (`docs/release-0-2-0`) is a different branch; it cannot be distinguished
 * from a re-merge of the release branch by subject alone, so it stays a
 * candidate and `expected-release-sha-ambiguous` refuses the run rather than
 * picking one.
 * @param {MergeCommit} commit
 * @param {string} releaseBranch
 * @returns {boolean}
 */
function integratesReleaseBranch(commit, releaseBranch) {
  if (commit.parents.length < 2) return false;
  const parsed = parseGitHubMergeSubject(commit.subject);
  if (parsed === null) return false;
  return parsed.headBranch.split('/').at(-1) === releaseBranch;
}

/**
 * Resolve the expected release commit for a version from `main` history.
 *
 * u-sekai lands releases with **merge commits only** (ADR-0003 and
 * `organization/profiles/release-driven-solo.md`), so the released source state
 * for version `V` is the commit on `main` that merged the `release-<V>` branch.
 * The durable evidence for that is the merge commit subject GitHub generates
 * (`Merge pull request #N from <owner>/release-<V>`), which stays readable long
 * after the release branch itself is deleted.
 *
 * Every qualifying merge is returned as a candidate. More than one candidate is
 * not resolved by "newest wins": it is refused, because picking one of two
 * commits that both claim to be the release of `V` is a guess about what a
 * public tag would point at.
 *
 * @param {{ merges: readonly MergeCommit[], releaseBranch: string }} input
 *   `merges` must be ordered newest first, exactly as `git log --merges` emits.
 * @returns {ExpectedReleaseSha}
 */
export function resolveExpectedReleaseSha({ merges, releaseBranch }) {
  const candidates = merges.filter((commit) => integratesReleaseBranch(commit, releaseBranch));
  const candidateShas = candidates.map((commit) => commit.sha);
  const newest = candidates[0];
  return {
    sha: newest === undefined ? null : newest.sha,
    subject: newest === undefined ? null : newest.subject,
    candidates: candidates.length,
    candidateShas,
  };
}

/**
 * Pick the check run that decides a required check, the way GitHub does.
 *
 * GitHub evaluates a required status check by the **latest** check run for that
 * context, so re-running a failed job legitimately supersedes it. Runs are
 * ordered by `completedAt`, then `startedAt`, then numeric `id`. A run with no
 * `completedAt` (queued, in progress) sorts after every finished run, so a
 * re-run queued on top of an earlier success still decides the gate and is
 * refused as not-yet-completed.
 *
 * @param {readonly CheckRun[]} runs
 * @param {string} name
 * @returns {CheckRun | null}
 */
export function selectLatestCheckRun(runs, name) {
  let latest = null;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (latest === null || compareCheckRuns(run, latest) > 0) latest = run;
  }
  return latest;
}

/**
 * @param {CheckRun} a
 * @param {CheckRun} b
 * @returns {number}
 */
function compareCheckRuns(a, b) {
  const keyOf = (/** @type {CheckRun} */ run) => `${run.completedAt ?? ''}|${run.startedAt ?? ''}|${padId(run.id)}`;
  const aKey = keyOf(a);
  const bKey = keyOf(b);
  if (aKey === bKey) return 0;
  return aKey > bKey ? 1 : -1;
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function padId(id) {
  if (id === null || id === undefined) return '0'.repeat(20);
  return String(id).padStart(20, '0');
}

/**
 * @param {CheckRun} run
 * @param {readonly string[]} applicableBranches
 * @returns {boolean}
 */
function isApplicable(run, applicableBranches) {
  // An unknown head branch counts as applicable: scoping it out would silently
  // relax the gate.
  return run.headBranch === null || run.headBranch === undefined
    ? true
    : applicableBranches.includes(run.headBranch);
}

/**
 * @param {CheckRun} run
 * @returns {string}
 */
function describeRun(run) {
  const conclusion = run.conclusion ?? 'no-conclusion';
  const where = run.url === null || run.url === undefined ? '' : ` (${run.url})`;
  return `${run.status}/${conclusion}${where}`;
}

/**
 * Evaluate every publication rule and return a verdict.
 *
 * @param {ReleaseEvaluationInput} input
 * @returns {ReleaseEvaluation}
 */
export function evaluateReleasePublication(input) {
  /** @type {ReleaseCheck[]} */
  const checks = [];
  /** @type {ReleaseViolation[]} */
  const violations = [];
  /** @type {ReleaseNote[]} */
  const notes = [];

  const record = /** @type {RecordCheck} */ (rule, ok, expected, observed) => {
    const message = `expected ${expected}; observed ${observed}`;
    checks.push({ rule, ok, message });
    if (!ok) violations.push({ rule, message });
  };
  const note = /** @type {RecordNote} */ (rule, message) => {
    notes.push({ rule, message });
  };

  const version = input.packageVersion;
  const quoted = (/** @type {unknown} */ value) => JSON.stringify(value);

  // --- the version source of truth is well formed ---------------------------
  const versionFormatted = STABLE_VERSION_PATTERN.test(version);
  record(
    'version-source-format',
    versionFormatted,
    `stable semver x.y.z in package.json#version at ${input.sourceRef}`,
    quoted(version),
  );

  // --- ...and it was read at the commit that is being tagged -----------------
  record(
    'version-source-sha',
    input.sourceSha === input.targetSha,
    `package.json#version to be read at the target release commit ${input.targetSha}`,
    `version read from ${input.sourceRef}, which resolves to ${input.sourceSha}`,
  );

  // --- the tag name is exactly v<major>.<minor>.<patch> ---------------------
  const parsedTag = parseReleaseTag(input.tagName);
  record(
    'tag-format',
    parsedTag !== null,
    'a semantic release tag v<major>.<minor>.<patch> (mandatory "v" prefix, stable semver, no pre-release suffix, no extra segments)',
    quoted(input.tagName),
  );

  // --- the tag version equals package.json#version --------------------------
  if (parsedTag !== null && versionFormatted) {
    record(
      'tag-version-match',
      parsedTag.version === version,
      `tag version ${quoted(version)} to match package.json#version at ${input.sourceRef}`,
      `tag version ${quoted(parsedTag.version)} declared by ${quoted(input.tagName)}`,
    );
  } else {
    note(
      'tag-version-match',
      'skipped: the tag name or the version source is not well formed, so the comparison carries no meaning',
    );
  }

  // --- the intended release branch is derived from the version --------------
  const expectedBranch = deriveReleaseBranchName(version);
  record(
    'release-branch-name',
    input.releaseBranch === expectedBranch,
    `release branch ${quoted(expectedBranch)} derived from package.json#version ${quoted(version)}`,
    `intended release branch ${quoted(input.releaseBranch)}`,
  );

  // --- an expected release commit exists on main -----------------------------
  const expected = input.expectedReleaseSha;
  const expectedSha = expected.sha;
  record(
    'expected-release-sha',
    expectedSha !== null,
    `a merge commit on ${input.mainRef} that integrates ${quoted(input.releaseBranch)}`,
    expectedSha === null
      ? 'no such merge commit'
      : `${expectedSha} (${String(expected.subject)})`,
  );

  // --- ...and exactly one such merge commit, so the tag has one answer -------
  if (expected.candidates > 1) {
    record(
      'expected-release-sha-ambiguous',
      false,
      `exactly one merge commit on ${input.mainRef} to integrate ${quoted(input.releaseBranch)}`,
      `${expected.candidates} merge commits integrate it, so the released state is ambiguous: ${expected.candidateShas.join(', ')}`,
    );
  }

  // --- the target commit is the expected release commit ---------------------
  if (expectedSha !== null) {
    record(
      'target-release-sha',
      input.targetSha === expectedSha,
      `the release commit ${expectedSha} for version ${quoted(version)}`,
      `target commit ${input.targetSha}`,
    );
  } else {
    note('target-release-sha', `skipped: no expected release commit could be resolved on ${input.mainRef}`);
  }

  // --- the target commit is a real remote object ----------------------------
  record(
    'target-sha-on-remote',
    input.remoteHasTargetSha,
    `target commit ${input.targetSha} contained in a ref advertised by the ${input.repo} remote`,
    input.remoteHasTargetSha
      ? `contained in ${input.remoteContainingRefs.join(', ')}`
      : 'no advertised remote ref contains it',
  );

  // --- the target commit is the released state on main ----------------------
  record(
    'target-sha-on-main',
    input.targetOnMain,
    `target commit ${input.targetSha} reachable from ${input.mainRef}`,
    input.targetOnMain ? 'reachable' : 'not reachable',
  );

  // --- durable evidence that the release branch was released ----------------
  const mergedEvidence = expectedSha !== null && expectedSha === input.targetSha;
  const branchExists = input.releaseBranchExists;
  record(
    'release-branch-evidence',
    branchExists || mergedEvidence,
    `release branch ${quoted(input.releaseBranch)} to exist on ${input.repo}, or to be recorded as merged into ${input.mainRef} for version ${quoted(version)}`,
    branchExists
      ? `branch exists at ${String(input.releaseBranchTip)}`
      : mergedEvidence
        ? `branch deleted, but merge commit ${expectedSha} on ${input.mainRef} records the release`
        : 'branch absent and no merge record on main',
  );
  if (!branchExists && mergedEvidence) {
    note(
      'release-branch-evidence',
      `release branch ${quoted(input.releaseBranch)} is already deleted; merge commit ${expectedSha} on ${input.mainRef} is the durable evidence that it was released`,
    );
  }

  // --- a surviving release branch must not be ahead of the tag --------------
  if (branchExists) {
    record(
      'release-branch-ancestor',
      input.releaseBranchTipIsAncestor === true,
      `the tip ${String(input.releaseBranchTip)} of ${quoted(input.releaseBranch)} to be an ancestor of the target commit ${input.targetSha}`,
      input.releaseBranchTipIsAncestor === true
        ? 'ancestor'
        : 'not an ancestor, so the release branch moved past the tagged state',
    );
  } else {
    note('release-branch-ancestor', 'skipped: the release branch does not exist on the remote');
  }

  // --- the release gate passed on the release state --------------------------
  evaluateReleaseGate({ input, record, note });

  // --- branch protection agrees with the release gate -----------------------
  evaluateProtectionCoverage({ input, record, note });

  // --- idempotency over an existing tag --------------------------------------
  const tag = input.existingTag;
  if (tag === null) {
    note('tag-idempotency', `tag ${quoted(input.tagName)} does not exist yet; it would be created at ${input.targetSha}`);
  } else {
    record(
      'tag-idempotency',
      tag.sha === input.targetSha,
      `an existing tag ${quoted(input.tagName)} to point at the release commit ${input.targetSha}`,
      `tag ${quoted(input.tagName)} already points at ${tag.sha}`,
    );
  }

  // --- idempotency over an existing GitHub Release ---------------------------
  const release = input.existingRelease;
  if (release === null) {
    note(
      'release-idempotency',
      `GitHub Release ${quoted(input.tagName)} does not exist yet; it would be created with notes generated from merged pull requests`,
    );
  } else {
    const conflicts = [];
    if (release.sha !== input.targetSha) {
      conflicts.push(`it points at ${release.sha} instead of ${input.targetSha}`);
    }
    if (release.draft) conflicts.push('it is still a draft');
    if (release.prerelease) conflicts.push('it is marked as a pre-release');
    record(
      'release-idempotency',
      conflicts.length === 0,
      `an existing GitHub Release ${quoted(input.tagName)} to be a published, non-prerelease release of the commit ${input.targetSha}`,
      conflicts.length === 0
        ? `published release of ${release.sha}`
        : `existing release cannot be reused: ${conflicts.join('; ')}`,
    );
    if (conflicts.length === 0 && release.targetCommitish != null && release.targetCommitish !== release.sha) {
      note(
        'release-idempotency',
        `the existing GitHub Release ${quoted(input.tagName)} records target_commitish ${quoted(release.targetCommitish)}; the shipped commit is taken from the tag it references, ${release.sha}`,
      );
    }
  }

  // --- no duplicate release artifact for the same version --------------------
  evaluateDuplicateArtifacts({ input, record, note });

  const ok = violations.length === 0;
  const alreadyPublished = tag !== null && release !== null;
  const verdict = ok ? (alreadyPublished ? 'already-published' : 'publish') : 'refused';
  const plan = buildPlan({ input, violations });

  return { ok, verdict, checks, violations, notes, plan };
}

/**
 * @param {EvaluationContext} context
 * @returns {void}
 */
function evaluateReleaseGate({ input, record, note }) {
  if (input.checkRunsReadable !== true) {
    record(
      'release-gate',
      false,
      `the GitHub check runs for ${input.targetSha} to be readable`,
      'the check runs could not be read, so the gate is undeterminable and is never assumed to have passed',
    );
    return;
  }

  const required = input.requiredChecks;
  if (required.length === 0) {
    record(
      'release-gate',
      false,
      'at least one required release check, supplied with --required-check or RELEASE_REQUIRED_CHECKS',
      'the required release check list is empty',
    );
    return;
  }

  const runs = input.checkRuns ?? [];
  const applicableBranches = input.applicableBranches;
  const scoped = runs.filter((run) => isApplicable(run, applicableBranches));
  const ignored = runs.filter((run) => !isApplicable(run, applicableBranches));
  if (ignored.length > 0) {
    note(
      'release-gate',
      `ignored ${ignored.length} check run(s) on ${input.targetSha} that were not triggered by the release state (${applicableBranches.join(', ')}): ${ignored
        .map((run) => `${run.name}@${run.headBranch ?? 'unknown-branch'}`)
        .join(', ')}`,
    );
  }

  for (const name of required) {
    const latest = selectLatestCheckRun(scoped, name);
    if (latest === null) {
      record(
        'release-gate',
        false,
        `a completed/success check run named ${JSON.stringify(name)} on ${input.targetSha} for the release state (${applicableBranches.join(', ')})`,
        'no such check run; an absent check is never treated as a pass',
      );
      continue;
    }
    const passed = latest.status === 'completed' && latest.conclusion === 'success';
    record(
      'release-gate',
      passed,
      `the latest check run named ${JSON.stringify(name)} on ${input.targetSha} to be completed/success`,
      `${describeRun(latest)}${passed ? '' : ` on head branch ${latest.headBranch ?? 'unknown'}`}`,
    );
  }
}

/**
 * Cross-check the committed required-check list against the status checks
 * branch protection registers on the protected branch.
 *
 * This is a **local-only** cross-check (ADR-0010). `GITHUB_TOKEN` cannot be
 * granted Administration: read, so the release-publish workflow never performs
 * it and the committed `DEFAULT_REQUIRED_RELEASE_CHECKS` is the only definition
 * of the gate there. When the cross-check was not performed, or was performed
 * with a credential that could not read the answer, that fact is reported as
 * such. It is never reported as "branch protection registers no required
 * status check", because an unanswered request is not evidence of an empty
 * configuration.
 *
 * @param {EvaluationContext} context
 * @returns {void}
 */
function evaluateProtectionCoverage({ input, record, note }) {
  const source = input.gateSource ?? 'an unset source';
  const committed = `${JSON.stringify(input.requiredChecks)} (from ${source})`;

  if (input.protectionCheck !== 'performed') {
    refuseOrNote({
      input,
      record,
      note,
      detail:
        'the branch-protection cross-check was not performed, so ' +
        `${committed} is the only definition of the release gate; ` +
        'run it locally with --cross-check-protection, because the release-publish ' +
        'workflow token cannot read branch protection',
      remedy: 'it cannot be decided without --cross-check-protection',
    });
    return;
  }

  const configured = input.protectionContexts;
  if (configured === null) {
    refuseOrNote({
      input,
      record,
      note,
      detail:
        `the required status checks registered on ${input.mainRef} could not be read with this ` +
        `credential, so ${committed} is the only definition of the release gate; ` +
        're-run with a credential that has Administration: read',
    });
    return;
  }
  if (configured.length === 0) {
    refuseOrNote({
      input,
      record,
      note,
      detail: `branch protection on ${input.mainRef} registers no required status check, so ${committed} is the only definition of the release gate`,
    });
    return;
  }

  const mergeTime = configured.filter((context) => isPrTimeContext(context));
  if (mergeTime.length > 0) {
    note(
      'protection-sync',
      `required check(s) ${mergeTime.map((context) => JSON.stringify(context)).join(', ')} are merge-time pull request checks and are not expected on the release commit`,
    );
  }
  const uncovered = configured.filter(
    (context) =>
      !isPrTimeContext(context) &&
      !input.requiredChecks.some((name) => coversCheckName(context, name)),
  );
  record(
    'protection-sync',
    uncovered.length === 0,
    'every status check registered on the protected branch to be covered by the release gate or to be a merge-time pull request check',
    uncovered.length === 0
      ? `covered: ${configured.map((context) => JSON.stringify(context)).join(', ')}`
      : `not covered: ${uncovered.map((context) => JSON.stringify(context)).join(', ')}`,
  );
}

/**
 * `protection-sync` is a note unless the operator asked for the configuration
 * to be verified. `--require-protection-configured` without a performed,
 * readable cross-check is itself a refusal: the request cannot be decided, and
 * an undecidable request is never reported as a satisfied one.
 *
 * @param {EvaluationContext & { detail: string, remedy?: string }} context
 * @returns {void}
 */
function refuseOrNote({ input, record, note, detail, remedy }) {
  if (input.requireProtectionConfigured === true) {
    record(
      'protection-sync',
      false,
      `a readable, non-empty required status check configuration on ${input.mainRef}`,
      `${detail}; --require-protection-configured was set${remedy === undefined ? '' : ` and ${remedy}`}`,
    );
  } else {
    note('protection-sync', detail);
  }
}

/**
 * Refuse a second Release or tag that carries the same version.
 *
 * An incomplete inventory is a refusal, not an absence. A `null` release list or
 * an unreadable tag list used to be indistinguishable from "no duplicates",
 * which is a fail-open answer to a question about what already exists publicly.
 */
/**
 * @param {EvaluationContext} context
 * @returns {void}
 */
function evaluateDuplicateArtifacts({ input, record }) {
  if (input.conflictingReleaseTagsReadable !== true) {
    record(
      'no-duplicate-release-artifacts',
      false,
      `a complete list of the existing GitHub Releases and git tags of ${input.repo}`,
      'the existing Releases and tags could not be listed, so a duplicate artifact for this version cannot be ruled out',
    );
    return;
  }
  const duplicates = [...new Set([...input.conflictingReleaseTags, ...input.conflictingTagRefs])];
  record(
    'no-duplicate-release-artifacts',
    duplicates.length === 0,
    'no other git tag or GitHub Release to carry the same version',
    duplicates.length === 0
      ? 'none'
      : `existing tag/release ${duplicates.map((name) => JSON.stringify(name)).join(', ')}`,
  );
}

/**
 * @param {{ input: ReleaseEvaluationInput, violations: readonly ReleaseViolation[] }} context
 * @returns {string[]}
 */
function buildPlan({ input, violations }) {
  if (violations.length > 0) {
    const rules = [...new Set(violations.map((violation) => violation.rule))];
    return [
      `refuse to publish ${JSON.stringify(input.tagName)}: ${violations.length} rule(s) violated (${rules.join(', ')})`,
    ];
  }
  const steps = [];
  if (input.existingTag === null) {
    steps.push(`create tag ${JSON.stringify(input.tagName)} at ${input.targetSha}`);
  }
  if (input.existingRelease === null) {
    steps.push(
      `create GitHub Release ${JSON.stringify(input.tagName)} at ${input.targetSha} with notes generated from merged pull requests`,
    );
  }
  if (steps.length === 0) {
    steps.push(
      `no-op: tag and GitHub Release ${JSON.stringify(input.tagName)} already exist at ${input.targetSha}`,
    );
  }
  return steps;
}
