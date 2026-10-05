/**
 * Finding contract: schema validation and the evidence requirement.
 *
 * Issue #61 acceptance criteria covered here:
 * - "A finding cannot be valid without inspectable evidence references."
 * - "Multiple evidence channels can disagree without being collapsed
 *   into one UX score."
 * - "Customer disposition is distinct from model confidence."
 * - "No field may claim that a Synthetic Cohort is a representative
 *   human sample."
 */

import { describe, it, expect } from 'vitest';
import {
  channelsOf,
  conditionKey,
  deriveFindingId,
  findingId,
  deriveVerificationId,
  evidenceForChannel,
  contradictingEvidence,
  EVIDENCE_CHANNELS,
  isChannelConflict,
  isFinding,
  parseEvidenceRef,
  parseFinding,
  ReviewContractError,
} from '../../../src/review/index.js';
import {
  conditions,
  evidenceDeterministic,
  evidenceObserver,
  findingInput,
  lineageA,
  otherTarget,
  target,
  verification,
} from './support/fixtures.js';

describe('finding schema', () => {
  it('accepts a complete evidence-backed finding', () => {
    const f = parseFinding(findingInput());
    expect(f.outcome).toBe('productFinding');
    expect(f.id).toBe('fnd-0000abcd');
    expect(f.kind).toBe('workflowBlocker');
    expect(f.severity).toBe('high');
    expect(f.riskClass).toBe('usability');
    expect(f.evidenceRefs).toHaveLength(2);
    expect(f.affectedConditions).toHaveLength(2);
    expect(f.target).toEqual(target);
    expect(f.observedIn).toBe(lineageA.runId);
  });

  it('freezes every nested structure so a parsed finding cannot be edited in place', () => {
    const f = parseFinding(findingInput());
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(f.evidenceRefs[0])).toBe(true);
    expect(Object.isFrozen(f.affectedConditions)).toBe(true);
    expect(Object.isFrozen(f.longitudinal)).toBe(true);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(() => parseFinding(findingInput({ uxScore: 0.82 }))).toThrow(ReviewContractError);
    expect(() => parseFinding(findingInput({ uxScore: 0.82 }))).toThrow(/uxScore/);
  });

  it('rejects a finding that carries a customer disposition', () => {
    // Disposition is a separate type with its own reference to the
    // finding. Embedding it would let a model write a customer's
    // decision into the model's own claim.
    expect(() => parseFinding(findingInput({ disposition: { kind: 'accepted' } }))).toThrow(
      /unknown field\(s\): disposition/,
    );
  });
});

describe('the evidence requirement', () => {
  it('rejects a finding whose evidence list is empty', () => {
    expect(() => parseFinding(findingInput({ evidenceRefs: [] }))).toThrow(
      /evidenceRefs must not be empty/,
    );
  });

  it('rejects a finding with no evidence field at all', () => {
    const input = findingInput();
    delete input['evidenceRefs'];
    expect(() => parseFinding(input)).toThrow(/evidenceRefs/);
  });

  it('rejects a finding whose evidence is only inconclusive', () => {
    expect(() =>
      parseFinding(
        findingInput({
          evidenceRefs: [{ ...evidenceObserver, stance: 'inconclusive' }],
        }),
      ),
    ).toThrow(/at least one reference with stance "supports"/);
  });

  it('rejects a finding whose only evidence contradicts it', () => {
    expect(() =>
      parseFinding(findingInput({ evidenceRefs: [evidenceDeterministic] })),
    ).toThrow(/at least one reference with stance "supports"/);
  });

  it('rejects a reference with no locator, because it is not inspectable', () => {
    const { locator: _locator, ...withoutLocator } = evidenceObserver;
    expect(() => parseEvidenceRef(withoutLocator)).toThrow(/locator/);
  });

  it('rejects an empty locator', () => {
    expect(() => parseEvidenceRef({ ...evidenceObserver, locator: '   ' })).toThrow(
      /locator must not be empty/,
    );
  });

  it('rejects a reference whose channel is not a declared channel', () => {
    expect(() => parseEvidenceRef({ ...evidenceObserver, channel: 'vibes' })).toThrow(
      /channel must be one of/,
    );
    for (const channel of EVIDENCE_CHANNELS) {
      expect(parseEvidenceRef({ ...evidenceObserver, channel }).channel).toBe(channel);
    }
  });

  it('rejects the same evidence handle cited twice with two different stances', () => {
    expect(() =>
      parseFinding(
        findingInput({
          evidenceRefs: [evidenceObserver, { ...evidenceObserver, stance: 'contradicts' }],
        }),
      ),
    ).toThrow(/must not contain duplicates/);
  });

  it('rejects an unknown field inside a reference', () => {
    expect(() => parseEvidenceRef({ ...evidenceObserver, weight: 0.7 })).toThrow(
      /unknown field\(s\): weight/,
    );
  });
});

