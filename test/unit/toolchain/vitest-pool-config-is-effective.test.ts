/**
 * Invariant: the default Vitest profile's worker-pool settings are ones
 * Vitest 5 actually reads, and the file that declares them is inside the
 * type-check program so a future unreadable key is a build failure.
 *
 * ## The regression this file exists to prevent (Issue #95)
 *
 * `vitest.config.ts` carried
 *
 * ```ts
 * pool: 'forks',
 * forks: { singleFork: false },
 * ```
 *
 * under a comment promising one worker per test file so the integration
 * and e2e suites' ephemeral ports could not collide. The key was inert,
 * having been carried through two removals:
 *
 * - Vitest 2 renamed `test.forks` to `test.poolOptions.forks`;
 * - Vitest 4 removed `test.poolOptions` entirely ("All previous
 *   `poolOptions` are now top-level options") and dropped `singleFork`
 *   in favour of `maxWorkers: 1`.
 *
 * So on Vitest 5 the value was read by nothing, and the comment stated
 * an intent the toolchain was not honouring. Nothing was broken at the
 * time — `singleFork: false` is what the defaults already do — but the
 * next person to reach for the knob would have been ignored, and would
 * have gone looking for port collisions in a config that appeared to
 * rule them out.
 *
 * ## Why this is a test and not just a deleted key
 *
 * Deleting the key removes the lie. It does not stop the class. Two
 * independent workers hit the same error while doing other tickets,
 * because `tsconfig.json`'s `include` did not reach root-level config
 * files, so `tsc` never saw the unknown key and a guard that *imported*
 * the config inherited a type error it had no business fixing. Both
 * worked around it. So the property worth holding is the pair:
 *
 * 1. the config file is in the type-check program, so an unreadable key
 *    fails `npm run typecheck` — the real guard, and the one CI runs;
 * 2. no key from the removed `forks` / `poolOptions` eras is present,
 *    so the reintroduction fails here too, without needing a type check.
 *
 * Assertion 1 is the load-bearing one, because it protects the
 * *enabling condition* of the real guard: someone narrowing `include`
 * back to the pre-#95 list of `src`, `test` and `scripts` globs would
 * otherwise turn `npm run typecheck` blind to config drift again,
 * silently, and nothing else in the repository would notice.
 *
 * ## Why the include matcher is not taken on faith
 *
 * The matcher is hand-rolled, so the last test runs it over files that
 * discriminate it in both directions. If glob handling, extension
 * sensitivity or the exclude list stops working, this file goes red in
 * the same commit as the coverage goes back to being imaginary.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../../vitest.config.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The declared `test` block, viewed structurally.
 *
 * `UserConfig` cannot name `forks` or `poolOptions` — that is the whole
 * point of the regression — so the keys under test are read off a
 * deliberately untyped view. The typed half of the guard is
 * `tsconfig.json`'s coverage plus `npm run typecheck`; this half is the
 * one that keeps working when no type check is running.
 */
const testBlock = (vitestConfig as unknown as { test?: Record<string, unknown> }).test;

/* -------------------------------------------------------------------------- */
/* tsconfig include coverage                                                   */
/* -------------------------------------------------------------------------- */

interface TsconfigInclude {
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

function readTsconfig(file: string): TsconfigInclude {
  const absolute = path.join(REPO_ROOT, file);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  const include = parsed['include'];
  const exclude = parsed['exclude'];
  if (!Array.isArray(include) || !include.every((entry) => typeof entry === 'string')) {
    throw new Error(`${file} has no string-array \`include\`; update this test to read it`);
  }
  if (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === 'string')) {
    throw new Error(`${file} has no string-array \`exclude\`; update this test to read it`);
  }
  return { include: include as ReadonlyArray<string>, exclude: exclude as ReadonlyArray<string> };
}

