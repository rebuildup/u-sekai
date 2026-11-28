import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Guard for the GitHub Actions trigger surface (#82, #85).
 *
 * `ci.yml` and `browser-smoke.yml` used to gate their `pull_request` event
 * on `branches: [release-*, ...]`. GitHub evaluates that list against the
 * PR's *base* branch, and this repository stacks ticket PRs on their
 * predecessor ticket branch, so every stacked PR matched nothing and was
 * structurally ungated. Nothing went red: the workflow simply never ran.
 *
 * A YAML edit with no assertion behind it regresses silently the next time
 * someone tightens a filter, so this file pins the trigger that both
 * workflows are required to have.
 *
 * The parser is a targeted reader rather than a YAML dependency, for the
 * same reason `release-verification.test.ts` reads the workflow files with a
 * regex: the files are checked in, and comparing the committed workflow
 * against a committed constant is only meaningful if the constant is
 * derived from the file. The strictness that a real YAML parser would give
 * for free is recovered by throwing on any shape this reader does not model
 * - an unrecognised filter fails the test instead of passing it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CI_WORKFLOW = '.github/workflows/ci.yml';
const BROWSER_SMOKE_WORKFLOW = '.github/workflows/browser-smoke.yml';

/** Both gate-bearing workflows whose `pull_request` trigger is pinned here. */
const PULL_REQUEST_WORKFLOWS = [CI_WORKFLOW, BROWSER_SMOKE_WORKFLOW];

/**
 * Base branches that must keep working. `release-0-4-0` and `main` were
 * covered before #85 and must stay covered; the numeric entries are the
 * ticket-branch bases that were not.
 */
const BASES_THAT_MUST_BE_GATED = [
  'release-0-4-0',
  'release-0-3-0',
  'main',
  '57',
  '1',
  '1234',
];

// ---------------------------------------------------------------------------
// GitHub filter-pattern semantics
// ---------------------------------------------------------------------------

/**
 * Escape a literal for use in a regular expression. Only literals reach
 * this: `*`, `+` and `?` are consumed by the pattern scanner below.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Characters this reader admits inside a `[...]` class. */
function isClassChar(char: string): boolean {
  return /^[A-Za-z0-9._-]$/.test(char);
}

/**
 * Translate the body of a `[...]` class, rejecting anything that is not a
 * plain character or a plain `lo-hi` range.
 */
function charClassSource(body: string, pattern: string): string {
  let source = '';
  let index = 0;
  if (body.startsWith('!') || body.startsWith('^')) {
    source += '^';
    index = 1;
  }
  while (index < body.length) {
    const char = body[index] ?? '';
    const maybeRangeEnd = body[index + 2];
    if (body[index + 1] === '-' && maybeRangeEnd !== undefined) {
      if (!isClassChar(char) || !isClassChar(maybeRangeEnd)) {
        throw new Error(`Unsupported character range in filter pattern ${pattern}`);
      }
      source += `${char}-${maybeRangeEnd}`;
      index += 3;
      continue;
    }
    if (!isClassChar(char)) {
      throw new Error(`Unsupported character in filter pattern ${pattern}`);
    }
    source += char;
    index += 1;
  }
  if (source === '' || source === '^') {
    throw new Error(`Empty character class in filter pattern ${pattern}`);
  }
  return source;
}

/**
 * Compile one GitHub filter pattern.
 *
 * Implements the syntax GitHub documents for `branches` / `branches-ignore`:
 * `*` (any run of characters except `/`), `**` (any run including `/`), `+`
 * (one or more of the preceding character), `?` (zero or one of the
 * preceding character) and `[...]`. `!` is negation of a whole pattern and
 * is handled by the caller, so it is a hard error here: a `!` that reached
 * this function would be a pattern this reader does not understand, and
 * guessing would make the guard lie.
 */
function compileFilterPattern(pattern: string): RegExp {
  if (pattern.startsWith('!')) {
    throw new Error(`Negation must be resolved before compiling ${pattern}`);
  }
  const atoms: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        atoms.push('.*');
        index += 2;
        continue;
      }
      atoms.push('[^/]*');
      index += 1;
      continue;
    }
    if (char === '+' || char === '?') {
      const previous = atoms.pop();
      if (previous === undefined) {
        throw new Error(`Quantifier with nothing to quantify in filter pattern ${pattern}`);
      }
      atoms.push(char === '+' ? `(?:${previous})+` : `(?:${previous})?`);
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        throw new Error(`Unterminated character class in filter pattern ${pattern}`);
      }
      atoms.push(`[${charClassSource(pattern.slice(index + 1, close), pattern)}]`);
      index = close + 1;
      continue;
    }
    if (char === '!') {
      throw new Error(`Unexpected '!' in filter pattern ${pattern}`);
    }
    atoms.push(escapeRegExp(char));
    index += 1;
  }
  return new RegExp(`^${atoms.join('')}$`);
}

