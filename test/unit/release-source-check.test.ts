import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  evaluateReleaseSource,
  expectedHeadShaFromEvent,
  readCheckedOutSha,
  readPackageVersion,
  runGate,
} from '../../scripts/release-source-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/release-source-check.yml');

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MERGE_SHA = 'f0e1d2c3b4a5968778695a4b3c2d1e0f91827364';

function gate(input: {
  headRef: string | null;
  version: string | null;
  expectedHeadSha?: string | null;
  checkedOutSha?: string | null;
}) {
  return evaluateReleaseSource({
    headRef: input.headRef,
    version: input.version,
    // `in` rather than `??`: an explicit `null` is a case under test
    // (the gate must fail closed), not a request for the default.
    expectedHeadSha: 'expectedHeadSha' in input ? input.expectedHeadSha : HEAD_SHA,
    checkedOutSha: 'checkedOutSha' in input ? input.checkedOutSha : HEAD_SHA,
  });
}

function codes(violations: ReadonlyArray<{ code: string }>): string[] {
  return violations.map((violation) => violation.code);
}

describe('a well-formed release source passes', () => {
  it('accepts a release branch whose head commit ships the matching version', () => {
    const result = gate({ headRef: 'release-0-4-0', version: '0.4.0' });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.expectedRef).toBe('release-0-4-0');
  });
});

describe('the head branch name must match the HEAD COMMIT version', () => {
  it('rejects a release branch whose own package.json disagrees with its name', () => {
    // The exact false-green condition from #52: the branch is called
    // release-0-3-0 but the commit it would merge still says 0.2.0.
    const result = gate({ headRef: 'release-0-3-0', version: '0.2.0' });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('head-ref-version-mismatch');
    expect(result.violations[0]?.message).toContain("PR head 'release-0-3-0'");
    expect(result.violations[0]?.message).toContain("expected 'release-0-2-0'");
  });

  it('rejects a non-release head branch', () => {
    const result = gate({ headRef: 'main', version: '0.4.0' });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('head-ref-not-release-branch');
  });

  it('rejects an empty head ref rather than treating it as a pass', () => {
    const result = gate({ headRef: '', version: '0.4.0' });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('head-ref-missing');
  });

  it('rejects a version that is not stable semver', () => {
    const result = gate({ headRef: 'release-0-4-0', version: '0.4.0-rc.1' });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('package-version-malformed');
  });

  it('rejects an unreadable version rather than skipping the comparison', () => {
    const result = gate({ headRef: 'release-0-4-0', version: null });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('package-version-missing');
  });
});

describe('the gate fails closed when it cannot prove which commit it checked', () => {
  it('rejects a checkout that is not the pull request head', () => {
    // This is the guard that keeps a future edit which drops the
    // `ref:` on actions/checkout from silently restoring the false green.
    const result = gate({
      headRef: 'release-0-3-0',
      version: '0.3.0',
      expectedHeadSha: HEAD_SHA,
      checkedOutSha: MERGE_SHA,
    });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('checkout-not-at-head');
    expect(result.violations[0]?.message).toContain(MERGE_SHA);
    expect(result.violations[0]?.message).toContain(HEAD_SHA);
  });

  it('rejects a run with no head SHA at all', () => {
    const result = gate({
      headRef: 'release-0-4-0',
      version: '0.4.0',
      expectedHeadSha: null,
      checkedOutSha: null,
    });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('head-sha-missing');
  });

  it('rejects a run that cannot determine the checked-out commit', () => {
    const result = gate({
      headRef: 'release-0-4-0',
      version: '0.4.0',
      expectedHeadSha: HEAD_SHA,
      checkedOutSha: null,
    });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain('head-sha-unverifiable');
  });

  it('reports every violation rather than stopping at the first', () => {
    const result = gate({
      headRef: 'feature/x',
      version: null,
      expectedHeadSha: null,
      checkedOutSha: null,
    });
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toEqual([
      'head-sha-missing',
      'head-ref-not-release-branch',
      'package-version-missing',
    ]);
  });
});

describe('the head SHA is read from the event payload, not from GITHUB_SHA', () => {
  it('extracts github.event.pull_request.head.sha', () => {
    expect(expectedHeadShaFromEvent({ pull_request: { head: { sha: HEAD_SHA } } })).toBe(HEAD_SHA);
  });

  it('returns null rather than a default for a payload without a head', () => {
    expect(expectedHeadShaFromEvent({})).toBeNull();
    expect(expectedHeadShaFromEvent({ pull_request: {} })).toBeNull();
    expect(expectedHeadShaFromEvent({ pull_request: { head: { sha: '' } } })).toBeNull();
    expect(expectedHeadShaFromEvent(null)).toBeNull();
  });
});

