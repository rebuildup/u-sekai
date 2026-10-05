/**
 * #66 control-plane property: an empty result is not a passing result.
 *
 * This project has been bitten by "did not run" recorded as "nothing to
 * report" three separate times: Issue #78's `test:unit` script resolved
 * a root-relative `include` to `test/integration/test/integration/**`
 * and ran **zero** files while exiting 1; Issue #179 in `ty-plus` had a
 * partition execute zero tests and still report success. A control
 * plane has the same failure mode and worse consequences — a customer
 * reads "no findings" as "my product is fine".
 *
 * So every one of the five states below has a **distinct, named
 * observable**, and the tests assert them apart:
 *
 * | state | observable |
 * | --- | --- |
 * | never scheduled | `ServiceError` `job-not-found` — not an empty list |
 * | queued | `definitive: false`, `unexecuted[0].reason` starts `queued:` |
 * | running | `definitive: false`, `unexecuted[0].reason` starts `running:` |
 * | failed | `definitive: false`, `unexecuted[0].reason` starts `failed:`, `coverage.jobsFailed === 1` |
 * | ran, found nothing | `definitive: true`, `runs.length === 1`, `findings.length === 0` |
 * | ran, found something | `definitive: true`, `findings.length > 0` |
 *
 * Plus the case the last row does not cover: a run where every
 * participant hit a `SetupFailure`. It has zero findings and a
 * non-empty `setupFailures` list, and a `SetupFailure` must never be
 * silently folded into `findings` — #61 makes the types
 * non-assignable and #64's KPIs must never see one in a numerator or a
 * denominator.
 */

import { describe, expect, it } from 'vitest';

import { isServiceError } from '../../../src/service/index.js';
import { isFinding, isSetupFailure } from '../../../src/review/index.js';
import {
  buildService,
  buildStore,
  manualTrigger,
  principal,
  PROGRAM_ID,
  PRODUCT_ID,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor, makeFinding, makeSetupFailure } from './support/doubles.js';

const BASE_URL = 'http://127.0.0.1:65535';
const AT = '2026-10-05T09:00:00.000Z';

function setup(executor = fakeExecutor()) {
  const store = buildStore();
  const service = buildService({ dir: '/tmp/svc-vis', store, executor, clock: stillClock(AT) });
  service.registerProduct(principal(), registrationBody(BASE_URL));
  return { service, store, executor };
}

function submit(service: ReturnType<typeof buildService>, jobId: string) {
  const r = service.submitTriggerEvaluation(principal(), manualTrigger(jobId, `dlv-${jobId}`, AT));
  if (!r.accepted) throw new Error(`expected ${jobId} to be accepted, got ${r.reason}`);
  return r.job;
}