function matchesPattern(pattern: string, branch: string): boolean {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const matched = compileFilterPattern(body).test(branch);
  return negated ? !matched : matched;
}

// ---------------------------------------------------------------------------
// The gate predicate under test
// ---------------------------------------------------------------------------

type EventFilter = {
  branches?: string[] | undefined;
  branchesIgnore?: string[] | undefined;
};

/**
 * Whether an event fires for a pull request whose *base* branch is `base`.
 *
 * Mirrors GitHub's evaluation order: `branches-ignore` excludes first, then
 * an absent `branches` list means "every branch", otherwise the base must
 * match a positive pattern and no `!`-prefixed one.
 */
export function eventGates(event: EventFilter | undefined, base: string): boolean {
  // An event that is not declared at all never fires. Treating a missing
  // event as "gated" would make this guard pass on a workflow that had its
  // `pull_request` trigger deleted outright.
  if (event === undefined) {
    return false;
  }
  const ignore = event.branchesIgnore ?? [];
  if (ignore.some((pattern) => matchesPattern(pattern, base))) {
    return false;
  }
  const branches = event.branches;
  if (branches === undefined) {
    return true;
  }
  const positives = branches.filter((pattern) => !pattern.startsWith('!'));
  const negatives = branches.filter((pattern) => pattern.startsWith('!'));
  if (positives.length > 0 && !positives.some((pattern) => matchesPattern(pattern, base))) {
    return false;
  }
  return !negatives.some((pattern) => matchesPattern(pattern.slice(1), base));
}

// ---------------------------------------------------------------------------
// Minimal reader for the `on:` block of a checked-in workflow
// ---------------------------------------------------------------------------

/** Parse `[a, b]`, honouring quoted items so `['release-*']` works. */
function parseFlowList(raw: string, file: string): string[] {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    throw new Error(`${file}: expected a flow sequence, got ${JSON.stringify(raw)}`);
  }
  const inner = text.slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new Error(`${file}: unterminated quote in filter list`);
  }
  if (inner.trim() !== '') {
    items.push(current.trim());
  }
  return items.filter((item) => item.length > 0);
}

/** Every line belonging to the top-level `on:` block. */
function readOnBlock(text: string, file: string): string[] {
  const lines = text.split('\n');
  const onAt = lines.indexOf('on:');
  if (onAt === -1) {
    throw new Error(`${file} has no top-level 'on:' key`);
  }
  const block: string[] = [];
  for (let index = onAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      continue;
    }
    if (!/^\s/.test(line)) {
      break;
    }
    block.push(line);
  }
  return block;
}

/**
 * The event filters declared by a workflow file.
 *
 * Throws on a shape it does not model rather than returning a partial
 * answer, so a future edit to a trigger cannot quietly stop being checked.
 */