describe('the committed workflow verifies the head commit, not the synthetic merge', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  function checkoutRef(text: string): string {
    return /- uses: actions\/checkout@[\w.]+\n(?: {8}.*\n)*? {8}ref: *(.*)\n/.exec(text)?.[1] ?? '';
  }

  it('pins actions/checkout to the pull request head SHA', () => {
    // Without an explicit `ref:`, actions/checkout resolves GITHUB_SHA,
    // which on pull_request is refs/pull/<n>/merge. That is the bug.
    const checkoutBlock = /- uses: actions\/checkout@[\w.]+\n(?: {8}.*\n)*/.exec(workflow);
    expect(checkoutBlock, 'the workflow has an actions/checkout step').not.toBeNull();
    expect(checkoutBlock?.[0]).toContain('ref: ${{ github.event.pull_request.head.sha }}');
  });

  it('derives that SHA from the pull request head, not from GITHUB_SHA', () => {
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    // `ref:` must never be left to default to the synthetic merge.
    expect(checkoutRef(workflow)).not.toBe('GITHUB_SHA');
  });

  it('never trades the gate for a success it cannot back', () => {
    // No escape hatches anywhere in the gate: a failure here is the
    // signal the required status check exists to produce.
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toMatch(/\|\|\s*true/);
    expect(workflow).not.toMatch(/exit 0/);
  });

  it('has no condition that could make the job silently not run', () => {
    const jobBlock = workflow.slice(workflow.indexOf('\njobs:\n'));
    expect(jobBlock).not.toMatch(/^\s{4}if:/m);
    expect(jobBlock).not.toMatch(/^\s{6}if:/m);
  });

  it('delegates the decision to the tested module', () => {
    expect(workflow).toContain('node scripts/release-source-check.mjs');
  });
});

describe('reading package.json never throws', () => {
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsc-package-json-'));
    scratchDirs.push(dir);
    return dir;
  }

  it('reads a well-formed version', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "u-sekai", "version": "0.4.0" }');
    expect(readPackageVersion(dir)).toEqual({ version: '0.4.0', error: null });
  });

  it('reports a missing file instead of throwing', () => {
    expect(readPackageVersion(scratch()).error).toMatch(/cannot read package\.json/);
  });

  it('reports invalid JSON instead of throwing', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'package.json'), '{ not json');
    const result = readPackageVersion(dir);
    expect(result.version).toBeNull();
    expect(result.error).toMatch(/not valid JSON/);
  });

  it('reports a non-string version instead of throwing', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'package.json'), '{ "version": 4 }');
    expect(readPackageVersion(dir).error).toMatch(/no string "version" field/);
  });
});

