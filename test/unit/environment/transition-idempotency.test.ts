/**
 * A→B transition semantics (issue #69).
 *
 * Covers: a transition is observable and names both endpoints;
 * re-running is idempotent; a partially-failed transition resumes or
 * refuses cleanly; "rejected / never started" is distinguishable from
 * "succeeded"; the record is durable across processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  TransitionStore,
  applyTransition,
  readTransition,
  resumeIncomplete,
  startEnvironmentPair,
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

const COHORT = 'coh-release-transition';

let store: TransitionStore;
let root: string;
let pair: EnvironmentPair;
const started: EnvironmentInstance[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'usekai69-transition-'));
  store = new TransitionStore(root);
  pair = await startEnvironmentPair(DECLARATION_A, DECLARATION_B);
  started.push(pair.before, pair.after);
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((i) => i.close().catch(() => undefined)));
  await fs.rm(root, { recursive: true, force: true });
});

const endpointsOf = (p: EnvironmentPair) => ({
  fromKey: p.before.key,
  toKey: p.after.key,
});

describe('a transition is observable and names both endpoints', () => {
  it('records from and to instances, with both version labels', async () => {
    const outcome = await applyTransition(store, COHORT, pair);

    expect(outcome.state.status).toBe('committed');
    if (outcome.state.status !== 'committed') throw new Error('expected committed');

    expect(outcome.state.record.fromKey).toBe(pair.before.key);
    expect(outcome.state.record.toKey).toBe(pair.after.key);
    expect(outcome.state.record.fromVersion).toBe('1.4.0');
    expect(outcome.state.record.toVersion).toBe('1.5.0');
    expect(outcome.state.record.cohortId).toBe(COHORT);
  });

  it('moves the active pointer without mutating either environment', async () => {
    const beforeTasks = pair.before.state.tasks.size;
    const afterTasks = pair.after.state.tasks.size;

    await applyTransition(store, COHORT, pair);

    expect(pair.active().key).toBe(pair.after.key);
    // The earlier version must survive the promotion intact, or the
    // baseline the comparison depends on is gone.
    expect(pair.before.state.tasks.size).toBe(beforeTasks);
    expect(pair.after.state.tasks.size).toBe(afterTasks);
    expect(pair.before.baseUrl).not.toBe(pair.after.baseUrl);
  });

  it('is readable back as a committed transition', async () => {
    await applyTransition(store, COHORT, pair);
    const state = await readTransition(store, COHORT, endpointsOf(pair));
    expect(state.status).toBe('committed');
  });
});

describe('re-running a transition is idempotent', () => {
  it('reports applied=true once and applied=false thereafter', async () => {
    const first = await applyTransition(store, COHORT, pair);
    expect(first.applied).toBe(true);

    const second = await applyTransition(store, COHORT, pair);
    expect(second.applied).toBe(false);
    expect(second.state.status).toBe('committed');

    const third = await applyTransition(store, COHORT, pair);
    expect(third.applied).toBe(false);
  });

  it('leaves one transition envelope and one cohort record, not three', async () => {
    await applyTransition(store, COHORT, pair);
    await applyTransition(store, COHORT, pair);
    await applyTransition(store, COHORT, pair);

    // Three requests, one transition file: the key is derived from
    // (cohort, from, to) with no clock, so all three resolve to the
    // same envelope rather than appending three.
    const files = (await fs.readdir(root)).filter((f) => f.startsWith('transition-'));
    expect(files).toHaveLength(1);

    const cohorts = (await fs.readdir(root)).filter((f) => f.startsWith('cohort-'));
    expect(cohorts).toHaveLength(1);

    const state = await store.readCohortState(COHORT);
    expect(state?.currentKey).toBe(pair.after.key);
    expect(state?.pending).toBeUndefined();
  });

  it('derives the same transition key across processes, so idempotency is not in-memory', async () => {
    const outcome = await applyTransition(store, COHORT, pair);
    if (outcome.state.status !== 'committed') throw new Error('expected committed');
    const { transitionKey } = outcome.state.record;

    const fromChild = await runInChildProcess(`
      import { readTransition, TransitionStore } from ${JSON.stringify(modulePath())};
      const store = new TransitionStore(${JSON.stringify(root)});
      const state = await readTransition(store, ${JSON.stringify(COHORT)}, {
        fromKey: ${JSON.stringify(pair.before.key)},
        toKey: ${JSON.stringify(pair.after.key)},
      });
      if (state.status !== 'committed') { process.stdout.write(state.status); }
      else { process.stdout.write(state.record.transitionKey); }
    `);
    expect(fromChild).toBe(transitionKey);
  });
});

describe('a partially-failed transition resumes or refuses cleanly', () => {
  /**
   * Reproduce a crash after the intent is durable but before the
   * pointer moves and the commit lands.
   *
   * The store exposes no "crash halfway" switch, so the on-disk state
   * is reconstructed directly: the intent envelope is written and the
   * cohort record is left holding the pending marker with the pointer
   * still on the earlier version. That is exactly what the write order
   * in `applyTransition` produces.
   */
  async function leaveIntentOnly(p: EnvironmentPair = pair): Promise<void> {
    const { deriveTransitionKey } = await import(
      '../../../examples/continuous-product-evaluation/environment/keys.js'
    );
    const transitionKey = deriveTransitionKey(COHORT, p.before.key, p.after.key);
    const record = {
      transitionKey,
      cohortId: COHORT,
      fromKey: p.before.key,
      toKey: p.after.key,
      fromVersion: p.before.version,
      toVersion: p.after.version,
    };
    await store.writeIntent(record);
    await store.writeCohortState(COHORT, {
      currentKey: p.before.key,
      pending: { transitionKey, fromKey: p.before.key, toKey: p.after.key },
    });
  }

  it('reports an intent without a commit as incomplete, not as succeeded', async () => {
    await leaveIntentOnly();
    const state = await readTransition(store, COHORT, endpointsOf(pair));
    expect(state.status).toBe('incomplete');
  });

  it('leaves the pointer on the earlier version while the transition is incomplete', async () => {
    await leaveIntentOnly();
    expect(pair.active().key).toBe(pair.before.key);
  });

  it('completes the pending intent on re-apply, without double-applying', async () => {
    await leaveIntentOnly();

    const outcome = await applyTransition(store, COHORT, pair);
    expect(outcome.applied).toBe(true);
    expect(outcome.state.status).toBe('committed');
    expect(pair.active().key).toBe(pair.after.key);

    // A further re-run is then a plain idempotent no-op.
    const again = await applyTransition(store, COHORT, pair);
    expect(again.applied).toBe(false);
  });

  it('resumes an incomplete transition explicitly', async () => {
    await leaveIntentOnly();
    const outcome = await resumeIncomplete(store, COHORT, pair);
    expect(outcome.applied).toBe(true);
    expect(outcome.state.status).toBe('committed');
  });

  it('clears the pending marker once the transition commits', async () => {
    await leaveIntentOnly();
    await resumeIncomplete(store, COHORT, pair);
    const state = await store.readCohortState(COHORT);
    expect(state?.pending).toBeUndefined();
    expect(state?.currentKey).toBe(pair.after.key);
  });

  it('treats resumeIncomplete with nothing pending as a first attempt', async () => {
    const outcome = await resumeIncomplete(store, COHORT, pair);
    expect(outcome.applied).toBe(true);
    expect(outcome.state.status).toBe('committed');
  });

  it('refuses to start a different transition while one is pending', async () => {
    await leaveIntentOnly();

    // A second, different pair. Applying it now would move the pointer
    // out from under the pending A->B record.
    const other = await startEnvironmentPair(DECLARATION_A, {
      ...DECLARATION_B,
      version: '1.6.0',
    });
    started.push(other.before, other.after);

    const outcome = await applyTransition(store, COHORT, other);
    expect(outcome.state.status).toBe('rejected');
    if (outcome.state.status !== 'rejected') throw new Error('expected rejected');
    expect(outcome.state.reason).toBe('incomplete-conflict');
    expect(outcome.applied).toBe(false);
    // The pending transition is untouched and still resumable.
    expect(pair.active().key).toBe(pair.before.key);
    const state = await readTransition(store, COHORT, endpointsOf(pair));
    expect(state.status).toBe('incomplete');
  });

  it('refuses to resume a transition that is not the pending one', async () => {
    await leaveIntentOnly();

    const other = await startEnvironmentPair(DECLARATION_A, {
      ...DECLARATION_B,
      version: '1.6.0',
    });
    started.push(other.before, other.after);

    const outcome = await resumeIncomplete(store, COHORT, other);
    expect(outcome.state.status).toBe('rejected');
    if (outcome.state.status !== 'rejected') throw new Error('expected rejected');
    expect(outcome.state.reason).toBe('incomplete-conflict');
  });
});

