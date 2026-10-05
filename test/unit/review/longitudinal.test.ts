/**
 * Longitudinal change: point-in-time and release-transition findings
 * share one envelope, and a comparative claim requires a joinable
 * baseline.
 *
 * Issue #61 acceptance criteria covered here:
 * - "Point-in-time and longitudinal/release-transition findings share
 *   one stable envelope."
 * - "Unit tests cover ... longitudinal references."
 */

import { describe, it, expect } from 'vitest';
import {
  isReleaseTransitionComparison,
  parseCohortId,
  parseEnvironmentId,
  parseEvaluationRunId,
  parseProductId,
  parseReviewProgramId,
  parseRunLineage,
  parseSyntheticIdentityId,
} from '../../../src/product/index.js';
import type { RunLineage } from '../../../src/product/index.js';
import {
  CHANGE_KINDS,
  EVALUATION_MODES,
  isComparativeChange,
  parseFinding,
  parseLongitudinalChange,
  ReviewContractError,
} from '../../../src/review/index.js';
import {
  evidenceObserver,
  evidenceSelfReport,
  findingInput,
  lineageA,
  lineageB,
  lineageUnrelated,
  target,
  verification,
} from './support/fixtures.js';

const COMPARATIVE_CHANGES = CHANGE_KINDS.filter((k) => k !== 'unknown');

/** A finding observed on `lineageB` with a given longitudinal block. */
function findingOn(
  longitudinal: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return findingInput({
    observedIn: lineageB.runId,
    identityIds: ['idn-alice'],
    evidenceRefs: [evidenceObserver, evidenceSelfReport],
    observedAt: '2026-10-07T00:07:00Z',
    verification: { ...verification, findingId: 'fnd-0000abcd' },
    longitudinal,
    ...overrides,
  });
}

describe('one envelope for all three evaluation modes', () => {
  it('parses a point-in-time finding with no baseline', () => {
    const l = parseLongitudinalChange({
      mode: 'pointInTime',
      change: 'unknown',
      baseline: null,
      observed: lineageA,
    });
    expect(l.mode).toBe('pointInTime');
    expect(l.change).toBe('unknown');
    expect(l.baseline).toBeNull();
    expect(isComparativeChange(l)).toBe(false);
  });

  it('parses a release-transition finding against a joinable baseline', () => {
    const l = parseLongitudinalChange({
      mode: 'releaseTransition',
      change: 'regressed',
      baseline: lineageA,
      observed: lineageB,
      note: 'The 2026-10 release reintroduced the inert save control.',
    });
    expect(l.mode).toBe('releaseTransition');
    expect(l.change).toBe('regressed');
    expect(l.baseline?.runId).toBe(lineageA.runId);
    expect(l.note).toContain('2026-10 release');
  });

  it('parses a continuous finding with and without a baseline', () => {
    const withBaseline = parseLongitudinalChange({
      mode: 'continuous',
      change: 'persisted',
      baseline: lineageA,
      observed: lineageB,
    });
    expect(withBaseline.change).toBe('persisted');

    const firstRun = parseLongitudinalChange({
      mode: 'continuous',
      change: 'unknown',
      baseline: null,
      observed: lineageB,
    });
    expect(firstRun.baseline).toBeNull();
  });

  it('parses a finding for every declared mode', () => {
    for (const mode of EVALUATION_MODES) {
      const l = parseLongitudinalChange({
        mode,
        change: 'unknown',
        baseline: mode === 'pointInTime' ? null : lineageA,
        observed: lineageB,
      });
      expect(l.mode).toBe(mode);
    }
  });
});

