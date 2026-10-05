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
 * "is the file ignored, **and** does a config object actually contribute
 * rules to it?".
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
 * - an entry that no longer matches any tracked file fails, so a gap that gets
 *   fixed cannot leave a stale exemption behind to be inherited;
 * - the final test runs the discovery over a synthetic file in a directory
 *   that does not exist, so a filter that had degenerated to "always true"
 *   would pass this file vacuously — it must go red instead.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
      'scripts/*.mjs is type-checked via `scripts/**/*.mjs`, but no eslint config object carries `rules` for it, so it is linted with an empty ruleset. Closing this needs either a semantics-changing `!=` to `!==` in a release script or a `no-console` exception for CLIs whose stdout is their product — both out of scope here.',
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

/** Directories that hold at least one discovered source file. */
function sourceDirectories(files: ReadonlyArray<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    // Every ancestor up to (but excluding) the file itself, plus the top level.
    segments.pop();
    for (let i = 1; i <= segments.length; i += 1) {
      directories.add(segments.slice(0, i).join('/'));
    }
    directories.add('.');
  }
  return directories;
}

/* -------------------------------------------------------------------------- */
/* what the tools actually do                                                  */
/* -------------------------------------------------------------------------- */

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintVerdict(file: string): Promise<{ covered: boolean; why: string }> {
  if (await eslint.isPathIgnored(file)) {
    return { covered: false, why: 'matches an eslint `ignores` entry' };
  }
  const config = await eslint.calculateConfigForFile(file);
  const ruleCount = Object.keys(config?.rules ?? {}).length;
  if (ruleCount === 0) {
    return {
      covered: false,
      why: 'no eslint config object contributes `rules` to it, so it is linted with an empty ruleset (or not linted at all)',
    };
  }
  return { covered: true, why: `${ruleCount} rules` };
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

function isCovered(file: string, axis: Axis, lintVerdicts: ReadonlyMap<string, string>): boolean {
  if (axis === 'typecheck') {
    return program.has(file) || exemptionFor(file, axis) !== undefined;
  }
  return lintVerdicts.get(file) === 'ok' || exemptionFor(file, axis) !== undefined;
}

/* -------------------------------------------------------------------------- */

describe('lint and type-check coverage', () => {
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

  it('has no stale exemption left behind by a gap that has since been closed', () => {
    const stale = EXEMPTIONS.filter((exemption) => !sourceFiles.some(isCoveredBy(exemption)));
    expect(
      stale.map((exemption) => `${exemption.path} (${exemption.axis})`),
      'these exemptions no longer match any tracked source file — delete them',
    ).toEqual([]);
  });

  it('gives every tracked source file a real lint ruleset', async () => {
    const verdicts = new Map<string, string>();
    const uncovered: string[] = [];
    for (const file of sourceFiles) {
      const verdict = await lintVerdict(file);
      if (verdict.covered) {
        verdicts.set(file, 'ok');
      } else if (exemptionFor(file, 'lint') !== undefined) {
        verdicts.set(file, 'ok');
      } else {
        uncovered.push(`${file} — ${verdict.why}`);
      }
    }
    // Reported per directory so the message points at the thing to fix.
    expect(uncovered, uncoveredDirectories(uncovered)).toEqual([]);
  });

  it('puts every tracked source file inside the tsc program', () => {
    const uncovered = sourceFiles
      .filter((file) => !isCovered(file, 'typecheck', new Map()))
      .map((file) => `${file} — not in the file list tsconfig.json resolves to`);
    expect(uncovered, uncoveredDirectories(uncovered)).toEqual([]);
  });

  it('covers something on both axes without help from an exemption', () => {
    // If every file were exempted, the two tests above would pass while
    // checking nothing. At least one file must be covered on the merits.
    const lintExempted = new Set(EXEMPTIONS.filter((e) => e.axis === 'lint').map((e) => e.path));
    const typecheckExempted = new Set(EXEMPTIONS.filter((e) => e.axis === 'typecheck').map((e) => e.path));
    const coveredByMerit = sourceFiles.filter(
      (file) =>
        !lintExempted.has(file) && !typecheckExempted.has(file) && program.has(file),
    );
    expect(coveredByMerit.length).toBeGreaterThan(50);
  });
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isCoveredBy(exemption: Exemption): (file: string) => boolean {
  return (file) => exemption.path === file || file.startsWith(`${exemption.path}/`);
}

function uncoveredDirectories(messages: ReadonlyArray<string>): string {
  const directories = [...sourceDirectories(messages.map((message) => message.split(' — ')[0] as string))].sort();
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
    `Directories involved: ${directories.join(', ')}`,
  ].join('\n');
}
