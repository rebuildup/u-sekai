#!/usr/bin/env node
/**
 * Verify - and, with `--apply`, publish - a version-aligned Git tag and
 * GitHub Release for u-sekai (Issue #22, ADR-0010).
 *
 * This CLI gathers the facts (git history, remote refs, GitHub check runs,
 * existing tags and releases) and hands them to the pure rules in
 * `scripts/release-rules.mjs`. It never corrects a violation: every rule
 * violation exits non-zero with the observed value next to the expected one.
 *
 * Default mode is plan / dry-run: every check runs and the intended actions are
 * printed, but nothing is created, moved or deleted.
 *
 * There is deliberately no flag that sets the version. `package.json#version` at
 * the resolved source ref is the only version input, so "the tag version equals
 * package.json#version" cannot be bypassed by an argument (ADR-0010).
 *
 * Usage:
 *   node scripts/verify-release.mjs [options]
 *
 * Options:
 *   --sha <ref>                    Target release commit. Default: the head of
 *                                  --main-ref.
 *   --source-ref <ref>             Ref to read package.json#version from.
 *                                  Default: --sha. It must resolve to --sha;
 *                                  a different commit is refused rather than
 *                                  mixing facts from two commits.
 *   --tag <name>                   Tag to publish. Default: v<version>.
 *   --release-branch <name>        Intended release branch.
 *                                  Default: release-<version with dashes>.
 *   --main-ref <ref>               Ref holding the released source state.
 *                                  Default: main.
 *   --remote <name>                Git remote. Default: origin.
 *   --repo <owner/name>            GitHub repository. Default: from the remote URL.
 *   --required-check <name>        Repeatable. Replaces the default release
 *                                  gate list. Also settable with the
 *                                  RELEASE_REQUIRED_CHECKS env variable.
 *   --cross-check-protection       Read the required status checks registered on
 *                                  --main-ref and refuse when the committed
 *                                  release gate is narrower than them. Local
 *                                  only: it needs a credential with
 *                                  Administration: read, which GITHUB_TOKEN
 *                                  cannot provide, so the release-publish
 *                                  workflow never performs it.
 *   --require-protection-configured
 *                                  Refuse to publish unless branch protection
 *                                  on --main-ref registers required status checks.
 *                                  Requires --cross-check-protection.
 *   --apply                        Perform the publication. Without this flag
 *                                  nothing is mutated.
 *   --no-fetch                     Do not run `git fetch` before verifying.
 *   -h, --help                     Print this help.
 *
 * Exit codes: 0 verdict is `publish` or `already-published`, 1 at least one
 * rule was violated, 2 the facts could not be gathered at all.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_REQUIRED_RELEASE_CHECKS,
  deriveReleaseBranchName,
  evaluateReleasePublication,
  resolveExpectedReleaseSha,
} from './release-rules.mjs';

/** @typedef {import('./release-rules.mjs').CheckRun} CheckRun */
/** @typedef {import('./release-rules.mjs').ExistingRelease} ExistingRelease */
/** @typedef {import('./release-rules.mjs').ProtectionCheck} ProtectionCheck */

const PREFIX = 'release-verify';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fact could not be gathered. Exit code 2, never "rule violated". */
export class FactsError extends Error {}

/**
 * @param {string} message
 * @returns {void}
 */
function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

/**
 * @param {string} message
 * @returns {void}
 */
function info(message) {
  console.log(`${PREFIX}: ${message}`);
}

/**
 * @param {string} message
 * @returns {void}
 */
function warn(message) {
  console.error(`${PREFIX}: ${message}`);
}

/**
 * @typedef {{ ok: boolean, stdout: string, stderr: string }} CommandResult
 */

/**
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {CommandResult}
 */
