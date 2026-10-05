/**
 * Setup failure vs product finding.
 *
 * Issue #61 and the runtime integration ticket #63 both depend on this
 * being a real distinction rather than a naming convention:
 *
 * - #61: a finding is an evidence-backed claim about the product.
 * - #63: "Setup/runtime failure is distinguishable from a product
 *   finding."
 *
 * `BehavioralEvidence.runtimeErrors` in `src/domain/evidence.ts` is
 * `{ ts, where, message }[]` and cannot tell a dead browser from a
 * dead button, so the distinction is made at the boundary where a
 * runtime error becomes a durable review record.
 */

import { describe, it, expect } from 'vitest';
import {
  inferSetupFailureCause,
  isFinding,
  isSetupFailure,
  parseFinding,
  parseReviewOutcome,
  parseSetupFailure,
  ReviewContractError,
  SETUP_FAILURE_CAUSES,
  setupFailureId,
  setupFailureFromRuntimeError,
  type RuntimeErrorRecord,
  type SetupFailure,
} from '../../../src/review/index.js';
import { parseSyntheticIdentityId } from '../../../src/product/index.js';
import { findingInput, lineageA, target } from './support/fixtures.js';
import { browserGone, setupInput } from './support/setup-fixture.js';

const SF_A = setupFailureId('sf-0000abcd');
const SF_B = setupFailureId('sf-0000ffff');

describe('the two outcomes are separate types', () => {
  it('parses a setup failure', () => {
    const f = parseSetupFailure(setupInput());
    expect(f.outcome).toBe('setupFailure');
    expect(f.cause).toBe('harnessUnavailable');
    expect(f.id).toBe('sf-0000abcd');
    expect(f.evidenceRefs).toHaveLength(1);
  });

  it('refuses to parse a setup failure as a product finding', () => {
    expect(() => parseFinding(setupInput())).toThrow(
      /outcome must be "productFinding"; a SetupFailure is a separate type/,
    );
  });

  it('refuses to parse a product finding as a setup failure', () => {
    expect(() => parseSetupFailure(findingInput())).toThrow(
      /outcome must be "setupFailure"; a product observation is a Finding/,
    );
  });

  it('reports the two with disjoint type guards', () => {
    const failure = parseSetupFailure(setupInput());
    const finding = parseFinding(findingInput());
    expect(isSetupFailure(failure)).toBe(true);
    expect(isFinding(failure)).toBe(false);
    expect(isFinding(finding)).toBe(true);
    expect(isSetupFailure(finding)).toBe(false);
  });

  it('dispatches on the discriminant through one entry point', () => {
    const outcome = parseReviewOutcome(setupInput());
    expect(isSetupFailure(outcome)).toBe(true);

    const productOutcome = parseReviewOutcome(findingInput());
    expect(isFinding(productOutcome)).toBe(true);
  });

  it('rejects an outcome that is neither', () => {
    expect(() => parseReviewOutcome({ outcome: 'observation' })).toThrow(
      /outcome must be "productFinding" or "setupFailure"/,
    );
  });

  it('keeps a setup failure free of product-claim fields', () => {
    // There is no severity, confidence, affectedConditions or
    // longitudinal on a SetupFailure, so there is nothing for a
    // harness problem to be reported as.
    for (const productField of ['severity', 'riskClass', 'confidence', 'affectedConditions']) {
      expect(() => parseSetupFailure(setupInput({ [productField]: 'high' }))).toThrow(
        /unknown field/,
      );
    }
  });

  it('rejects a setup failure with no inspectable evidence', () => {
    expect(() => parseSetupFailure(setupInput({ evidenceRefs: [] }))).toThrow(
      /evidenceRefs must not be empty/,
    );
    const withoutEvidence = setupInput();
    delete withoutEvidence['evidenceRefs'];
    expect(() => parseSetupFailure(withoutEvidence)).toThrow(/evidenceRefs/);
  });

  it('freezes a setup failure and its evidence', () => {
    const f = parseSetupFailure(setupInput());
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.evidenceRefs)).toBe(true);
  });

  it('accepts a setup failure that predates any known evaluation', () => {
    const f = parseSetupFailure(
      setupInput({ target: undefined, runId: undefined, identityIds: undefined }),
    );
    expect('target' in f).toBe(false);
    expect('runId' in f).toBe(false);
    expect('identityIds' in f).toBe(false);
  });

  it('rejects a setup failure id that is a finding id', () => {
    expect(() => parseSetupFailure(setupInput({ id: 'fnd-0000abcd' }))).toThrow(
      /id must match/,
    );
  });
});