describe('a comparative claim requires a joinable baseline', () => {
  for (const change of COMPARATIVE_CHANGES) {
    it(`rejects "${change}" with no baseline`, () => {
      expect(() =>
        parseLongitudinalChange({ mode: 'continuous', change, baseline: null, observed: lineageB }),
      ).toThrow(/is a comparative claim and requires a baseline/);
    });

    it(`rejects "${change}" against a run with no shared identity`, () => {
      expect(() =>
        parseLongitudinalChange({
          mode: 'continuous',
          change,
          baseline: lineageUnrelated,
          observed: lineageB,
        }),
      ).toThrow(/requires a joinable baseline/);
    });
  }

  it('accepts a baseline on a different environment — that is what a transition is', () => {
    // ADR-0011's release-transition mode is a persistent cohort meeting
    // an earlier and a newer version, which are normally two different
    // deployments. #57's isReleaseTransitionComparison deliberately
    // excludes the environment from the comparison scope.
    const staging = { ...lineageA };
    const production = {
      ...lineageB,
      environmentId: parseEnvironmentId('env-production'),
    };
    const l = parseLongitudinalChange({
      mode: 'releaseTransition',
      change: 'regressed',
      baseline: staging,
      observed: production,
    });
    expect(l.change).toBe('regressed');
    expect(l.baseline?.environmentId).toBe('env-staging');
    expect(l.observed.environmentId).toBe('env-production');
  });

  it('rejects a baseline from a different cohort or program', () => {
    // The scope guard that the environment relaxation makes load-bearing.
    const otherCohort = {
      ...lineageA,
      runId: 'run-2026-10-01-0003',
      cohortId: parseCohortId('coh-edge'),
    };
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: otherCohort,
        observed: lineageB,
      }),
    ).toThrow(/requires a joinable baseline/);

    const otherProgram = {
      ...lineageA,
      runId: 'run-2026-10-01-0004',
      programId: parseReviewProgramId('rp-weekly'),
    };
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'persisted',
        baseline: otherProgram,
        observed: lineageB,
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects a baseline outside the program scope even when no claim is made', () => {
    const otherCohort = {
      ...lineageA,
      runId: 'run-2026-10-01-0005',
      cohortId: parseCohortId('coh-edge'),
    };
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'unknown',
        baseline: otherCohort,
        observed: lineageB,
      }),
    ).toThrow(/must belong to the same Review Program scope/);
  });

  it('rejects a baseline that starts after the observation', () => {
    // A later baseline with the same identities and target: it joins on
    // every other axis, so only the temporal check can catch it.
    const later = {
      ...lineageA,
      runId: 'run-2026-10-09-0001',
      startedAt: '2026-10-09T00:00:00Z',
      endedAt: undefined,
    };
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'introduced',
        baseline: later,
        observed: lineageB,
      }),
    ).toThrow(/must not be after observed.startedAt/);
  });

  it('rejects a later baseline even when no comparative claim is made', () => {
    // A reference to the wrong run is a defect in the reference itself,
    // not only when a claim is built on top of it.
    const later = {
      ...lineageA,
      runId: 'run-2026-10-09-0001',
      startedAt: '2026-10-09T00:00:00Z',
      endedAt: undefined,
    };
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'unknown',
        baseline: later,
        observed: lineageB,
      }),
    ).toThrow(/must not be after observed.startedAt/);
  });

  it('rejects a release-transition finding with no baseline at all', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: null,
        observed: lineageB,
      }),
    ).toThrow(/baseline is required in releaseTransition mode/);
  });

  it('rejects a point-in-time finding that claims to carry a baseline', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'pointInTime',
        change: 'unknown',
        baseline: lineageA,
        observed: lineageA,
      }),
    ).toThrow(/a point-in-time evaluation has no earlier observation/);
  });

  it('accepts exactly the join #57 defines, and agrees with it', () => {
    const l = parseLongitudinalChange({
      mode: 'releaseTransition',
      change: 'regressed',
      baseline: lineageA,
      observed: lineageB,
    });
    // Same predicate, reached through this layer: the claim is legal
    // because the two runs share a target and idn-alice, not merely
    // because they are in the same repository.
    expect(isReleaseTransitionComparison(lineageA, lineageB)).toBe(true);
    expect(l.baseline).not.toBeNull();
  });
});

