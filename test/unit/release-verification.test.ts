import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REQUIRED_RELEASE_CHECKS,
  PR_TIME_CHECK_CONTEXTS,
  deriveReleaseBranchName,
  evaluateReleasePublication,
  parseGitHubMergeSubject,
  parseReleaseTag,
  resolveExpectedReleaseSha,
  selectLatestCheckRun,
} from '../../scripts/release-rules.mjs';
import type {
  CheckRun,
  ReleaseEvaluation,
  ReleaseEvaluationInput,
} from '../../scripts/release-rules.mjs';
import {
  FactsError,
  assertPublished,
  firstLine,
  isNotFound,
  mapCheckRuns,
  parseArgs,
  parsePackageVersion,
  protectionContextsFrom,
  protectionSectionAbsent,
  resolveCommitish,
  scanConflictingReleaseArtifacts,
} from '../../scripts/verify-release.mjs';

const RELEASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BRANCH_TIP = 'c1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Job names declared under the `jobs:` block of a GitHub Actions workflow.
 *
 * A targeted regex rather than a YAML dependency: the file is checked in, its
 * shape is a two-line job header, and parsing it here is what makes the
 * `DEFAULT_REQUIRED_RELEASE_CHECKS` invariant test compare the committed
 * constant against the real workflow instead of against itself.
 */
function workflowJobNames(relativePath: string): string[] {
  const text = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const jobsAt = text.indexOf('\njobs:\n');
  expect(jobsAt, `${relativePath} has no jobs: block`).toBeGreaterThan(-1);
  const jobsBlock = text.slice(jobsAt);
  return [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\n {4}name: (.+)$/gm)].map(
    (match) => match[2]?.trim() ?? '',
  );
}

const CI_JOB_NAMES = workflowJobNames('.github/workflows/ci.yml');
const PR_CHECK_JOB_NAMES = workflowJobNames('.github/workflows/release-source-check.yml');
// The fixture uses the real job name, so a renamed CI job breaks the fixtures
// instead of silently keeping a passing check run that cannot exist.
const CI_CHECK = CI_JOB_NAMES[0] ?? '';

function passingCheckRun(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    name: CI_CHECK,
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    startedAt: '2026-09-27T00:00:00Z',
    completedAt: '2026-09-27T00:05:00Z',
    id: 1,
    url: 'https://github.com/rebuildup/u-sekai/actions/runs/1/job/1',
    ...overrides,
  };
}

/** A fully valid 0.2.0 publication. Individual tests override one fact each. */
function baseInput(overrides: Partial<ReleaseEvaluationInput> = {}): ReleaseEvaluationInput {
  return {
    repo: 'rebuildup/u-sekai',
    sourceRef: 'origin/main',
    sourceSha: RELEASE_SHA,
    mainRef: 'origin/main',
    packageVersion: '0.2.0',
    tagName: 'v0.2.0',
    releaseBranch: 'release-0-2-0',
    targetSha: RELEASE_SHA,
    expectedReleaseSha: {
      sha: RELEASE_SHA,
      subject: 'Merge pull request #30 from rebuildup/release-0-2-0',
      candidates: 1,
      candidateShas: [RELEASE_SHA],
    },
    remoteHasTargetSha: true,
    remoteContainingRefs: ['origin/main'],
    targetOnMain: true,
    releaseBranchExists: true,
    releaseBranchTip: BRANCH_TIP,
    releaseBranchTipIsAncestor: true,
    requiredChecks: [CI_CHECK],
    gateSource: 'test',
    protectionCheck: 'performed',
    protectionContexts: [`CI / ${CI_CHECK}`],
    requireProtectionConfigured: false,
    checkRunsReadable: true,
    checkRuns: [passingCheckRun()],
    applicableBranches: ['main', 'release-0-2-0'],
    existingTag: null,
    existingRelease: null,
    conflictingReleaseTagsReadable: true,
    conflictingReleaseTags: [],
    conflictingTagRefs: [],
    ...overrides,
  };
}

function rule(result: ReleaseEvaluation, name: string) {
  return result.checks.find((check) => check.rule === name);
}

function isViolated(result: ReleaseEvaluation, name: string): boolean {
  return result.violations.some((violation) => violation.rule === name);
}

