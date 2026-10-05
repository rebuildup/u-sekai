/**
 * Compile-time separations, enforced by `npm run typecheck`.
 *
 * Every `@ts-expect-error` below is a *failing-build* assertion. If a
 * future change made one of these assignments legal, `tsc --noEmit`
 * would report "Unused '@ts-expect-error' directive" and the gate would
 * fail. That is the point: the guarantees this file claims are the ones
 * a reviewer cannot check by reading a test's `expect` calls, because
 * they live in the type system rather than at runtime.
 *
 * The four separations that matter downstream:
 *
 * 1. A `SetupFailure` is not a `Finding` and a `Finding` is not a
 *    `SetupFailure` (issue #63 acceptance criterion).
 * 2. A `SetupFailureId` is not a `FindingId` — the wire-form guard
 *    that survives `JSON.stringify`.
 * 3. A `Finding` cannot be given a customer disposition, and a
 *    `Disposition` cannot be given model confidence (issue #61
 *    acceptance criterion).
 * 4. #64's aggregation inputs are `Finding[]`; a setup failure is not
 *    assignable to the element type, so it cannot silently enter a
 *    KPI denominator.
 *
 * The runtime behaviour of the same boundaries is covered in
 * `finding.test.ts`, `disposition.test.ts` and `setup-failure.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  isFinding,
  isSetupFailure,
  parseDisposition,
  parseFinding,
  parseSetupFailure,
  type Disposition,
  type Finding,
  type FindingId,
  type SetupFailure,
  type SetupFailureId,
} from '../../../src/review/index.js';
import { dispositionInput, findingInput } from './support/fixtures.js';
import { setupInputFor } from './support/setup-fixture.js';

const finding = parseFinding(findingInput());
const failure = parseSetupFailure(setupInputFor());
const disposition = parseDisposition(dispositionInput());

describe('setup failures and findings are separate types', () => {
  it('does not let a SetupFailure be used as a Finding', () => {
    // @ts-expect-error a SetupFailure is not a product finding
    const asFinding: Finding = failure;
    expect(asFinding).toBeDefined();
  });

  it('does not let a Finding be used as a SetupFailure', () => {
    // @ts-expect-error a product finding is not a setup failure
    const asFailure: SetupFailure = finding;
    expect(asFailure).toBeDefined();
  });

  it('keeps the two disjoint in a mixed outcome list', () => {
    const outcomes = [finding, failure] as const;
    expect(outcomes.filter(isFinding)).toEqual([finding]);
    expect(outcomes.filter(isSetupFailure)).toEqual([failure]);
  });

  it('does not let a KPI aggregation over findings accept a setup failure', () => {
    // #64 aggregates over Finding[]. This is the shape of
    // `findingAcceptanceRate(dispositions, findings)`.
    const findingsForKpi: ReadonlyArray<Finding> = [finding];
    // @ts-expect-error a setup failure must not enter a KPI denominator
    const contaminated: ReadonlyArray<Finding> = [finding, failure];
    expect(findingsForKpi).toHaveLength(1);
    expect(contaminated).toHaveLength(2);
  });
});

describe('the two ids are separate brands', () => {
  it('does not let a SetupFailureId be used where a FindingId is expected', () => {
    const failureId: SetupFailureId = failure.id;
    // @ts-expect-error a setup failure id is not a finding id
    const findingId: FindingId = failureId;
    expect(findingId).toBeDefined();
  });

  it('does not let a FindingId be used where a SetupFailureId is expected', () => {
    const findingId: FindingId = finding.id;
    // @ts-expect-error a finding id is not a setup failure id
    const failureId: SetupFailureId = findingId;
    expect(failureId).toBeDefined();
  });

  it('keeps them distinguishable after serialisation, by prefix', () => {
    expect(finding.id.startsWith('fnd-')).toBe(true);
    expect(failure.id.startsWith('sf-')).toBe(true);
    expect(JSON.parse(JSON.stringify(finding)).id).not.toBe(
      JSON.parse(JSON.stringify(failure)).id,
    );
  });
});

describe('confidence and disposition stay apart', () => {
  it('does not let a Finding carry a disposition field', () => {
    const withDisposition: Pick<Finding, 'id'> = {
      id: finding.id,
      // @ts-expect-error a Finding has no customer disposition field
      disposition,
    };
    expect(withDisposition.id).toBe(finding.id);
  });

  it('does not let a Disposition carry model confidence', () => {
    const judged: Pick<Disposition, 'id'> = {
      id: disposition.id,
      // @ts-expect-error a Disposition has no model confidence field
      confidence: finding.confidence,
    };
    expect(judged.id).toBe(disposition.id);
  });

  it('keeps the two questions answerable independently', () => {
    // The producer's confidence is on the finding and says nothing about
    // whether the customer accepted it.
    expect(finding.confidence.level).toBe('medium');
    expect(finding).not.toHaveProperty('disposition');
    expect(disposition.kind).toBe('accepted');
    expect(disposition).not.toHaveProperty('confidence');
  });
});
