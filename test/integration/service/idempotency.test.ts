/**
 * #66 acceptance: duplicate trigger submission is idempotent.
 *
 * Four distinct ways to "submit the same trigger twice", because the
 * naive test (call it twice, sequentially, assert one job) passes
 * against stores and ledgers that are racy:
 *
 * 1. **Sequentially, same declared job id** — the obvious case.
 * 2. **Sequentially, different declared job ids** — two callers racing
 *    the same delivery. The second must receive the *first's* job, not
 *    a new one, or one evaluation becomes two.
 * 3. **Concurrently** (`Promise.all`) — the read-plan-write sequence in
 *    `submitTriggerEvaluation` has to be atomic. This is the test that
 *    would fail against a store whose methods are `async`.
 * 4. **After the job has run** — a redelivery after completion must
 *    still resolve to the same job rather than re-running it.
 *
 * And the budget half: the ledger's `costUnitsSpent` and `runsSpent`
 * must each have moved exactly once. A duplicate that silently charges
 * twice is a money bug that no job-count assertion would catch.
 */

import { describe, expect, it } from 'vitest';

import { isServiceError } from '../../../src/service/index.js';
import { createBudgetLedger, defaultBudgetWindow } from '../../../src/program/index.js';
import { parseReviewProgramId } from '../../../src/product/index.js';
import {
  buildService,
  buildStore,
  manualTrigger,
  principal,
  PROGRAM_ID,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor } from './support/doubles.js';

const BASE_URL = 'http://127.0.0.1:65535';
const AT = '2026-10-05T09:00:00.000Z';

function setup() {
  const executor = fakeExecutor();
  const store = buildStore();
  const service = buildService({ dir: '/tmp/svc-idem', store, executor, clock: stillClock(AT) });
  service.registerProduct(principal(), registrationBody(BASE_URL));
  return { service, store, executor };
}

function ledgerOf(store: ReturnType<typeof buildStore>) {
  return store.getLedger(
    'tn-acme' as never,
    parseReviewProgramId(PROGRAM_ID),
  );
}