describe('the committed release gate matches the real CI job names', () => {
  it('parses the CI and release-source-check workflows', () => {
    expect(CI_JOB_NAMES.length).toBeGreaterThan(0);
    expect(PR_CHECK_JOB_NAMES.length).toBeGreaterThan(0);
  });

  it('names only check runs the CI workflow actually defines', () => {
    // The invariant is "the gate list is a subset of the actual CI job names",
    // which is what a renamed `jobs.<id>.name` would break.
    for (const required of DEFAULT_REQUIRED_RELEASE_CHECKS) {
      expect(CI_JOB_NAMES, `DEFAULT_REQUIRED_RELEASE_CHECKS names ${required}`).toContain(required);
    }
  });

  it('names only merge-time checks the release-source-check workflow defines', () => {
    for (const context of PR_TIME_CHECK_CONTEXTS) {
      const jobName = context.split(' / ').at(-1) ?? context;
      expect(PR_CHECK_JOB_NAMES, `PR_TIME_CHECK_CONTEXTS names ${jobName}`).toContain(jobName);
    }
  });
});

describe('release version derivation', () => {
  it('derives the release branch from the version', () => {
    expect(deriveReleaseBranchName('0.2.0')).toBe('release-0-2-0');
    expect(deriveReleaseBranchName('1.10.3')).toBe('release-1-10-3');
  });

  it('accepts only a v-prefixed stable semver tag', () => {
    expect(parseReleaseTag('v0.2.0')).toEqual({ version: '0.2.0' });
    for (const invalid of ['0.2.0', 'v0.2', 'v0.2.0-rc.1', 'release-0-2-0', 'v0.2.0.1', 'V0.2.0']) {
      expect(parseReleaseTag(invalid)).toBeNull();
    }
  });

  it('reads only the GitHub merge-commit subject shape', () => {
    expect(parseGitHubMergeSubject('Merge pull request #30 from rebuildup/release-0-2-0')).toEqual({
      prNumber: 30,
      owner: 'rebuildup',
      headBranch: 'release-0-2-0',
    });
    expect(parseGitHubMergeSubject('Merge pull request #9 from a/docs/release-0-2-0')).toEqual({
      prNumber: 9,
      owner: 'a',
      headBranch: 'docs/release-0-2-0',
    });
    for (const notAMerge of [
      'docs: document the release-0-2-0 rollback plan',
      'Merge branch tmp; revert release-0-2-0',
      'Squash and merge release-0-2-0',
      'Merge pull request #30 from rebuildup',
      'merge pull request #30 from rebuildup/release-0-2-0',
    ]) {
      expect(parseGitHubMergeSubject(notAMerge), notAMerge).toBeNull();
    }
  });
});

describe('expected release SHA resolution', () => {
  const merges = [
    {
      sha: RELEASE_SHA,
      parents: ['1111111', '2222222'],
      subject: 'Merge pull request #30 from rebuildup/release-0-2-0',
    },
    {
      sha: OTHER_SHA,
      parents: ['3333333'],
      subject: 'docs: mention release-0-2-0 in passing',
    },
    {
      sha: 'd'.repeat(40),
      parents: ['4444444', '5555555'],
      subject: 'Merge pull request #12 from rebuildup/release-0-1-0',
    },
  ];

  it('resolves the merge commit that integrated the release branch', () => {
    expect(resolveExpectedReleaseSha({ merges, releaseBranch: 'release-0-2-0' })).toEqual({
      sha: RELEASE_SHA,
      subject: 'Merge pull request #30 from rebuildup/release-0-2-0',
      candidates: 1,
      candidateShas: [RELEASE_SHA],
    });
  });

  it('ignores non-merge commits and other release branches', () => {
    expect(resolveExpectedReleaseSha({ merges, releaseBranch: 'release-0-9-9' })).toEqual({
      sha: null,
      subject: null,
      candidates: 0,
      candidateShas: [],
    });
  });

  it('ignores subjects that only mention the release branch', () => {
    // A loose whitespace-token scan used to qualify all of these, so the tag
    // could be pinned to a commit that never merged the release branch.
    const decoys = [
      'docs: document the release-0-2-0 rollback plan',
      'Merge branch tmp; revert release-0-2-0',
      'Squash and merge release-0-2-0',
      'chore: rename release-0-2-0-notes',
    ];
    for (const subject of decoys) {
      const result = resolveExpectedReleaseSha({
        merges: [{ sha: OTHER_SHA, parents: ['1', '2'], subject }],
        releaseBranch: 'release-0-2-0',
      });
      expect(result.candidates, subject).toBe(0);
      expect(result.sha, subject).toBeNull();
    }
  });

  it('reports every qualifying merge when the release branch was merged more than once', () => {
    const remerged = [
      { sha: OTHER_SHA, parents: ['1', '2'], subject: 'Merge pull request #40 from rebuildup/release-0-2-0' },
      ...merges,
    ];
    expect(resolveExpectedReleaseSha({ merges: remerged, releaseBranch: 'release-0-2-0' })).toEqual({
      sha: OTHER_SHA,
      subject: 'Merge pull request #40 from rebuildup/release-0-2-0',
      candidates: 2,
      candidateShas: [OTHER_SHA, RELEASE_SHA],
    });
  });

  it('refuses a re-merged release branch instead of silently pinning the newest', () => {
    // "newest wins" is a guess about what a public tag would point at, so
    // ambiguity is a refusal. This is the "publish the wrong thing" path.
    const result = evaluateReleasePublication(
      baseInput({
        expectedReleaseSha: {
          sha: OTHER_SHA,
          subject: 'Merge pull request #40 from rebuildup/release-0-2-0',
          candidates: 2,
          candidateShas: [OTHER_SHA, RELEASE_SHA],
        },
      }),
    );
    expect(isViolated(result, 'expected-release-sha-ambiguous')).toBe(true);
    expect(rule(result, 'expected-release-sha-ambiguous')?.message).toContain(RELEASE_SHA);
    expect(result.verdict).toBe('refused');
  });

  it('refuses when a branch whose last segment is the release branch also merged', () => {
    // `docs/release-0-2-0` is indistinguishable from a re-merge of the release
    // branch by subject alone, so the two candidates together must refuse.
    const result = evaluateReleasePublication(
      baseInput({
        expectedReleaseSha: {
          sha: OTHER_SHA,
          subject: 'Merge pull request #99 from rebuildup/docs/release-0-2-0',
          candidates: 2,
          candidateShas: [OTHER_SHA, RELEASE_SHA],
        },
      }),
    );
    expect(isViolated(result, 'expected-release-sha-ambiguous')).toBe(true);
    expect(result.violations.map((violation) => violation.rule)).toContain('target-release-sha');
  });
});

