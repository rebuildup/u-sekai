/**
 * Invariant: the **default** Vitest profile must not require a browser.
 *
 * ## The regression this file exists to prevent (Issue #90)
 *
 * `test/integration/runtime/playwright-vertical-slice.test.ts` was a
 * Playwright-backed acceptance test placed under `test/integration/**`,
 * which the default `include` covers. `npm run ci` runs that profile, so
 * a Chromium whose shared libraries are not installed turned `npm run
 * ci` red. That is not hypothetical: the machine this fix was written
 * on failed with `libnspr4.so: cannot open shared object file`, which
 * is the ordinary state of a machine that ran `npm ci` but never
 * `npx playwright install --with-deps chromium`.
 *
 * The test has since moved to `test/browser/**`, where
 * `test/vitest.browser.config.ts` owns it. A comment saying "do not put
 * browser tests in the default profile" does not survive the next
 * contributor, so the rule is asserted here instead.
 *
 * ## What is asserted, structurally
 *
 * Not "this file mentions Playwright" — the whole point is to catch a
 * violation that looks nothing like the one that happened. Instead:
 *
 * 1. the default profile's `include` globs are read out of
 *    `vitest.config.ts` itself, so **widening the profile is what makes
 *    the test bite**, not editing this file;
 * 2. every file those globs match is walked over its **transitive**
 *    import closure, because a browser dependency three modules deep is
 *    the same regression as one at the top;
 * 3. a violation is any file in that closure under `test/browser/**` —
 *    the browser profile's support tree, which is where
 *    `assertBrowserRuntimeAvailable` and the browser `globalSetup` live
 *    and where the fail-loud preflight is implemented;
 * 4. a violation is also any **test** file the include matches that
 *    imports a browser entry point in an import of its own — the
 *    `playwright` package, or `src/adapter/browser/playwright-adapter`.
 *
 * Rule 3 is what regression #90 actually was. Rule 4 catches the shape
 * that would be next: importing `PlaywrightAdapter` straight into
 * `test/integration/**` with no browser support helper in sight.
 *
 * ## Why rule 4 stops at the test file
 *
 * `src/cli/index.ts` statically imports `PlaywrightAdapter` so the
 * shipped CLI can offer `--adapter playwright`, and any test that
 * imports the CLI therefore reaches the `playwright` *module*. That is
 * a deliberate product boundary, not a defect, and it costs nothing at
 * rest: importing the module does not launch a browser, and the default
 * profile only ever asks for the HTTP adapter. Asserting on the whole
 * transitive package graph would therefore be red on a correct tree, so
 * the rule is scoped to what a test itself imports.
 *
 * A subprocess spawn (`node dist/cli/index.js run ... --adapter
 * playwright` with no import) is the one shape this analysis cannot see.
 * That is stated here rather than papered over, because a guard that
 * claims more coverage than it has is worse than no guard.
 *
 * ## Proving the guard is not vacuous
 *
 * A structural check that can never fail is worse than a comment. The
 * last test in this file runs the *same* two rules over the file that
 * actually caused the regression and asserts that both report. If the
 * walker stops resolving imports, or the globs stop matching, or the
 * forbidden set stops being compared, that test goes red in the same
 * commit as the guard becomes toothless.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BROWSER_TREE = 'test/browser/';
/**
 * What a default-profile test may not name in an import of its own.
 *
 * Both the SDK and the adapter that wraps it count: regression #90 did
 * not import Chromium itself, it imported `PlaywrightAdapter` and let
 * the CLI's own adapter registry decide when to launch.
 */
const BROWSER_ENTRY_POINTS = new Set([
  'playwright',
  'playwright-core',
  'src/adapter/browser/playwright-adapter.ts',
]);

/** The file whose presence under the default profile was regression #90. */
const REGRESSION_FILE = 'test/browser/runtime/playwright-vertical-slice.test.ts';

/* -------------------------------------------------------------------------- */
/* Glob matching                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compile one `include` glob to a matcher over POSIX repo-relative paths.
 *
 * Supports the subset Vitest's `include` actually uses: `**`, `*` and
 * `?`. Hand-rolled rather than pulled from a dependency so the guard
 * cannot break when Vitest changes its bundling.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Every file under `test/`, as a POSIX repo-relative path. */
