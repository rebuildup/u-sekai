/**
 * Fixtures for the feedback-ledger and KPI tests (issue #64).
 *
 * Self-contained on purpose: `test/unit/review/support/` belongs to
 * #61's file set, and #64 must not edit it. Duplicating the ~60 lines
 * needed to mint one valid finding is cheaper than coupling this
 * ticket's test surface to another ticket's private helper, which would
 * make a #61 fixture refactor an unannounced breakage here.
 *
 * Two properties matter for the tests that use these:
 *
 * 1. **Every value is built with the same `parse*` entry point a real
 *    caller would use.** A fixture that had drifted out of the #61
 *    contract would fail here, at import time, instead of quietly
 *    weakening whichever assertion depended on it.
 * 2. **Ids are derived, not hand-typed.** `deriveFindingId(runId, n)`
 *    gives stable distinct handles, so "finding 1 accepted, finding 2
 *    unresolved" is expressed as an intent rather than as three magic
 *    strings that can be transposed.
 */

import {
  parseCohortId,
  parseEnvironmentId,
  parseEvaluationRunId,
  parseProductId,
  parseReviewProgramId,
  parseRunLineage,
  parseSyntheticIdentityId,
} from '../../../../src/product/index.js';
import type { EvaluationTargetRef, RunLineage } from '../../../../src/product/index.js';
import {
  deriveFindingId,
  deriveVerificationId,
  dispositionId,
  parseDisposition,
  parseEvidenceRef,
  parseFinding,
  parseSetupFailure,
  setupFailureId,
} from '../../../../src/review/index.js';
import type {
  Disposition,
  DispositionKind,
  Finding,
  FindingId,
  ReproductionStatus,
  SetupFailure,
  VerificationOutcome,
} from '../../../../src/review/index.js';
import { appendDisposition, emptyLedger } from '../../../../src/feedback/ledger.js';
import type { DispositionLedger } from '../../../../src/feedback/ledger.js';

export const RUN_ID = 'run-2026-10-01-0001';
const VERIFY_RUN_ID = 'run-2026-10-07-0001';

export const target: EvaluationTargetRef = {
  productId: parseProductId('prd-task-tracker'),
  environmentId: parseEnvironmentId('env-staging'),
  cohortId: parseCohortId('coh-core'),
  programId: parseReviewProgramId('rp-continuous'),
};

const alice = parseSyntheticIdentityId('idn-alice');
const bob = parseSyntheticIdentityId('idn-bob');

export const lineage: RunLineage = parseRunLineage({
  runId: parseEvaluationRunId(RUN_ID),
  ...target,
  identityIds: [alice, bob],
  startedAt: '2026-10-01T00:00:00Z',
  endedAt: '2026-10-01T00:30:00Z',
});

const verifyLineage: RunLineage = parseRunLineage({
  runId: parseEvaluationRunId(VERIFY_RUN_ID),
  ...target,
  identityIds: [alice],
  startedAt: '2026-10-07T00:00:00Z',
  endedAt: '2026-10-07T00:20:00Z',
});

const longitudinal = {
  mode: 'pointInTime',
  change: 'unknown',
  baseline: null,
  observed: lineage,
} as const;

/** The nth finding of this run. Ids are derived, so n is the only input. */
export function findingIdFor(n: number): FindingId {
  return deriveFindingId(RUN_ID, n);
}

/**
 * A complete, valid finding. Defaults to a `reproduced` finding with a
 * `confirmed` verification pass — the shape every cost/verification KPI
 * is measured over — and takes overrides for the cases that are not.
 */
export function findingFor(n: number, overrides: Record<string, unknown> = {}): Finding {
  const id = findingIdFor(n);
  // `verificationOutcome` is a fixture-level lever, not a contract
  // field, so it is consumed here rather than spread into the
  // document — where `rejectUnknownKeys` would (correctly) refuse it.
  const { verificationOutcome, ...fields } = overrides;
  const outcome: VerificationOutcome = (verificationOutcome as VerificationOutcome | undefined) ?? 'confirmed';
  return parseFinding({
    outcome: 'productFinding',
    id,
    title: `Finding ${n}: save is inert on task creation`,
    summary:
      'Entering a title and activating Save leaves the draft in the form; the task is never ' +
      'created and no error is shown.',
    kind: 'workflowBlocker',
    severity: 'high',
    riskClass: 'usability',
    confidence: {
      level: 'medium',
      basis: 'multiChannelAgreement',
      source: 'model',
      provenance: {
        channel: 'observer',
        recordedAt: '2026-10-01T00:07:00Z',
        provider: 'internal',
        modelId: 'scripted-observer-1',
      },
      calibration: { calibrated: false },
    },
    target,
    observedIn: RUN_ID,
    identityIds: ['idn-alice', 'idn-bob'],
    evidenceRefs: [
      parseEvidenceRef({
        id: `ev-observer-${n}`,
        channel: 'observer',
        stance: 'supports',
        locator: `events.ndjson#observer.response[${n}]`,
        observedAt: '2026-10-01T00:05:00Z',
        summary: 'Observer reported the save button inert after entering a title.',
      }),
    ],
    affectedConditions: [{ dimension: 'flow', value: `task/create/${n}` }],
    reproduction: {
      status: 'reproduced',
      steps: [
        'Open the task creation form.',
        'Enter a title and press Save.',
        'Observe that the draft is still in the form.',
      ],
    },
    longitudinal,
    observedAt: '2026-10-01T00:07:00Z',
    verification: {
      id: deriveVerificationId(id as Finding['id'], 1),
      findingId: id,
      outcome,
      runId: verifyLineage.runId,
      identityIds: ['idn-alice'],
      evidenceRefs: [
        parseEvidenceRef({
          id: `ev-verify-${n}`,
          channel: 'observer',
          stance: 'supports',
          locator: `events.ndjson#observer.response[${n}9]`,
          observedAt: '2026-10-07T00:08:00Z',
          summary: 'An independent pass reproduced the inert save control.',
        }),
      ],
      rationale: 'A second identity on a later run reproduced the same inert control.',
      verifiedAt: '2026-10-07T00:09:00Z',
    },
    // Last, so a caller can replace the whole `verification` block —
    // which is how `unverifiedFindingFor` removes it.
    ...fields,
  });
}