describe('longitudinal references are validated as part of the finding', () => {
  it('accepts a release-transition finding whose baseline joins', () => {
    const f = parseFinding(findingOn({
      mode: 'releaseTransition',
      change: 'regressed',
      baseline: lineageA,
      observed: lineageB,
    }));
    expect(f.longitudinal.change).toBe('regressed');
    expect(f.longitudinal.baseline?.runId).toBe(lineageA.runId);
  });

  it('rejects a release-transition finding whose baseline does not join', () => {
    expect(() =>
      parseFinding(
        findingOn({
          mode: 'releaseTransition',
          change: 'regressed',
          baseline: lineageUnrelated,
          observed: lineageB,
        }),
      ),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects a finding whose baseline is in a different program scope', () => {
    expect(() =>
      parseFinding(
        findingOn({
          mode: 'releaseTransition',
          change: 'persisted',
          baseline: { ...lineageA, cohortId: parseCohortId('coh-edge') },
          observed: lineageB,
        }),
      ),
    ).toThrow(/requires a joinable baseline/);
  });

  it('accepts a release-transition finding across two environments', () => {
    // The end-to-end shape ADR-0011 describes: the same persistent
    // identity and the same program scope, observed against a newer
    // deployment. The finding's own target is the deployment it was
    // raised on (production); the baseline is the earlier one.
    const production = parseEnvironmentId('env-production');
    const f = parseFinding(
      findingOn(
        {
          mode: 'releaseTransition',
          change: 'regressed',
          baseline: { ...lineageA },
          observed: { ...lineageB, environmentId: production },
        },
        { target: { ...target, environmentId: production } },
      ),
    );
    expect(f.longitudinal.change).toBe('regressed');
    expect(f.target.environmentId).toBe('env-production');
    expect(f.longitudinal.baseline?.environmentId).toBe('env-staging');
  });

  it('still refuses a finding whose own target is not the one it observed', () => {
    // The relaxation applies to the *baseline*, never to the run that
    // raised the finding: a claim about staging must come from a run
    // that actually looked at staging.
    expect(() =>
      parseFinding(
        findingOn({
          mode: 'releaseTransition',
          change: 'regressed',
          baseline: { ...lineageA },
          observed: { ...lineageB, environmentId: parseEnvironmentId('env-production') },
        }),
      ),
    ).toThrow(
      /may not be attributed to a Product\/Environment\/Cohort\/Program its run did not evaluate/,
    );
  });

  it('rejects an unknown longitudinal field', () => {
    expect(() => parseFinding(findingOn({ mode: 'continuous', extra: true }))).toThrow(
      ReviewContractError,
    );
  });

  it('rejects an unknown change kind', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'slightlyWorse',
        baseline: null,
        observed: lineageB,
      }),
    ).toThrow(/change must be one of/);
  });

  it('rejects a relatedFindingId list with duplicates', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'unknown',
        baseline: null,
        observed: lineageB,
        relatedFindingIds: ['fnd-0000abcd', 'fnd-0000abcd'],
      }),
    ).toThrow(/must not contain duplicates/);
  });

  it('keeps a related-finding reference by id rather than by copy', () => {
    const l = parseLongitudinalChange({
      mode: 'continuous',
      change: 'unknown',
      baseline: null,
      observed: lineageB,
      relatedFindingIds: ['fnd-0000abcd'],
    });
    expect(l.relatedFindingIds).toEqual(['fnd-0000abcd']);
  });
});

/**
 * The cross-environment boundary, attempted to be falsified.
 *
 * #57 deliberately removed `environmentId` from
 * `isReleaseTransitionComparison`'s scope, so a claim gate written
 * against the older, stricter predicate would silently admit more than
 * intended. This block exists to prove the relaxation did not make the
 * gate vacuous.
 *
 * Every rejection below is **cross-environment** and differs from the
 * one accepted case by exactly one thing. If any of these were
 * accepted, the gate would be admitting a comparison that is not a
 * returning-user observation of the same durable population — the
 * falsification ADR-0011's returning-user thesis depends on.
 *
 * What this block cannot falsify, and says so rather than papering
 * over: `RunLineage` carries **no version identity**, so nothing in
 * this layer can verify that a release transition actually crossed a
 * version boundary rather than two runs of one deployment. See the
 * `longitudinal.ts` module docstring.
 */