describe('release publication gate', () => {
  it('accepts an aligned v0.2.0 publication', () => {
    const result = evaluateReleasePublication(baseInput());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('publish');
    expect(result.plan).toEqual([
      'create tag "v0.2.0" at ' + RELEASE_SHA,
      'create GitHub Release "v0.2.0" at ' +
        RELEASE_SHA +
        ' with notes generated from merged pull requests',
    ]);
  });

  it.each(['', '0.2', '0.2.0-rc.1', 'v0.2.0', '../../etc', '0.2.0.1', '0.2.0 '])(
    'refuses the malformed package.json#version %j',
    (packageVersion) => {
      const result = evaluateReleasePublication(baseInput({ packageVersion }));
      expect(isViolated(result, 'version-source-format')).toBe(true);
      expect(rule(result, 'version-source-format')?.message).toContain(
        JSON.stringify(packageVersion),
      );
    },
  );

  it('refuses a version read from a commit other than the one being tagged', () => {
    const result = evaluateReleasePublication(baseInput({ sourceRef: 'de72ec3', sourceSha: OTHER_SHA }));
    expect(isViolated(result, 'version-source-sha')).toBe(true);
    const message = rule(result, 'version-source-sha')?.message ?? '';
    expect(message).toContain(RELEASE_SHA);
    expect(message).toContain(OTHER_SHA);
  });

  it('refuses a tag whose version differs from package.json#version and names both values', () => {
    const result = evaluateReleasePublication(baseInput({ tagName: 'v0.3.0' }));
    expect(isViolated(result, 'tag-version-match')).toBe(true);
    expect(result.verdict).toBe('refused');
    const message = rule(result, 'tag-version-match')?.message ?? '';
    expect(message).toContain('"0.2.0"');
    expect(message).toContain('"0.3.0"');
  });

  it.each(['0.2.0', 'v0.2', 'v0.2.0-rc.1', 'release-0-2-0', 'v0.2.0.1'])(
    'refuses the non-semantic tag %s',
    (tagName) => {
      const result = evaluateReleasePublication(baseInput({ tagName }));
      expect(isViolated(result, 'tag-format')).toBe(true);
      expect(rule(result, 'tag-format')?.message).toContain(tagName);
    },
  );

  it('refuses a release branch that does not match the version', () => {
    const result = evaluateReleasePublication(baseInput({ releaseBranch: 'release-0-1-0' }));
    expect(isViolated(result, 'release-branch-name')).toBe(true);
    const message = rule(result, 'release-branch-name')?.message ?? '';
    expect(message).toContain('"release-0-1-0"');
    expect(message).toContain('"release-0-2-0"');
  });

  it('refuses an unexpected target SHA', () => {
    const result = evaluateReleasePublication(baseInput({ targetSha: OTHER_SHA }));
    expect(isViolated(result, 'target-release-sha')).toBe(true);
    const message = rule(result, 'target-release-sha')?.message ?? '';
    expect(message).toContain(RELEASE_SHA);
    expect(message).toContain(OTHER_SHA);
  });

  it('refuses a target SHA that is not the released state on main', () => {
    const result = evaluateReleasePublication(baseInput({ targetOnMain: false }));
    expect(isViolated(result, 'target-sha-on-main')).toBe(true);
  });

  it('refuses a target SHA that no advertised remote ref contains', () => {
    const result = evaluateReleasePublication(
      baseInput({ remoteHasTargetSha: false, remoteContainingRefs: [] }),
    );
    expect(isViolated(result, 'target-sha-on-remote')).toBe(true);
  });

  it('refuses when the release branch is neither present nor recorded as merged', () => {
    const result = evaluateReleasePublication(
      baseInput({
        releaseBranchExists: false,
        releaseBranchTip: null,
        releaseBranchTipIsAncestor: null,
        expectedReleaseSha: { sha: null, subject: null, candidates: 0, candidateShas: [] },
      }),
    );
    expect(isViolated(result, 'expected-release-sha')).toBe(true);
    expect(isViolated(result, 'release-branch-evidence')).toBe(true);
  });

  it('accepts a deleted release branch when main records the merge', () => {
    const result = evaluateReleasePublication(
      baseInput({
        releaseBranchExists: false,
        releaseBranchTip: null,
        releaseBranchTipIsAncestor: null,
      }),
    );
    expect(result.violations).toEqual([]);
    expect(
      result.notes.some((note) => note.message.includes('is already deleted')),
    ).toBe(true);
  });

  it('refuses when a surviving release branch moved past the tagged state', () => {
    const result = evaluateReleasePublication(baseInput({ releaseBranchTipIsAncestor: false }));
    expect(isViolated(result, 'release-branch-ancestor')).toBe(true);
  });
});