describe('channels may disagree, and the disagreement is kept', () => {
  const conflicting = parseFinding(
    findingInput({ evidenceRefs: [evidenceObserver, evidenceDeterministic] }),
  );

  it('accepts a finding whose deterministic check refutes its own observer', () => {
    expect(conflicting.evidenceRefs).toHaveLength(2);
    expect(channelsOf(conflicting.evidenceRefs)).toEqual(['deterministicCheck', 'observer']);
  });

  it('reports the conflict rather than resolving it', () => {
    expect(isChannelConflict(conflicting.evidenceRefs)).toBe(true);
    expect(contradictingEvidence(conflicting.evidenceRefs)).toEqual([evidenceDeterministic]);
  });

  it('reports no conflict when every reference supports the claim', () => {
    const f = parseFinding(findingInput());
    expect(isChannelConflict(f.evidenceRefs)).toBe(false);
    expect(contradictingEvidence(f.evidenceRefs)).toEqual([]);
  });

  it('has no field that could hold a combined score', () => {
    // A single universal UX score is an explicit anti-metric in
    // docs/product/kpis.md. The contract cannot hold one at all: the
    // only way to add it is an unknown key, which throws.
    for (const scoreField of ['uxScore', 'score', 'overallScore', 'compositeScore', 'rating']) {
      expect(() => parseFinding(findingInput({ [scoreField]: 0.5 }))).toThrow(
        ReviewContractError,
      );
    }
  });
});

describe('confidence is not disposition', () => {
  it('requires a provenance channel on every confidence', () => {
    expect(() =>
      parseFinding(
        findingInput({
          confidence: {
            level: 'high',
            basis: 'modelJudgement',
            source: 'model',
            calibration: { calibrated: false },
          },
        }),
      ),
    ).toThrow(/provenance/);
  });

  it('rejects an unknown confidence field', () => {
    expect(() =>
      parseFinding(
        findingInput({
          confidence: {
            level: 'high',
            basis: 'modelJudgement',
            source: 'model',
            provenance: { channel: 'observer', recordedAt: '2026-10-01T00:07:00Z' },
            calibration: { calibrated: false },
            customerApproved: true,
          },
        }),
      ),
    ).toThrow(/customerApproved/);
  });

  it('refuses a calibration claim with no yardstick', () => {
    expect(() =>
      parseFinding(
        findingInput({
          confidence: {
            level: 'high',
            basis: 'multiChannelAgreement',
            source: 'human',
            provenance: { channel: 'observer', recordedAt: '2026-10-01T00:07:00Z' },
            calibration: { calibrated: true },
          },
        }),
      ),
    ).toThrow(/yardstick is required/);
  });

  it('refuses a calibration claim with a yardstick but no sample size', () => {
    expect(() =>
      parseFinding(
        findingInput({
          confidence: {
            level: 'high',
            basis: 'multiChannelAgreement',
            source: 'human',
            provenance: { channel: 'observer', recordedAt: '2026-10-01T00:07:00Z' },
            calibration: { calibrated: true, yardstick: 'human-usability-study' },
          },
        }),
      ),
    ).toThrow(/sampleSize is required/);
  });

  it('accepts a calibration claim that names its yardstick and sample', () => {
    const f = parseFinding(
      findingInput({
        confidence: {
          level: 'high',
          basis: 'multiChannelAgreement',
          source: 'human',
          provenance: { channel: 'observer', recordedAt: '2026-10-01T00:07:00Z' },
          calibration: {
            calibrated: true,
            yardstick: 'human-usability-study',
            sampleSize: 24,
          },
        },
      }),
    );
    expect(f.confidence.calibration.yardstick).toBe('human-usability-study');
  });

  it('refuses to let a model certify its own confidence as calibrated', () => {
    expect(() =>
      parseFinding(
        findingInput({
          confidence: {
            level: 'high',
            basis: 'modelJudgement',
            source: 'model',
            provenance: { channel: 'observer', recordedAt: '2026-10-01T00:07:00Z' },
            calibration: { calibrated: true, yardstick: 'self-report', sampleSize: 10 },
          },
        }),
      ),
    ).toThrow(/may not certify its own confidence/);
  });
});