describe('the cross-environment boundary is falsifiable', () => {
  const STAGING = parseEnvironmentId('env-staging');
  const PRODUCTION = parseEnvironmentId('env-production');
  const ALICE = parseSyntheticIdentityId('idn-alice');
  const CAROL = parseSyntheticIdentityId('idn-carol');

  /** A run in `env-staging`, fully parameterised so one axis can move at a time. */
  function stagingRun(overrides: Record<string, unknown> = {}): RunLineage {
    return parseRunLineage({
      runId: parseEvaluationRunId('run-2026-10-01-0001'),
      ...target,
      environmentId: STAGING,
      identityIds: [ALICE],
      startedAt: '2026-10-01T00:00:00Z',
      ...overrides,
    });
  }

  /** A later run in `env-production`, parameterised the same way. */
  function productionRun(overrides: Record<string, unknown> = {}): RunLineage {
    return parseRunLineage({
      runId: parseEvaluationRunId('run-2026-10-07-0001'),
      ...target,
      environmentId: PRODUCTION,
      identityIds: [ALICE],
      startedAt: '2026-10-07T00:00:00Z',
      ...overrides,
    });
  }

  it('accepts exactly the canonical case: same scope, shared identity, two deployments', () => {
    const l = parseLongitudinalChange({
      mode: 'releaseTransition',
      change: 'regressed',
      baseline: stagingRun(),
      observed: productionRun(),
    });
    expect(l.change).toBe('regressed');
    expect(l.baseline?.environmentId).toBe(STAGING);
    expect(l.observed.environmentId).toBe(PRODUCTION);
    expect(isReleaseTransitionComparison(stagingRun(), productionRun())).toBe(true);
  });

  it('rejects cross-environment with no shared identity — not a returning user', () => {
    const baseline = stagingRun({ identityIds: [CAROL] });
    expect(baseline.environmentId).not.toBe(productionRun().environmentId);
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline,
        observed: productionRun(),
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects cross-environment under a different cohort — not the same population', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: stagingRun({ cohortId: parseCohortId('coh-edge') }),
        observed: productionRun(),
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects cross-environment under a different program — not the same policy', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: stagingRun({ programId: parseReviewProgramId('rp-weekly') }),
        observed: productionRun(),
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects a cross-environment pair that is the same run observed twice', () => {
    const sameRun = productionRun({ runId: 'run-2026-10-01-0001' });
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: stagingRun(),
        observed: sameRun,
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects cross-environment under a different product', () => {
    expect(() =>
      parseLongitudinalChange({
        mode: 'releaseTransition',
        change: 'regressed',
        baseline: stagingRun({ productId: parseProductId('prd-other') }),
        observed: productionRun(),
      }),
    ).toThrow(/requires a joinable baseline/);
  });

  it('rejects every one of those cases at the Finding level too, not just the helper', () => {
    // The gate must not be bypassable by going through parseFinding.
    for (const baseline of [
      stagingRun({ identityIds: [CAROL] }),
      stagingRun({ cohortId: parseCohortId('coh-edge') }),
      stagingRun({ programId: parseReviewProgramId('rp-weekly') }),
      stagingRun({ productId: parseProductId('prd-other') }),
    ]) {
      expect(() =>
        parseFinding(
          findingOn({
            mode: 'releaseTransition',
            change: 'regressed',
            baseline,
            observed: productionRun(),
            ...{},
          }, { target: { ...target, environmentId: PRODUCTION } }),
        ),
      ).toThrow(/requires a joinable baseline/);
    }
  });
});
