/**
 * Test doubles for the service integration suite (issue #66).
 *
 * ## Which doubles exist, and why only these
 *
 * - A **fake executor** for the tests about the control plane's own
 *   decisions: lifecycle, idempotency, tenancy, failure accounting.
 *   Those questions are about *what the service does with a result*, and
 *   driving them through a real browser run would make a policy
 *   assertion fail for reasons that have nothing to do with the policy.
 * - A **real feedback sink double** for the disposition tests. The
 *   point of the #64 seam is that the service enforces #61's transition
 *   table itself, so the double has to be able to *refuse* to — which
 *   is what `lax` proves.
 * - The **real runtime** for the end-to-end path, in
 *   `end-to-end.test.ts` and `operator-boundary.test.ts`, because the
 *   operator gate and the finding projection are only real there.
 *
 * Every value a double produces is built through the owning layer's own
 * parser (#57 for lineage, #61 for findings and evidence), so a
 * double cannot hand the service something the real contract would
 * refuse.
 */

import {
  cohortId,
  environmentId,
  parseEvaluationRunId,
  parseProductId,
  parseReviewProgramId,
  parseRunLineage,
  parseSyntheticIdentityId,
  targetKey,
  type EvaluationTargetRef,
  type RunLineage,
} from '../../../../src/product/index.js';
import {
  findingId,
  parseEvidenceRef,
  parseFinding,
  parseSetupFailure,
  setupFailureId,
  type AffectedCondition,
  type Confidence,
  type EvidenceRef,
  type Finding,
  type SetupFailure,
} from '../../../../src/review/index.js';
import type { EvaluationRunResult } from '../../../../src/runtime/index.js';
import type { Disposition, DispositionId, FindingId } from '../../../../src/review/index.js';
import type {
  DispositionAppendResult,
  DispositionSubmission,
  EvaluationExecutor,
  FeedbackSink,
} from '../../../../src/service/index.js';
import { COHORT_ID, ENV_ID, PRODUCT_ID, PROGRAM_ID } from './fixtures.js';

export const TARGET: EvaluationTargetRef = Object.freeze({
  productId: parseProductId(PRODUCT_ID),
  environmentId: environmentId(ENV_ID),
  cohortId: cohortId(COHORT_ID),
  programId: parseReviewProgramId(PROGRAM_ID),
});

export const AVA = parseSyntheticIdentityId('idn-ava');

export function makeLineage(runId: string, identityIds: ReadonlyArray<string> = ['idn-ava']): RunLineage {
  return parseRunLineage({
    ...TARGET,
    runId: parseEvaluationRunId(runId),
    identityIds: identityIds.map((id) => parseSyntheticIdentityId(id)),
    startedAt: '2026-10-05T09:00:00.000Z',
    endedAt: '2026-10-05T09:05:00.000Z',
  });
}

const evidence: EvidenceRef = parseEvidenceRef({
  id: 'ev-observer-1',
  channel: 'observer',
  stance: 'supports',
  locator: 'events.ndjson#observer.response[0]',
  observedAt: '2026-10-05T09:02:00.000Z',
  summary: 'Observer reported the save button doing nothing after a title was entered.',
});

const conditions: ReadonlyArray<AffectedCondition> = [
  { dimension: 'flow', value: 'task/create' },
];

const confidence = {
  level: 'medium',
  basis: 'multiChannelAgreement',
  source: 'model',
  provenance: {
    channel: 'observer',
    recordedAt: '2026-10-05T09:03:00.000Z',
    provider: 'internal',
    modelId: 'scripted-observer-1',
  },
  calibration: { calibrated: false },
} as unknown as Confidence;

/** A complete, valid `Finding`, built by #61's own parser. */
export function makeFinding(runId: string, overrides: Record<string, unknown> = {}): Finding {
  const lineage = makeLineage(runId);
  return parseFinding({
    outcome: 'productFinding',
    id: findingId('fnd-0000abcd'),
    title: 'Save button is inert on task creation',
    summary: 'Entering a title and activating Save leaves the draft in the form.',
    kind: 'workflowBlocker',
    severity: 'high',
    riskClass: 'usability',
    confidence,
    target: TARGET,
    observedIn: lineage.runId,
    identityIds: ['idn-ava'],
    evidenceRefs: [evidence],
    affectedConditions: conditions,
    // `attemptedNotReproduced`, not `reproduced`: #61 requires a
    // verification record for a reproduced claim, and a fixture that
    // claimed reproduction without one would be refused by the parser
    // this very fixture calls.
    reproduction: {
      status: 'attemptedNotReproduced',
      steps: ['Open the task form.', 'Enter a title and press Save.'],
    },
    longitudinal: { mode: 'pointInTime', change: 'unknown', baseline: null, observed: lineage },
    observedAt: '2026-10-05T09:03:00.000Z',
    ...overrides,
  });
}

/** A complete, valid `SetupFailure`. Its id brand is not a `FindingId`. */
export function makeSetupFailure(runId: string, message: string): SetupFailure {
  const lineage = makeLineage(runId);
  return parseSetupFailure({
    outcome: 'setupFailure',
    id: setupFailureId('sf-0000abcd'),
    cause: 'environmentUnreachable',
    message,
    target: TARGET,
    runId: lineage.runId,
    identityIds: ['idn-ava'],
    evidenceRefs: [evidence],
    occurredAt: '2026-10-05T09:01:00.000Z',
  });
}