describe('release gate checks', () => {
  it('refuses a required check that never ran', () => {
    const result = evaluateReleasePublication(baseInput({ checkRuns: [] }));
    expect(isViolated(result, 'release-gate')).toBe(true);
    expect(rule(result, 'release-gate')?.message).toContain('never treated as a pass');
  });

  it('refuses a required check that failed', () => {
    const result = evaluateReleasePublication(
      baseInput({ checkRuns: [passingCheckRun({ conclusion: 'failure' })] }),
    );
    expect(isViolated(result, 'release-gate')).toBe(true);
    expect(rule(result, 'release-gate')?.message).toContain('completed/failure');
  });

  it('refuses a required check that is still running', () => {
    const result = evaluateReleasePublication(
      baseInput({
        checkRuns: [passingCheckRun({ status: 'in_progress', conclusion: null })],
      }),
    );
    expect(isViolated(result, 'release-gate')).toBe(true);
  });

  it('refuses a queued re-run on top of an earlier success', () => {
    // A re-run supersedes the earlier run, exactly as GitHub decides a required
    // status check, so a queued run must be the one that decides the gate.
    const runs = [
      passingCheckRun({ id: 1, startedAt: '2026-09-27T00:00:00Z', completedAt: '2026-09-27T00:05:00Z' }),
      passingCheckRun({ id: 2, status: 'queued', conclusion: null, startedAt: '2026-09-27T02:00:00Z', completedAt: null }),
    ];
    expect(selectLatestCheckRun(runs, CI_CHECK)?.id).toBe(2);
    const result = evaluateReleasePublication(baseInput({ checkRuns: runs }));
    expect(isViolated(result, 'release-gate')).toBe(true);
    expect(rule(result, 'release-gate')?.message).toContain('queued/no-conclusion');
  });

  it('refuses when the check runs could not be read at all', () => {
    const result = evaluateReleasePublication(
      baseInput({ checkRunsReadable: false, checkRuns: [] }),
    );
    expect(isViolated(result, 'release-gate')).toBe(true);
    expect(rule(result, 'release-gate')?.message).toContain('undeterminable');
  });

  it('refuses when no required check is configured', () => {
    const result = evaluateReleasePublication(baseInput({ requiredChecks: [] }));
    expect(isViolated(result, 'release-gate')).toBe(true);
  });

  it('decides a required check by the latest run, the way GitHub does', () => {
    const runs = [
      passingCheckRun({
        conclusion: 'failure',
        completedAt: '2026-09-27T00:00:00Z',
        startedAt: '2026-09-26T23:55:00Z',
        id: 1,
      }),
      passingCheckRun({
        conclusion: 'success',
        completedAt: '2026-09-27T01:00:00Z',
        startedAt: '2026-09-27T00:55:00Z',
        id: 2,
      }),
    ];
    expect(selectLatestCheckRun(runs, CI_CHECK)?.id).toBe(2);
    expect(evaluateReleasePublication(baseInput({ checkRuns: runs })).violations).toEqual([]);
  });

  it('ignores check runs that the release state did not trigger, and says so', () => {
    const result = evaluateReleasePublication(
      baseInput({
        checkRuns: [
          passingCheckRun(),
          passingCheckRun({ headBranch: '26', conclusion: 'failure', id: 2 }),
        ],
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.notes.some((note) => note.rule === 'release-gate' && note.message.includes('ignored 1'))).toBe(
      true,
    );
  });

  it('keeps a check run with an unknown head branch in scope', () => {
    const result = evaluateReleasePublication(
      baseInput({
        checkRuns: [passingCheckRun({ headBranch: null, conclusion: 'failure' })],
      }),
    );
    expect(isViolated(result, 'release-gate')).toBe(true);
  });
});

describe('branch protection cross-check', () => {
  it('refuses when branch protection requires a check the release gate ignores', () => {
    const result = evaluateReleasePublication(
      baseInput({ protectionContexts: ['CI / some-other-gate'] }),
    );
    expect(isViolated(result, 'protection-sync')).toBe(true);
    expect(rule(result, 'protection-sync')?.message).toContain('some-other-gate');
  });

  it('accepts a merge-time pull request check as branch protection coverage', () => {
    const result = evaluateReleasePublication(
      baseInput({ protectionContexts: [`CI / ${CI_CHECK}`, ...PR_TIME_CHECK_CONTEXTS] }),
    );
    expect(result.violations).toEqual([]);
  });

  it('accepts a merge-time check registered under its bare check-run name', () => {
    const result = evaluateReleasePublication(
      baseInput({ protectionContexts: [CI_CHECK, 'release-source-check'] }),
    );
    expect(result.violations).toEqual([]);
    expect(
      result.notes.some(
        (note) => note.rule === 'protection-sync' && note.message.includes('merge-time pull request checks'),
      ),
    ).toBe(true);
  });

  it('says the cross-check was not performed rather than claiming nothing is required', () => {
    // The CI default. A `GITHUB_TOKEN` that cannot read branch protection must
    // never be reported as "main registers no required status check".
    const result = evaluateReleasePublication(
      baseInput({ protectionCheck: 'not-performed', protectionContexts: null }),
    );
    expect(result.violations).toEqual([]);
    const note = result.notes.find((entry) => entry.rule === 'protection-sync')?.message ?? '';
    expect(note).toContain('was not performed');
    expect(note).not.toContain('registers no required status check');
  });

  it('refuses --require-protection-configured when the cross-check was not performed', () => {
    const result = evaluateReleasePublication(
      baseInput({
        protectionCheck: 'not-performed',
        protectionContexts: null,
        requireProtectionConfigured: true,
      }),
    );
    expect(isViolated(result, 'protection-sync')).toBe(true);
    expect(rule(result, 'protection-sync')?.message).toContain('--cross-check-protection');
  });

  it('refuses --require-protection-configured when the answer was unreadable', () => {
    const result = evaluateReleasePublication(
      baseInput({ protectionContexts: null, requireProtectionConfigured: true }),
    );
    expect(isViolated(result, 'protection-sync')).toBe(true);
    expect(rule(result, 'protection-sync')?.message).toContain('could not be read');
  });

  it('refuses a missing branch protection configuration only when asked to', () => {
    expect(
      evaluateReleasePublication(baseInput({ protectionContexts: [] })).violations,
    ).toEqual([]);
    expect(
      isViolated(
        evaluateReleasePublication(
          baseInput({ protectionContexts: [], requireProtectionConfigured: true }),
        ),
        'protection-sync',
      ),
    ).toBe(true);
  });
});

describe('publication idempotency', () => {
  it('is a no-op when the tag and the release already exist at the expected commit', () => {
    const result = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: { sha: RELEASE_SHA, draft: false, prerelease: false },
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.verdict).toBe('already-published');
    expect(result.plan).toEqual([
      'no-op: tag and GitHub Release "v0.2.0" already exist at ' + RELEASE_SHA,
    ]);
  });

  it('resumes a half-finished publication with a single release step', () => {
    // The tag exists and the Release does not: a previous run failed between
    // the two. That is `publish`, not `already-published`, and the plan is the
    // one missing step.
    const result = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: null,
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.verdict).toBe('publish');
    expect(result.plan).toEqual([
      'create GitHub Release "v0.2.0" at ' +
        RELEASE_SHA +
        ' with notes generated from merged pull requests',
    ]);
  });

  it('explains a symbolic target_commitish on an otherwise reusable release', () => {
    const result = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: {
          sha: RELEASE_SHA,
          targetCommitish: 'main',
          draft: false,
          prerelease: false,
        },
      }),
    );
    expect(result.verdict).toBe('already-published');
    expect(
      result.notes.some(
        (note) => note.rule === 'release-idempotency' && note.message.includes('target_commitish "main"'),
      ),
    ).toBe(true);
  });

  it('refuses when the tag exists at a different commit', () => {
    const result = evaluateReleasePublication(baseInput({ existingTag: { sha: OTHER_SHA } }));
    expect(isViolated(result, 'tag-idempotency')).toBe(true);
    const message = rule(result, 'tag-idempotency')?.message ?? '';
    expect(message).toContain(OTHER_SHA);
    expect(message).toContain(RELEASE_SHA);
  });

  it('refuses an existing draft or pre-release for the same tag', () => {
    const draft = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: { sha: RELEASE_SHA, draft: true, prerelease: false },
      }),
    );
    expect(isViolated(draft, 'release-idempotency')).toBe(true);
    expect(rule(draft, 'release-idempotency')?.message).toContain('still a draft');

    const prerelease = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: { sha: RELEASE_SHA, draft: false, prerelease: true },
      }),
    );
    expect(isViolated(prerelease, 'release-idempotency')).toBe(true);
  });

  it('refuses a release artifact that points at a different commit', () => {
    const result = evaluateReleasePublication(
      baseInput({
        existingTag: { sha: RELEASE_SHA },
        existingRelease: { sha: OTHER_SHA, draft: false, prerelease: false },
      }),
    );
    expect(isViolated(result, 'release-idempotency')).toBe(true);
  });

  it('refuses a duplicate release that already carries the same version', () => {
    const result = evaluateReleasePublication(baseInput({ conflictingReleaseTags: ['0.2.0'] }));
    expect(isViolated(result, 'no-duplicate-release-artifacts')).toBe(true);
    expect(rule(result, 'no-duplicate-release-artifacts')?.message).toContain('"0.2.0"');
  });

  it('refuses a duplicate git tag for the same version', () => {
    const result = evaluateReleasePublication(baseInput({ conflictingTagRefs: ['0.2.0'] }));
    expect(isViolated(result, 'no-duplicate-release-artifacts')).toBe(true);
    expect(rule(result, 'no-duplicate-release-artifacts')?.message).toContain('"0.2.0"');
  });

  it('refuses when the duplicate inventory could not be read', () => {
    // An unreadable list must never be read as "no duplicates".
    const result = evaluateReleasePublication(baseInput({ conflictingReleaseTagsReadable: false }));
    expect(isViolated(result, 'no-duplicate-release-artifacts')).toBe(true);
    expect(rule(result, 'no-duplicate-release-artifacts')?.message).toContain('could not be listed');
  });
});