describe('#66 failure visibility: an empty result is not a passing result', () => {
  it('a job that was never scheduled is job-not-found, not an empty findings list', () => {
    const { service } = setup();
    try {
      service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-never-existed' });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      // The distinction, asserted at the exact call a dashboard makes.
      expect(error.code).toBe('job-not-found');
      expect(error.message).toContain('has never been scheduled');
    }
  });

  it('a queued job reports "not knowable yet", not "no findings"', () => {
    const { service } = setup();
    submit(service, 'jb-vis-queued');

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-queued' });
    expect(report.findings).toHaveLength(0);
    expect(report.definitive).toBe(false);
    expect(report.unexecuted).toHaveLength(1);
    expect(report.unexecuted[0]?.status).toBe('queued');
    expect(report.unexecuted[0]?.reason).toContain('not knowable yet');
    expect(report.coverage).toMatchObject({ jobsConsidered: 1, runsExecuted: 0, jobsPending: 1 });
  });

  it('a running job reports "not knowable yet", and says so differently from queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = setup(fakeExecutor({ gate }));
    submit(service, 'jb-vis-running');

    const inFlight = service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-running' });
    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-running' });

    expect(report.definitive).toBe(false);
    expect(report.unexecuted[0]?.status).toBe('running');
    expect(report.unexecuted[0]?.reason).toContain('in flight');
    release();
    await inFlight;
  });

  it('a failed job is reported as failed, with its reason, and never as an empty result', async () => {
    const { service } = setup(
      fakeExecutor({ throws: new Error('browser session could not be established') }),
    );
    submit(service, 'jb-vis-failed');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-failed' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-failed' });
    expect(report.findings).toHaveLength(0);
    // A failed job is emphatically not a pass.
    expect(report.definitive).toBe(false);
    expect(report.unexecuted).toHaveLength(1);
    expect(report.unexecuted[0]?.status).toBe('failed');
    expect(report.unexecuted[0]?.reason).toContain('browser session could not be established');
    expect(report.coverage).toMatchObject({ runsExecuted: 0, jobsFailed: 1 });
  });

  it('a cancelled job is reported as cancelled, separately from failed', () => {
    const { service } = setup();
    submit(service, 'jb-vis-cancelled');
    service.cancelJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-cancelled', reason: 'withdrawn' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-cancelled' });
    expect(report.definitive).toBe(false);
    expect(report.unexecuted[0]?.status).toBe('cancelled');
    expect(report.unexecuted[0]?.reason).toContain('withdrawn');
    expect(report.coverage).toMatchObject({ jobsCancelled: 1, jobsFailed: 0 });
  });

  it('a run that happened and found nothing is a *definitive* zero', async () => {
    const { service } = setup(fakeExecutor({ findings: [] }));
    submit(service, 'jb-vis-clean');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-clean' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-clean' });
    // This is the only state in which an empty `findings` array is a
    // good answer, and it is distinguishable precisely because a run
    // record exists and `definitive` is true.
    expect(report.findings).toHaveLength(0);
    expect(report.runs).toHaveLength(1);
    expect(report.definitive).toBe(true);
    expect(report.unexecuted).toHaveLength(0);
  });

  it('a scope with no jobs at all is not a definitive zero', () => {
    const { service } = setup();
    // `every` over an empty array is `true`, so a program that has never
    // been evaluated would otherwise report "definitively, nothing to
    // find". That is the exact confusion this ticket exists to stop.
    const report = service.getFindings(principal(), {
      tenantId: 'tn-acme',
      productId: PRODUCT_ID,
      programId: PROGRAM_ID,
    });
    expect(report.jobs).toHaveLength(0);
    expect(report.findings).toHaveLength(0);
    expect(report.definitive).toBe(false);
    expect(report.coverage.jobsConsidered).toBe(0);
  });

  it('a program-scoped report counts a failed job and a clean run side by side', async () => {
    // One service, one store, one program: the first job runs clean and
    // the second raises. Scoped by program, both land in one report, and
    // a reader must be able to tell which is which.
    const { service } = setup(
      fakeExecutor({
        findings: [],
        throwsFor: (jobId) =>
          jobId === 'jb-vis-mix-2' ? new Error('provider 503') : undefined,
      }),
    );
    submit(service, 'jb-vis-mix-1');
    submit(service, 'jb-vis-mix-2');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-mix-1' });
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-mix-2' });

    const report = service.getFindings(principal(), {
      tenantId: 'tn-acme',
      productId: PRODUCT_ID,
      programId: PROGRAM_ID,
    });
    expect(report.jobs).toHaveLength(2);
    expect(report.runs).toHaveLength(1);
    // One run is not enough to make the window definitive: the other
    // job failed, so a KPI computed over this report would be a rate
    // over a partial denominator.
    expect(report.definitive).toBe(false);
    expect(report.coverage).toMatchObject({
      jobsConsidered: 2,
      runsExecuted: 1,
      jobsFailed: 1,
      jobsCancelled: 0,
      jobsPending: 0,
    });
    expect(report.unexecuted.map((u) => u.jobId)).toEqual(['jb-vis-mix-2']);
    expect(report.unexecuted[0]?.reason).toContain('provider 503');
  });

  it('a setup failure is never merged into findings', async () => {
    const failure = makeSetupFailure('jb-vis-sf', 'the staging environment refused the connection');
    const { service } = setup(fakeExecutor({ findings: [], setupFailures: [failure] }));
    submit(service, 'jb-vis-sf');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-sf' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-sf' });
    expect(report.findings).toHaveLength(0);
    expect(report.setupFailures).toHaveLength(1);
    expect(report.setupFailures[0]?.message).toContain('refused the connection');
    // The type-level separation #61 guarantees, asserted at runtime.
    expect(report.findings.every((f) => isFinding(f))).toBe(true);
    expect(report.setupFailures.every((f) => isSetupFailure(f))).toBe(true);
    expect(report.setupFailures.some((f) => isFinding(f))).toBe(false);
    // The run *did* happen, and the report says so.
    expect(report.runs).toHaveLength(1);
    expect(report.definitive).toBe(true);
  });

  it('a setup failure is not reportable as a dispositionable finding', async () => {
    const failure = makeSetupFailure('jb-vis-sf2', 'world state could not be obtained');
    const { service } = setup(fakeExecutor({ findings: [makeFinding('jb-vis-sf2')], setupFailures: [failure] }));
    submit(service, 'jb-vis-sf2');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-sf2' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-sf2' });
    const findingIds = new Set(report.findings.map((f) => f.id));
    const failureIds = new Set(report.setupFailures.map((f) => f.id));
    // Distinct id brands: `sf-` and `fnd-`. A disposition may only name
    // a `FindingId`, so a setup failure can never be dispositioned by
    // passing a disposition's findingId at it.
    for (const id of findingIds) expect(id.startsWith('fnd-')).toBe(true);
    for (const id of failureIds) expect(id.startsWith('sf-')).toBe(true);
    expect([...failureIds].some((id) => findingIds.has(id as never))).toBe(false);
  });

  it('a job whose setup was refused still yields a run record and a visible refusal', async () => {
    const { service } = setup(
      fakeExecutor({ findings: [], setupFailures: [makeSetupFailure('jb-vis-refused', 'provisioning denied')], setupRefused: true }),
    );
    submit(service, 'jb-vis-refused');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-refused' });

    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-vis-refused' });
    expect(report.runs[0]?.setupRefused).toBe(true);
    expect(report.runs[0]?.privilegedEffects).toMatchObject({ declared: true, refused: true });
    expect(report.setupFailures).toHaveLength(1);
  });
});