describe('adapting a runtime error record', () => {
  it('turns a runtimeErrors entry into a setup failure, not a finding', () => {
    const failure = setupFailureFromRuntimeError(browserGone, {
      id: SF_A,
      index: 0,
      runId: lineageA.runId,
      target,
      identityIds: [parseSyntheticIdentityId('idn-alice')],
    }) as SetupFailure;

    expect(failure.outcome).toBe('setupFailure');
    expect(isFinding(failure)).toBe(false);
    expect(failure.cause).toBe('harnessUnavailable');
    expect(failure.message).toBe(browserGone.message);
    expect(failure.evidenceRefs[0]?.channel).toBe('environmentProbe');
    expect(failure.evidenceRefs[0]?.locator).toBe('runtimeErrors[0]');
  });

  it('derives the same evidence handle for the same record, so it cannot double-count', () => {
    const a = setupFailureFromRuntimeError(browserGone, { id: SF_A });
    const b = setupFailureFromRuntimeError(browserGone, { id: SF_B });
    expect(a.evidenceRefs[0]?.id).toBe(b.evidenceRefs[0]?.id);
  });

  it('derives a different evidence handle for a different record', () => {
    const a = setupFailureFromRuntimeError(browserGone, { id: SF_A });
    const b = setupFailureFromRuntimeError(
      { ...browserGone, message: 'a different failure' },
      { id: SF_B },
    );
    expect(a.evidenceRefs[0]?.id).not.toBe(b.evidenceRefs[0]?.id);
  });

  it('accepts a BehavioralEvidence.runtimeErrors array structurally', () => {
    // No import from src/domain/** — the shape is local, so this
    // assignment is the proof that #63 can pass the array straight in.
    const runtimeErrors: ReadonlyArray<RuntimeErrorRecord> = [browserGone];
    for (const record of runtimeErrors) {
      expect(() => setupFailureFromRuntimeError(record, { id: SF_A })).not.toThrow();
    }
  });

  it('honours an explicit cause over the keyword inference', () => {
    const f = setupFailureFromRuntimeError(browserGone, {
      id: SF_A,
      cause: 'environmentUnreachable',
    });
    expect(f.cause).toBe('environmentUnreachable');
  });

  it('rejects a record whose timestamp is not an instant', () => {
    expect(() =>
      setupFailureFromRuntimeError({ ...browserGone, ts: '2026-10-01' }, { id: SF_A }),
    ).toThrow(/error.ts must be an ISO-8601 instant/);
  });
});

describe('cause inference is conservative', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['harnessUnavailable', 'connect ECONNREFUSED 127.0.0.1:3000'],
    ['harnessUnavailable', 'net::ERR_CONNECTION_REFUSED at https://staging.example.test'],
    ['policyDenied', 'world state mutation is not permitted by the configured policy'],
    ['budgetExhausted', 'daily run budget exhausted'],
    ['providerUnavailable', 'model provider returned 429'],
    ['worldOperatorDenied', 'world operator provisioning denied for this identity'],
    ['worldStateUnavailable', 'could not seed the test account fixture'],
    ['unknown', 'something entirely novel happened'],
  ];

  for (const [cause, message] of cases) {
    it(`maps ${JSON.stringify(message)} to ${cause}`, () => {
      expect(inferSetupFailureCause(message)).toBe(cause);
    });
  }

  it('declares a cause for every failure the contract can represent', () => {
    expect(SETUP_FAILURE_CAUSES).toContain(inferSetupFailureCause('anything at all'));
  });

  it('rejects a cause outside the declared taxonomy', () => {
    expect(() => parseSetupFailure(setupInput({ cause: 'cosmicRay' }))).toThrow(
      /cause must be one of/,
    );
  });
});

describe('the two never leak into one another in a parsed record', () => {
  it('keeps a product finding free of a cause field', () => {
    expect(() => parseFinding(findingInput({ cause: 'harnessUnavailable' }))).toThrow(
      ReviewContractError,
    );
  });

  it('keeps a setup failure free of a findingId field', () => {
    expect(() => parseSetupFailure(setupInput({ findingId: 'fnd-0000abcd' }))).toThrow(
      /unknown field\(s\): findingId/,
    );
  });
});

describe('a setup failure must cite evidence that supports it', () => {
  it('rejects a setup failure whose diagnostics all contradict it', () => {
    expect(() =>
      parseSetupFailure(
        setupInput({
          evidenceRefs: [
            {
              id: 'ev-setup-1',
              channel: 'environmentProbe',
              stance: 'contradicts',
              locator: 'runtimeErrors[0]',
              observedAt: '2026-10-01T00:02:11Z',
              summary: 'The probe says the environment was reachable.',
            },
          ],
        }),
      ),
    ).toThrow(/at least one reference with stance "supports"/);
  });

  it('rejects a setup failure whose only diagnostic is inconclusive', () => {
    expect(() =>
      parseSetupFailure(
        setupInput({
          evidenceRefs: [
            {
              id: 'ev-setup-1',
              channel: 'environmentProbe',
              stance: 'inconclusive',
              locator: 'runtimeErrors[0]',
              observedAt: '2026-10-01T00:02:11Z',
              summary: 'Unclear whether the probe ran.',
            },
          ],
        }),
      ),
    ).toThrow(/at least one reference with stance "supports"/);
  });
});