describe('the non-reality boundary', () => {
  it('refuses a field that claims a cohort represents humans', () => {
    expect(() => parseFinding(findingInput({ representativeSample: true }))).toThrow(
      /representative sample of human users/,
    );
    expect(() => parseFinding(findingInput({ humanSample: 1200 }))).toThrow(
      /ADR-0011 non-reality boundary/,
    );
    expect(() => parseFinding(findingInput({ populationSize: 50000 }))).toThrow(
      /ADR-0011 non-reality boundary/,
    );
  });

  it('refuses an unlisted but still-representative-sounding field name', () => {
    expect(() => parseFinding(findingInput({ representativenessScore: 0.9 }))).toThrow(
      /may not assert human representativeness/,
    );
  });

  it('still allows conditions to be described as synthetic', () => {
    const f = parseFinding(
      findingInput({
        affectedConditions: [
          ...conditions,
          { dimension: 'synthetic', value: 'identity=idn-alice' },
        ],
      }),
    );
    expect(f.affectedConditions).toHaveLength(3);
  });
});

describe('cross-field consistency', () => {
  it('rejects a finding attributed to a run it was not raised on', () => {
    expect(() => parseFinding(findingInput({ observedIn: 'run-2026-10-07-0001' }))).toThrow(
      /observedIn must be the run the finding was raised on/,
    );
  });

  it('rejects a finding whose target is not the target its own run observed', () => {
    expect(() => parseFinding(findingInput({ target: otherTarget }))).toThrow(
      /may not be attributed to a Product\/Environment\/Cohort\/Program its run did not evaluate/,
    );
  });

  it('rejects a finding attributed only to identities absent from its run', () => {
    expect(() => parseFinding(findingInput({ identityIds: ['idn-carol'] }))).toThrow(
      /at least one identity that took part in the run/,
    );
  });

  it('rejects a duplicated identity list', () => {
    expect(() =>
      parseFinding(findingInput({ identityIds: ['idn-alice', 'idn-alice'] })),
    ).toThrow(/must not contain duplicates/);
  });

  it('rejects a duplicated affected condition', () => {
    expect(() =>
      parseFinding(
        findingInput({
          affectedConditions: [conditions[0], conditions[0]],
        }),
      ),
    ).toThrow(/must not contain duplicates/);
  });

  it('rejects an empty affected-condition list', () => {
    expect(() => parseFinding(findingInput({ affectedConditions: [] }))).toThrow(
      /affectedConditions must not be empty/,
    );
  });
});