function runCommand(file, args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const failure = /** @type {{ stdout?: unknown, stderr?: unknown }} */ (error);
    const result = {
      ok: false,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    };
    if (allowFailure) return result;
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    throw new FactsError(`${file} ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`);
  }
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function firstLine(text) {
  const line = String(text).split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/**
 * @param {readonly string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {string}
 */
function git(args, options) {
  return runCommand('git', args, options).stdout;
}

/**
 * Whether a failed `gh` request is a 404.
 *
 * This is a *transport* signal only. A 404 does not say *what* was missing, so
 * callers must never turn it into a fact about the repository unless the
 * response body also names the missing thing (see `protectionSectionAbsent`).
 *
 * @param {CommandResult} result
 * @returns {boolean}
 */
export function isNotFound(result) {
  return /HTTP 404/.test(result.stderr) || /not found/i.test(result.stderr);
}

/**
 * Whether GitHub read the branch and reported that the required-status-checks
 * section is absent, as opposed to being unable to see the branch at all.
 *
 * @param {CommandResult} result
 * @returns {boolean}
 */
export function protectionSectionAbsent(result) {
  return isNotFound(result) && /required status checks not enabled/i.test(result.stderr);
}

/**
 * Structural read of an untyped GitHub API body.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/**
 * @param {string} endpoint
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {unknown}
 */
export function ghApi(endpoint, { allowMissing = false } = {}) {
  const result = runCommand('gh', ['api', endpoint], { allowFailure: allowMissing });
  if (!result.ok) {
    if (allowMissing && isNotFound(result)) return null;
    throw new FactsError(`gh api ${endpoint} failed: ${firstLine(result.stderr)}`);
  }
  const trimmed = result.stdout.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new FactsError(
      `gh api ${endpoint} returned a body that is not JSON: ${firstLine(trimmed)} (${errorMessage(error)})`,
    );
  }
}

/**
 * @typedef {object} ReleaseOptions
 * @property {string | null} tag
 * @property {string | null} releaseBranch
 * @property {string | null} sha
 * @property {string | null} sourceRef
 * @property {string} mainRef
 * @property {string} remote
 * @property {string | null} repo
 * @property {string[]} requiredChecks
 * @property {boolean} crossCheckProtection
 * @property {boolean} requireProtectionConfigured
 * @property {boolean} apply
 * @property {boolean} fetch
 * @property {boolean} help
 */

/**
 * @param {readonly string[]} argv
 * @returns {ReleaseOptions}
 */
export function parseArgs(argv) {
  /** @type {ReleaseOptions} */
  const options = {
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
  };
  const takesValue = new Set([
    '--sha',
    '--source-ref',
    '--tag',
    '--release-branch',
    '--main-ref',
    '--remote',
    '--repo',
    '--required-check',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    let name = token;
    let inlineValue = null;
    const equals = token.indexOf('=');
    if (token.startsWith('--') && equals !== -1) {
      name = token.slice(0, equals);
      inlineValue = token.slice(equals + 1);
    }
    if (name === '-h' || name === '--help') {
      options.help = true;
      continue;
    }
    if (name === '--apply') {
      options.apply = true;
      continue;
    }
    if (name === '--no-fetch') {
      options.fetch = false;
      continue;
    }
    if (name === '--cross-check-protection') {
      options.crossCheckProtection = true;
      continue;
    }
    if (name === '--require-protection-configured') {
      options.requireProtectionConfigured = true;
      continue;
    }
    if (!takesValue.has(name)) {
      throw new FactsError(
        `unknown option ${JSON.stringify(token)}; the version source of truth is ` +
          'package.json#version and cannot be set from the command line',
      );
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new FactsError(`option ${name} requires a value`);
    }
    if (name === '--required-check') {
      options.requiredChecks.push(value);
    } else if (name === '--sha') {
      options.sha = value;
    } else if (name === '--source-ref') {
      options.sourceRef = value;
    } else if (name === '--tag') {
      options.tag = value;
    } else if (name === '--release-branch') {
      options.releaseBranch = value;
    } else if (name === '--main-ref') {
      options.mainRef = value;
    } else if (name === '--remote') {
      options.remote = value;
    } else if (name === '--repo') {
      options.repo = value;
    }
  }
  return options;
}

/**
 * @param {ReleaseOptions} options
 * @returns {string}
 */
function resolveRepo(options) {
  if (options.repo !== null) return options.repo;
  const url = firstLine(git(['remote', 'get-url', options.remote])).trim();
  const ssh = /^[^@\s]+@[^:\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) return ssh[1] ?? '';
  const https = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
  if (https !== null) return https[1] ?? '';
  throw new FactsError(
    `cannot derive the GitHub repository from remote ${options.remote} (${url}); pass --repo owner/name`,
  );
}

/**
 * @param {string} ref
 * @returns {string}
 */
function revParse(ref) {
  return firstLine(git(['rev-parse', '--verify', `${ref}^{commit}`]));
}

/**
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
function isAncestor(ancestor, descendant) {
  const result = runCommand('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  return result.ok;
}

/**
 * Read `package.json#version` out of a raw file body.
 *
 * A malformed body is a `FactsError` (exit 2, "facts unavailable"), never an
 * uncaught `SyntaxError` with exit 1, because exit 1 means "a rule was
 * violated" and a broken file violates no rule.
 *
 * @param {string} raw
 * @param {string} sourceRef
 * @returns {string}
 */
export function parsePackageVersion(raw, sourceRef) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FactsError(
      `package.json at ${sourceRef} is not valid JSON: ${errorMessage(error)}; ` +
        'the version source of truth could not be read',
    );
  }
  const version = asRecord(parsed).version;
  if (typeof version !== 'string') {
    throw new FactsError(`package.json at ${sourceRef} has no string version field`);
  }
  return version;
}

