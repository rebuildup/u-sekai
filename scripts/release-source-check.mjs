/**
 * Decision logic for the `release-source-check` gate.
 *
 * The gate exists to enforce ADR-0003: a pull request that merges into
 * `main` must come from a `release-<major>-<minor>-<patch>` branch whose
 * name agrees with the version the branch actually ships. It is a required
 * status check on `main`, so a green result must mean the claim was
 * *verified*, not merely that a comparison happened to succeed.
 *
 * ## Why this lives in a module and not in the workflow
 *
 * The check used to be inline shell in
 * `.github/workflows/release-source-check.yml`, which made the gate
 * impossible to test. It is extracted here so `test/unit/` can construct
 * the failing conditions directly, and the workflow invokes *this* module
 * — the tested code is the code that runs in CI, not a stand-in for it.
 *
 * ## Which commit is under test
 *
 * On a `pull_request` event `GITHUB_SHA` is the synthetic merge
 * (`refs/pull/<n>/merge`), and `actions/checkout` with no `ref:` checks
 * that out. Reading `package.json` from there reads the **base** branch's
 * copy of every file the pull request did not change, so a head branch
 * named `release-0-3-0` while its own `package.json` still says `0.2.0`
 * passes the gate as soon as `main` has moved to `0.3.0`. That is the
 * false green this module exists to close.
 *
 * The fix has two halves and both are required:
 *
 * 1. the workflow checks out `github.event.pull_request.head.sha`, so
 *    `package.json` is the head's; and
 * 2. this module refuses to pass unless the working tree is provably at
 *    that head SHA, so a future edit that drops the `ref:` fails loudly
 *    instead of silently reverting to the merge.
 *
 * Every rule below is fail-closed: an unreadable, unparseable, or
 * unverifiable fact is a violation, never a pass.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveReleaseBranchName } from './release-rules.mjs';

/** ADR-0003: a release branch is `release-<major>-<minor>-<patch>`. */
const RELEASE_BRANCH_PATTERN = /^release-[0-9]+-[0-9]+-[0-9]+$/;

/** Stable semver only. A pre-release or missing patch is not shippable. */
const STABLE_SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * @typedef {{
 *   code: string,
 *   message: string,
 * }} ReleaseSourceViolation
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   expectedRef: string | null,
 *   version: string | null,
 *   violations: ReleaseSourceViolation[],
 * }} ReleaseSourceEvaluation
 */

/**
 * @typedef {{
 *   headRef: string | null,
 *   version: string | null,
 *   expectedHeadSha: string | null,
 *   checkedOutSha: string | null,
 * }} ReleaseSourceInput
 */

/**
 * The PR head commit this gate must verify.
 *
 * Read from the event payload rather than from `GITHUB_SHA`, because
 * `GITHUB_SHA` is the synthetic merge on `pull_request` and is exactly
 * the value this gate must not trust.
 *
 * @param {unknown} event a `pull_request` event payload (or any subset)
 * @returns {string | null} the head SHA, or `null` when absent/unusable
 */
