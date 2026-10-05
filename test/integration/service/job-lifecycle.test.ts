/**
 * #66 control-plane property: a job cannot re-enter an earlier state.
 *
 * The claim has two halves and this file tests both, because either
 * alone is worthless:
 *
 * 1. **The transition set.** `JOB_TRANSITIONS` gives `succeeded`,
 *    `failed` and `cancelled` *empty* outgoing sets, and
 *    `assertJobTransition` refuses every move out of them. The
 *    exhaustive test below walks all 25 status pairs rather than
 *    sampling the ones that look right.
 * 2. **The write path.** A table nothing consults is documentation. So
 *    the reachability tests go through the real `compareAndSetJob`:
 *    a cancelled job cannot be run, a succeeded job cannot be
 *    re-run, and two concurrent `runJob` calls cannot both execute.
 *
 * The re-entrancy test is the one that matters most. It is not enough
 * for `assertJobTransition` to exist; a service that read the job,
 * decided the transition was legal, and then wrote it unconditionally
 * would pass every transition-table test and still let a job re-enter
 * `running`. So the concurrency assertions watch the *executor call
 * count*, not just the final status.
 */

import { describe, expect, it } from 'vitest';

import {
  assertJobTransition,
  isServiceError,
  isTerminalJobStatus,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  type JobStatus,
} from '../../../src/service/index.js';
import {
  buildService,
  buildStore,
  manualTrigger,
  principal,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor } from './support/doubles.js';

const BASE_URL = 'http://127.0.0.1:65535';
const AT = '2026-10-05T09:00:00.000Z';

const LEGAL: ReadonlyArray<readonly [JobStatus, JobStatus]> = (Object.keys(JOB_TRANSITIONS) as JobStatus[]).flatMap(
  (from) => JOB_TRANSITIONS[from].map((to) => [from, to] as const),
);

function setup(executor = fakeExecutor()) {
  const store = buildStore();
  const service = buildService({ dir: '/tmp/svc-life', store, executor, clock: stillClock(AT) });
  service.registerProduct(principal(), registrationBody(BASE_URL));
  return { service, store, executor };
}

function submit(service: ReturnType<typeof buildService>, jobId: string, deliveryId: string) {
  const r = service.submitTriggerEvaluation(
    principal(),
    manualTrigger(jobId, deliveryId, AT),
  );
  if (!r.accepted) throw new Error(`expected ${jobId} to be accepted, got ${r.reason}`);
  return r.job;
}