/**
 * @param {string} sourceRef
 * @returns {string}
 */
function readVersionFrom(sourceRef) {
  const raw = runCommand('git', ['show', `${sourceRef}:package.json`], { allowFailure: true });
  if (!raw.ok) {
    throw new FactsError(
      `cannot read package.json at ${sourceRef}: ${firstLine(raw.stderr) || 'unknown error'}`,
    );
  }
  return parsePackageVersion(raw.stdout, sourceRef);
}

/**
 * @param {string} ref
 * @returns {{ sha: string, parents: string[], subject: string }[]}
 */
function parseMerges(ref) {
  const raw = git(['log', ref, '--merges', '--format=%H%x1f%P%x1f%s%x1e']);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const parts = record.split('\x1f');
      const parents = (parts[1] ?? '').split(' ').filter((value) => value !== '');
      return { sha: parts[0] ?? '', parents, subject: parts[2] ?? '' };
    });
}

/**
 * @param {string} remote
 * @returns {Map<string, string>}
 */
function remoteRefs(remote) {
  const raw = git(['ls-remote', '--heads', remote]);
  const refs = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (ref !== undefined && ref.startsWith('refs/heads/')) {
      refs.set(ref.slice('refs/heads/'.length), sha);
    }
  }
  return refs;
}

/**
 * Which advertised remote branches contain a commit.
 *
 * `git branch -r --contains` answers from the *local* remote-tracking refs, which
 * can be stale, and it also lists symbolic refs such as `origin/HEAD`. Intersecting
 * both with the live `git ls-remote` head list makes the answer depend only on what
 * the remote actually advertises right now, without pruning anything.
 *
 * @param {string} remote
 * @param {string} sha
 * @param {ReadonlySet<string>} advertisedHeads
 * @returns {string[]}
 */
function remoteRefsContaining(remote, sha, advertisedHeads) {
  const prefix = `${remote}/`;
  const listed = runCommand('git', ['branch', '-r', '--contains', sha], { allowFailure: true })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('->'))
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .filter((name) => advertisedHeads.has(name));
  return [...new Set(listed)].sort();
}

/**
 * Reduce a `check-runs` response body to the facts the gate decides from.
 *
 * @param {unknown} body
 * @param {(suiteId: unknown) => unknown} readSuite
 * @returns {CheckRun[]}
 */
export function mapCheckRuns(body, readSuite) {
  const listed = asRecord(body).check_runs;
  const runs = Array.isArray(listed) ? listed : [];
  const suiteIds = new Set();
  for (const run of runs) {
    const id = asRecord(asRecord(run).check_suite).id;
    if (id !== undefined && id !== null) suiteIds.add(id);
  }
  const headBranchBySuite = new Map();
  for (const suiteId of suiteIds) {
    const suite = asRecord(readSuite(suiteId));
    headBranchBySuite.set(
      suiteId,
      typeof suite.head_branch === 'string' ? suite.head_branch : null,
    );
  }
  return runs.map((run) => {
    const record = asRecord(run);
    const id = asRecord(record.check_suite).id;
    return {
      name: String(record.name ?? ''),
      status: String(record.status ?? ''),
      conclusion:
        record.conclusion === undefined || record.conclusion === null
          ? null
          : String(record.conclusion),
      headBranch: headBranchBySuite.get(id) ?? null,
      startedAt: record.started_at === undefined ? null : String(record.started_at),
      completedAt: record.completed_at === undefined ? null : String(record.completed_at),
      id:
        typeof record.id === 'number' || typeof record.id === 'string' ? record.id : null,
      url: record.html_url === undefined ? null : String(record.html_url),
    };
  });
}