function repoFilesUnder(dir: string): ReadonlyArray<string> {
  const absolute = path.join(REPO_ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(absolute);
  return out.sort();
}

/**
 * The default profile's `include` globs, read from `vitest.config.ts`.
 *
 * Parsed from the config's source rather than imported, for two
 * reasons. Importing it would drag the root config file into the
 * `tsconfig.json` program — which excludes root-level files today, and
 * would surface an unrelated latent type error in a file this change
 * has no business touching. And a source read keeps the guard honest
 * about *why* it throws: if the config stops being a literal
 * `include: [...]` of string literals, the guard must fail loudly
 * rather than quietly check nothing.
 */
function defaultInclude(): ReadonlyArray<string> {
  const source = readRepoFile('vitest.config.ts');
  if (source === null) throw new Error('vitest.config.ts is missing at the repository root');

  const declarations = source.match(/\binclude\s*:\s*\[/g) ?? [];
  if (declarations.length !== 1) {
    throw new Error(
      `expected exactly one \`include: [\` in vitest.config.ts, found ${declarations.length}; ` +
        'update test/unit/toolchain/default-profile-is-browser-free.test.ts to read it.',
    );
  }

  const body = /\binclude\s*:\s*\[([\s\S]*?)\]/.exec(source)?.[1];
  if (body === undefined) {
    throw new Error('could not read the include array body out of vitest.config.ts');
  }
  const globs = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((g): g is string => typeof g === 'string');
  if (globs.length === 0) {
    throw new Error(
      'the include array in vitest.config.ts holds no string literal; ' +
        'update test/unit/toolchain/default-profile-is-browser-free.test.ts to read it.',
    );
  }
  return globs;
}

/* -------------------------------------------------------------------------- */
/* Import-closure walking                                                       */
/* -------------------------------------------------------------------------- */

const SPECIFIER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from '...' / export ... from '...'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // await import('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
];

/**
 * Every module specifier in a TypeScript source, static or dynamic.
 *
 * A deliberately blunt scan rather than a parser: it over-approximates
 * (a specifier inside a comment counts), and over-approximation is the
 * safe direction for a guard.
 */
function specifiersIn(source: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/** The bare package name of a specifier, or `null` when it is relative. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/**
 * Resolve a relative specifier written in this repo's NodeNext style.
 *
 * `../../src/x.js` from a test file resolves to the `.ts` source, which
 * is what Vitest loads; `dir/index.js` resolves to `dir/index.ts`.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const candidate of [`${base.replace(/\.js$/, '')}.ts`, `${base}/index.ts`]) {
    if (existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

function readRepoFile(rel: string): string | null {
  const absolute = path.join(REPO_ROOT, rel);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  return readFileSync(absolute, 'utf8');
}

/** The transitive relative-import closure of `entry`, in discovery order. */
function closureOf(entry: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const files: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readRepoFile(current);
    if (source === null) continue;
    files.push(current);
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelative(current, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return files;
}

interface Violation {
  readonly rule: string;
  readonly via: string;
}

/** Rule 3: does `entry` reach the browser profile's support tree? */
function reachesBrowserTree(entry: string): ReadonlyArray<Violation> {
  return closureOf(entry)
    .filter((file) => file.startsWith(BROWSER_TREE))
    .map((file) => ({ rule: 'reaches test/browser/**', via: file }));
}

/** Rule 4: does `entry` itself import a browser entry point? */
function importsBrowserEntryPoint(entry: string): ReadonlyArray<Violation> {
  const source = readRepoFile(entry);
  if (source === null) return [];
  return specifiersIn(source)
    .map((specifier) => {
      const resolved = specifier.startsWith('.')
        ? resolveRelative(entry, specifier)
        : packageOf(specifier);
      return { specifier, resolved };
    })
    .filter(({ resolved }) => resolved !== null && BROWSER_ENTRY_POINTS.has(resolved))
    .map(({ specifier }) => ({ rule: 'imports a browser entry point', via: specifier }));
}

/** Every reason `entry` would drag a browser into the default profile. */
function browserViolationsOf(entry: string): ReadonlyArray<Violation> {
  return [...reachesBrowserTree(entry), ...importsBrowserEntryPoint(entry)];
}

function report(violations: ReadonlyArray<Violation>): string {
  return violations.map((v) => `  ${v.rule}: ${v.via}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* The invariant                                                                 */
/* -------------------------------------------------------------------------- */

describe('the default Vitest profile stays runnable without a browser', () => {
  const include = defaultInclude();
  const candidates = repoFilesUnder('test').filter((file) =>
    include.some((glob) => globToRegExp(glob).test(file)),
  );

  it('matches the suites the default profile is supposed to run', () => {
    // Zero discovered files is a failed validation, not a pass. If a
    // refactor moves the suites, this says so instead of the guard
    // silently checking an empty set.
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((f) => f.startsWith('test/unit/'))).toBe(true);
    expect(candidates.some((f) => f.startsWith('test/integration/'))).toBe(true);
    expect(candidates.some((f) => f.startsWith('test/e2e/'))).toBe(true);
  });

  it('does not match the browser profile at all', () => {
    // The first half of the invariant, stated directly: `test/browser/**`
    // is a separate profile, so a file there is never `npm run ci`'s
    // problem. This is what makes `npm run test:browser` the only way
    // to pay for Chromium.
    const leaked = candidates.filter((f) => f.startsWith(BROWSER_TREE));
    expect(leaked, `the default include matches browser tests:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('keeps every matched test off the browser support tree and off every browser entry point', () => {
    const violations = candidates.flatMap((file) => browserViolationsOf(file));
    expect(
      violations,
      [
        'the default Vitest profile must stay runnable with no browser binaries installed.',
        'Move browser-backed tests to test/browser/ (npm run test:browser), and cover the',
        'browser-independent path under test/integration/ or test/unit/ through HttpAdapter.',
        '',
        report(violations),
      ].join('\n'),
    ).toEqual([]);
  });

  it('reaches the browser through the regression file, so the check above is not vacuous', () => {
    // The detector is exercised against the file that actually caused
    // the regression. If this ever reports nothing, the walker, the
    // resolution or the forbidden set has stopped working and the test
    // above is guarding nothing.
    const violations = browserViolationsOf(REGRESSION_FILE);
    expect(violations.map((v) => v.rule)).toContain('reaches test/browser/**');
    expect(violations.map((v) => v.rule)).toContain('imports a browser entry point');
    expect(violations.map((v) => v.via)).toContain(
      'test/browser/support/browser-runtime.ts',
    );
  });
});