export function expectedHeadShaFromEvent(event) {
  const pullRequest = asRecord(asRecord(event).pull_request);
  const sha = asRecord(pullRequest.head).sha;
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

/**
 * Read `package.json#version` from a working tree without throwing.
 *
 * A gate must be able to *report* an unreadable version, so this returns
 * a result object instead of raising.
 *
 * @param {string} cwd directory holding the `package.json` under test
 * @returns {{ version: string | null, error: string | null }}
 */
export function readPackageVersion(cwd) {
  let raw;
  try {
    raw = readFileSync(path.join(cwd, 'package.json'), 'utf8');
  } catch (error) {
    return { version: null, error: `cannot read package.json in ${cwd}: ${errorMessage(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { version: null, error: `package.json in ${cwd} is not valid JSON: ${errorMessage(error)}` };
  }
  const version = asRecord(parsed).version;
  if (typeof version !== 'string') {
    return { version: null, error: `package.json in ${cwd} has no string "version" field` };
  }
  return { version, error: null };
}

/**
 * The commit the working tree is actually on.
 *
 * @param {string} cwd
 * @returns {string | null} the SHA, or `null` when git cannot answer
 */
export function readCheckedOutSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Decide whether the head branch under test is a legitimate release
 * source, collecting every reason it is not.
 *
 * Violations are accumulated rather than short-circuited so a failed run
 * tells an operator everything that is wrong in one pass.
 *
 * @param {ReleaseSourceInput} input
 * @returns {ReleaseSourceEvaluation}
 */
export function evaluateReleaseSource(input) {
  /** @type {ReleaseSourceViolation[]} */
  const violations = [];
  const headRef = typeof input.headRef === 'string' ? input.headRef.trim() : '';
  const version = typeof input.version === 'string' ? input.version.trim() : null;
  const expectedHeadSha =
    typeof input.expectedHeadSha === 'string' && input.expectedHeadSha.length > 0
      ? input.expectedHeadSha
      : null;
  const checkedOutSha =
    typeof input.checkedOutSha === 'string' && input.checkedOutSha.length > 0
      ? input.checkedOutSha
      : null;

  // --- the working tree must be provably the head commit -------------------
  // Checked first because every other fact is read from that tree: if we
  // are standing somewhere else, the version below is not the head's and
  // no comparison built on it can mean anything.
  if (expectedHeadSha === null) {
    violations.push({
      code: 'head-sha-missing',
      message:
        'the pull request head SHA is unavailable, so this gate cannot say which commit it verified; ' +
        'refusing to report a result for an unidentified commit',
    });
  } else if (checkedOutSha === null) {
    violations.push({
      code: 'head-sha-unverifiable',
      message:
        `cannot determine the checked-out commit, so it cannot be proven to be the head ${expectedHeadSha}; ` +
        'refusing to report a result for an unverified checkout',
    });
  } else if (checkedOutSha !== expectedHeadSha) {
    violations.push({
      code: 'checkout-not-at-head',
      message:
        `the working tree is at ${checkedOutSha}, not the pull request head ${expectedHeadSha}; ` +
        'the package.json read here is not the head\'s, so this gate would be reporting on the wrong commit',
    });
  }

  // --- the head ref must be a release branch ------------------------------
  if (headRef === '') {
    violations.push({
      code: 'head-ref-missing',
      message:
        'HEAD_REF is empty; this gate is only meaningful for pull requests raised from a branch',
    });
  } else if (!RELEASE_BRANCH_PATTERN.test(headRef)) {
    violations.push({
      code: 'head-ref-not-release-branch',
      message: `PR head branch '${headRef}' is not a release-<major>-<minor>-<patch> branch`,
    });
  }

  // --- the head branch content must agree with its name -------------------
  if (version === null) {
    violations.push({
      code: 'package-version-missing',
      message: 'package.json#version could not be read from the checked-out head commit',
    });
  } else if (!STABLE_SEMVER_PATTERN.test(version)) {
    violations.push({
      code: 'package-version-malformed',
      message: `package.json#version '${version}' is not stable semver x.y.z`,
    });
  }

  const expectedRef = version === null ? null : deriveReleaseBranchName(version);
  if (
    headRef !== '' &&
    RELEASE_BRANCH_PATTERN.test(headRef) &&
    expectedRef !== null &&
    STABLE_SEMVER_PATTERN.test(version ?? '') &&
    headRef !== expectedRef
  ) {
    violations.push({
      code: 'head-ref-version-mismatch',
      message:
        `PR head '${headRef}' does not match the head commit's package.json version '${version}' ` +
        `(expected '${expectedRef}')`,
    });
  }

  return { ok: violations.length === 0, expectedRef, version, violations };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @typedef {{
 *   info: (message: string) => void,
 *   error: (message: string) => void,
 * }} GateIo
 */

/** @type {GateIo} */
const DEFAULT_IO = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * Run the gate. Returns the process exit code; never throws.
 *
 * @param {GateIo} io
 * @param {string} cwd working tree holding the `package.json` under test
 * @param {{
 *   headRef: string | null,
 *   expectedHeadSha: string | null,
 *   readVersion?: (dir: string) => { version: string | null, error: string | null },
 *   readSha?: (dir: string) => string | null,
 * }} facts
 * @returns {number} 0 when the head is a legitimate release source, 1 otherwise
 */
export function runGate(io, cwd, facts) {
  const readVersion = facts.readVersion ?? readPackageVersion;
  const readSha = facts.readSha ?? readCheckedOutSha;

  const { version, error } = readVersion(cwd);
  if (error !== null) io.error(`::error::${error}`);

  const evaluation = evaluateReleaseSource({
    headRef: facts.headRef,
    version,
    expectedHeadSha: facts.expectedHeadSha,
    checkedOutSha: readSha(cwd),
  });

  for (const violation of evaluation.violations) {
    io.error(`::error::release-source-check: ${violation.message}`);
  }

  if (evaluation.ok) {
    io.info(
      `release-source-check: head '${facts.headRef}' at ` +
        `${facts.expectedHeadSha} ships package.json version '${evaluation.version}'; ` +
        `consistent with '${evaluation.expectedRef}'.`,
    );
    return 0;
  }

  io.error(
    `release-source-check: FAILED (${evaluation.violations.length} violation(s): ` +
      `${evaluation.violations.map((violation) => violation.code).join(', ')})`,
  );
  return 1;
}

/**
 * @param {string[]} argv
 * @param {GateIo} io
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {number}
 */
export function main(argv, io = DEFAULT_IO, env = process.env, cwd = process.cwd()) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.info(
      'usage: node scripts/release-source-check.mjs\n' +
        '  Requires HEAD_REF, EXPECTED_HEAD_SHA in the environment; verifies that the\n' +
        '  current working tree is the PR head commit and that its package.json version\n' +
        '  matches the head branch name. Exits non-zero on any violation.',
    );
    return 0;
  }
  return runGate(io, cwd, {
    headRef: env.HEAD_REF ?? null,
    expectedHeadSha: env.EXPECTED_HEAD_SHA ?? null,
  });
}

const invokedPath = process.argv[1];
const invokedDirectly =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
