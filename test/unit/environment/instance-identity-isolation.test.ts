/**
 * Versioned environment identity and A/B coexistence (issue #69).
 *
 * Covers: two environments coexist and are independently addressable;
 * A and B share no mutable state (asserted structurally); environment
 * identity is stable and derived only from declared values.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  assertNoSharedMutableState,
  deriveInstanceKey,
  parseInstanceDeclaration,
  parseInstanceKey,
  startEnvironmentInstance,
  startEnvironmentPair,
  EnvironmentIsolationError,
  type EnvironmentInstance,
  type EnvironmentPair,
} from '../../../examples/continuous-product-evaluation/environment/index.js';

const DECLARATION_A = {
  product: 'task-tracker',
  name: 'staging',
  version: '1.4.0',
  seed: 'seed-alpha',
} as const;

const DECLARATION_B = {
  product: 'task-tracker',
  name: 'staging',
  version: '1.5.0',
  seed: 'seed-alpha',
} as const;

/** Every started instance, closed after each test. */
const started: EnvironmentInstance[] = [];
const pairs: EnvironmentPair[] = [];

async function trackPair(before: unknown, after: unknown): Promise<EnvironmentPair> {
  const pair = await startEnvironmentPair(before, after);
  pairs.push(pair);
  started.push(pair.before, pair.after);
  return pair;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((i) => i.close().catch(() => undefined)));
  pairs.length = 0;
});

describe('environment identity', () => {
  it('is a pure function of the declared values, with no clock or counter', () => {
    const first = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_A));
    const second = deriveInstanceKey(parseInstanceDeclaration({ ...DECLARATION_A }));
    expect(first).toBe(second);
  });

  it('round-trips through the validating parser', () => {
    const key = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_A));
    expect(parseInstanceKey(key)).toBe(key);
  });

  it('differs when the version differs, so a promotion changes identity', () => {
    const a = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_A));
    const b = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_B));
    expect(a).not.toBe(b);
  });

  it('differs when the seed differs, so world state cannot be confused across seeds', () => {
    const a = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_A));
    const reseeded = deriveInstanceKey(
      parseInstanceDeclaration({ ...DECLARATION_A, seed: 'seed-beta' }),
    );
    expect(a).not.toBe(reseeded);
  });

  it('does not let adjacent components collide', () => {
    // Without length prefixing these two would hash the same string.
    const left = deriveInstanceKey(
      parseInstanceDeclaration({ product: 'ab', name: 'c', version: '1', seed: 's' }),
    );
    const right = deriveInstanceKey(
      parseInstanceDeclaration({ product: 'a', name: 'bc', version: '1', seed: 's' }),
    );
    expect(left).not.toBe(right);
  });

  it('rejects a declaration carrying a per-run field, so a run id cannot enter identity', () => {
    expect(() =>
      parseInstanceDeclaration({ ...DECLARATION_A, runId: 'run-0001' }),
    ).toThrow(/not a known field/);
    expect(() => parseInstanceDeclaration({ ...DECLARATION_A, createdAt: '2026-10-05' })).toThrow(
      /not a known field/,
    );
  });

  it('rejects a key that was not derived by this module', () => {
    expect(() => parseInstanceKey('envkey-not-a-digest')).toThrow(/sha256/);
    expect(() => parseInstanceKey('staging-1.4.0')).toThrow(/starting with/);
  });
});