/**
 * A finding whose verification outcome is `outcome` — the lever for
 * the "only `confirmed` counts as verified" rule.
 */
export function findingWithVerification(
  n: number,
  outcome: VerificationOutcome,
): Finding {
  // #61 refuses a finding that is "reproduced" while its own pass
  // reports `refuted` or `notRun`, so the reproduction status has to
  // follow the verdict rather than stay at the default.
  const status: Record<VerificationOutcome, ReproductionStatus> = {
    confirmed: 'reproduced',
    inconclusive: 'reproduced',
    refuted: 'attemptedNotReproduced',
    notRun: 'attemptedNotReproduced',
  };
  return findingFor(n, {
    verificationOutcome: outcome,
    reproduction: {
      status: status[outcome],
      steps: [
        'Open the task creation form.',
        'Enter a title and press Save.',
        'Observe that the draft is still in the form.',
      ],
    },
  });
}

/** A finding that was never verified and never reproduced. */
export function unverifiedFindingFor(n: number): Finding {
  return findingFor(n, { verification: undefined, reproduction: { status: 'notAttempted' } });
}

/** A complete, valid setup failure. Carries no severity/confidence/longitudinal. */
export function setupFailureFor(n: number): SetupFailure {
  return parseSetupFailure({
    outcome: 'setupFailure',
    id: setupFailureId(`sf-${String(n).padStart(8, '0')}abcd`),
    cause: 'harnessUnavailable',
    message: 'Chromium could not be launched.',
    target,
    runId: RUN_ID,
    identityIds: ['idn-alice'],
    evidenceRefs: [
      parseEvidenceRef({
        id: `ev-setup-${n}`,
        channel: 'environmentProbe',
        stance: 'supports',
        locator: 'runtimeErrors[0]',
        observedAt: '2026-10-01T00:02:11Z',
        summary: 'participant/browser: launch failed',
      }),
    ],
    occurredAt: '2026-10-01T00:02:11Z',
  });
}

/**
 * A complete, valid disposition input for `findingIdFor(n)`.
 *
 * The state defaults from the kind so a caller overriding only the kind
 * gets a legal pair: an open kind is only legal in `needsHumanResearch`
 * and a decided kind only in `decided`. Tests that want to explore the
 * state machine itself pass both.
 */
export function dispositionInputFor(
  n: number,
  kind: DispositionKind,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const open = kind === 'unresolved' || kind === 'needsHumanResearch';
  const rationaleRequired = kind === 'invalid' || kind === 'alreadyKnown' || kind === 'wontFix';
  return {
    id: dispositionId(`dsp-${String(n).padStart(8, '0')}0001`),
    findingId: findingIdFor(n),
    kind,
    state: open ? 'needsHumanResearch' : 'decided',
    actor: { kind: 'customer', reference: 'design-partner-alpha' },
    decidedAt: '2026-10-02T09:00:00Z',
    ...(rationaleRequired
      ? { rationale: `Recorded because the customer requires a reason for "${kind}".` }
      : {}),
    ...overrides,
  };
}

/** `dispositionInputFor` parsed, so a test holds a real `Disposition`. */
export function dispositionFor(
  n: number,
  kind: DispositionKind,
  overrides: Record<string, unknown> = {},
): Disposition {
  return parseDisposition(dispositionInputFor(n, kind, overrides));
}

/** An `accepted` decision, optionally with a follow-up action attached. */
export function acceptedFor(
  n: number,
  action?: { kind: string; reference: string },
): Disposition {
  return dispositionFor(n, 'accepted', {
    ...(action ? { action } : {}),
  });
}

/** An `unresolved` disposition: recorded, but explicitly not a decision. */
export function unresolvedFor(n: number, overrides: Record<string, unknown> = {}): Disposition {
  return dispositionFor(n, 'unresolved', overrides);
}

/** A `needsHumanResearch` disposition: also open, also not a decision. */
export function needsResearchFor(n: number): Disposition {
  return dispositionFor(n, 'needsHumanResearch');
}

/**
 * Fold dispositions into a ledger in the order given.
 *
 * The fold goes through `appendDisposition`, so a fixture that is not a
 * legal sequence fails here rather than producing a ledger the rest of
 * the test would then measure KPIs over.
 */
export function ledgerOf(...dispositions: ReadonlyArray<Disposition>): DispositionLedger {
  let ledger = emptyLedger();
  for (const disposition of dispositions) {
    // Not `reduce(appendDisposition)`: `appendDisposition` takes an
    // optional `field` third argument, which `reduce` would fill with
    // the element index.
    ledger = appendDisposition(ledger, disposition);
  }
  return ledger;
}