describe('#66 job lifecycle', () => {
  it('enforces the transition set exhaustively over all 25 status pairs', () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const legal = LEGAL.some(([f, t]) => f === from && t === to);
        if (legal) {
          expect(() => assertJobTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertJobTransition(from, to)).toThrowError(
            /illegal job transition|is terminal and has no legal successor/,
          );
        }
      }
    }
  });

  it('gives every terminal status an empty outgoing set', () => {
    for (const status of JOB_STATUSES.filter(isTerminalJobStatus)) {
      expect(JOB_TRANSITIONS[status]).toEqual([]);
    }
    // ...which is what makes re-entry impossible rather than unlikely.
    expect(JOB_TRANSITIONS.succeeded).not.toContain('running');
    expect(JOB_TRANSITIONS.failed).not.toContain('queued');
    expect(JOB_TRANSITIONS.cancelled).not.toContain('running');
  });

  it('walks queued -> running -> succeeded and never back', async () => {
    const { service } = setup();
    submit(service, 'jb-lf-1', 'dlv-lf-1');
    expect(service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-1' }).status).toBe('queued');

    const done = await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-1' });
    expect(done.status).toBe('succeeded');
    expect(done.revision).toBe(3);
    expect(done.outcome.kind).toBe('completed');
    expect(done.startedAt).toBeDefined();
    expect(done.endedAt).toBeDefined();
  });

  it('refuses to run a cancelled job, and the refusal does not execute anything', async () => {
    const { service, executor } = setup();
    submit(service, 'jb-lf-2', 'dlv-lf-2');
    const cancelled = service.cancelJob(principal(), {
      tenantId: 'tn-acme',
      jobId: 'jb-lf-2',
      reason: 'operator withdrew the request',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.outcome).toMatchObject({ kind: 'cancelled', reason: 'operator withdrew the request' });

    try {
      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-2' });
      throw new Error('expected the run to be refused');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      // The precise code matters: a `job-not-found` here would tell an
      // operator the job never existed, which is the opposite of what
      // happened.
      expect(error.code).toBe('illegal-job-transition');
      expect(error.message).toContain('terminal and has no legal successor');
    }
    expect(executor.calls).toHaveLength(0);
    expect(service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-2' }).status).toBe('cancelled');
  });

  it('refuses to cancel a finished job', async () => {
    const { service } = setup();
    submit(service, 'jb-lf-3', 'dlv-lf-3');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-3' });

    try {
      service.cancelJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-3', reason: 'too late' });
      throw new Error('expected the cancel to be refused');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('illegal-job-transition');
    }
  });

  it('refuses to re-run a succeeded job, and does not execute it twice', async () => {
    const { service, executor } = setup();
    submit(service, 'jb-lf-4', 'dlv-lf-4');
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-4' });

    try {
      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-4' });
      throw new Error('expected the re-run to be refused');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('illegal-job-transition');
    }
    expect(executor.calls).toHaveLength(1);
  });

  it('two concurrent runJob calls execute the job exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, executor } = setup(fakeExecutor({ gate }));

    submit(service, 'jb-lf-race', 'dlv-lf-race');
    const both = Promise.allSettled([
      service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-race' }),
      service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-race' }),
    ]);
    release();
    const results = await both;

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = (rejected[0] as PromiseRejectedResult).reason;
    if (!isServiceError(failure)) throw failure;
    expect(failure.code).toBe('illegal-job-transition');
    // The load-bearing assertion: one execution, not two.
    expect(executor.calls).toHaveLength(1);
    expect(service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-race' }).status).toBe('succeeded');
  });

  it('a job observed mid-flight is running and cannot be started again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, executor } = setup(fakeExecutor({ gate }));
    submit(service, 'jb-lf-inflight', 'dlv-lf-inflight');

    const inFlight = service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-inflight' });
    // The synchronous prefix of runJob has already taken `queued ->
    // running`, so this read sees the in-flight state.
    const observed = service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-inflight' });
    expect(observed.status).toBe('running');
    expect(observed.outcome).toEqual({ kind: 'notStarted' });

    // `running -> running` is not in the table, so re-arming an
    // in-flight job is refused rather than producing a second run.
    await expect(
      service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-inflight' }),
    ).rejects.toMatchObject({ code: 'illegal-job-transition' });

    release();
    await inFlight;
    expect(executor.calls).toHaveLength(1);
  });

  it('a cancel that lands while a run is in flight wins, and the run is told it lost', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, store } = setup(fakeExecutor({ gate }));
    submit(service, 'jb-lf-cancel-race', 'dlv-lf-cancel-race');

    const inFlight = service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-cancel-race' });
    // `running -> cancelled` is legal, so a cancel is *not* refused here.
    const cancelled = service.cancelJob(principal(), {
      tenantId: 'tn-acme',
      jobId: 'jb-lf-cancel-race',
      reason: 'operator withdrew the request',
    });
    expect(cancelled.status).toBe('cancelled');

    release();
    // The run finished, but its `running -> succeeded` write lost the
    // compare-and-set. The caller is told rather than handed a success
    // the record does not support.
    await expect(inFlight).rejects.toMatchObject({ code: 'stale-job-revision' });
    expect(service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-cancel-race' }).status).toBe('cancelled');
    // The run genuinely executed, so its record is kept — and the
    // report says the job was cancelled *and* shows the real findings,
    // rather than reporting a cancelled job as one that never ran.
    expect(store.listRuns('tn-acme' as never, {})).toHaveLength(1);
    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-cancel-race' });
    expect(report.unexecuted).toHaveLength(0);
    expect(report.findings).toHaveLength(1);
    expect(report.coverage.jobsCancelled).toBe(1);
  });

  it('records an executor fault as a failed job, never as a success with nothing to report', async () => {
    const { service } = setup(
      fakeExecutor({ throws: new Error('reasoner provider refused to construct') }),
    );
    submit(service, 'jb-lf-fail', 'dlv-lf-fail');

    const done = await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-fail' });
    expect(done.status).toBe('failed');
    expect(done.outcome).toMatchObject({
      kind: 'failed',
      reason: 'Error: reasoner provider refused to construct',
    });
  });

  it('a run that produced no findings is still a succeeded job with a run record', async () => {
    const { service } = setup(fakeExecutor({ findings: [] }));
    submit(service, 'jb-lf-empty', 'dlv-lf-empty');
    const done = await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-empty' });

    // "The run happened and found nothing" is a *success*. The way it
    // is distinguished from "the run did not happen" is the run record
    // existing at all, not the finding count.
    expect(done.status).toBe('succeeded');
    const report = service.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-lf-empty' });
    expect(report.findings).toHaveLength(0);
    expect(report.runs).toHaveLength(1);
    expect(report.definitive).toBe(true);
    expect(report.unexecuted).toHaveLength(0);
  });
});