/* -------------------------------------------------------------------------- */
/* Fake executor                                                                 */
/* -------------------------------------------------------------------------- */

export interface FakeExecutorOptions {
  readonly findings?: ReadonlyArray<Finding>;
  readonly setupFailures?: ReadonlyArray<SetupFailure>;
  readonly setupRefused?: boolean;
  readonly operatorAuditLength?: number;
  /** Raise instead of returning, to exercise the failed-job path. */
  readonly throws?: Error;
  /**
   * Per-job failures, so one service can hold both a clean run and a
   * failed one and a program-scoped report has to account for both.
   */
  readonly throwsFor?: (jobId: string) => Error | undefined;
  /** Gate on resolution so a test can observe a job still `running`. */
  readonly gate?: Promise<void>;
}

export interface FakeExecutor extends EvaluationExecutor {
  readonly calls: ReadonlyArray<{ readonly jobId: string; readonly runId: string }>;
}

/**
 * An executor that returns a constructed run result.
 *
 * The run's *domain* content — target, lineage, findings, setup
 * failures — is built by #57 and #61's real parsers, so it is
 * genuinely valid. The runtime's own bookkeeping (`resolvedCohort`,
 * `persistence`, `observer`) is a placeholder: the control plane never
 * reads it, and reconstructing a cohort state and an observer report
 * would add fixture weight without testing anything. That is the one
 * cast in this file, and it is confined to those three fields.
 */
export function fakeExecutor(options: FakeExecutorOptions = {}): FakeExecutor {
  const calls: { jobId: string; runId: string }[] = [];
  return {
    calls,
    async execute(request) {
      calls.push({ jobId: request.jobId, runId: request.jobId });
      if (options.gate !== undefined) {
        await options.gate;
      }
      if (options.throws !== undefined) {
        throw options.throws;
      }
      const perJob = options.throwsFor?.(request.jobId);
      if (perJob !== undefined) {
        throw perJob;
      }
      const lineage = makeLineage(request.jobId, request.plan.target.cohortId === COHORT_ID ? ['idn-ava'] : []);
      return { result: fakeRunResult(request.jobId, lineage, options) };
    },
  };
}

function fakeRunResult(
  runId: string,
  lineage: RunLineage,
  options: FakeExecutorOptions,
): EvaluationRunResult {
  const findings = options.findings ?? [makeFinding(runId)];
  const setupFailures = options.setupFailures ?? [];
  const setupRefused = options.setupRefused ?? false;
  return {
    runId: parseEvaluationRunId(runId),
    target: TARGET,
    lineage,
    mode: 'continuous',
    outcomes: [...findings, ...setupFailures],
    findings,
    setupFailures,
    evidence: [],
    resolvedCohort: undefined,
    setup: {
      status: setupRefused ? 'denied' : 'provisioned',
      connector: { connectorId: 'scripted-connector' },
      resourceKeys: [],
      spendUnits: 0,
      audit: [],
      failures: [],
    },
    operatorAudit: new Array(options.operatorAuditLength ?? 1).fill(null),
    persistence: undefined,
    observer: undefined,
    setupRefused,
    startedAt: lineage.startedAt,
    endedAt: lineage.endedAt ?? lineage.startedAt,
    artifactDir: `/tmp/u-sekai-service-fixture/${runId}`,
  } as unknown as EvaluationRunResult;
}

/* -------------------------------------------------------------------------- */
/* Feedback sink double                                                          */
/* -------------------------------------------------------------------------- */

export interface RecordingFeedbackSink extends FeedbackSink {
  /** Every append, in order. */
  readonly appends: ReadonlyArray<DispositionSubmission>;
  readonly historyFor: (findingId: FindingId) => ReadonlyArray<Disposition>;
}

/**
 * An in-memory sink with #64's *shape* and none of its enforcement.
 *
 * It appends whatever it is given without checking the transition
 * table, and that is deliberate: `disposition.test.ts` installs it to
 * prove the **service** refuses an illegal move on its own, rather than
 * relying on the ledger to notice. A sink that enforced the table
 * would make that test pass for the wrong reason.
 */
export function feedbackSink(): RecordingFeedbackSink {
  const appends: DispositionSubmission[] = [];
  const byFinding = new Map<string, Disposition[]>();

  return {
    appends,
    historyFor: (id) => Object.freeze([...(byFinding.get(id) ?? [])]),
    async currentDisposition(id: FindingId): Promise<Disposition | undefined> {
      const list = byFinding.get(id);
      return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
    },
    async appendDisposition(
      submission: DispositionSubmission,
    ): Promise<DispositionAppendResult> {
      appends.push(submission);
      const key = submission.disposition.findingId;
      const list = byFinding.get(key) ?? [];
      const existing = list.find((d) => d.id === submission.disposition.id);
      if (existing !== undefined) {
        return { recorded: true, dispositionId: existing.id, duplicate: true };
      }
      list.push(submission.disposition);
      byFinding.set(key, list);
      return {
        recorded: true,
        dispositionId: submission.disposition.id as DispositionId,
        duplicate: false,
      };
    },
    async dispositionHistory(id: FindingId): Promise<ReadonlyArray<Disposition>> {
      return Object.freeze([...(byFinding.get(id) ?? [])]);
    },
  };
}

/** Re-exported so a test can assert on the key the service derives. */
export { targetKey };