function parseEventFilters(text: string, file: string): Map<string, EventFilter> {
  const block = readOnBlock(text, file);
  const events = new Map<string, EventFilter>();
  let current: string | null = null;

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index] ?? '';
    const indent = line.length - line.trimStart().length;

    if (indent === 2) {
      const header = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (header === null) {
        throw new Error(`${file}: unparsed event header ${JSON.stringify(line)}`);
      }
      current = header[1] ?? '';
      events.set(current, {});
      continue;
    }

    // Deeper indentation is step / job level and carries no trigger.
    if (indent !== 4 || current === null) {
      continue;
    }

    const entry = /^ {4}(branches|branches-ignore):\s*(.*)$/.exec(line);
    if (entry === null) {
      continue;
    }
    const key = entry[1] === 'branches' ? 'branches' : 'branchesIgnore';
    const filter = events.get(current);
    if (filter === undefined) {
      throw new Error(`${file}: filter outside a known event in ${JSON.stringify(line)}`);
    }

    let items = (entry[2] ?? '').trim();
    if (items === '') {
      // Block sequence form: collect the following `- item` lines.
      const collected: string[] = [];
      let cursor = index + 1;
      while (cursor < block.length) {
        const itemLine = block[cursor] ?? '';
        const itemMatch = /^ {6}-\s*(.*)$/.exec(itemLine);
        if (itemMatch === null) {
          break;
        }
        collected.push((itemMatch[1] ?? '').trim().replace(/^["']|["']$/g, ''));
        cursor += 1;
      }
      if (collected.length === 0) {
        throw new Error(`${file}: empty filter list in ${JSON.stringify(line)}`);
      }
      filter[key] = collected;
      index = cursor - 1;
      continue;
    }

    items = items.replace(/\s+#.*$/, '').trim();
    filter[key] = parseFlowList(items, file);
  }

  return events;
}

function readEventFilters(relativePath: string): Map<string, EventFilter> {
  const text = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return parseEventFilters(text, relativePath);
}

function readWorkflow(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// The pattern compiler, pinned so the guard cannot pass for the wrong reason
// ---------------------------------------------------------------------------

describe('github filter pattern semantics', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['main', 'main', true],
    ['main', '57', false],
    ['release-*', 'release-0-4-0', true],
    ['release-*', 'main', false],
    ['release-*', '57', false],
    ['*', '57', true],
    ['*', 'release-0-4-0', true],
    ['*', 'feature/nested', false],
    ['**', 'feature/nested', true],
    ['[0-9]*', '57', true],
    ['[0-9]*', '1234', true],
    ['[0-9]*', 'main', false],
    ['[!a-z]*', '57', true],
    ['[!a-z]*', 'abc', false],
    ['v[12].x', 'v1.x', true],
    ['v[12].x', 'v3.x', false],
    ['release-[0-9]+-[0-9]+-[0-9]+', 'release-0-4-0', true],
    ['release-[0-9]+-[0-9]+-[0-9]+', 'release-0-4', false],
    ['ab?c', 'abc', true],
    ['ab?c', 'ac', true],
    ['ab?c', 'abbc', false],
  ];

  for (const [pattern, branch, expected] of cases) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${branch}`, () => {
      expect(compileFilterPattern(pattern).test(branch)).toBe(expected);
    });
  }

  it('rejects a pattern it does not model instead of guessing', () => {
    // A silently mis-compiled pattern would let a restrictive filter pass
    // the guard, which is the exact failure this file exists to prevent.
    expect(() => compileFilterPattern('release-[0-9')).toThrow(/Unterminated/);
    expect(() => compileFilterPattern('release-[]')).toThrow(/Empty character class/);
    expect(() => compileFilterPattern('!release-*')).toThrow(/Negation/);
    expect(() => compileFilterPattern('+release')).toThrow(/nothing to quantify/);
  });
});

// ---------------------------------------------------------------------------
// Negative control
// ---------------------------------------------------------------------------

describe('the pre-fix trigger is detected as ungating', () => {
  // The exact filter shape that shipped in ci.yml and browser-smoke.yml.
  const preFixCi: EventFilter = { branches: ['release-*', 'main'] };
  const preFixBrowserSmoke: EventFilter = { branches: ['release-*'] };

  it('does not gate a ticket-branch base', () => {
    expect(eventGates(preFixCi, '57')).toBe(false);
    expect(eventGates(preFixBrowserSmoke, '57')).toBe(false);
  });

  it('did gate the release-line base, which is why the gap was invisible', () => {
    expect(eventGates(preFixCi, 'release-0-4-0')).toBe(true);
    expect(eventGates(preFixCi, 'main')).toBe(true);
    expect(eventGates(preFixBrowserSmoke, 'release-0-4-0')).toBe(true);
  });

  it('did not gate a main-based pull request in browser-smoke, either', () => {
    // `[release-*]` names no `main`, so the browser gate was skipped for
    // main-based PRs as well. Worth pinning: it shows the allow-list was
    // never load-bearing, only narrowing.
    expect(eventGates(preFixBrowserSmoke, 'main')).toBe(false);
  });

  it('treats a missing event as ungated', () => {
    expect(eventGates(undefined, '57')).toBe(false);
  });
});

describe('the reader reports the real pre-fix files as ungating', () => {
  // The literal-only control above would still pass if `parseEventFilters`
  // regressed to never populating `branches` - `eventGates` would then see
  // an absent filter, return true for every base, and the guard would pass
  // vacuously while gating nothing. These cases push the *pre-fix file
  // text* through the same reader the live assertions use, so a reader that
  // stops understanding the file fails here instead.
  //
  // Verbatim from the pre-fix `on:` blocks (origin/release-0-4-0), trimmed to
  // the block the reader reads.
  const PRE_FIX_ON: Record<string, string> = {
    [CI_WORKFLOW]: [
      'on:',
      '  push:',
      '    branches: [release-*, main]',
      '  pull_request:',
      '    branches: [release-*, main]',
      '',
      'permissions:',
      '  contents: read',
      '',
    ].join('\n'),
    [BROWSER_SMOKE_WORKFLOW]: [
      'on:',
      '  push:',
      '    branches: [release-*]',
      '  pull_request:',
      '    branches: [release-*]',
      '',
      'permissions:',
      '  contents: read',
      '',
    ].join('\n'),
  };

  it.each(PULL_REQUEST_WORKFLOWS)('%s: the reader recovers the pre-fix filter', (file) => {
    const filters = parseEventFilters(PRE_FIX_ON[file] ?? "", file);
    const pullRequest = filters.get('pull_request');
    expect(pullRequest, `${file}: pre-fix pull_request trigger was not read`).toBeDefined();
    // Not merely "not undefined": the filter must actually have been read,
    // otherwise the reader has gone blind and the live assertions vacuously
    // pass.
    expect(pullRequest?.branches).toEqual(
      file === CI_WORKFLOW ? ['release-*', 'main'] : ['release-*'],
    );
  });

  it.each(PULL_REQUEST_WORKFLOWS)('%s: the pre-fix filter fails the live assertion', (file) => {
    const filters = parseEventFilters(PRE_FIX_ON[file] ?? "", file);
    for (const base of ['57', '1', '1234']) {
      expect(
        eventGates(filters.get('pull_request'), base),
        `${file}: pre-fix trigger unexpectedly gated ${base}, so the guard would not catch a regression`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The committed workflows
// ---------------------------------------------------------------------------

describe.each(PULL_REQUEST_WORKFLOWS)('%s', (relativePath) => {
  const filters = readEventFilters(relativePath);

  it('declares a pull_request trigger', () => {
    expect(filters.has('pull_request'), `${relativePath} lost its pull_request trigger`).toBe(
      true,
    );
  });

  it.each(BASES_THAT_MUST_BE_GATED)(
    'gates a pull request based on %s',
    (base) => {
      expect(
        eventGates(filters.get('pull_request'), base),
        `${relativePath} does not gate a pull request based on ${base}`,
      ).toBe(true);
    },
  );

  it('does not exclude ticket-branch bases via branches-ignore', () => {
    // An ignore list is the same defect wearing a different hat, and it is
    // easy to add next to a widening without noticing.
    expect(filters.get('pull_request')?.branchesIgnore).toBeUndefined();
  });
});

describe('push triggers keep their release-line scope', () => {
  // Widening `push` to every branch is not wanted: every ticket branch
  // carries a pull request, so a push run only duplicates the pull_request
  // run once per WIP commit. Pinned so the decision is visible if revisited.
  const ci = readEventFilters(CI_WORKFLOW);
  const browserSmoke = readEventFilters(BROWSER_SMOKE_WORKFLOW);

  it('ci.yml still gates pushes to the release line and to main', () => {
    const push = ci.get('push');
    expect(eventGates(push, 'release-0-4-0')).toBe(true);
    expect(eventGates(push, 'main')).toBe(true);
  });

  it('browser-smoke.yml still gates pushes to the release line', () => {
    expect(eventGates(browserSmoke.get('push'), 'release-0-4-0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A wider trigger must not be paid for by weakening a job
// ---------------------------------------------------------------------------

describe('no gate was weakened to make the wider trigger affordable', () => {
  it.each(PULL_REQUEST_WORKFLOWS)('%s has no continue-on-error', (relativePath) => {
    expect(readWorkflow(relativePath)).not.toMatch(/continue-on-error/);
  });

  it('ci.yml has no failure-short-circuiting shell operator', () => {
    // ci.yml has no legitimate use for one, so any appearance is a
    // downgrade of a gate step.
    expect(readWorkflow(CI_WORKFLOW)).not.toMatch(/\|\|\s*true/);
  });

  it('browser-smoke.yml still installs Chromium and fails closed without it', () => {
    const text = readWorkflow(BROWSER_SMOKE_WORKFLOW);
    expect(text).toMatch(/npx playwright install --with-deps chromium/);
    expect(text).toMatch(/Chromium failed to launch/);
    expect(text).toMatch(/Browser smoke produced no run artifact/);
    // `find ... || true` is present and is a listing convenience for an
    // optional directory, not a gate step; the gate itself exits non-zero
    // in the same block, which the assertion above already pins.
  });

  it('keeps the CI job name that branch protection requires', () => {
    // DEFAULT_REQUIRED_RELEASE_CHECKS in scripts/release-rules.mjs registers
    // this exact name on main. Renaming it would silently unregister the
    // required check.
    expect(readWorkflow(CI_WORKFLOW)).toMatch(/^ {4}name: lint \+ typecheck \+ build \+ test$/m);
  });
});
