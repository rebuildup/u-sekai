/**
 * Compile-time and runtime separation of a `SetupFailure` from every
 * product KPI (issue #64).
 *
 * ## Why this is a separate file
 *
 * `test/unit/review/type-separation.test.ts` proves that #61's two
 * record types are separate. This file proves the *consequence* for
 * this layer: that a setup failure cannot reach a product KPI's
 * numerator or denominator. The guarantee a reviewer cannot check by
 * reading `expect` calls lives in the type system, so the
 * `@ts-expect-error` directives below are the assertions, and
 * `tsc --noEmit` is the gate that runs them.
 *
 * Each directive is a failing-build assertion: if a change ever made
 * one of these assignments legal, `tsc` would report "Unused
 * '@ts-expect-error' directive" and `npm run typecheck` would fail.
 *
 * ## The two layers of the guarantee
 *
 * 1. **Compile time.** `KpiInput.findings` is `ReadonlyArray<Finding>`,
 *    and `Finding` is not assignable from `SetupFailure`, so a typed
 *    caller cannot pass one. No runtime filter is involved, so there is
 *    no "someone forgot to call the filter" failure mode.
 * 2. **Runtime.** A run produces `ReviewOutcome[]`, and narrowing that
 *    to `Finding[]` is the caller's job. A caller who narrows wrongly
 *    produces a correctly-typed, wrongly-populated array, which no type
 *    system can catch. `assertFindingSet` re-checks at the boundary —
 *    and refuses, rather than filtering, so nothing disappears
 *    silently. Covered in `kpi.test.ts`; the shape is pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  isFinding,
  isSetupFailure,
  type Finding,
  type ReviewOutcome,
  type SetupFailure,
} from '../../../src/review/index.js';
import {
  acceptedFindingCount,
  computeKpiSnapshot,
  costPerVerifiedFinding,
  dispositionCoverage,
  falsePositiveRate,
  findingAcceptanceRate,
  kpiSnapshotFromOutcomes,
  type KpiInput,
} from '../../../src/feedback/index.js';
import { acceptedFor, findingFor, setupFailureFor } from './support/fixtures.js';

const finding = findingFor(1);
const failure = setupFailureFor(1);
const ledger = { events: [] } as unknown as KpiInput['ledger'];

describe('a setup failure cannot enter a product KPI', () => {
  it('is not assignable to the aggregation input element type', () => {
    const clean: KpiInput = { findings: [finding], ledger };
    // @ts-expect-error a SetupFailure is not a product finding, so it
    // cannot be handed to a KPI as one — this is the primary
    // guarantee, and it needs no runtime filter to hold.
    const contaminated: KpiInput = { findings: [finding, failure], ledger };

    expect(clean.findings).toHaveLength(1);
    expect(contaminated.findings).toHaveLength(2);
  });

  it('is not assignable to the findings a cost KPI measures over', () => {
    // The cost KPIs are the sharpest case: their denominator is every
    // finding, so a setup failure added to it would deflate
    // cost-per-verified-finding without any numerator moving.
    // @ts-expect-error a SetupFailure is not a Finding
    const asFindings: ReadonlyArray<Finding> = [failure];
    // The directive above is the compile-time guarantee; this is the
    // runtime backstop for a caller that got past it anyway.
    expect(() => costPerVerifiedFinding({ findings: asFindings, ledger })).toThrow(
      /never enter a product KPI/,
    );
    expect(asFindings).toHaveLength(1);
  });

  it('is reachable only through the split, which counts what it excluded', () => {
    const outcomes: ReadonlyArray<ReviewOutcome> = [finding, failure];
    // The type-level separation is what forces the split to happen at
    // all; `kpiSnapshotFromOutcomes` is the supported way to do it,
    // and it reports the exclusions rather than swallowing them.
    const snapshot = kpiSnapshotFromOutcomes(outcomes, ledger);
    expect(snapshot.excludedSetupFailures.map((f) => f.id)).toEqual([failure.id]);
    expect(acceptedFindingCount({ findings: [finding], ledger }).value).toBe(0);
  });

  it('stays out of every denominator a mixed stream is measured with', () => {
    const snapshot = kpiSnapshotFromOutcomes([finding, failure], ledger);
    const denominators = [
      findingAcceptanceRate({ findings: [finding], ledger }).denominator,
      falsePositiveRate({ findings: [finding], ledger }).denominator,
      dispositionCoverage({ findings: [finding], ledger }).denominator,
      snapshot.dispositionCoverage.denominator,
      snapshot.findingAcceptanceRate.basis.totalFindings,
    ];
    // One finding in, one in every denominator — the setup failure
    // moved nothing.
    expect(denominators).toEqual([0, 0, 1, 1, 1]);
  });

  it('remains distinguishable from a finding after serialisation', () => {
    // The `sf-` / `fnd-` prefixes survive `JSON.stringify`, so an
    // untyped boundary cannot swap one for the other unnoticed.
    const wire = JSON.parse(JSON.stringify([finding, failure])) as ReadonlyArray<unknown>;
    expect(wire.filter(isFinding)).toHaveLength(1);
    expect(wire.filter(isSetupFailure)).toHaveLength(1);
    expect((wire[1] as SetupFailure).id.startsWith('sf-')).toBe(true);
  });

  it('computes a snapshot that names every excluded failure by id', () => {
    const snapshot = computeKpiSnapshot({ findings: [finding], ledger });
    // Nothing was excluded on this path, and the field says so rather
    // than being absent.
    expect(snapshot.excludedSetupFailures).toEqual([]);

    const excluded = kpiSnapshotFromOutcomes([finding, failure, setupFailureFor(2)], ledger);
    expect(excluded.excludedSetupFailures.map((f) => f.id)).toEqual([
      failure.id,
      setupFailureFor(2).id,
    ]);
  });

  it('is refused outright if a caller forces one past the type system', () => {
    // The runtime backstop for the caller the types cannot reach.
    // `kpi.test.ts` asserts the message; here the guarantee that it
    // throws at all, at the aggregation boundary, is the point.
    const smuggled = [finding, failure] as unknown as ReadonlyArray<Finding>;
    expect(() => computeKpiSnapshot({ findings: smuggled, ledger })).toThrow();
    expect(() =>
      acceptedFindingCount({ findings: smuggled, ledger: undefined as never }),
    ).toThrow();
  });

  it('keeps a setup failure from being a disposition either', () => {
    // A dead browser is not a product outcome, and it is not a
    // customer's answer about one.
    const smuggled = failure as unknown as Parameters<typeof acceptedFor>[0] & object;
    expect(isSetupFailure(smuggled)).toBe(true);
    expect(isFinding(smuggled)).toBe(false);
  });
});