describe('the false green, reproduced against a real git merge', () => {
  // This is the #52 regression, built the way GitHub builds it: a base
  // branch that moved on, a head branch that did not touch the file the
  // gate reads, and the synthetic merge that GitHub would check out.
  //
  //   main      0.2.0 ──▶ 0.3.0
  //     └── release-0-3-0 (adds NOTES.md, never bumps package.json)
  //
  // The merge tree carries main's 0.3.0. A gate that reads package.json
  // from the merge compares 0.3.0 against the head branch name
  // release-0-3-0, agrees, and reports green — for a head branch that
  // actually still ships 0.2.0.
  const roots: string[] = [];
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function writePkg(dir: string, version: string): void {
    writeFileSync(
      path.join(dir, 'package.json'),
      `{\n  "name": "u-sekai",\n  "version": "${version}",\n  "private": true\n}\n`,
    );
  }

  function buildFalseGreenFixture(): {
    headSha: string;
    mergeSha: string;
    root: string;
  } {
    const root = mkdtempSync(path.join(tmpdir(), 'rsc-false-green-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main', '.');
    git(root, 'config', 'user.email', 'gate-test@example.invalid');
    git(root, 'config', 'user.name', 'release-source-check test');

    writePkg(root, '0.2.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base 0.2.0');

    // Head branch: adds work, never bumps package.json.
    git(root, 'checkout', '-q', '-b', 'release-0-3-0');
    writeFileSync(path.join(root, 'NOTES.md'), 'release notes\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'head work, package.json untouched');
    const headSha = git(root, 'rev-parse', 'HEAD');

    // Base branch moves on and bumps the version the head never took.
    git(root, 'checkout', '-q', 'main');
    writePkg(root, '0.3.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main bumps to 0.3.0');

    // The synthetic merge ref GitHub checks out for a pull_request event.
    git(root, 'checkout', '-q', '-b', 'synthetic-merge', 'main');
    git(root, 'merge', '-q', '--no-edit', 'release-0-3-0');
    const mergeSha = git(root, 'rev-parse', 'HEAD');

    return { headSha, mergeSha, root };
  }

  /**
   * Run the shipped gate exactly as the workflow does. A non-zero exit is
   * the expected result for a failing gate, not a test failure, so the
   * streams are returned rather than thrown.
   */
  function runShippedGate(
    root: string,
    headRef: string,
    eventHeadSha: string,
  ): { stdout: string; stderr: string; code: number } {
    // The gate reads its own source from the tree it verifies; copy the
    // real scripts in rather than reimplementing the logic here.
    execFileSync('cp', ['-r', path.join(repoRoot, 'scripts'), path.join(root, 'scripts')]);
    const eventPath = path.join(root, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { ref: headRef, sha: eventHeadSha } } }),
    );
    try {
      const stdout = execFileSync('node', [path.join(root, 'scripts/release-source-check.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HEAD_REF: headRef, GITHUB_EVENT_PATH: eventPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: String(failure.stdout ?? ''),
        stderr: String(failure.stderr ?? ''),
        code: failure.status ?? -1,
      };
    }
  }

  it('sees the base version on the merge tree and the head version on the head tree', () => {
    const { headSha, mergeSha, root } = buildFalseGreenFixture();

    expect(JSON.parse(git(root, 'show', `${headSha}:package.json`)).version).toBe('0.2.0');
    expect(JSON.parse(git(root, 'show', `${mergeSha}:package.json`)).version).toBe('0.3.0');
  });

  it('reproduces the false green: reading the merge tree passes the head branch name', () => {
    const { headSha, mergeSha, root } = buildFalseGreenFixture();

    // The pre-fix gate: checkout with no `ref:` lands on the merge, and
    // the merge's package.json is main's. The comparison succeeds.
    const preFix = evaluateReleaseSource({
      headRef: 'release-0-3-0',
      version: readPackageVersion(root).version,
      expectedHeadSha: headSha,
      checkedOutSha: mergeSha,
    });
    expect(readPackageVersion(root).version).toBe('0.3.0');
    // Only the checkout pin stands between this and a green light; with
    // it removed the branch-name comparison alone would pass.
    const branchOnly = evaluateReleaseSource({
      headRef: 'release-0-3-0',
      version: '0.3.0',
      expectedHeadSha: headSha,
      checkedOutSha: headSha,
    });
    expect(branchOnly.ok).toBe(true);
    expect(preFix.violations.map((violation) => violation.code)).toContain('checkout-not-at-head');
  });

  it('fails on the head tree, which is what the fixed workflow reads', () => {
    const { headSha, root } = buildFalseGreenFixture();
    git(root, 'checkout', '-q', '--detach', headSha);

    const result = runGate(collectingIo(), root, {
      headRef: 'release-0-3-0',
      expectedHeadSha: headSha,
    });

    expect(result).toBe(1);
    expect(readPackageVersion(root).version).toBe('0.2.0');
    expect(readCheckedOutSha(root)).toBe(headSha);
  });

  it('goes red, not green, if a future edit drops the checkout pin', () => {
    // The regression this whole change exists to prevent: someone
    // removes `ref:` from actions/checkout, the tree lands on the
    // synthetic merge, and the merge's package.json happens to agree
    // with the branch name. The gate must refuse to report a result.
    const { headSha, root } = buildFalseGreenFixture();

    // Stand on the merge (what an unpinned checkout gives) while still
    // being asked to verify the head.
    git(root, 'checkout', '-q', '--detach', git(root, 'rev-parse', 'synthetic-merge'));

    const gate = runShippedGate(root, 'release-0-3-0', headSha);
    expect(gate.code).not.toBe(0);
    expect(gate.stderr).toContain('checkout-not-at-head');
  });

  it('refuses to report anything without an event payload to identify the head', () => {
    const { headSha, root } = buildFalseGreenFixture();
    git(root, 'checkout', '-q', '--detach', headSha);
    execFileSync('cp', ['-r', path.join(repoRoot, 'scripts'), path.join(root, 'scripts')]);

    let stderr = '';
    try {
      execFileSync('node', [path.join(root, 'scripts/release-source-check.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HEAD_REF: 'release-0-3-0', GITHUB_EVENT_PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }
    expect(stderr).toContain('GITHUB_EVENT_PATH is not set');
  });

  it('runs the shipped script end to end and exits non-zero on the false-green fixture', () => {
    const { headSha, root } = buildFalseGreenFixture();
    git(root, 'checkout', '-q', '--detach', headSha);

    const gate = runShippedGate(root, 'release-0-3-0', headSha);
    expect(gate.code).not.toBe(0);
    expect(gate.stderr).toContain('head-ref-version-mismatch');
    expect(gate.stderr).toContain("PR head 'release-0-3-0'");
  });

  it('exits zero from the shipped script when the head branch is genuinely consistent', () => {
    const { headSha, root } = buildFalseGreenFixture();
    git(root, 'checkout', '-q', '--detach', headSha);
    // The branch is release-0-3-0; bring its content in line with its name.
    writePkg(root, '0.3.0');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'bump to 0.3.0');
    const consistentHead = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach', consistentHead);

    const gate = runShippedGate(root, 'release-0-3-0', consistentHead);
    expect(gate.stderr).toBe('');
    expect(gate.code).toBe(0);
    expect(gate.stdout).toContain("head 'release-0-3-0'");
    expect(gate.stdout).toContain("version '0.3.0'");
  });
});

function collectingIo(): { info: (m: string) => void; error: (m: string) => void; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => undefined,
    error: (message: string) => errors.push(message),
  };
}