describe('verify-release CLI argument parsing', () => {
  it('defaults to plan mode, main, origin, and the local-only protection check', () => {
    expect(parseArgs([])).toEqual({
      tag: null,
      releaseBranch: null,
      sha: null,
      sourceRef: null,
      mainRef: 'main',
      remote: 'origin',
      repo: null,
      requiredChecks: [],
      crossCheckProtection: false,
      requireProtectionConfigured: false,
      apply: false,
      fetch: true,
      help: false,
    });
  });

  it('accepts both `--opt value` and `--opt=value`', () => {
    expect(parseArgs(['--sha', 'abc', '--tag=v1.2.3', '--release-branch', 'release-1-2-3']).sha).toBe('abc');
    expect(parseArgs(['--sha', 'abc', '--tag=v1.2.3']).tag).toBe('v1.2.3');
  });

  it('collects repeated --required-check values', () => {
    expect(parseArgs(['--required-check', 'a', '--required-check', 'b']).requiredChecks).toEqual([
      'a',
      'b',
    ]);
  });

  it('parses the boolean switches, including help', () => {
    const options = parseArgs([
      '--apply',
      '--no-fetch',
      '--cross-check-protection',
      '--require-protection-configured',
      '-h',
    ]);
    expect(options.apply).toBe(true);
    expect(options.fetch).toBe(false);
    expect(options.crossCheckProtection).toBe(true);
    expect(options.requireProtectionConfigured).toBe(true);
    expect(options.help).toBe(true);
  });

  it('rejects an unknown option and a version override', () => {
    expect(() => parseArgs(['--version', '9.9.9'])).toThrow(FactsError);
    expect(() => parseArgs(['--version', '9.9.9'])).toThrow(/version source of truth/);
  });

  it('rejects an option that is missing its value', () => {
    expect(() => parseArgs(['--sha'])).toThrow(FactsError);
    expect(() => parseArgs(['--sha'])).toThrow(/requires a value/);
  });
});

