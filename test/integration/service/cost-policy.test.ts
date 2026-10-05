/**
 * The open product decision #64 routed here: the declared cost unit and
 * the reportable precision of a cost-per-finding.
 *
 * ## What was searched, and what was found
 *
 * `docs/product/kpis.md` (branch `55`, unmerged) defines "cost per
 * verified finding" and "cost per accepted finding" as
 * `direct evaluation cost / findings` and names the cost *sources* —
 * model, browser/execution, storage, provider — without naming a unit.
 * `docs/product/configuration-and-authority.md` puts customer billing
 * for the u-sekai service outside the Synthetic Participant model, and
 * `docs/product/implementation-plan-0.4.0.md` defers it explicitly
 * "after the vertical slice". ADR-0011 additionally requires provider
 * neutrality, which excludes a unit denominated in one vendor's tokens
 * or cents. There is no unit to read out of the repository.
 *
 * #64 recorded the gap in `UNCOMPUTED_KPI_TERMS` rather than picking
 * one, and named the service configuration (#66) as where the declared
 * unit belongs. This file is the answer to that routing.
 *
 * ## What this ticket therefore does, and does not, decide
 *
 * It does **not** choose a precision. Picking "six decimal places"
 * because #64's ratio constant happens to be six would produce a number
 * that looks specified and is unbacked.
 *
 * It makes the answer a **required input with no default**, carries the
 * declared unit onto every figure it publishes, and publishes **no**
 * cost-per-finding figure at all. The tests below pin each of those,
 * so the day the product decides, the change is one wiring edit plus
 * #64's rounding rule — and until then nothing asserts a scale nobody
 * chose.
 */

import { describe, expect, it } from 'vitest';

import {
  declaredCost,
  isServiceError,
  MAX_REPORTABLE_DECIMALS,
  parseServiceCostPolicy,
  type ServiceErrorCode,
} from '../../../src/service/index.js';
import {
  buildService,
  buildStore,
  DECLARED_COST,
  manualTrigger,
  principal,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor } from './support/doubles.js';

const BASE_URL = 'http://127.0.0.1:65535';
const AT = '2026-10-05T09:00:00.000Z';

function code(fn: () => unknown): ServiceErrorCode {
  try {
    fn();
  } catch (error) {
    if (isServiceError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a ServiceError, nothing was thrown');
}

describe('#66 declared cost unit and the open precision decision', () => {
  it('refuses to start a service with no declared unit, and applies no default', () => {
    expect(code(() => buildService({ dir: '/tmp/svc-cost-1', cost: undefined }))).toBe(
      'missing-cost-policy',
    );
    expect(code(() => buildService({ dir: '/tmp/svc-cost-1', cost: null }))).toBe('missing-cost-policy');
    expect(code(() => buildService({ dir: '/tmp/svc-cost-1', cost: {} }))).toBe('invalid-request');
    expect(code(() => buildService({ dir: '/tmp/svc-cost-1', cost: { unit: 'usd' } }))).toBe(
      'invalid-request',
    );
    expect(code(() => buildService({ dir: '/tmp/svc-cost-1', cost: { reportableDecimals: 2 } }))).toBe(
      'invalid-request',
    );
  });

  it('rejects a precision that is not a usable integer', () => {
    for (const decimals of [-1, 1.5, Number.NaN, MAX_REPORTABLE_DECIMALS + 1]) {
      expect(
        code(() => parseServiceCostPolicy({ unit: 'svc.microcredits', reportableDecimals: decimals })),
      ).toBe('invalid-request');
    }
    expect(MAX_REPORTABLE_DECIMALS).toBe(12);
  });

  it('rejects an unmodelled key, so a policy cannot smuggle in a currency by the side door', () => {
    expect(code(() => parseServiceCostPolicy({ unit: 'x', reportableDecimals: 2, currency: 'JPY' }))).toBe(
      'unknown-field',
    );
  });

  it('labels every cost figure with the declared unit and precision', () => {
    const policy = parseServiceCostPolicy({ unit: 'svc.microcredits', reportableDecimals: 4 });
    expect(declaredCost(120, policy)).toEqual({
      amount: 120,
      unit: 'svc.microcredits',
      reportableDecimals: 4,
    });
    // A negative or fractional amount in the declared unit is a
    // different unit, not a small cost.
    expect(code(() => declaredCost(-1, policy))).toBe('invalid-request');
    expect(code(() => declaredCost(1.5, policy))).toBe('invalid-request');
  });

  it('publishes no cost-per-finding figure, and says which policy would decide it', () => {
    const store = buildStore();
    const service = buildService({
      dir: '/tmp/svc-cost-2',
      store,
      executor: fakeExecutor(),
      clock: stillClock(AT),
    });
    service.registerProduct(principal(), registrationBody(BASE_URL));
    const accepted = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-cost-1', 'dlv-cost-1', AT),
    );
    if (!accepted.accepted) throw new Error(`expected acceptance, got ${accepted.reason}`);

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-cost-1' });

    // The open question, visible to a consumer rather than guessed at.
    expect(report.costPerFinding).toBeUndefined();
    expect(report.costPolicy).toEqual(DECLARED_COST);
    expect(report.costPolicy.unit).toBe('svc.microcredits');
    expect(report.costPolicy.reportableDecimals).toBe(4);
  });

  it('names the open question in the source, so a reader is not left to infer it', async () => {
    // #64's `UNCOMPUTED_KPI_TERMS` is deliberately *not* imported: it
    // lives on branch `64`, which is a sibling of this ticket's base
    // (`63`) and is not reachable from here. So the check is that this
    // package states the question in terms a reviewer can check against
    // `docs/product/kpis.md` — not that it agrees with a constant that
    // does not exist on this base.
    const { promises: fs } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = (await import('node:path')).default;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.resolve(here, '../../../src/service/cost.ts'), 'utf8');
    expect(source).toContain('In what declared unit is *direct evaluation cost* denominated');
    expect(source).toContain('no default');
  });
});