/**
 * Compile one tsconfig `include` / `exclude` pattern to a matcher.
 *
 * Supports the subset this repository's tsconfigs use: `**`, `*`, `?`,
 * and a wildcard-free entry meaning "this directory and everything in
 * it" (TypeScript's own reading of `include: ["src"]`). Hand-rolled
 * rather than delegated to the TypeScript compiler API so the guard
 * cannot inherit a `typescript` upgrade's behaviour silently.
 */
function patternToRegExp(pattern: string): RegExp {
  const anchored = /[*?]/.test(pattern) ? pattern : `${pattern.replace(/\/+$/, '')}/**/*`;
  let out = '';
  for (let i = 0; i < anchored.length; i += 1) {
    const ch = anchored[i] as string;
    if (ch === '*') {
      if (anchored[i + 1] === '*') {
        if (anchored[i + 2] === '/') {
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

function matchesAny(patterns: ReadonlyArray<string>, candidate: string): boolean {
  return patterns.some((pattern) => patternToRegExp(pattern).test(candidate));
}

/** Whether `tsc -p tsconfig.json` would type-check this repo-relative file. */
function isInTypecheckProgram(candidate: string): boolean {
  const { include, exclude } = readTsconfig('tsconfig.json');
  const posix = candidate.split(path.sep).join('/');
  return matchesAny(include, posix) && !matchesAny(exclude, posix);
}

/* -------------------------------------------------------------------------- */

describe('the default Vitest profile', () => {
  it('declares no key from the removed forks / poolOptions eras', () => {
    expect(testBlock).toBeTypeOf('object');
    // `test.forks` — unreadable since Vitest 2.
    expect(Object.hasOwn(testBlock as object, 'forks')).toBe(false);
    // `test.poolOptions` — deprecated by Vitest 5 with
    // "`test.poolOptions` was removed in Vitest 4"; anything nested in it
    // is inert, `singleFork` included.
    expect(Object.hasOwn(testBlock as object, 'poolOptions')).toBe(false);
  });

  it('uses the forks pool', () => {
    expect(testBlock?.['pool']).toBe('forks');
  });

  it('lets each test file run in its own process', () => {
    // The intent the deleted `forks: { singleFork: false }` was stating.
    // In Vitest 5 the defaults deliver it, and these are the three
    // settings that would take it away: `fileParallelism: false` forces a
    // single worker, `maxWorkers: 1` caps the run at one, and
    // `isolate: false` reuses one worker across files so a bound port
    // survives into the next file. The last one is the live temptation —
    // Vitest 5 prints it as a startup-time optimisation after every run.
    expect(testBlock?.['fileParallelism']).not.toBe(false);
    expect([1, '1']).not.toContain(testBlock?.['maxWorkers']);
    expect(testBlock?.['isolate']).not.toBe(false);
  });
});

describe('tsconfig type-check coverage of root config files', () => {
  it('type-checks vitest.config.ts', () => {
    // The structural fix. Without this, `npm run typecheck` cannot see an
    // unknown key in the config and the defect class is undetectable.
    expect(isInTypecheckProgram('vitest.config.ts')).toBe(true);
  });

  it('type-checks the browser profile config, which it always has', () => {
    // `test/**/*` already covered this one. The root config was the odd
    // one out, which is what made the gap look deliberate.
    expect(isInTypecheckProgram('test/vitest.browser.config.ts')).toBe(true);
  });

  it('still type-checks the product', () => {
    expect(isInTypecheckProgram('src/index.ts')).toBe(true);
    expect(isInTypecheckProgram('scripts/check-version-sync.mjs')).toBe(true);
  });

  it('has a matcher that discriminates', () => {
    // Without these the assertion above is a tautology: a matcher that
    // answered "covered" to everything would pass it.
    expect(isInTypecheckProgram('scripts/anything.ts')).toBe(false);
    expect(isInTypecheckProgram('dist/index.js')).toBe(false);
    expect(isInTypecheckProgram('node_modules/vitest/index.ts')).toBe(false);
  });
});