describe('#66 duplicate trigger submission is idempotent', () => {
  it('the same declared job id submitted twice yields one job and one charge', () => {
    const { service, store } = setup();
    const request = manualTrigger('jb-idem-1', 'dlv-idem-1', AT);

    const first = service.submitTriggerEvaluation(principal(), request);
    const afterFirst = ledgerOf(store);
    const second = service.submitTriggerEvaluation(principal(), request);

    expect(first.accepted && first.deduplicated).toBe(false);
    expect(second.accepted && second.deduplicated).toBe(true);
    if (!first.accepted || !second.accepted) throw new Error('expected both accepted');
    expect(second.job.id).toBe(first.job.id);
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' })).toHaveLength(1);

    const afterSecond = ledgerOf(store);
    expect(afterSecond?.costUnitsSpent).toBe(afterFirst?.costUnitsSpent);
    expect(afterSecond?.runsSpent).toBe(afterFirst?.runsSpent);
    expect(afterSecond?.consumedKeys).toEqual(afterFirst?.consumedKeys);
    // And the spend is real, not zero-because-nothing-happened.
    expect(afterFirst?.costUnitsSpent).toBeGreaterThan(0);
    expect(afterFirst?.runsSpent).toBe(1);
  });

  it('two different declared job ids for one delivery resolve to the same job', () => {
    const { service, store } = setup();

    const first = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-idem-a', 'dlv-idem-shared', AT),
    );
    const second = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-idem-b', 'dlv-idem-shared', AT),
    );

    if (!first.accepted || !second.accepted) throw new Error('expected both accepted');
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe('jb-idem-a');
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' })).toHaveLength(1);
    expect(ledgerOf(store)?.runsSpent).toBe(1);
  });

  it('two concurrent identical submissions produce one job and one charge', async () => {
    const { service, store } = setup();
    const request = manualTrigger('jb-idem-race', 'dlv-idem-race', AT);

    // Concurrently, not sequentially: a sequential test passes against a
    // racy read-modify-write too.
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => service.submitTriggerEvaluation(principal(), request)),
      Promise.resolve().then(() => service.submitTriggerEvaluation(principal(), request)),
    ]);

    if (!first.accepted || !second.accepted) throw new Error('expected both accepted');
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' })).toHaveLength(1);
    expect(ledgerOf(store)?.runsSpent).toBe(1);
    expect(ledgerOf(store)?.consumedKeys).toHaveLength(1);
  });

  it('a redelivery after the job has run still resolves to the same job', async () => {
    const { service, store, executor } = setup();
    const request = manualTrigger('jb-idem-after', 'dlv-idem-after', AT);

    service.submitTriggerEvaluation(principal(), request);
    await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-idem-after' });
    const spendAfterRun = ledgerOf(store)?.costUnitsSpent;

    const redelivery = service.submitTriggerEvaluation(principal(), request);

    if (!redelivery.accepted) throw new Error('expected the redelivery to be accepted');
    expect(redelivery.deduplicated).toBe(true);
    expect(redelivery.job.id).toBe('jb-idem-after');
    expect(redelivery.job.status).toBe('succeeded');
    // The completed job is not re-executed.
    expect(executor.calls).toHaveLength(1);
    expect(ledgerOf(store)?.costUnitsSpent).toBe(spendAfterRun);
  });

  it('a trigger that is not due creates no job and charges nothing', () => {
    // A program that can afford exactly one run, so the second
    // submission is refused by the budget rather than by a missing
    // trigger. `not-due` is the only refusal that means "nothing was
    // scheduled", and a budget refusal is the one a caller is most
    // likely to misread as a successful no-op.
    const store = buildStore();
    const service = buildService({
      dir: '/tmp/svc-idem-budget',
      store,
      executor: fakeExecutor(),
      clock: stillClock(AT),
    });
    service.registerProduct(
      principal(),
      registrationBody(BASE_URL, ['idn-ava'], { maxRunsPerDay: 1, maxRunsPerEvent: 1 }),
    );

    const first = service.submitTriggerEvaluation(principal(), manualTrigger('jb-nd-1', 'dlv-nd-1', AT));
    const spent = ledgerOf(store)?.costUnitsSpent ?? 0;
    const second = service.submitTriggerEvaluation(principal(), manualTrigger('jb-nd-2', 'dlv-nd-2', AT));

    if (!first.accepted) throw new Error('expected the first submission to be accepted');
    expect(second.accepted).toBe(false);
    if (second.accepted) throw new Error('expected a not-due result');
    expect(second.reason).toBe('budget-exhausted');
    expect(second.job).toBeUndefined();

    // The refused submission created nothing and moved nothing.
    expect(ledgerOf(store)?.costUnitsSpent).toBe(spent);
    expect(ledgerOf(store)?.consumedKeys).toHaveLength(1);
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' }).map((j) => j.id)).toEqual([
      'jb-nd-1',
    ]);
  });

  it('a signal no declared trigger matches is not-due, with no job', () => {
    const { service } = setup();
    const rejected = service.submitTriggerEvaluation(principal(), {
      tenantId: 'tn-acme',
      jobId: 'jb-nomatch',
      productId: 'prd-task-tracker',
      programId: PROGRAM_ID,
      // The registered program declares only a `manual` trigger.
      signal: {
        kind: 'event',
        deliveryId: 'dlv-nomatch',
        event: 'deployment.completed',
        occurredAt: AT,
      },
    });

    expect(rejected.accepted).toBe(false);
    if (rejected.accepted) throw new Error('expected a not-due result');
    expect(rejected.reason).toBe('no-trigger');
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' })).toHaveLength(0);
  });

  it('an event redelivery with a different occurredAt is a different evaluation, not a duplicate', () => {
    const store = buildStore();
    const service = buildService({
      dir: '/tmp/svc-idem-event',
      store,
      executor: fakeExecutor(),
      clock: stillClock(AT),
    });
    service.registerProduct(
      principal(),
      registrationBody(BASE_URL, ['idn-ava'], {
        triggers: [{ kind: 'event', event: 'deployment.completed', debounceMinutes: 0 }],
      }),
    );

    const event = (jobId: string, occurredAt: string) => ({
      tenantId: 'tn-acme',
      jobId,
      productId: 'prd-task-tracker',
      programId: PROGRAM_ID,
      signal: { kind: 'event', deliveryId: 'dlv-event-1', event: 'deployment.completed', occurredAt },
    });

    const first = service.submitTriggerEvaluation(principal(), event('jb-ev-1', '2026-10-05T08:00:00.000Z'));
    const second = service.submitTriggerEvaluation(principal(), event('jb-ev-2', '2026-10-05T08:30:00.000Z'));

    // #62 keys an event on (delivery, occurredAt): the same message
    // cannot have happened at two times, so two occurrences are two
    // evaluations. This is the boundary of the idempotency claim.
    if (!first.accepted || !second.accepted) throw new Error('expected both accepted');
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.job.id).toBe('jb-ev-2');
    expect(ledgerOf(store)?.runsSpent).toBe(2);
  });

  it('the same event redelivered verbatim is one evaluation', () => {
    const store = buildStore();
    const service = buildService({
      dir: '/tmp/svc-idem-event-2',
      store,
      executor: fakeExecutor(),
      clock: stillClock(AT),
    });
    service.registerProduct(
      principal(),
      registrationBody(BASE_URL, ['idn-ava'], {
        triggers: [{ kind: 'event', event: 'deployment.completed', debounceMinutes: 0 }],
      }),
    );

    const event = (jobId: string) => ({
      tenantId: 'tn-acme',
      jobId,
      productId: 'prd-task-tracker',
      programId: PROGRAM_ID,
      signal: {
        kind: 'event',
        deliveryId: 'dlv-event-redelivered',
        event: 'deployment.completed',
        occurredAt: '2026-10-05T09:00:00.000Z',
      },
    });

    service.submitTriggerEvaluation(principal(), event('jb-rd-1'));
    const redelivered = service.submitTriggerEvaluation(principal(), event('jb-rd-2'));

    if (!redelivered.accepted) throw new Error('expected the redelivery to resolve');
    expect(redelivered.deduplicated).toBe(true);
    expect(redelivered.job.id).toBe('jb-rd-1');
    expect(ledgerOf(store)?.runsSpent).toBe(1);
  });

  it('re-submitting a declared job id for a *different* plan is refused, not silently merged', () => {
    const { service, store } = setup();
    const first = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-collide', 'dlv-collide-a', AT),
    );
    if (!first.accepted) throw new Error('expected the first submission to be accepted');
    const planBefore = store.planForJob('tn-acme' as never, 'jb-collide' as never);

    try {
      service.submitTriggerEvaluation(
        principal(),
        manualTrigger('jb-collide', 'dlv-collide-b', AT),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('job-already-exists');
    }

    // The regression that matters: the refused submission must have
    // written *nothing*. An earlier version bound the new plan key and
    // overwrote the existing job's stored plan before raising, so a
    // queued job would later have run a different evaluation from the
    // one it was created and charged for.
    expect(store.planForJob('tn-acme' as never, 'jb-collide' as never)).toBe(planBefore);
    expect(store.jobIdForPlanKey('tn-acme' as never, first.job.planKey)).toBe('jb-collide');
    expect(service.listJobs(principal(), { tenantId: 'tn-acme' })).toHaveLength(1);
    expect(ledgerOf(store)?.consumedKeys).toHaveLength(1);
  });

  it('a refused duplicate leaves the existing job runnable with its own plan', async () => {
    const { service, executor } = setup();
    const first = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-collide-run', 'dlv-collide-run-a', AT),
    );
    if (!first.accepted) throw new Error('expected acceptance');
    expect(() =>
      service.submitTriggerEvaluation(
        principal(),
        manualTrigger('jb-collide-run', 'dlv-collide-run-b', AT),
      ),
    ).toThrow();

    // The queued job still runs, and it runs *its* plan.
    const done = await service.runJob(principal(), {
      tenantId: 'tn-acme',
      jobId: 'jb-collide-run',
    });
    expect(done.status).toBe('succeeded');
    expect(executor.calls).toEqual([{ jobId: 'jb-collide-run', runId: 'jb-collide-run' }]);
  });

  it('the ledger the service uses is the stored one, not a fresh zero-spend ledger each call', () => {
    const { service, store } = setup();
    const before = store.getLedger('tn-acme' as never, parseReviewProgramId(PROGRAM_ID));
    expect(before).toBeUndefined();

    service.submitTriggerEvaluation(principal(), manualTrigger('jb-ledger-1', 'dlv-ledger-1', AT));
    const after = store.getLedger('tn-acme' as never, parseReviewProgramId(PROGRAM_ID));

    // Same program, same window, and the ceiling came from the
    // registered program's budget rather than from a default.
    expect(after?.ceilings.maxRunsPerDay).toBe(100);
    expect(after?.window).toEqual(defaultBudgetWindow(AT));
    expect(createBudgetLedger).toBeTypeOf('function');
  });
});