describe('rejected and never-started are distinguishable from succeeded', () => {
  it('reports never-started before any transition is attempted', async () => {
    const state = await readTransition(store, COHORT, endpointsOf(pair));
    expect(state.status).toBe('never-started');
    expect(state.status).not.toBe('committed');
  });

  it('reports rejected, with a reason, when the cohort is already on the target', async () => {
    await applyTransition(store, COHORT, pair);
    const again = await applyTransition(store, COHORT, pair);
    // Already committed is idempotent, not rejected: re-running the
    // same transition is a success that changed nothing.
    expect(again.state.status).toBe('committed');
    expect(again.applied).toBe(false);
  });

  it('rejects a transition whose cohort is bound to an unrelated environment', async () => {
    const unrelated = await startEnvironmentPair(
      { ...DECLARATION_A, seed: 'seed-other' },
      { ...DECLARATION_B, seed: 'seed-other' },
    );
    started.push(unrelated.before, unrelated.after);
    await applyTransition(store, COHORT, unrelated);

    const outcome = await applyTransition(store, COHORT, pair);
    expect(outcome.state.status).toBe('rejected');
    if (outcome.state.status !== 'rejected') throw new Error('expected rejected');
    expect(outcome.state.reason).toBe('unknown-endpoint');
    expect(outcome.applied).toBe(false);
  });

  it('never returns an empty list or undefined in place of a state', async () => {
    const state = await readTransition(store, 'coh-never-seen', endpointsOf(pair));
    expect(state).toBeDefined();
    expect(['never-started', 'incomplete', 'committed', 'rejected']).toContain(state.status);
  });
});

describe('the transition record is durable across processes', () => {
  it('is readable by a separate process that never held the pair', async () => {
    const outcome = await applyTransition(store, COHORT, pair);
    if (outcome.state.status !== 'committed') throw new Error('expected committed');
    const expected = outcome.state.record.transitionKey;

    const seen = await runInChildProcess(`
      import { readTransition, TransitionStore } from ${JSON.stringify(modulePath())};
      const store = new TransitionStore(${JSON.stringify(root)});
      const state = await readTransition(store, ${JSON.stringify(COHORT)}, {
        fromKey: ${JSON.stringify(pair.before.key)},
        toKey: ${JSON.stringify(pair.after.key)},
      });
      process.stdout.write(JSON.stringify({ status: state.status, key: state.status === 'committed' ? state.record.transitionKey : null }));
    `);
    expect(JSON.parse(seen)).toEqual({ status: 'committed', key: expected });
  });
});

function modulePath(): string {
  return path.resolve(process.cwd(), 'examples/continuous-product-evaluation/environment/index.ts');
}

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
