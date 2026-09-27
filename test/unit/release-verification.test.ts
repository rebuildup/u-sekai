import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REQUIRED_RELEASE_CHECKS,
  PR_TIME_CHECK_CONTEXTS,
  deriveReleaseBranchName,
  evaluateReleasePublication,
  parseReleaseTag,
  resolveExpectedReleaseSha,
  selectLatestCheckRun,
} from '../../scripts/release-rules.mjs';
import type {
  CheckRun,
  ReleaseEvaluation,
  ReleaseEvaluationInput,
} from '../../scripts/release-rules.mjs';

const RELEASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BRANCH_TIP = 'c1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CI_CHECK = 'lint + typecheck + build + test';

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
    mainRef: 'origin/main',
    packageVersion: '0.2.0',
    tagName: 'v0.2.0',
    releaseBranch: 'release-0-2-0',
    targetSha: RELEASE_SHA,
    expectedReleaseSha: {
      sha: RELEASE_SHA,
      subject: 'Merge pull request #30 from rebuildup/release-0-2-0',
    },
    remoteHasTargetSha: true,
    remoteContainingRefs: ['origin/main'],
    targetOnMain: true,
    releaseBranchExists: true,
    releaseBranchTip: BRANCH_TIP,
    releaseBranchTipIsAncestor: true,
    requiredChecks: [CI_CHECK],
    gateSource: 'test',
    protectionContexts: [`CI / ${CI_CHECK}`],
    requireProtectionConfigured: false,
    checkRunsReadable: true,
    checkRuns: [passingCheckRun()],
    applicableBranches: ['main', 'release-0-2-0'],
    existingTag: null,
    existingRelease: null,
    conflictingReleaseTags: [],
    ...overrides,
  };
}

function rule(result: ReleaseEvaluation, name: string) {
  return result.checks.find((check) => check.rule === name);
}

function isViolated(result: ReleaseEvaluation, name: string): boolean {
  return result.violations.some((violation) => violation.rule === name);
}

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
    });
  });

  it('ignores non-merge commits and other release branches', () => {
    expect(resolveExpectedReleaseSha({ merges, releaseBranch: 'release-0-9-9' })).toEqual({
      sha: null,
      candidates: 0,
    });
  });

  it('takes the newest merge when a release branch was merged more than once', () => {
    const remerged = [
      { sha: OTHER_SHA, parents: ['1', '2'], subject: 'Merge pull request #40 from rebuildup/release-0-2-0' },
      ...merges,
    ];
    expect(resolveExpectedReleaseSha({ merges: remerged, releaseBranch: 'release-0-2-0' })).toEqual({
      sha: OTHER_SHA,
      subject: 'Merge pull request #40 from rebuildup/release-0-2-0',
      candidates: 2,
    });
  });

  it('reports a re-merged release branch instead of hiding it', () => {
    const result = evaluateReleasePublication(
      baseInput({
        expectedReleaseSha: {
          sha: RELEASE_SHA,
          subject: 'Merge pull request #30 from rebuildup/release-0-2-0',
          candidates: 2,
        },
      }),
    );
    expect(result.violations).toEqual([]);
    expect(
      result.notes.some((note) => note.rule === 'expected-release-sha' && note.message.includes('2 times')),
    ).toBe(true);
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
        expectedReleaseSha: { sha: null, candidates: 0 },
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

  it('refuses a missing branch protection configuration only when asked to', () => {
    expect(
      evaluateReleasePublication(baseInput({ protectionContexts: [] })).violations,
    ).toEqual([]);
    expect(
      isViolated(
        evaluateReleasePublication(
          baseInput({ protectionContexts: null, requireProtectionConfigured: true }),
        ),
        'protection-sync',
      ),
    ).toBe(true);
  });

  it('ships a default release gate that matches the CI job name', () => {
    expect(DEFAULT_REQUIRED_RELEASE_CHECKS).toEqual([CI_CHECK]);
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
});