describe('verify-release CLI fact parsing', () => {
  it('reads the first non-empty line', () => {
    expect(firstLine('\n\n  detail  \nsecond')).toBe('detail');
    expect(firstLine('   \n\n')).toBe('');
  });

  it('reads a version out of a package.json body', () => {
    expect(parsePackageVersion('{\n  "version": "0.2.0"\n}\n', 'abc')).toBe('0.2.0');
  });

  it('reports a malformed package.json as an unavailable fact, not a stack trace', () => {
    // Exit 2 means "facts unavailable"; exit 1 means "a rule was violated", and
    // a broken file violates no rule.
    expect(() => parsePackageVersion('{ "version": ', 'abc')).toThrow(FactsError);
    expect(() => parsePackageVersion('{ "version": ', 'abc')).toThrow(/not valid JSON/);
  });

  it('reports a package.json without a string version as an unavailable fact', () => {
    expect(() => parsePackageVersion('{"version": 2}', 'abc')).toThrow(/no string version field/);
    expect(() => parsePackageVersion('[]', 'abc')).toThrow(/no string version field/);
  });

  it('treats a 404 as a transport signal, not as a fact about the repository', () => {
    expect(isNotFound({ ok: false, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })).toBe(true);
    expect(isNotFound({ ok: false, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' })).toBe(false);
    // Only a body that names the missing section is evidence of an empty one.
    expect(
      protectionSectionAbsent({
        ok: false,
        stdout: '',
        stderr: 'gh: Required status checks not enabled (HTTP 404)',
      }),
    ).toBe(true);
    expect(
      protectionSectionAbsent({ ok: false, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' }),
    ).toBe(false);
    expect(protectionSectionAbsent({ ok: false, stdout: '', stderr: 'HTTP 403' })).toBe(false);
  });

  it('maps a check-runs body and keeps an unreadable suite head branch in scope', () => {
    const runs = mapCheckRuns(
      {
        check_runs: [
          {
            id: 7,
            name: CI_CHECK,
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-09-27T00:00:00Z',
            completed_at: '2026-09-27T00:05:00Z',
            html_url: 'https://example.invalid/1',
            check_suite: { id: 42 },
          },
        ],
      },
      (suiteId) => (suiteId === 42 ? { head_branch: 'main' } : null),
    );
    expect(runs).toEqual([
      {
        name: CI_CHECK,
        status: 'completed',
        conclusion: 'success',
        headBranch: 'main',
        startedAt: '2026-09-27T00:00:00Z',
        completedAt: '2026-09-27T00:05:00Z',
        id: 7,
        url: 'https://example.invalid/1',
      },
    ]);
    // A suite that cannot be read yields `null`, which the gate keeps in scope.
    expect(mapCheckRuns({ check_runs: [{ name: 'x', check_suite: { id: 9 } }] }, () => null)[0]?.headBranch).toBeNull();
    expect(mapCheckRuns({}, () => null)).toEqual([]);
  });

  it('reads required status checks from both protection shapes', () => {
    expect(
      protectionContextsFrom({ contexts: ['a'], checks: [{ context: 'b' }, { context: 'a' }] }),
    ).toEqual(['a', 'b']);
    expect(protectionContextsFrom({})).toEqual([]);
  });

  it('takes the shipped commit from the tag, not from an unresolvable target_commitish', () => {
    const resolveLocal = (ref: string) => (ref === 'main' ? OTHER_SHA : null);
    expect(resolveCommitish(RELEASE_SHA, RELEASE_SHA, resolveLocal)).toBe(RELEASE_SHA);
    expect(resolveCommitish(RELEASE_SHA, 'HEAD', resolveLocal)).toBe(RELEASE_SHA);
    expect(resolveCommitish(RELEASE_SHA, 'main', resolveLocal)).toBe(OTHER_SHA);
    // A branch or tag name that does not resolve is not a different commit.
    expect(resolveCommitish(RELEASE_SHA, 'v0.2.0', resolveLocal)).toBe(RELEASE_SHA);
    expect(resolveCommitish(null, 'v0.2.0', resolveLocal)).toBeNull();
    expect(resolveCommitish(RELEASE_SHA, null, resolveLocal)).toBeNull();
  });
});

describe('duplicate release artifact scan', () => {
  const noTags = () => [];

  it('finds a stray tag that shadows the version', () => {
    const scan = scanConflictingReleaseArtifacts({
      version: '0.2.0',
      tagName: 'v0.2.0',
      listReleases: () => [{ tag_name: 'v0.1.0' }],
      listTagRefs: () => [{ ref: 'refs/tags/v0.1.0' }, { ref: 'refs/tags/0.2.0' }],
    });
    expect(scan.readable).toBe(true);
    expect(scan.conflictingTagRefs).toEqual(['0.2.0']);
    expect(scan.conflictingReleaseTags).toEqual([]);
  });

  it('does not report the intended artifact as a duplicate of itself', () => {
    const scan = scanConflictingReleaseArtifacts({
      version: '0.1.0',
      tagName: 'v0.1.0',
      listReleases: () => [{ tag_name: 'v0.1.0' }],
      listTagRefs: () => [{ ref: 'refs/tags/v0.1.0' }],
    });
    expect(scan.readable).toBe(true);
    expect(scan.conflictingReleaseTags).toEqual([]);
    expect(scan.conflictingTagRefs).toEqual([]);
  });

  it('paginates past the first 100 Releases', () => {
    const requested: number[] = [];
    const scan = scanConflictingReleaseArtifacts({
      version: '0.2.0',
      tagName: 'v0.2.0',
      listReleases: (page) => {
        requested.push(page);
        if (page === 1) {
          return Array.from({ length: 100 }, (_unused, index) => ({ tag_name: `v0.0.${index}` }));
        }
        return [{ tag_name: '0.2.0' }];
      },
      listTagRefs: noTags,
    });
    expect(requested).toEqual([1, 2]);
    expect(scan.readable).toBe(true);
    expect(scan.conflictingReleaseTags).toEqual(['0.2.0']);
  });

  it('refuses to conclude when the release list is unreadable', () => {
    const scan = scanConflictingReleaseArtifacts({
      version: '0.2.0',
      tagName: 'v0.2.0',
      listReleases: () => null,
      listTagRefs: noTags,
    });
    expect(scan.readable).toBe(false);
    expect(scan.detail).toContain('could not be read');
  });

  it('refuses to conclude when the tag list is unreadable', () => {
    const scan = scanConflictingReleaseArtifacts({
      version: '0.2.0',
      tagName: 'v0.2.0',
      listReleases: () => [],
      listTagRefs: () => {
        throw new FactsError('gh api failed');
      },
    });
    expect(scan.readable).toBe(false);
    expect(scan.detail).toContain('could not be read');
  });

  it('refuses to conclude on a truncated scan', () => {
    const requested: number[] = [];
    const scan = scanConflictingReleaseArtifacts({
      version: '0.2.0',
      tagName: 'v0.2.0',
      listReleases: (page) => {
        requested.push(page);
        // A full page every time, so the scan runs to its page cap.
        return Array.from({ length: 100 }, () => ({ tag_name: 'v9.9.9' }));
      },
      listTagRefs: noTags,
    });
    expect(requested.length).toBeGreaterThan(1);
    expect(scan.readable).toBe(false);
    expect(scan.detail).toContain('without reading all of them');
  });
});

describe('post-condition assertion', () => {
  it('accepts a tag and a published release at the target commit', () => {
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, {
        readTag: () => ({ sha: RELEASE_SHA }),
        readRelease: () => ({ sha: RELEASE_SHA, draft: false, prerelease: false }),
      }),
    ).not.toThrow();
  });

  it('refuses a missing or moved tag', () => {
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, {
        readTag: () => null,
        readRelease: () => null,
      }),
    ).toThrow(/tag v0.2.0 is missing/);
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, {
        readTag: () => ({ sha: OTHER_SHA }),
        readRelease: () => null,
      }),
    ).toThrow(/expected/);
  });

  it('refuses a missing, moved, or draft Release', () => {
    const withTag = { readTag: () => ({ sha: RELEASE_SHA }) };
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, { ...withTag, readRelease: () => null }),
    ).toThrow(/GitHub Release v0.2.0 is missing/);
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, {
        ...withTag,
        readRelease: () => ({ sha: OTHER_SHA, draft: false, prerelease: false }),
      }),
    ).toThrow(/points at/);
    expect(() =>
      assertPublished('o/r', 'v0.2.0', RELEASE_SHA, {
        ...withTag,
        readRelease: () => ({ sha: RELEASE_SHA, draft: true, prerelease: false }),
      }),
    ).toThrow(/still a draft/);
  });
});
