/**
 * Invariant: every tracked source file is actually linted by `eslint .` with
 * the project's ruleset, and is inside the `tsc` program. A file that escapes
 * both is a file this repository has never looked at, and nothing in the
 * quality gate will say so.
 *
 * ## The regression this file exists to prevent (Issue #104)
 *
 * `eslint.config.js` declared an explicit allow-list:
 *
 * ```js
 * files: ['src/**\/*.ts', 'test/**\/*.ts'],
 * ```
 *
 * `eslint .` lints what its config objects match and nothing else. Two
 * distinct escapes existed, and the second is the one that hurts:
 *
 * 1. **Silently skipped.** `vitest.config.ts` sits at the repository root. No
 *    config object matched it, so `eslint .` linted nothing there, printed
 *    nothing, and exited 0. Issue #69 had already found `examples/` in exactly
 *    this state, and also outside `tsconfig.json`'s `include` — that code was
 *    doubly unverified while `eslint .` reported green.
 * 2. **Linted with zero rules.** `scripts/*.mjs` and `eslint.config.js` *are*
 *    picked up by ESLint's built-in `**\/*.js,mjs,cjs` catch-all, so they
 *    appear to be covered. But no config object carries `rules` for them, so
 *    `calculateConfigForFile` resolves to an empty ruleset: `eqeqeq`,
 *    `no-unused-vars`, `no-console` and `@typescript-eslint/no-explicit-any`
 *    are all inert there. The file is counted as linted by any check that only
 *    asks "was this file linted?" and it is verified by nothing.
 *
 * Escape 2 is why the assertion here is not "is the file ignored?". It is
 * "does a config object actually contribute rules to it?".
 *
 * ## Why this is a test and not just a longer `files` array
 *
 * Adding `examples/` to `files` (what #69 did) fixes one directory and stops
 * nothing. The next directory a contributor creates repeats the escape, and
 * the gate stays green, because a green `eslint .` is exactly what an
 * unobserved directory looks like. The list cannot police itself; only a check
 * that re-derives the set of source files and asks the real tools about each
 * one can.
 *
 * So this file does not enumerate the directories it checks. It asks `git`
 * which files are tracked, keeps the ones that are source, and then asks
 * **ESLint and the TypeScript compiler** — the same engines, reading the same
 * config files, that `npm run lint` and `npm run typecheck` use — what each of
 * them would do with each file. There is no second glob engine here to fall out
 * of sync with the first, which is the failure mode that produced #95, #69 and
 * this ticket.
 *
 * ## Why the exemption list cannot become the next allow-list
 *
 * Genuine gaps exist and are owned by other tickets, so they are declared
 * rather than hidden. Three properties keep the list honest:
 *
 * - every entry must carry a `reason` and an `issue`, so an escape cannot be
 *   added without saying what it is and who owns it;
 * - an entry whose files are now covered *without* it fails, so closing a gap
 *   forces the declaration to be deleted instead of being inherited forever;
 * - the last test runs the very same coverage pipeline over a synthetic path in
 *   a directory that does not exist, proving the pipeline reports an unseen
 *   directory as uncovered rather than passing it vacuously.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Extensions treated as source code.
 *
 * This is a definition of "what is source", not a list of directories — the
 * directories are discovered. If the repository adopts a new source extension
 * it has to be added here, which is a deliberate, visible act; the failure
 * mode this guards against (a new *directory*) needs no change to this set.
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** The two ways a source file can escape verification. */
type Axis = 'lint' | 'typecheck';

interface Verdict {
  /** True only when a config object contributes a non-empty ruleset. */
  readonly covered: boolean;
  /** Why, phrased so the message names the thing to change. */
  readonly why: string;
}

interface Exemption {
  /** Path or directory prefix. Matches `file` exactly or as a `path/` prefix. */
  readonly path: string;
  readonly axis: Axis;
  /** Why this is uncovered. Required — an exemption without one cannot be added. */
  readonly reason: string;
  /** Ticket that owns closing the gap. Required. */
  readonly issue: string;
}

/**
 * Gaps that are real, owned elsewhere, and therefore declared rather than
 * silently tolerated. Everything else must be covered.
 */
const EXEMPTIONS: ReadonlyArray<Exemption> = [
  {
    path: 'eslint.config.js',
    axis: 'typecheck',
    reason:
      "eslint.config.js:53 raises TS18048 ('tseslint.configs.recommended' is possibly undefined) under checkJs, so `*.js` cannot join the tsconfig program yet. Lint coverage is present; only the type check is missing.",
    issue: '#101',
  },
  {
    path: 'vitest.config.ts',
    axis: 'typecheck',
    reason:
      "tsconfig.json's `include` does not reach root-level `*.config.ts` yet, so the file is outside the tsc program. PR #98 (branch 95) adds it. Lint coverage is present.",
    issue: '#98',
  },
  {
    path: 'scripts',
    axis: 'lint',
    reason:
      'scripts/*.mjs is type-checked via `scripts/**/*.mjs`, but no eslint config object carries `rules` for it, so it is linted with an empty ruleset. Closing this needs either a semantics-changing `!=` to `!==` in a release script (release-rules.mjs:619 uses the deliberate `!= null` idiom, which `!==` would break) or a `no-console` exception for CLIs whose stdout is their product — both out of scope here.',
    issue: '#104',
  },
];