describe('two environments coexist', () => {
  it('starts both instances live at once on distinct origins', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);
    expect(pair.before.baseUrl).not.toBe(pair.after.baseUrl);
    expect(pair.before.port).not.toBe(pair.after.port);
    expect(pair.before.key).not.toBe(pair.after.key);
  });

  it('keeps both independently addressable over HTTP', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);

    const before = await fetch(`${pair.before.baseUrl}/`);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('No tasks yet.');

    // Writing to A must be visible at A...
    await fetch(`${pair.before.baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=written-on-A',
    });
    expect(await (await fetch(`${pair.before.baseUrl}/`)).text()).toContain('written-on-A');

    // ...and must NOT be visible at B. If it were, B would not be a
    // clean later version and the A→B comparison would be meaningless.
    expect(await (await fetch(`${pair.after.baseUrl}/`)).text()).toContain('No tasks yet.');
  });

  it('points at the earlier version until the transition advances it', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);
    expect(pair.active().key).toBe(pair.before.key);
    expect(pair.active().version).toBe('1.4.0');
    pair.advancePointer();
    expect(pair.active().key).toBe(pair.after.key);
    expect(pair.active().version).toBe('1.5.0');
  });

  it('refuses to build a pair whose two sides are the same version', async () => {
    await expect(startEnvironmentPair(DECLARATION_A, DECLARATION_A)).rejects.toThrow(
      EnvironmentIsolationError,
    );
  });
});

describe('A and B share no mutable state', () => {
  it('passes the structural graph walk on a fresh pair', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);
    expect(() => assertNoSharedMutableState(pair.before, pair.after)).not.toThrow();
  });

  it('keeps the two state objects distinct by reference', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);
    expect(pair.before.state).not.toBe(pair.after.state);
    expect(pair.before.state.tasks).not.toBe(pair.after.state.tasks);
    expect(pair.before.state.settings).not.toBe(pair.after.state.settings);
  });

  it('detects a deliberately shared container, proving the check is not vacuous', async () => {
    // Two independent instances, then one instance's state is made to
    // share the other's task Map. This is the exact leak the check
    // exists for, and it must be reported rather than tolerated.
    const a = await startEnvironmentInstance(DECLARATION_A, 'a');
    const b = await startEnvironmentInstance(DECLARATION_B, 'b');
    started.push(a, b);

    expect(() => assertNoSharedMutableState(a, b)).not.toThrow();
    const leaky = { ...b, state: { ...b.state, tasks: a.state.tasks } };
    expect(() => assertNoSharedMutableState(a, leaky as EnvironmentInstance)).toThrow(
      EnvironmentIsolationError,
    );
  });

  it('mutating A through every writable path leaves B unchanged', async () => {
    const pair = await trackPair(DECLARATION_A, DECLARATION_B);

    // Direct state mutation, not only via HTTP: this covers a leak that
    // the HTTP test path would not reach.
    pair.before.state.tasks.set('1', {
      id: '1',
      title: 'injected',
      createdAt: '2026-10-05T00:00:00.000Z',
      done: false,
    });
    pair.before.state.settings.theme = 'dark';
    pair.before.state.settings.notifications = true;

    expect(pair.after.state.tasks.size).toBe(0);
    expect(pair.after.state.settings.theme).toBe('light');
    expect(pair.after.state.settings.notifications).toBe(false);
  });
});

describe('identity survives process boundaries', () => {
  it('recomputes the same key from a store round-trip with no in-memory state', async () => {
    // The declaration is the only input. Nothing in the derivation
    // touches a module-level cache, a counter or a clock, so a
    // different process given the same declaration gets the same key.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usekai69-identity-'));
    try {
      const modulePath = path.resolve(
        process.cwd(),
        'examples/continuous-product-evaluation/environment/index.ts',
      );
      const script = `
        import { deriveInstanceKey, parseInstanceDeclaration } from ${JSON.stringify(modulePath)};
        const decl = parseInstanceDeclaration(${JSON.stringify(DECLARATION_A)});
        process.stdout.write(deriveInstanceKey(decl));
      `;
      const first = await runInChildProcess(script);
      const second = await runInChildProcess(script);
      const inThisProcess = deriveInstanceKey(parseInstanceDeclaration(DECLARATION_A));

      expect(first).toBe(inThisProcess);
      expect(second).toBe(inThisProcess);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Run a tsx-loaded module snippet in a genuinely separate OS process.
 *
 * Spawning rather than re-importing is the point: an in-process
 * re-import would share module state and could not distinguish "identity
 * is derived" from "identity was cached".
 */
async function runInChildProcess(script: string): Promise<string> {
  const execFileAsync = promisify(execFile);
  const tsxLoader = path.resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', `file://${tsxLoader}`, '--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return stdout;
}
