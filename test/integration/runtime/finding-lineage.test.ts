/**
 * Acceptance: evidence and finding lineage identify Product,
 * Environment, Review Program, Synthetic Identity / Cohort and run
 * (Issue #63, criterion 5).
 *
 * ## The observable this file exists to prove
 *
 * Lineage is the join key for everything downstream, and a join key is
 * only worth what it can be *checked* against. So this file asserts
 * four independent joins per record rather than one aggregate:
 *
 * | join | observable |
 * | --- | --- |
 * | record → durable target | `target` equals the plan's target field for field, on every record |
 * | record → run | `observedIn` and `longitudinal.observed.runId` both equal the run's own `RunLineage.runId` |
 * | record → identities | `identityIds` is a non-empty subset of the run lineage's `identityIds`, and every member is a member of the resolved cohort |
 * | record → evidence | every `evidenceRefs[].id` is in the run lineage's `evidenceIds`, and every `locator` resolves to a file the run actually wrote |
 * | record → baseline | the baseline is a *reference* to the earlier run's own `RunLineage` object, not a copy of it |
 *
 * The last row is the one that is easy to get wrong and impossible to
 * notice: a *copy* of the baseline would satisfy every assertion above
 * and still be able to drift from the run it describes. The identity
 * assertion (`===`, not `toEqual`) is what catches it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { isReleaseTransitionComparison, sameTarget } from '../../../src/product/index.js';
import type { RunLineage } from '../../../src/product/index.js';
import { runEvaluation } from '../../../src/runtime/index.js';
import {
  COHORT_ID,
  ENV_A,
  PROGRAM_ID,
  PRODUCT_ID,
  makeIdentity,
  makePlan,
  seedIdentities,
} from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-lineage-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'release' as const };
const BOB = { id: 'idn-bob', lifecycle: 'release' as const };
const FINDING_A = 'The list gave no confirmation that the task had been saved.';
const FINDING_B = 'The Settings page links to nothing that changes anything.';

describe('evidence and finding lineage', () => {
  it('names Product, Environment, Review Program, Cohort, identities and run on every record', async () => {
    const identities = [makeIdentity(ALICE), makeIdentity(BOB)];
    const { config } = buildHarness(root, {
      identities: [ALICE, BOB],
      storeName: 'lineage-store',
      observerFindings: [
        { id: 'obs-1', summary: FINDING_A },
        { id: 'obs-2', summary: FINDING_B },
      ],
    });
    await seedIdentities(config.cohort, identities);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'lineage-1',
      }),
      runId: 'run-lineage-1',
    });

    // --- The run lineage is the single source; nothing else restates it.
    const lineage = result.lineage;
    expect(lineage.runId).toBe('run-lineage-1');
    expect(lineage.identityIds).toEqual(['idn-alice', 'idn-bob']);
    expect(lineage.evidenceIds?.length ?? 0).toBeGreaterThan(0);

    expect(result.findings).toHaveLength(2);

    for (const finding of result.findings) {
      // --- record -> durable target
      expect(finding.target).toEqual({
        productId: PRODUCT_ID,
        environmentId: ENV_A,
        cohortId: COHORT_ID,
        programId: PROGRAM_ID,
      });

      // --- record -> run. Value equality, not object identity: #61's
      // `parseFinding` re-parses `longitudinal.observed` through #57's
      // `parseRunLineage`, so the consumer holds a re-materialised equal.
      // The anti-drift property is that the values agree on *every*
      // field, including the evidence set, because the runtime builds
      // one lineage value per run and never a second one per finding.
      expect(finding.observedIn).toBe(lineage.runId);
      expect(finding.longitudinal.observed).toEqual(lineage);
      expect(finding.longitudinal.observed.evidenceIds).toEqual(lineage.evidenceIds);
      expect(sameTarget(finding.longitudinal.observed, finding.target)).toBe(true);

      // --- record -> identities. Non-empty, a subset of the run, and
      // every member actually captured an observation.
      expect(finding.identityIds.length).toBeGreaterThan(0);
      for (const id of finding.identityIds) {
        expect(lineage.identityIds).toContain(id);
        expect(result.resolvedCohort.members.map((m) => m.id)).toContain(id);
      }

      // --- record -> evidence. Every handle is one the run produced.
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      const produced = new Set(lineage.evidenceIds ?? []);
      for (const ref of finding.evidenceRefs) {
        expect(produced.has(ref.id)).toBe(true);
      }
      // The finding names at least one *supporting* citation, which is
      // what makes it evidence-backed rather than merely annotated.
      expect(finding.evidenceRefs.some((r) => r.stance === 'supports')).toBe(true);

      // --- the affected conditions name the durable environment and say
      // out loud that the observation was made by a synthetic identity.
      expect(finding.affectedConditions).toContainEqual({
        dimension: 'environment',
        value: ENV_A,
      });
      expect(finding.affectedConditions).toContainEqual({
        dimension: 'synthetic',
        value: 'synthetic-identity',
      });
    }

    // --- Every locator names a file the run wrote, so a reviewer
    // following a citation arrives at a file and not a dead reference.
    for (const ref of result.evidence) {
      const file = ref.locator.split('#')[0] ?? '';
      expect(file.length).toBeGreaterThan(0);
      await expect(fs.stat(path.join(result.artifactDir, file))).resolves.toBeDefined();
    }

    // --- A `continuous` run with no baseline supplied makes no
    // comparative claim, and says so rather than omitting the field.
    // `unknown` is #61's first-class value for "we did not compare", and
    // the note spells out that it does not mean "no change".
    const withBaselineAbsent = result.findings[0];
    expect(withBaselineAbsent?.longitudinal.mode).toBe('continuous');
    expect(withBaselineAbsent?.longitudinal.change).toBe('unknown');
    expect(withBaselineAbsent?.longitudinal.baseline).toBeNull();
    expect(withBaselineAbsent?.longitudinal.note).toContain('no comparative claim');
    expect(withBaselineAbsent?.longitudinal.note).toContain('not compared');
  }, 60_000);

  it('references the earlier run rather than copying it', async () => {
    const identities = [makeIdentity(ALICE)];
    const { config } = buildHarness(root, {
      identities: [ALICE],
      storeName: 'lineage-baseline-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
      observerFindings: [{ id: 'obs-1', summary: FINDING_A }],
    });
    await seedIdentities(config.cohort, identities);

    const first = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        mode: 'pointInTime',
        delivery: 'lineage-base',
      }),
      runId: 'run-lineage-base',
    });

    const second = await runEvaluation(config, {
      plan: makePlan({
        environmentId: 'env-beta',
        version: '2026.10.2',
        observedAt: '2026-10-08T00:00:00.000Z',
        // No explicit mode: `previousObservation` makes this a genuine
        // `releaseTransition` plan carrying real `VersionLineage`.
        previousObservation: {
          environmentId: ENV_A,
          version: '2026.10.1',
          observedAt: '2026-10-01T00:00:00.000Z',
        },
      }),
      runId: 'run-lineage-follow',
      baseline: first.lineage as RunLineage,
      baselineFindings: first.findings,
    });

    const finding = second.findings[0];
    expect(finding).toBeDefined();
    // The baseline is the *earlier run's own lineage value*, not
    // something the runtime assembled for the finding: it carries the
    // earlier run's environment and its earlier evidence set.
    expect(finding?.longitudinal.baseline).toEqual(first.lineage);
    expect(finding?.longitudinal.baseline?.runId).toBe('run-lineage-base');
    expect(finding?.longitudinal.baseline?.evidenceIds).toEqual(first.lineage.evidenceIds);
    expect(finding?.longitudinal.baseline?.evidenceIds).not.toEqual(second.lineage.evidenceIds);
    expect(isReleaseTransitionComparison(finding!.longitudinal.baseline!, second.lineage)).toBe(true);
    // The environment differs — that is the axis a transition varies
    // along — while the program scope matches.
    expect(finding?.target.environmentId).toBe('env-beta');
    expect(finding?.longitudinal.baseline?.environmentId).toBe(ENV_A);
  }, 60_000);
});
