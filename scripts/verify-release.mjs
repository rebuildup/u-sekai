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
 *                                  Default: --sha, else --main-ref.
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
 *   --require-protection-configured
 *                                  Refuse to publish unless branch protection
 *                                  on --main-ref registers required status checks.
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
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REQUIRED_RELEASE_CHECKS,
  deriveReleaseBranchName,
  evaluateReleasePublication,
  resolveExpectedReleaseSha,
} from './release-rules.mjs';

const PREFIX = 'release-verify';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class FactsError extends Error {}

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function info(message) {
  console.log(`${PREFIX}: ${message}`);
}

function warn(message) {
  console.error(`${PREFIX}: ${message}`);
}

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
    const result = {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
    if (allowFailure) return result;
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    throw new FactsError(`${file} ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`);
  }
}

function firstLine(text) {
  const line = String(text).split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

function git(args, options) {
  return runCommand('git', args, options).stdout;
}

function isNotFound(result) {
  return /HTTP 404/.test(result.stderr) || /not found/i.test(result.stderr);
}

function ghApi(endpoint, { allowMissing = false } = {}) {
  const result = runCommand('gh', ['api', endpoint], { allowFailure: allowMissing });
  if (!result.ok) {
    if (allowMissing && isNotFound(result)) return null;
    throw new FactsError(`gh api ${endpoint} failed: ${firstLine(result.stderr)}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed === '' ? null : JSON.parse(trimmed);
}

function parseArgs(argv) {
  const options = {
    tag: null,
    releaseBranch: null,
    sha: null,
    sourceRef: null,
    mainRef: 'main',
    remote: 'origin',
    repo: null,
    requiredChecks: [],
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

function resolveRepo(options) {
  if (options.repo !== null) return options.repo;
  const url = firstLine(git(['remote', 'get-url', options.remote])).trim();
  const ssh = /^[^@\s]+@[^:\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) return ssh[1];
  const https = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
  if (https !== null) return https[1];
  throw new FactsError(
    `cannot derive the GitHub repository from remote ${options.remote} (${url}); pass --repo owner/name`,
  );
}

function revParse(ref) {
  return firstLine(git(['rev-parse', '--verify', `${ref}^{commit}`]));
}

function isAncestor(ancestor, descendant) {
  const result = runCommand('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  return result.ok;
}

function readVersionFrom(sourceRef) {
  const raw = runCommand('git', ['show', `${sourceRef}:package.json`], { allowFailure: true });
  if (!raw.ok) {
    throw new FactsError(
      `cannot read package.json at ${sourceRef}: ${firstLine(raw.stderr) || 'unknown error'}`,
    );
  }
  const parsed = JSON.parse(raw.stdout);
  if (typeof parsed.version !== 'string') {
    throw new FactsError(`package.json at ${sourceRef} has no string version field`);
  }
  return parsed.version;
}

function parseMerges(ref) {
  const raw = git(['log', ref, '--merges', '--format=%H%x1f%P%x1f%s%x1e']);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha, parents, subject] = record.split('\x1f');
      return { sha, parents: parents.split(' ').filter((value) => value !== ''), subject };
    });
}

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

function readCheckRuns(repo, sha) {
  const response = ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
    allowMissing: true,
  });
  if (response === null) return null;
  const runs = Array.isArray(response.check_runs) ? response.check_runs : [];
  const suiteIds = new Set();
  for (const run of runs) {
    if (run?.check_suite?.id !== undefined && run.check_suite.id !== null) {
      suiteIds.add(run.check_suite.id);
    }
  }
  const headBranchBySuite = new Map();
  for (const suiteId of suiteIds) {
    const suite = ghApi(`repos/${repo}/check-suites/${suiteId}`, { allowMissing: true });
    headBranchBySuite.set(suiteId, suite?.head_branch ?? null);
  }
  return runs.map((run) => ({
    name: String(run?.name ?? ''),
    status: String(run?.status ?? ''),
    conclusion: run?.conclusion ?? null,
    headBranch: headBranchBySuite.get(run?.check_suite?.id) ?? null,
    startedAt: run?.started_at ?? null,
    completedAt: run?.completed_at ?? null,
    id: run?.id ?? null,
    url: run?.html_url ?? null,
  }));
}

function readExistingTag(repo, tagName) {
  const ref = ghApi(`repos/${repo}/git/ref/tags/${tagName}`, { allowMissing: true });
  if (ref === null || ref === undefined) return null;
  let object = ref.object;
  for (let depth = 0; depth < 5 && object?.type === 'tag'; depth += 1) {
    const annotated = ghApi(`repos/${repo}/git/tags/${object.sha}`, { allowMissing: true });
    if (annotated === null) break;
    object = annotated.object;
  }
  if (typeof object?.sha !== 'string') return null;
  return { sha: object.sha };
}

/**
 * Status check contexts registered on the protected branch.
 *
 * Returns an empty array when GitHub reports that none are enabled, and `null`
 * when the answer could not be read at all, for example because the workflow
 * token may not read branch protection. The two cases are reported differently
 * so an unreadable answer is never presented as "nothing is required".
 */
function readProtectionContexts(repo, mainRef) {
  const endpoint = `repos/${repo}/branches/${encodeURIComponent(mainRef)}/protection/required_status_checks`;
  const result = runCommand('gh', ['api', endpoint], { allowFailure: true });
  if (!result.ok) {
    if (isNotFound(result)) return [];
    warn(`required status checks on ${mainRef} could not be read: ${firstLine(result.stderr)}`);
    return null;
  }
  const trimmed = result.stdout.trim();
  if (trimmed === '') return [];
  const response = JSON.parse(trimmed);
  const contexts = new Set();
  for (const context of Array.isArray(response.contexts) ? response.contexts : []) {
    contexts.add(String(context));
  }
  for (const check of Array.isArray(response.checks) ? response.checks : []) {
    if (typeof check?.context === 'string') contexts.add(check.context);
  }
  return [...contexts];
}

function resolveCommitish(repo, tagSha, value) {
  if (typeof value !== 'string' || value === '') return null;
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  if (tagSha !== null && value === 'HEAD') return tagSha;
  const local = runCommand('git', ['rev-parse', '--verify', `${value}^{commit}`], {
    allowFailure: true,
  });
  if (local.ok) return firstLine(local.stdout);
  // A GitHub Release is identified by its tag, and `target_commitish` is only
  // consulted while that tag does not exist yet. Once the tag resolves, the
  // commit a release ships is the tag's commit, so an unresolvable symbolic
  // value (a branch name, the tag name) must not be reported as a different
  // commit and must not be compared as one. `tag-idempotency` independently
  // pins the tag to the release commit.
  return tagSha;
}

function readExistingRelease(repo, tagName, tagSha) {
  const release = ghApi(`repos/${repo}/releases/tags/${tagName}`, { allowMissing: true });
  if (release === null || release === undefined) return null;
  return {
    sha: resolveCommitish(repo, tagSha, release.target_commitish) ?? 'unknown',
    targetCommitish: typeof release.target_commitish === 'string' ? release.target_commitish : null,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
  };
}

function readConflictingReleaseTags(repo, version, tagName) {
  const releases = ghApi(`repos/${repo}/releases?per_page=100`, { allowMissing: true });
  if (releases === null || !Array.isArray(releases)) return [];
  return releases
    .map((release) => String(release?.tag_name ?? ''))
    .filter((name) => name !== '' && name !== tagName && name.replace(/^v/, '') === version);
}

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

function assertPublished(repo, tagName, targetSha) {
  const tag = readExistingTag(repo, tagName);
  if (tag === null || tag.sha !== targetSha) {
    throw new FactsError(
      `post-condition failed: tag ${tagName} is ${tag === null ? 'missing' : `at ${tag.sha}`}, expected ${targetSha}`,
    );
  }
  const release = readExistingRelease(repo, tagName, targetSha);
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

function main(argv) {
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
    const packageVersion = readVersionFrom(sourceRef);
    const tagName = options.tag ?? `v${packageVersion}`;
    const releaseBranch = options.releaseBranch ?? deriveReleaseBranchName(packageVersion);
    const { checks: requiredChecks, source: gateSource } = selectRequiredChecks(options);

    info(`repository ${repo}`);
    info(`mode ${options.apply ? 'apply' : 'plan (no mutation)'}`);
    info(`version source ${sourceRef}:package.json#version = ${JSON.stringify(packageVersion)}`);
    info(`tag ${tagName} -> ${targetSha}`);
    info(`release branch ${releaseBranch} (derived from version)`);
    info(`release gate ${JSON.stringify(requiredChecks)} from ${gateSource}`);

    const merges = parseMerges(mainRef);
    const expectedReleaseSha = resolveExpectedReleaseSha({ merges, releaseBranch });
    info(
      `expected release commit ${expectedReleaseSha.sha ?? 'unresolved'} on ${mainRef}` +
        (expectedReleaseSha.subject === undefined ? '' : ` (${expectedReleaseSha.subject})`),
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
    const conflictingReleaseTags = readConflictingReleaseTags(repo, packageVersion, tagName);
    info(
      `existing artifacts: tag ${existingTag === null ? 'absent' : `at ${existingTag.sha}`}, release ${
        existingRelease === null ? 'absent' : `at ${existingRelease.sha}`
      }`,
    );

    const protectionContexts = readProtectionContexts(repo, options.mainRef);
    info(
      `branch protection required status checks on ${options.mainRef}: ${
        protectionContexts === null
          ? 'unreadable'
          : protectionContexts.length === 0
            ? 'none registered'
            : protectionContexts.join(', ')
      }`,
    );

    const evaluation = evaluateReleasePublication({
      repo,
      sourceRef,
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
      releaseBranchTip,
      releaseBranchTipIsAncestor,
      requiredChecks,
      gateSource,
      protectionContexts,
      requireProtectionConfigured: options.requireProtectionConfigured,
      checkRunsReadable: checkRuns !== null,
      checkRuns: checkRuns ?? [],
      applicableBranches: ['main', releaseBranch],
      existingTag,
      existingRelease,
      conflictingReleaseTags,
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

    // Re-read each artifact immediately before creating it. Two concurrent
    // publishing runs must converge on one tag and one Release rather than race
    // into a second artifact; the post-condition assertion below still fails
    // loudly if the pre-existing artifact points somewhere else.
    if (existingTag === null) {
      const current = readExistingTag(repo, tagName);
      if (current === null) {
        ghApiWrite(`repos/${repo}/git/refs`, `refs/tags/${tagName}`, targetSha);
        info(`created tag ${tagName} at ${targetSha}`);
      } else {
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
  --source-ref <ref>                ref to read package.json#version from (default: --sha)
  --tag <name>                      tag to publish (default: v<version>)
  --release-branch <name>           intended release branch (default: release-<version with dashes>)
  --main-ref <ref>                  ref holding the released source state (default: main)
  --remote <name>                   git remote (default: origin)
  --repo <owner/name>               GitHub repository (default: derived from the remote URL)
  --required-check <name>           repeatable; replaces the default release gate list
  --require-protection-configured   refuse unless branch protection registers required checks
  --apply                           perform the publication (default: plan only)
  --no-fetch                        skip \`git fetch\` before verifying
  -h, --help                        print this help

Exit codes: 0 publish/already-published, 1 rule violated, 2 facts unavailable.`;

main(process.argv.slice(2));
