/**
 * Shared builders for the `test/unit/cohort/**` suite.
 *
 * Everything here is deterministic: a fixed clock, fixed ids and fixed
 * instants. A persistence test that reads well on a fast machine and
 * fails on a slow one is a flaky test, and a flaky test is worse than no
 * test because it trains reviewers to re-run instead of read.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cohortId,
  environmentId,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  productId,
  syntheticIdentityId,
  type CohortId,
  type ProductId,
  type SyntheticCohort,
  type SyntheticIdentity,
  type SyntheticIdentityId,
} from '../../../src/product/index.js';
import { FileRecordStore, CohortStateService, type AccountRef } from '../../../src/cohort/index.js';

export const PRODUCT_ID = 'prd-task-tracker';

/**
 * Branded environment ids for observations.
 *
 * `EnvironmentId` is a nominal type, so a bare string literal will not
 * typecheck as one — which is the point of the brand. Going through
 * #57's `environmentId()` here keeps the fixtures honest and means a
 * test cannot accidentally pass an unvalidated origin as an environment.
 */
export const ENV_STAGING = environmentId('env-staging');
export const ENV_BETA = environmentId('env-beta');

/** A monotonic, deterministic clock. Never read the wall clock in a test. */
export function fixedClock(start = '2026-10-01T00:00:00.000Z', stepMs = 60_000): () => string {
  let t = Date.parse(start);
  return () => {
    const value = new Date(t).toISOString();
    t += stepMs;
    return value;
  };
}

export interface IdentityOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly persona?: string;
  readonly stateRef?: string;
  readonly permittedOrigins?: ReadonlyArray<string>;
  readonly maxConcurrentSessions?: number;
}

/**
 * Build a `SyntheticIdentity` through #57's own parser.
 *
 * Always goes through `parseSyntheticIdentity` so a fixture can never
 * describe an identity #57 would have rejected.
 */
export function makeIdentity(
  lifecycle: 'ephemeral' | 'release' | 'persistent',
  options: IdentityOptions = {},
): SyntheticIdentity {
  const retention =
    lifecycle === 'ephemeral' ? 'none' : lifecycle === 'release' ? 'durable' : 'durable';
  const base: Record<string, unknown> = {
    id: options.id ?? `idn-${lifecycle}-1`,
    productId: PRODUCT_ID,
    displayName: options.displayName ?? `${lifecycle} user`,
    lifecycle,
    persona: options.persona ?? `A ${lifecycle} synthetic user.`,
    capability: {
      maxConcurrentSessions: options.maxConcurrentSessions ?? 1,
      stateRetention: retention,
      permittedOrigins: options.permittedOrigins ?? ['https://staging.example'],
    },
  };
  if (retention !== 'none' && options.stateRef !== undefined) {
    base['stateRef'] = options.stateRef;
  }
  return parseSyntheticIdentity(base);
}

export interface CohortOptions {
  readonly id?: string;
  readonly name?: string;
  readonly notes?: string;
}

/** Build a `SyntheticCohort` through #57's own parser. */
export function makeExplicitCohort(
  identityIds: ReadonlyArray<string>,
  options: CohortOptions = {},
): SyntheticCohort {
  return parseSyntheticCohort({
    id: options.id ?? 'coh-explicit',
    productId: PRODUCT_ID,
    name: options.name ?? 'Explicit cohort',
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    membership: { kind: 'explicit', identityIds: [...identityIds] },
  });
}

export function makeLifecycleCohort(
  lifecycle: 'ephemeral' | 'release' | 'persistent',
  options: CohortOptions = {},
): ReturnType<typeof parseSyntheticCohort> {
  return parseSyntheticCohort({
    id: options.id ?? `coh-${lifecycle}`,
    productId: PRODUCT_ID,
    name: options.name ?? `${lifecycle} cohort`,
    membership: { kind: 'byLifecycle', lifecycle },
  });
}

export function makeSizeTargetCohort(
  lifecycle: 'ephemeral' | 'release' | 'persistent',
  targetSize: number,
  options: CohortOptions = {},
): ReturnType<typeof parseSyntheticCohort> {
  return parseSyntheticCohort({
    id: options.id ?? `coh-${lifecycle}-n${targetSize}`,
    productId: PRODUCT_ID,
    name: options.name ?? `${lifecycle} cohort of ${targetSize}`,
    membership: { kind: 'sizeTarget', lifecycle, targetSize },
  });
}

export function asProductId(value: string): ProductId {
  return productId(value);
}

export function asCohortId(value: string): CohortId {
  return cohortId(value);
}

export function asIdentityId(value: string): SyntheticIdentityId {
  return syntheticIdentityId(value);
}

export const ACCOUNT_REF = 'acct-alice-primary' as AccountRef;

/* -------------------------------------------------------------------------- */
/* Store fixtures                                                              */
/* -------------------------------------------------------------------------- */

/** A throwaway directory that is removed by the returned cleanup function. */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'u-sekai-cohort-'));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A service over a **file** store in `dir`.
 *
 * Tests call this a second time with the same `dir` to simulate a fresh
 * process: a new `FileRecordStore` and a new `CohortStateService` that
 * share nothing but the bytes on disk. That is the real definition of
 * "survives process restart", and an in-memory store cannot express it.
 */
export function makeService(
  dir: string,
  options: { readonly now?: () => string } = {},
): CohortStateService {
  return new CohortStateService({
    store: new FileRecordStore({ rootDir: dir }),
    now: options.now ?? fixedClock(),
  });
}

/**
 * Re-open a service over an existing directory, discarding every
 * in-process object.
 */
export function restart(dir: string): CohortStateService {
  return makeService(dir);
}