/**
 * @param {string} repo
 * @param {string} sha
 * @returns {CheckRun[] | null}
 */
function readCheckRuns(repo, sha) {
  const response = ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
    allowMissing: true,
  });
  if (response === null) return null;
  return mapCheckRuns(response, (suiteId) =>
    ghApi(`repos/${repo}/check-suites/${String(suiteId)}`, { allowMissing: true }),
  );
}

/**
 * @param {string} repo
 * @param {string} tagName
 * @returns {{ sha: string } | null}
 */
function readExistingTag(repo, tagName) {
  const ref = ghApi(`repos/${repo}/git/ref/tags/${tagName}`, { allowMissing: true });
  if (ref === null || ref === undefined) return null;
  let object = asRecord(ref).object;
  for (let depth = 0; depth < 5 && asRecord(object).type === 'tag'; depth += 1) {
    const annotated = ghApi(`repos/${repo}/git/tags/${String(asRecord(object).sha)}`, {
      allowMissing: true,
    });
    if (annotated === null) break;
    object = asRecord(annotated).object;
  }
  const sha = asRecord(object).sha;
  if (typeof sha !== 'string') return null;
  return { sha };
}

/**
 * Status check contexts registered on the protected branch.
 *
 * Returns an empty array only when GitHub itself reported that no required
 * status check is enabled. Any other unreadable answer - a 404 that does not
 * name the missing section, a 403, a transport failure - returns `null`, so an
 * answer this credential could not obtain is never presented as "nothing is
 * required".
 *
 * @param {string} repo
 * @param {string} mainRef
 * @returns {{ contexts: string[] | null, reason: string }}
 */
export function readProtectionContexts(repo, mainRef) {
  const endpoint = `repos/${repo}/branches/${encodeURIComponent(mainRef)}/protection/required_status_checks`;
  const result = runCommand('gh', ['api', endpoint], { allowFailure: true });
  if (!result.ok) {
    if (protectionSectionAbsent(result)) {
      return {
        contexts: [],
        reason: `GitHub reports that ${mainRef} has no required status checks enabled`,
      };
    }
    return { contexts: null, reason: firstLine(result.stderr) || `HTTP failure: ${result.stderr}` };
  }
  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return { contexts: null, reason: 'the API returned an empty body' };
  }
  try {
    return {
      contexts: protectionContextsFrom(JSON.parse(trimmed)),
      reason: 'the required status checks were read',
    };
  } catch (error) {
    return { contexts: null, reason: `the body was not JSON: ${errorMessage(error)}` };
  }
}

/**
 * @param {unknown} body
 * @returns {string[]}
 */
export function protectionContextsFrom(body) {
  const record = asRecord(body);
  const contexts = new Set();
  for (const context of Array.isArray(record.contexts) ? record.contexts : []) {
    contexts.add(String(context));
  }
  for (const check of Array.isArray(record.checks) ? record.checks : []) {
    const context = asRecord(check).context;
    if (typeof context === 'string') contexts.add(context);
  }
  return [...contexts];
}

/**
 * Resolve the commit a published Release ships.
 *
 * @param {string | null} tagSha Commit the referenced tag resolves to, or `null`.
 * @param {unknown} value Raw `target_commitish`.
 * @param {(ref: string) => string | null} resolveLocal
 * @returns {string | null}
 */
export function resolveCommitish(tagSha, value, resolveLocal) {
  if (typeof value !== 'string' || value === '') return null;
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  if (tagSha !== null && value === 'HEAD') return tagSha;
  const local = resolveLocal(value);
  // A GitHub Release is identified by its tag, and `target_commitish` is only
  // consulted while that tag does not exist yet. Once the tag resolves, the
  // commit a release ships is the tag's commit, so an unresolvable symbolic
  // value (a branch name, the tag name) must not be reported as a different
  // commit and must not be compared as one. `tag-idempotency` independently
  // pins the tag to the release commit.
  return local ?? tagSha;
}

/**
 * @param {string} ref
 * @returns {string | null}
 */