/* -------------------------------------------------------------------------- */
/* discovery                                                                   */
/* -------------------------------------------------------------------------- */

function trackedFiles(): ReadonlyArray<string> {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((entry) => entry.length > 0);
  } catch (error) {
    // Fail loudly. A guard that cannot see the repository must not report
    // "everything is covered".
    throw new Error(
      `could not list tracked files with \`git ls-files\`: ${String(error)}. ` +
        'This guard discovers source files from git, so it cannot run here.',
    );
  }
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

const sourceFiles: ReadonlyArray<string> = trackedFiles()
  .map((file) => file.split(path.sep).join('/'))
  .filter(isSourceFile)
  .sort();

/**
 * Directories that hold at least one of the given files.
 *
 * `.` is included only when a top-level file is actually involved, so a failure
 * message does not point the contributor at the repository root for a problem
 * that lives three directories down.
 */
function directoriesOf(files: ReadonlyArray<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    segments.pop();
    if (segments.length === 0) {
      directories.add('.');
      continue;
    }
    for (let i = 1; i <= segments.length; i += 1) {
      directories.add(segments.slice(0, i).join('/'));
    }
  }
  return directories;
}

/* -------------------------------------------------------------------------- */
/* what the tools actually do                                                  */
/* -------------------------------------------------------------------------- */

const eslint = new ESLint({ cwd: REPO_ROOT });

/**
 * Count the rules that would actually run. A rule set to `off` is present in
 * the config and enforces nothing, so counting it as coverage would reproduce
 * the exact defect this file exists to catch — "listed, but inert".
 */
function enabledRuleCount(config: { rules?: Record<string, unknown> } | undefined): number {
  return Object.values(config?.rules ?? {}).filter((setting) => {
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity !== 'off' && severity !== 0;
  }).length;
}

/**
 * Ask ESLint, reading the project's own `eslint.config.js`, whether `file` is
 * linted by a config object that actually carries rules.
 *
 * `isPathIgnored` is true both for a path matched by an `ignores` entry *and*
 * for a file no config object matches at all — which is escape 1. The message
 * therefore states both causes rather than guessing at one.
 */
async function lintVerdict(file: string): Promise<Verdict> {
  if (await eslint.isPathIgnored(file)) {
    return {
      covered: false,
      why: '`eslint .` does not lint it at all: no eslint config object matches it, or it matches an `ignores` entry',
    };
  }
  const config = await eslint.calculateConfigForFile(file);
  const ruleCount = enabledRuleCount(config);
  if (ruleCount === 0) {
    return {
      covered: false,
      why: 'no eslint config object contributes an enabled rule to it, so it is linted with an empty ruleset',
    };
  }
  return { covered: true, why: `${ruleCount} enabled rules` };
}

