/**
 * Reads the two test profiles' `include` arrays as data, so the routing
 * decision can be asserted instead of assumed.
 *
 * Issue #70 is a routing bug: the #67 acceptance scenario sits under
 * `test/e2e/service-acceptance/**`, which the default profile sweeps with
 * a `*.test.ts` glob and the browser profile ignored. A profile `include`
 * array is exactly the kind of declaration that drifts back silently, so
 * the invariant "the acceptance scenario is executed by the browser
 * profile, and by nothing else" is pinned here and asserted in
 * `browser-profile-routing.test.ts`.
 *
 * The browser profile is imported directly: it lives under `test/`, so it
 * is already part of the TypeScript program. The default profile is read as
 * *source text* rather than imported. Importing `vitest.config.ts` would
 * pull a file this ticket does not own into `npm run typecheck` and turn its
 * latent errors into this ticket's gate failures (see Issue #70's sibling,
 * which owns that file). Reading it as text, and pinning the exact glob the
 * guard reasons about, keeps the assumption explicit and checkable.
 *
 * Nothing in this module touches a browser: it is imported from the default
 * (HTTP-free) profile so that the guard runs in `npm run ci`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import browserProfile from '../../../vitest.browser.config.js';

/** Where the #67 acceptance scenario lives. Owned by #67; routed by #70. */
export const ACCEPTANCE_DIR = 'test/e2e/service-acceptance';

/**
 * The one subtree of `ACCEPTANCE_DIR` that belongs to the *default*
 * profile: the routing guard itself. It is an HTTP-free configuration
 * assertion, so it must run in `npm run ci` — which means it must not be
 * matched by the browser profile either.
 */
export const ROUTING_SUBDIR = `${ACCEPTANCE_DIR}/routing`;

/** The file suffix that routes a scenario into the browser profile. */
const SCENARIO_SUFFIX = '.browser-acceptance.ts';

/** The exact entry that routes the acceptance scenario into the browser profile. */
export const SCENARIO_GLOB = `${ACCEPTANCE_DIR}/**/*${SCENARIO_SUFFIX}`;

/** The pre-existing browser suite entry, so this change adds a route, not a replacement. */
export const BROWSER_SUITE_GLOB = 'test/browser/**/*.test.ts';

/** The default profile's e2e sweep — the sweep #70's routing has to escape. */
export const DEFAULT_E2E_GLOB = 'test/e2e/**/*.test.ts';

const cache = new Map<string, RegExp>();

/**
 * Compiles the subset of glob syntax these profiles actually use: `*`
 * (within one path segment), a doubled star (zero or more path segments)
 * and `?`.
 *
 * Anything else is rejected rather than approximated. A guard built on a
 * silently mis-parsed pattern is worse than no guard, because it reports a
 * green for routing it never actually checked.
 */
function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        i += 1;
        if (pattern.charAt(i + 1) === '/') {
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if ('[]{}!+()|@'.includes(ch)) {
      throw new Error(
        `unsupported glob syntax ${JSON.stringify(ch)} in pattern ${JSON.stringify(pattern)}; ` +
          'the routing guard only implements *, ** and ? so it cannot mis-report coverage',
      );
    }
    source += ch.replace(/[.$^\\]/g, '\\$&');
  }

  const regex = new RegExp(`^${source}$`);
  cache.set(pattern, regex);
  return regex;
}

/** True when `filePath` (repo-relative, POSIX separators) is matched by `pattern`. */
export function matchesGlob(pattern: string, filePath: string): boolean {
  return compile(pattern).test(filePath);
}

/** Normalises Vitest's `string | string[] | undefined` include to a list. */
function includeList(value: unknown, profile: string): string[] {
  if (value === undefined) {
    throw new Error(`${profile} has no test.include; the routing guard cannot check coverage`);
  }
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${profile} test.include is not a list of globs: ${JSON.stringify(value)}`);
  }
  return list;
}

/** Repo root, derived from this file's own location. */
export const repoRoot = path
  .resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
  .replace(/[/\\]+$/, '');

/**
 * The browser profile pins `root` explicitly because it lives in `test/`,
 * and its globs are compared here as repo-relative paths. Assert the root
 * rather than assume it: a moved config would silently compare paths
 * against the wrong base.
 */
export const browserRoot = (() => {
  const root = (browserProfile as { root?: unknown }).root;
  if (typeof root !== 'string') {
    throw new Error(`test/vitest.browser.config.ts root is not a string: ${JSON.stringify(root)}`);
  }
  return root.replace(/[/\\]+$/, '');
})();

/** `test/vitest.browser.config.ts` — the browser-backed profile. */
export const browserInclude = includeList(
  (browserProfile as { test?: { include?: unknown } }).test?.include,
  'test/vitest.browser.config.ts',
);

/** The default profile's source, read rather than imported (see the file header). */
export const defaultProfileSource = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');

export interface ProfileClaim {
  /** Repo-relative, POSIX-separated path. */
  readonly file: string;
  readonly defaultProfile: boolean;
  readonly browserProfile: boolean;
}

/** Every `.ts` file under `ACCEPTANCE_DIR`, as repo-relative POSIX paths. */
function acceptanceFilesIn(dir: string): string[] {
  const absolute = path.join(repoRoot, dir);
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...acceptanceFilesIn(child));
    } else if (entry.name.endsWith('.ts')) {
      found.push(child);
    }
  }
  return found.sort();
}

/**
 * Which profile claims each acceptance-directory file. This is the
 * machine-checked form of the routing: a scenario file must be reached by
 * the browser profile alone, and the guard subtree by the default profile
 * alone.
 */
export function acceptanceClaims(): ProfileClaim[] {
  return acceptanceFilesIn(ACCEPTANCE_DIR).map((file) => ({
    file,
    // The default profile's other entries (`test/unit/**`,
    // `test/integration/**`) cannot reach `test/e2e/**`, so its e2e sweep
    // is the only claim that can apply inside the acceptance directory.
    defaultProfile: matchesGlob(DEFAULT_E2E_GLOB, file),
    browserProfile: browserInclude.some((pattern) => matchesGlob(pattern, file)),
  }));
}

/** True for a file a profile would try to execute as a test. */
export function isCollectable(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith(SCENARIO_SUFFIX);
}