describe('reproduction and verification', () => {
  it('requires a verification record when the finding claims to be reproduced', () => {
    const input = findingInput();
    delete input['verification'];
    expect(() => parseFinding(input)).toThrow(
      /requires a verification record/,
    );
  });

  it('rejects a reproduction claim with no steps to follow', () => {
    expect(() =>
      parseFinding(findingInput({ reproduction: { status: 'reproduced' } })),
    ).toThrow(/steps must be non-empty/);
  });

  it('accepts a reproduced finding carrying a matching verification', () => {
    const f = parseFinding(findingInput({ verification }));
    expect(f.verification?.outcome).toBe('confirmed');
    expect(f.verification?.id).toBe(verification?.id);
  });

  it('rejects a verification that names a different finding', () => {
    expect(() =>
      parseFinding(findingInput({ verification: { ...verification, findingId: 'fnd-99999999' } })),
    ).toThrow(/must be the finding being verified/);
  });

  it('rejects a finding that is both reproduced and refuted by its own verification', () => {
    expect(() =>
      parseFinding(findingInput({ verification: { ...verification, outcome: 'refuted' } })),
    ).toThrow(/cannot be "reproduced" while its own verification reports "refuted"/);
  });

  it('rejects a reproduction backed by a verification that never ran', () => {
    expect(() =>
      parseFinding(findingInput({ verification: { ...verification, outcome: 'notRun' } })),
    ).toThrow(/cannot be "reproduced" while its own verification reports "notRun"/);
  });

  it('accepts an inconclusive verification alongside a reproduction', () => {
    // The participant reproduced it; an independent pass could not
    // settle it. #64 counts that as a verification that did not survive,
    // so it must be representable.
    const f = parseFinding(
      findingInput({ verification: { ...verification, outcome: 'inconclusive' } }),
    );
    expect(f.verification?.outcome).toBe('inconclusive');
  });

  it('rejects a verification that carries no evidence of its own', () => {
    expect(() =>
      parseFinding(
        findingInput({ verification: { ...verification, evidenceRefs: [] } }),
      ),
    ).toThrow(/evidenceRefs must not be empty/);
  });

  it('accepts a notAttempted finding with no verification', () => {
    const input = findingInput({ reproduction: { status: 'notAttempted' } });
    delete input['verification'];
    const f = parseFinding(input);
    expect('verification' in f).toBe(false);
  });

  it('rejects a verification attached to a finding that was never checked', () => {
    expect(() =>
      parseFinding(findingInput({ reproduction: { status: 'notAttempted' } })),
    ).toThrow(/a verification was recorded but reproduction.status is "notAttempted"/);
  });
});

describe('type guards', () => {
  it('identifies a parsed finding', () => {
    const f = parseFinding(findingInput());
    expect(isFinding(f)).toBe(true);
    expect(isFinding({ outcome: 'setupFailure' })).toBe(false);
    expect(isFinding(null)).toBe(false);
    expect(isFinding('fnd-1')).toBe(false);
  });
});

describe('helpers downstream tickets will build on', () => {
  it('groups conditions by a stable key regardless of input order', () => {
    const a = conditionKey([
      { dimension: 'flow', value: 'task/create' },
      { dimension: 'capability', value: 'memory=limitedRecent' },
    ]);
    const b = conditionKey([
      { dimension: 'capability', value: 'memory=limitedRecent' },
      { dimension: 'flow', value: 'task/create' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe(conditionKey(conditions));
  });

  it('separates a different condition set into a different key', () => {
    expect(conditionKey(conditions)).not.toBe(
      conditionKey([{ dimension: 'flow', value: 'task/delete' }]),
    );
  });

  it('reports evidence for one channel without aggregating across channels', () => {
    const f = parseFinding(
      findingInput({ evidenceRefs: [evidenceObserver, evidenceDeterministic] }),
    );
    expect(evidenceForChannel(f.evidenceRefs, 'observer')).toEqual([evidenceObserver]);
    expect(evidenceForChannel(f.evidenceRefs, 'deterministicCheck')).toEqual([
      evidenceDeterministic,
    ]);
    expect(evidenceForChannel(f.evidenceRefs, 'productionSignal')).toEqual([]);
  });

  it('derives a finding id deterministically from a run and an ordinal', () => {
    expect(deriveFindingId('run-2026-10-01-0001', 1)).toBe(
      deriveFindingId('run-2026-10-01-0001', 1),
    );
    expect(deriveFindingId('run-2026-10-01-0001', 1)).not.toBe(
      deriveFindingId('run-2026-10-01-0001', 2),
    );
    expect(deriveFindingId('run-2026-10-01-0001', 1)).not.toBe(
      deriveFindingId('run-2026-10-01-0002', 1),
    );
  });

  it('rejects a derivation ordinal that is not a positive integer', () => {
    expect(() => deriveFindingId('run-2026-10-01-0001', 0)).toThrow(/ordinal/);
    expect(() => deriveFindingId('run-2026-10-01-0001', 1.5)).toThrow(/ordinal/);
  });

  it('derives a verification id per pass over the same finding', () => {
    const first = deriveVerificationId(findingId('fnd-0000abcd'), 1);
    const second = deriveVerificationId(findingId('fnd-0000abcd'), 2);
    expect(deriveVerificationId(findingId('fnd-0000abcd'), 1)).toBe(first);
    expect(second).not.toBe(first);
  });
});