function resolveLocalCommitish(ref) {
  const local = runCommand('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return local.ok ? firstLine(local.stdout) : null;
}

/**
 * @param {string} repo
 * @param {string} tagName
 * @param {string | null} tagSha
 * @returns {ExistingRelease | null}
 */
function readExistingRelease(repo, tagName, tagSha) {
  const release = ghApi(`repos/${repo}/releases/tags/${tagName}`, { allowMissing: true });
  if (release === null || release === undefined) return null;
  const record = asRecord(release);
  const targetCommitish =
    typeof record.target_commitish === 'string' ? record.target_commitish : null;
  return {
    sha: resolveCommitish(tagSha, targetCommitish, resolveLocalCommitish) ?? 'unknown',
    targetCommitish,
    draft: record.draft === true,
    prerelease: record.prerelease === true,
  };
}

const RELEASES_PAGE_SIZE = 100;
const RELEASES_MAX_PAGES = 20;

/**
 * @typedef {object} DuplicateScan
 * @property {boolean} readable False when the inventory could not be listed completely.
 * @property {string[]} conflictingReleaseTags Other Releases carrying the same version.
 * @property {string[]} conflictingTagRefs Other git tags carrying the same version.
 * @property {string} detail What was read, or why it could not be read.
 */

/**
 * List every other tag and Release that would be a second artifact for `version`.
 *
 * An unreadable or truncated inventory is reported as `readable: false`, never
 * as "no duplicates": the question is about what already exists publicly, and
 * answering it by assuming absence is the fail-open direction. Releases are
 * paginated and tags are scanned as well, so a stray `refs/tags/0.2.0` next to
 * the intended `v0.2.0` is visible.
 *
 * @param {{
 *   version: string,
 *   tagName: string,
 *   listReleases: (page: number) => unknown,
 *   listTagRefs: () => unknown,
 * }} input
 * @returns {DuplicateScan}
 */
export function scanConflictingReleaseArtifacts({ version, tagName, listReleases, listTagRefs }) {
  const unreadable = (/** @type {string} */ detail) => ({
    readable: false,
    conflictingReleaseTags: [],
    conflictingTagRefs: [],
    detail,
  });

  /** @type {string[]} */
  const releaseTags = [];
  /** @type {string[]} */
  const tagRefs = [];
  try {
    for (let page = 1; page <= RELEASES_MAX_PAGES; page += 1) {
      const listed = listReleases(page);
      if (!Array.isArray(listed)) {
        return unreadable(
          listed === null
            ? 'the GitHub Releases list could not be read'
            : `the GitHub Releases list (page ${page}) was not a list`,
        );
      }
      for (const release of listed) {
        const name = String(asRecord(release).tag_name ?? '');
        if (name !== '') releaseTags.push(name);
      }
      if (listed.length < RELEASES_PAGE_SIZE) break;
      if (page === RELEASES_MAX_PAGES) {
        return unreadable(
          `the repository has more than ${RELEASES_MAX_PAGES * RELEASES_PAGE_SIZE} GitHub Releases, so the scan stopped without reading all of them`,
        );
      }
    }
    const listedRefs = listTagRefs();
    if (!Array.isArray(listedRefs)) {
      return unreadable(
        listedRefs === null
          ? 'the git tag list could not be read'
          : 'the git tag list was not a list',
      );
    }
    for (const ref of listedRefs) {
      const name = String(asRecord(ref).ref ?? '');
      if (name === '') continue;
      tagRefs.push(name.replace(/^refs\/tags\//, ''));
    }
  } catch (error) {
    return unreadable(`the release artifact inventory could not be read: ${errorMessage(error)}`);
  }

  const carriesSameVersion = (/** @type {string} */ name) =>
    name !== tagName && name.replace(/^v/, '') === version;
  return {
    readable: true,
    conflictingReleaseTags: [...new Set(releaseTags.filter(carriesSameVersion))],
    conflictingTagRefs: [...new Set(tagRefs.filter(carriesSameVersion))],
    detail: `${releaseTags.length} release(s) and ${tagRefs.length} tag(s) read`,
  };
}

/**
 * @param {ReleaseOptions} options
 * @returns {{ checks: string[], source: string }}
 */
function selectRequiredChecks(options) {
  if (options.requiredChecks.length > 0) {
    return { checks: options.requiredChecks, source: 'flags:--required-check' };
  }
  const fromEnv = (process.env.RELEASE_REQUIRED_CHECKS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (fromEnv.length > 0) {
    return { checks: fromEnv, source: 'env:RELEASE_REQUIRED_CHECKS' };
  }
  return { checks: [...DEFAULT_REQUIRED_RELEASE_CHECKS], source: 'constant:DEFAULT_REQUIRED_RELEASE_CHECKS' };
}

/**
 * @param {import('./release-rules.mjs').ReleaseEvaluation} evaluation
 */
function printEvaluation(evaluation) {
  for (const check of evaluation.checks) {
    const label = check.ok ? 'ok  ' : 'FAIL';
    console.log(`release-check: ${label} ${check.rule}: ${check.message}`);
  }
  for (const note of evaluation.notes) {
    console.log(`release-note: ${note.rule}: ${note.message}`);
  }
  for (const step of evaluation.plan) {
    console.log(`release-plan: ${step}`);
  }
}

/**
 * @param {string} endpoint
 * @param {string} ref
 * @param {string} sha
 * @returns {string}
 */
function ghApiWrite(endpoint, ref, sha) {
  const result = runCommand('gh', [
    'api',
    '--method',
    'POST',
    endpoint,
    '-f',
    `ref=${ref}`,
    '-f',
    `sha=${sha}`,
  ]);
  return result.stdout;
}

/** @type {{ readTag: (repo: string, tagName: string) => { sha: string } | null, readRelease: (repo: string, tagName: string, tagSha: string | null) => ExistingRelease | null }} */
const DEFAULT_ARTIFACT_IO = {
  readTag: (repo, tagName) => readExistingTag(repo, tagName),
  readRelease: (repo, tagName, tagSha) => readExistingRelease(repo, tagName, tagSha),
};

/**
 * Re-read both artifacts and refuse to report success unless they are what was
 * intended.
 *
 * @param {string} repo
 * @param {string} tagName
 * @param {string} targetSha
 * @param {typeof DEFAULT_ARTIFACT_IO} [io]
 * @returns {void}
 */
export function assertPublished(repo, tagName, targetSha, io = DEFAULT_ARTIFACT_IO) {
  const tag = io.readTag(repo, tagName);
  if (tag === null || tag.sha !== targetSha) {
    throw new FactsError(
      `post-condition failed: tag ${tagName} is ${tag === null ? 'missing' : `at ${tag.sha}`}, expected ${targetSha}`,
    );
  }
  const release = io.readRelease(repo, tagName, targetSha);
  if (release === null) {
    throw new FactsError(`post-condition failed: GitHub Release ${tagName} is missing`);
  }
  if (release.sha !== targetSha) {
    throw new FactsError(
      `post-condition failed: GitHub Release ${tagName} points at ${release.sha}, expected ${targetSha}`,
    );
  }
  if (release.draft) {
    throw new FactsError(`post-condition failed: GitHub Release ${tagName} is still a draft`);
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {void}
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error instanceof FactsError ? error.message : String(error));
    return;
  }
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const auth = runCommand('gh', ['auth', 'status'], { allowFailure: true });
  if (!auth.ok) {
    fail('gh is not authenticated; set GH_TOKEN or run `gh auth login` before verifying a release');
  }

  try {
    if (options.fetch) {
      git(['fetch', '--no-tags', '--quiet', options.remote]);
    }

    const repo = resolveRepo(options);
    const mainRef = `${options.remote}/${options.mainRef}`;
    const mainHead = revParse(mainRef);
    const targetSha = options.sha === null ? mainHead : revParse(options.sha);
    const sourceRef = options.sourceRef ?? targetSha;
    const sourceSha = revParse(sourceRef);
    const packageVersion = readVersionFrom(sourceRef);
    const tagName = options.tag ?? `v${packageVersion}`;
    const releaseBranch = options.releaseBranch ?? deriveReleaseBranchName(packageVersion);
    const { checks: requiredChecks, source: gateSource } = selectRequiredChecks(options);

    info(`repository ${repo}`);
    info(`mode ${options.apply ? 'apply' : 'plan (no mutation)'}`);
    info(`version source ${sourceRef} (${sourceSha}):package.json#version = ${JSON.stringify(packageVersion)}`);
    info(`tag ${tagName} -> ${targetSha}`);
    info(`release branch ${releaseBranch} (derived from version)`);
    info(`release gate ${JSON.stringify(requiredChecks)} from ${gateSource}`);

    const merges = parseMerges(mainRef);
    const expectedReleaseSha = resolveExpectedReleaseSha({ merges, releaseBranch });
    info(
      `expected release commit ${expectedReleaseSha.sha ?? 'unresolved'} on ${mainRef}` +
        (expectedReleaseSha.subject === null ? '' : ` (${expectedReleaseSha.subject})`),
    );

    const heads = remoteRefs(options.remote);
    const releaseBranchExists = heads.has(releaseBranch);
    const releaseBranchTip = releaseBranchExists ? heads.get(releaseBranch) : null;
    const containing = remoteRefsContaining(
      options.remote,
      targetSha,
      new Set(heads.keys()),
    );
    const remoteHasTargetSha = containing.length > 0;
    const targetOnMain = isAncestor(targetSha, mainRef);
    const releaseBranchTipIsAncestor = releaseBranchExists
      ? isAncestor(String(releaseBranchTip), targetSha)
      : null;
    info(
      `remote refs: release branch ${releaseBranch} ${
        releaseBranchExists ? `exists at ${releaseBranchTip}` : 'is deleted'
      }; target contained in ${JSON.stringify(containing)}`,
    );

    const checkRuns = readCheckRuns(repo, targetSha);
    info(
      `check runs on ${targetSha}: ${
        checkRuns === null ? 'unreadable' : `${checkRuns.length} run(s) read`
      }`,
    );

    const existingTag = readExistingTag(repo, tagName);
    const existingRelease = readExistingRelease(repo, tagName, existingTag?.sha ?? null);
    const duplicates = scanConflictingReleaseArtifacts({
      version: packageVersion,
      tagName,
      listReleases: (page) =>
        ghApi(`repos/${repo}/releases?per_page=${RELEASES_PAGE_SIZE}&page=${page}`, {
          allowMissing: true,
        }),
      listTagRefs: () => ghApi(`repos/${repo}/git/matching-refs/tags/`, { allowMissing: true }),
    });
    info(
      `existing artifacts: tag ${existingTag === null ? 'absent' : `at ${existingTag.sha}`}, release ${
        existingRelease === null ? 'absent' : `at ${existingRelease.sha}`
      }`,
    );
    info(
      `duplicate artifact scan: ${
        duplicates.readable
          ? `${duplicates.detail}; conflicting release(s) ${JSON.stringify(duplicates.conflictingReleaseTags)}, conflicting tag(s) ${JSON.stringify(duplicates.conflictingTagRefs)}`
          : `unreadable: ${duplicates.detail}`
      }`,
    );

    let protectionCheck = /** @type {ProtectionCheck} */ ('not-performed');
    let protectionContexts = null;
    if (options.crossCheckProtection) {
      protectionCheck = 'performed';
      const read = readProtectionContexts(repo, options.mainRef);
      protectionContexts = read.contexts;
      info(
        `branch protection required status checks on ${options.mainRef}: ${
          read.contexts === null
            ? `unreadable (${read.reason})`
            : read.contexts.length === 0
              ? 'none registered'
              : read.contexts.join(', ')
        }`,
      );
    } else {
      info(
        `branch protection cross-check on ${options.mainRef}: not performed ` +
          '(local only; pass --cross-check-protection)',
      );
    }

    const evaluation = evaluateReleasePublication({
      repo,
      sourceRef,
      sourceSha,
      mainRef,
      packageVersion,
      tagName,
      releaseBranch,
      targetSha,
      expectedReleaseSha,
      remoteHasTargetSha,
      remoteContainingRefs: containing,
      targetOnMain,
      releaseBranchExists,
      releaseBranchTip: releaseBranchTip ?? null,
      releaseBranchTipIsAncestor,
      requiredChecks,
      gateSource,
      protectionCheck,
      protectionContexts,
      requireProtectionConfigured: options.requireProtectionConfigured,
      checkRunsReadable: checkRuns !== null,
      checkRuns: checkRuns ?? [],
      applicableBranches: [options.mainRef, releaseBranch],
      existingTag,
      existingRelease,
      conflictingReleaseTagsReadable: duplicates.readable,
      conflictingReleaseTags: duplicates.conflictingReleaseTags,
      conflictingTagRefs: duplicates.conflictingTagRefs,
    });

    printEvaluation(evaluation);

    if (!evaluation.ok) {
      for (const violation of evaluation.violations) {
        warn(`refused: [${violation.rule}] ${violation.message}`);
      }
      info(
        `verdict refused (${evaluation.violations.length} violation(s) of ${evaluation.checks.length} check(s)); nothing was created, moved or deleted`,
      );
      process.exit(1);
    }

    info(`verdict ${evaluation.verdict}`);
    if (!options.apply) {
      info('plan mode: re-run with --apply (or the release-publish workflow) to perform the plan above');
      return;
    }
    if (evaluation.verdict === 'already-published') {
      info('nothing to do: the tag and the GitHub Release already exist at the expected commit');
      return;
    }

    // Everything below mutates the repository, so every failure must name the
    // partial state and the way out of it. A tag created without a Release is
    // a recoverable half-finished publication, and the recovery is simply to
    // re-run: the script re-reads both artifacts and creates only what is
    // missing. It never deletes, moves, or re-points either artifact.
    let tagPresentAtTarget = existingTag !== null && existingTag.sha === targetSha;
    try {
      // Re-read each artifact immediately before creating it. Two concurrent
      // publishing runs must converge on one tag and one Release rather than
      // race into a second artifact; the post-condition assertion below still
      // fails loudly if the pre-existing artifact points somewhere else.
      if (existingTag === null) {
        const current = readExistingTag(repo, tagName);
        if (current === null) {
          ghApiWrite(`repos/${repo}/git/refs`, `refs/tags/${tagName}`, targetSha);
          tagPresentAtTarget = true;
          info(`created tag ${tagName} at ${targetSha}`);
        } else {
          tagPresentAtTarget = current.sha === targetSha;
          info(`tag ${tagName} already appeared at ${current.sha}; not creating a second one`);
        }
      }
      if (existingRelease === null) {
        const current = readExistingRelease(repo, tagName, existingTag?.sha ?? null);
        if (current === null) {
          const created = runCommand('gh', [
            'release',
            'create',
            tagName,
            '--repo',
            repo,
            '--target',
            targetSha,
            '--title',
            tagName,
            // Release notes come from GitHub's own generation over the merged
            // pull requests, so the artifact is reproducible from durable
            // repository history rather than from an agent's context.
            '--generate-notes',
          ]);
          const url = firstLine(created.stdout);
          info(`created GitHub Release ${tagName}${url === '' ? '' : ` (${url})`}`);
        } else {
          info(`GitHub Release ${tagName} already appeared; not creating a second one`);
        }
      }
      assertPublished(repo, tagName, targetSha);
    } catch (error) {
      if (!(error instanceof FactsError)) throw error;
      fail(
        `publication did not complete: ${error.message}\n` +
          `  recovery: ${
            tagPresentAtTarget
              ? `tag ${tagName} now exists at ${targetSha}`
              : `tag ${tagName} is absent or does not point at ${targetSha}`
          }. This script never deletes, moves, or re-points a tag, and never deletes a Release, ` +
          'so the partial state is safe to keep. Re-run the same command after fixing the cause: ' +
          'it re-reads both artifacts, creates only what is missing, and reports already-published once both exist.',
      );
    }
    info(`published ${tagName} -> ${targetSha} and verified the result`);
  } catch (error) {
    if (error instanceof FactsError) {
      fail(error.message);
      return;
    }
    throw error;
  }
}

const HELP_TEXT = `Usage: node scripts/verify-release.mjs [options]

  --sha <ref>                       target release commit (default: head of --main-ref)
  --source-ref <ref>                ref to read package.json#version from (default: --sha;
                                    must resolve to --sha)
  --tag <name>                      tag to publish (default: v<version>)
  --release-branch <name>           intended release branch (default: release-<version with dashes>)
  --main-ref <ref>                  ref holding the released source state (default: main)
  --remote <name>                   git remote (default: origin)
  --repo <owner/name>               GitHub repository (default: derived from the remote URL)
  --required-check <name>           repeatable; replaces the default release gate list
  --cross-check-protection          read the required status checks registered on --main-ref
                                    (local only; needs Administration: read)
  --require-protection-configured   refuse unless branch protection registers required checks
                                    (requires --cross-check-protection)
  --apply                           perform the publication (default: plan only)
  --no-fetch                        skip \`git fetch\` before verifying
  -h, --help                        print this help

Exit codes: 0 publish/already-published, 1 rule violated, 2 facts unavailable.`;

const invokedPath = process.argv[1];
const invokedDirectly =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2));
}
