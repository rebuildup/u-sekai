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
 * Default release gate for a published release.
 *
 * These are check-run *names* as reported by the GitHub Checks API
 * (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`). GitHub renders the
 * same check as the status context `CI / lint + typecheck + build + test`,
 * that is `<workflow name> / <job name>`.
 *
 * Keep this list in sync with:
 *   - the `jobs.<id>.name` values in `.github/workflows/ci.yml`, and
 *   - the `required_status_checks.contexts` registered on `main`
 *     (see `docs/adr/ADR-0003-public-main-protection.md`).
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
 * the `required_status_checks.contexts` registered on `main`.
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
 */
function coversCheckName(context, name) {
  return context === name || context.endsWith(` / ${name}`);
}

/** Whether a registered context is a merge-time pull request check. */
function isPrTimeContext(context) {
  return (
    PR_TIME_CHECK_CONTEXTS.includes(context) ||
    PR_TIME_CHECK_NAMES.some((name) => coversCheckName(context, name))
  );
}

/** `0.2.0` -> `release-0-2-0`. */
export function deriveReleaseBranchName(version) {
  return `release-${String(version).replaceAll('.', '-')}`;
}

/** `v0.2.0` -> `{ version: '0.2.0' }`; anything else -> `null`. */
export function parseReleaseTag(tagName) {
  const match = RELEASE_TAG_PATTERN.exec(String(tagName));
  return match === null ? null : { version: match[1] };
}

/** `Merge pull request #12 from rebuildup/release-0-1-0` references `release-0-1-0`. */
function referencesBranch(subject, releaseBranch) {
  return String(subject)
    .trim()
    .replace(/[.,;:]+$/, '')
    .split(/\s+/)
    .some((token) => token === releaseBranch || token.endsWith(`/${releaseBranch}`));
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
 * When the same release branch was merged more than once, the newest such merge
 * is the released state.
 *
 * @param {{ merges: ReadonlyArray<{ sha: string, parents: readonly string[], subject: string }>, releaseBranch: string }} input
 *   `merges` must be ordered newest first, exactly as `git log --merges` emits.
 * @returns {{ sha: string, subject: string, candidates: number } | { sha: null, candidates: number }}
 */
export function resolveExpectedReleaseSha({ merges, releaseBranch }) {
  const candidates = merges.filter(
    (commit) => commit.parents.length >= 2 && referencesBranch(commit.subject, releaseBranch),
  );
  const newest = candidates[0];
  if (newest === undefined) return { sha: null, candidates: 0 };
  return { sha: newest.sha, subject: newest.subject, candidates: candidates.length };
}

/**
 * Pick the check run that decides a required check, the way GitHub does.
 *
 * GitHub evaluates a required status check by the **latest** check run for that
 * context, so re-running a failed job legitimately supersedes it. Runs are
 * ordered by `completedAt`, then `startedAt`, then numeric `id`.
 *
 * @param {ReadonlyArray<import('./release-rules.d.mts').CheckRun>} runs
 * @param {string} name
 * @returns {import('./release-rules.d.mts').CheckRun | null}
 */
export function selectLatestCheckRun(runs, name) {
  let latest = null;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (latest === null || compareCheckRuns(run, latest) > 0) latest = run;
  }
  return latest;
}

function compareCheckRuns(a, b) {
  const keyOf = (run) => `${run.completedAt ?? ''}|${run.startedAt ?? ''}|${padId(run.id)}`;
  const aKey = keyOf(a);
  const bKey = keyOf(b);
  if (aKey === bKey) return 0;
  return aKey > bKey ? 1 : -1;
}

function padId(id) {
  if (id === null || id === undefined) return '0'.repeat(20);
  return String(id).padStart(20, '0');
}

function isApplicable(run, applicableBranches) {
  // An unknown head branch counts as applicable: scoping it out would silently
  // relax the gate.
  return run.headBranch === null || run.headBranch === undefined
    ? true
    : applicableBranches.includes(run.headBranch);
}

function describeRun(run) {
  const conclusion = run.conclusion ?? 'no-conclusion';
  const where = run.url === null || run.url === undefined ? '' : ` (${run.url})`;
  return `${run.status}/${conclusion}${where}`;
}

/**
 * Evaluate every publication rule and return a verdict.
 *
 * @param {import('./release-rules.d.mts').ReleaseEvaluationInput} input
 * @returns {import('./release-rules.d.mts').ReleaseEvaluation}
 */
export function evaluateReleasePublication(input) {
  /** @type {import('./release-rules.d.mts').ReleaseCheck[]} */
  const checks = [];
  /** @type {import('./release-rules.d.mts').ReleaseViolation[]} */
  const violations = [];
  /** @type {import('./release-rules.d.mts').ReleaseNote[]} */
  const notes = [];

  const record = (rule, ok, expected, observed) => {
    const message = `expected ${expected}; observed ${observed}`;
    checks.push({ rule, ok, message });
    if (!ok) violations.push({ rule, message });
  };
  const note = (rule, message) => {
    notes.push({ rule, message });
  };

  const version = input.packageVersion;
  const quoted = (value) => JSON.stringify(value);

  // --- the version source of truth is well formed ---------------------------
  const versionFormatted = STABLE_VERSION_PATTERN.test(version);
  record(
    'version-source-format',
    versionFormatted,
    `stable semver x.y.z in package.json#version at ${input.sourceRef}`,
    quoted(version),
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
  if (expectedSha !== null && expected.candidates !== undefined && expected.candidates > 1) {
    note(
      'expected-release-sha',
      `${quoted(input.releaseBranch)} was merged into ${input.mainRef} ${expected.candidates} times; the newest merge ${expectedSha} is treated as the released state`,
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
  const duplicates = input.conflictingReleaseTags ?? [];
  record(
    'no-duplicate-release-artifacts',
    duplicates.length === 0,
    'no other GitHub Release to carry the same version',
    duplicates.length === 0
      ? 'none'
      : `existing release tag(s) ${duplicates.map((name) => quoted(name)).join(', ')}`,
  );

  const ok = violations.length === 0;
  const alreadyPublished = tag !== null && release !== null;
  const verdict = ok ? (alreadyPublished ? 'already-published' : 'publish') : 'refused';
  const plan = buildPlan({ input, violations });

  return { ok, verdict, checks, violations, notes, plan };
}

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
 * Cross-check the committed required-check list against what branch protection
 * actually registers on `main`. A registered context that neither the release
 * gate nor `PR_TIME_CHECK_CONTEXTS` covers means the release gate is narrower
 * than the repository's own definition, which is a refusal, not a warning.
 */
function evaluateProtectionCoverage({ input, record, note }) {
  const configured = input.protectionContexts ?? null;
  if (configured === null || configured.length === 0) {
    const source = input.gateSource ?? 'an unset source';
    const detail =
      configured === null
        ? `the required status checks registered on ${input.mainRef} could not be read, so ${JSON.stringify(input.requiredChecks)} (from ${source}) is the only definition of the release gate`
        : `branch protection on ${input.mainRef} registers no required status check, so ${JSON.stringify(input.requiredChecks)} (from ${source}) is the only definition of the release gate`;
    if (input.requireProtectionConfigured === true) {
      record(
        'protection-sync',
        false,
        'at least one readable required status check registered on the protected branch',
        `${detail}; --require-protection-configured was set`,
      );
    } else {
      note('protection-sync', detail);
    }
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
