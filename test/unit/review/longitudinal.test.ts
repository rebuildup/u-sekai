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
import { isReleaseTransitionComparison } from '../../../src/product/index.js';
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
  otherTarget,
  verification,
} from './support/fixtures.js';

const COMPARATIVE_CHANGES = CHANGE_KINDS.filter((k) => k !== 'unknown');

/** A finding observed on `lineageB` with a given longitudinal block. */
function findingOn(longitudinal: Record<string, unknown>): Record<string, unknown> {
  return findingInput({
    observedIn: lineageB.runId,
    identityIds: ['idn-alice'],
    evidenceRefs: [evidenceObserver, evidenceSelfReport],
    observedAt: '2026-10-07T00:07:00Z',
    verification: { ...verification, findingId: 'fnd-0000abcd' },
    longitudinal,
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

  it('rejects a baseline on a different environment', () => {
    const elsewhere = { ...lineageA, environmentId: otherTarget.environmentId };
    expect(() =>
      parseLongitudinalChange({
        mode: 'continuous',
        change: 'persisted',
        baseline: elsewhere,
        observed: lineageB,
      }),
    ).toThrow(/requires a joinable baseline/);
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

  it('rejects a finding whose baseline is on a different environment', () => {
    expect(() =>
      parseFinding(
        findingOn({
          mode: 'releaseTransition',
          change: 'persisted',
          baseline: { ...lineageA, environmentId: otherTarget.environmentId },
          observed: lineageB,
        }),
      ),
    ).toThrow(/requires a joinable baseline/);
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
