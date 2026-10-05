/**
 * #66 acceptance: findings can be retrieved **and dispositioned**, and
 * the disposition goes through the #64 feedback abstraction.
 *
 * ## The seam, and why these tests do not import #64
 *
 * Branches `63` and `64` are siblings: `git merge-base 63 origin/64` is
 * `c36dc4c` and `git diff --stat 63 origin/64` shows #64 *removing* all
 * of #63's runtime. `src/feedback/**` is therefore not on this ticket's
 * base, and the control plane declares a {@link FeedbackSink} port
 * instead. The production wiring is a one-function adapter over #64's
 * `appendDisposition` / `currentDisposition` / `dispositionHistory`,
 * and it belongs at the composition root (`src/index.ts`, #65's
 * ticket). These tests use `support/doubles.ts`'s deliberately
 * **lax** sink so that what is being asserted is the *service's* own
 * enforcement rather than the double's.
 *
 * ## What is asserted
 *
 * - a legal first disposition (`unreviewed -> decided`) is accepted and
 *   reaches the sink;
 * - an **illegal** transition is refused by the service, with a lax
 *   sink installed, so the guarantee does not depend on the ledger;
 * - a replayed `requestId` is one disposition, not two;
 * - the same `requestId` with a different disposition id is an
 *   `idempotency-conflict`, not a silent overwrite;
 * - a disposition against a finding nothing observed is
 *   `finding-not-found`;
 * - a service with no sink configured refuses loudly rather than
 *   reporting a disposition as accepted and dropping it.
 */

import { describe, expect, it } from 'vitest';

import { isServiceError } from '../../../src/service/index.js';
import { parseFindingId } from '../../../src/review/index.js';
import {
  buildService,
  buildStore,
  manualTrigger,
  principal,
  PRODUCT_ID,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor, feedbackSink, makeFinding } from './support/doubles.js';

const BASE_URL = 'http://127.0.0.1:65535';
const AT = '2026-10-05T09:00:00.000Z';
const FINDING_ID = 'fnd-0000abcd';

async function withFinding(): Promise<{
  service: ReturnType<typeof buildService>;
  sink: ReturnType<typeof feedbackSink>;
}> {
  const finding = makeFinding('jb-disp');
  const sink = feedbackSink();
  const service = buildService({
    dir: '/tmp/svc-disp',
    store: buildStore(),
    executor: fakeExecutor({ findings: [finding] }),
    feedback: sink,
    clock: stillClock(AT),
  });
  service.registerProduct(principal(), registrationBody(BASE_URL));
  const accepted = service.submitTriggerEvaluation(
    principal(),
    manualTrigger('jb-disp', 'dlv-disp', AT),
  );
  if (!accepted.accepted) throw new Error(`expected the trigger to be accepted, got ${accepted.reason}`);
  await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-disp' });
  return { service, sink };
}

function disposition(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tn-acme',
    requestId: 'req-1',
    productId: PRODUCT_ID,
    findingId: FINDING_ID,
    dispositionId: 'dsp-0001',
    kind: 'accepted',
    state: 'decided',
    actor: { kind: 'customer', reference: 'acme-support' },
    decidedAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isServiceError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a ServiceError, nothing was thrown');
}