/** The file list `tsc -p tsconfig.json` would compile, from the compiler itself. */
function typecheckProgram(): ReadonlySet<string> {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error !== undefined) {
    throw new Error(
      `tsconfig.json could not be read (TS${raw.error.code}): ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  const globalErrors = parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
  if (globalErrors.length > 0) {
    throw new Error(
      `tsconfig.json is not resolvable: ${globalErrors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
        .join('; ')}`,
    );
  }
  return new Set(parsed.fileNames.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/')));
}

const program = typecheckProgram();

function exemptionFor(file: string, axis: Axis): Exemption | undefined {
  return EXEMPTIONS.find(
    (exemption) =>
      exemption.axis === axis &&
      (exemption.path === file || file.startsWith(`${exemption.path}/`)),
  );
}

/** True when the file needs no exemption on this axis. */
function coveredOnItsOwnMerits(file: string, axis: Axis, lint: ReadonlyMap<string, Verdict>): boolean {
  if (axis === 'typecheck') {
    return program.has(file);
  }
  return lint.get(file)?.covered === true;
}

function isCovered(file: string, axis: Axis, lint: ReadonlyMap<string, Verdict>): boolean {
  return coveredOnItsOwnMerits(file, axis, lint) || exemptionFor(file, axis) !== undefined;
}

/** One lint verdict per tracked source file, computed once for the whole suite. */
const lint = new Map<string, Verdict>();

/* -------------------------------------------------------------------------- */

describe('lint and type-check coverage', () => {
  beforeAll(async () => {
    await Promise.all(
      sourceFiles.map(async (file) => {
        lint.set(file, await lintVerdict(file));
      }),
    );
  });

  it('discovers the repository\'s tracked source files', () => {
    // Guards against the whole file passing vacuously if discovery breaks.
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(sourceFiles.every((file) => !file.startsWith('/'))).toBe(true);
  });

  it('classifies by extension, not by a directory list', () => {
    // A new directory with source in it must be discovered without this file
    // having to learn its name.
    expect(isSourceFile('examples/tour.ts')).toBe(true);
    expect(isSourceFile('bench/throughput.mjs')).toBe(true);
    expect(isSourceFile('docs/architecture.md')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
  });

  it('exempts nothing that is not declared with a reason and an owning issue', () => {
    for (const exemption of EXEMPTIONS) {
      expect(exemption.reason.trim(), `exemption ${exemption.path} (${exemption.axis}) has no reason`).not.toBe('');
      expect(exemption.issue.trim(), `exemption ${exemption.path} (${exemption.axis}) has no issue`).not.toBe('');
      expect(exemption.issue).toMatch(/^#\d+$/);
    }
  });

  it('carries no exemption for a gap that has since been closed', () => {
    // Fails in both directions the declaration can go stale: a path that no
    // longer exists, and — the one that actually bites — a gap that another PR
    // closed while the declaration stayed behind to be inherited forever.
    const stale = EXEMPTIONS.filter((exemption) => {
      const matched = sourceFiles.filter(isCoveredBy(exemption));
      return matched.length === 0 || matched.every((file) => coveredOnItsOwnMerits(file, exemption.axis, lint));
    });
    expect(
      stale.map((exemption) => `${exemption.path} (${exemption.axis})`),
      'these exemptions no longer describe a real gap — the files are covered without them. Delete the entry.',
    ).toEqual([]);
  });

  it('gives every tracked source file a real lint ruleset', () => {
    const uncovered = sourceFiles
      .filter((file) => !isCovered(file, 'lint', lint))
      .map((file) => `${file} — ${lint.get(file)?.why ?? 'not evaluated'}`);
    expect(uncovered, uncoveredMessage(uncovered)).toEqual([]);
  });

  it('puts every tracked source file inside the tsc program', () => {
    const uncovered = sourceFiles
      .filter((file) => !isCovered(file, 'typecheck', lint))
      .map((file) => `${file} — not in the file list tsconfig.json resolves to`);
    expect(uncovered, uncoveredMessage(uncovered)).toEqual([]);
  });

  it('covers most files on both axes on their own merits, not by exemption', () => {
    // If every file were exempted, the two tests above would pass while
    // checking nothing. Most files must be covered without help.
    const coveredByMerit = sourceFiles.filter(
      (file) => coveredOnItsOwnMerits(file, 'lint', lint) && coveredOnItsOwnMerits(file, 'typecheck', lint),
    );
    expect(coveredByMerit.length).toBeGreaterThan(sourceFiles.length / 2);
  });

  it('reports an unseen directory as uncovered instead of passing it vacuously', async () => {
    // The guard's own negative control, using the same code path as the real
    // checks. A path that exists in no directory of this repository must come
    // back uncovered on both axes — otherwise the tests above would pass
    // against a filter that had degenerated to "always covered".
    const synthetic = 'zz-synthetic-probe/never-created.mjs';
    const exempting = exemptionFor(synthetic, 'lint') ?? exemptionFor(synthetic, 'typecheck');
    expect(exempting, `the synthetic probe path must not be exempted (${exempting?.path})`).toBeUndefined();

    const verdict = await lintVerdict(synthetic);
    expect(verdict.covered, `the probe path was reported as lint-covered: ${verdict.why}`).toBe(false);
    expect(program.has(synthetic), 'the probe path was found inside the tsc program').toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isCoveredBy(exemption: Exemption): (file: string) => boolean {
  return (file) => exemption.path === file || file.startsWith(`${exemption.path}/`);
}

function uncoveredMessage(messages: ReadonlyArray<string>): string {
  const files = messages.map((message) => message.split(' — ')[0] as string);
  return [
    'These tracked source files are not covered. `eslint .` lints what its config',
    'objects match and stays silent about everything else, so this is exactly the',
    'state `examples/` was in when Issue #69 found it: verified by nothing, with a',
    'green gate.',
    '',
    'Fix: add the directory or file to the relevant config, then re-run.',
    '  - lint      -> a `files` entry in eslint.config.js that also carries `rules`',
    '  - typecheck -> an `include` entry in tsconfig.json',
    '',
    `Directories involved: ${[...directoriesOf(files)].sort().join(', ')}`,
  ].join('\n');
}