describe('#66 disposition submission through the feedback abstraction', () => {
  it('accepts a first decision and hands it to the sink', async () => {
    const { service, sink } = await withFinding();

    const result = await service.submitDisposition(principal(), disposition());

    expect(result.recorded).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.previousState).toBe('unreviewed');
    expect(result.disposition.kind).toBe('accepted');
    expect(result.disposition.findingId).toBe(FINDING_ID);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.disposition.id).toBe('dsp-0001');
  });

  it('refuses an illegal transition even with a lax sink installed', async () => {
    const { service, sink } = await withFinding();

    // Record a decision first, so the finding is in `decided`.
    await service.submitDisposition(principal(), disposition());

    // `decided -> needsHumanResearch` is legal, so pick a genuinely
    // illegal move: a correction recorded with an *open* kind cannot be
    // asserted as a decision. #61's `parseDisposition` refuses the
    // pair before the transition table is even consulted, and the
    // service reports it as an invalid request rather than silently
    // accepting it.
    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({
          requestId: 'req-2',
          dispositionId: 'dsp-0002',
          kind: 'unresolved',
          state: 'decided',
        }),
      ),
    );
    expect(code).toBe('invalid-request');
    expect(sink.appends).toHaveLength(1);
  });

  it('refuses a transition the sink would happily have taken', async () => {
    const { service, sink } = await withFinding();

    // `unreviewed -> closed` is the move that means "there is no such
    // thing as closing a finding nobody looked at". The lax sink does
    // not check it; the service does.
    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({ kind: 'wontFix', state: 'closed', rationale: 'not planned' }),
      ),
    );
    expect(code).toBe('illegal-disposition-transition');
    expect(sink.appends).toHaveLength(0);
  });

  it('allows the legal correction path and records the supersedes link', async () => {
    const { service, sink } = await withFinding();
    await service.submitDisposition(principal(), disposition());

    const correction = await service.submitDisposition(
      principal(),
      disposition({
        requestId: 'req-correct',
        dispositionId: 'dsp-0002',
        kind: 'invalid',
        state: 'decided',
        rationale: 'Reproduced against a seeded fixture, not the product.',
        supersedes: 'dsp-0001',
      }),
    );

    expect(correction.recorded).toBe(true);
    expect(correction.previousState).toBe('decided');
    expect(correction.disposition.supersedes).toBe('dsp-0001');
    // The older disposition is still in history: a correction appends,
    // it does not overwrite.
    expect(sink.historyFor(parseFindingId(FINDING_ID))).toHaveLength(2);
  });

  it('a replayed requestId records one disposition, not two', async () => {
    const { service, sink } = await withFinding();

    const first = await service.submitDisposition(principal(), disposition());
    const replay = await service.submitDisposition(principal(), disposition());

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.disposition.id).toBe('dsp-0001');
    expect(sink.appends).toHaveLength(1);
    expect(sink.historyFor(parseFindingId(FINDING_ID))).toHaveLength(1);
  });

  it('the same requestId with a different disposition is an idempotency conflict', async () => {
    const { service, sink } = await withFinding();
    await service.submitDisposition(principal(), disposition());

    const code = await codeOf(() =>
      service.submitDisposition(principal(), disposition({ dispositionId: 'dsp-9999' })),
    );
    expect(code).toBe('idempotency-conflict');
    expect(sink.appends).toHaveLength(1);
  });

  it('refuses a disposition against a finding nothing observed', async () => {
    const { service, sink } = await withFinding();

    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({ findingId: 'fnd-0000ffff', dispositionId: 'dsp-0003' }),
      ),
    );
    // The reference must resolve. A disposition about a finding that
    // does not exist is not a judgement, and #64's false-positive rate
    // is computed over what this records.
    expect(code).toBe('finding-not-found');
    expect(sink.appends).toHaveLength(0);
  });

  it('refuses a disposition naming another product', async () => {
    const { service, sink } = await withFinding();
    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({ productId: 'prd-someone-else', dispositionId: 'dsp-0004' }),
      ),
    );
    expect(code).toBe('invalid-request');
    expect(sink.appends).toHaveLength(0);
  });

  it('refuses loudly when no feedback ledger is configured', async () => {
    await withFinding();
    const bare = buildService({
      dir: '/tmp/svc-disp-bare',
      store: buildStore(),
      executor: fakeExecutor({ findings: [makeFinding('jb-disp-bare')] }),
      clock: stillClock(AT),
    });
    bare.registerProduct(principal(), registrationBody(BASE_URL));
    const accepted = bare.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-disp-bare', 'dlv-disp-bare', AT),
    );
    if (!accepted.accepted) throw new Error('expected the trigger to be accepted');
    await bare.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-disp-bare' });

    // A control plane with no ledger must say so rather than report the
    // disposition as accepted and drop it.
    await expect(
      bare.submitDisposition(principal(), disposition({ findingId: 'fnd-0000abcd' })),
    ).rejects.toThrow(/no FeedbackSink is configured/);
    // ...and nothing is recorded as accepted.
    const report = bare.getFindings(principal(), { tenantId: 'tn-acme', jobId: 'jb-disp-bare' });
    expect(report.findings).toHaveLength(1);
  });

  it('requires a rationale for the disposition kinds that discard a finding', async () => {
    const { service, sink } = await withFinding();
    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({ kind: 'invalid', state: 'decided', rationale: undefined }),
      ),
    );
    // #61's rule, reached through the service: `invalid` without a
    // reason is refused, or the cheapest disposition becomes the
    // default one.
    expect(code).toBe('invalid-request');
    expect(sink.appends).toHaveLength(0);
  });

  it('refuses an automation actor recording a decision', async () => {
    const { service, sink } = await withFinding();
    const code = await codeOf(() =>
      service.submitDisposition(
        principal(),
        disposition({ actor: { kind: 'automation', reference: 'triage-bot' } }),
      ),
    );
    // Acceptance and false-positive rates are counted over customer
    // dispositions, so a classifier must not be able to decide.
    expect(code).toBe('invalid-request');
    expect(sink.appends).toHaveLength(0);
  });

  it('lets automation escalate to human research', async () => {
    const { service, sink } = await withFinding();
    const result = await service.submitDisposition(
      principal(),
      disposition({
        dispositionId: 'dsp-escalate',
        kind: 'needsHumanResearch',
        state: 'needsHumanResearch',
        actor: { kind: 'automation', reference: 'triage-bot' },
      }),
    );
    expect(result.recorded).toBe(true);
    expect(sink.appends).toHaveLength(1);
  });
});
