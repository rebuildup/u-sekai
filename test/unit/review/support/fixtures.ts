/**
 * Fixtures for the review-contract tests.
 *
 * Every value here is a *complete, valid* document for its type, so a
 * test that wants to make one field invalid can spread the fixture and
 * override exactly that field. That keeps each assertion about one rule
 * rather than about a whole hand-built object.
 *
 * The typed constants are built with the same `parse*` entry points a
 * caller would use, so a fixture that drifted out of contract would fail
 * here rather than quietly weakening a test.
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
  findingId,
  parseEvidenceRef,
  verificationId,
} from '../../../../src/review/index.js';
import type {
  AffectedCondition,
  Confidence,
  EvidenceRef,
  Finding,
  Verification,
} from '../../../../src/review/index.js';

export const target: EvaluationTargetRef = {
  productId: parseProductId('prd-task-tracker'),
  environmentId: parseEnvironmentId('env-staging'),
  cohortId: parseCohortId('coh-core'),
  programId: parseReviewProgramId('rp-continuous'),
};

export const otherTarget: EvaluationTargetRef = {
  ...target,
  environmentId: parseEnvironmentId('env-production'),
};

const alice = parseSyntheticIdentityId('idn-alice');
const bob = parseSyntheticIdentityId('idn-bob');
const carol = parseSyntheticIdentityId('idn-carol');

/** Baseline run: two identities, same durable target. */
export const lineageA: RunLineage = parseRunLineage({
  runId: parseEvaluationRunId('run-2026-10-01-0001'),
  ...target,
  identityIds: [alice, bob],
  startedAt: '2026-10-01T00:00:00Z',
  endedAt: '2026-10-01T00:30:00Z',
});

/** Later run sharing `idn-alice`, so it joins with `lineageA`. */
export const lineageB: RunLineage = parseRunLineage({
  runId: parseEvaluationRunId('run-2026-10-07-0001'),
  ...target,
  identityIds: [alice],
  startedAt: '2026-10-07T00:00:00Z',
  endedAt: '2026-10-07T00:20:00Z',
});

/** Same window as `lineageA` but a disjoint identity set: not joinable. */
export const lineageUnrelated: RunLineage = parseRunLineage({
  runId: parseEvaluationRunId('run-2026-10-01-0002'),
  ...target,
  identityIds: [carol],
  startedAt: '2026-10-01T00:00:00Z',
});

export const evidenceObserver: EvidenceRef = parseEvidenceRef({
  id: 'ev-observer-1',
  channel: 'observer',
  stance: 'supports',
  locator: 'events.ndjson#observer.response[0]',
  observedAt: '2026-10-01T00:05:00Z',
  summary: 'Observer reported the save button inert after entering a title.',
});

export const evidenceSelfReport: EvidenceRef = parseEvidenceRef({
  id: 'ev-selfreport-1',
  channel: 'participantSelfReport',
  stance: 'supports',
  locator: 'events.ndjson#selfReport.response[0]',
  observedAt: '2026-10-01T00:06:00Z',
  summary: 'Participant said the save action "does nothing".',
});

/** A deterministic check that refutes the claim. */
export const evidenceDeterministic: EvidenceRef = parseEvidenceRef({
  id: 'ev-check-1',
  channel: 'deterministicCheck',
  stance: 'contradicts',
  locator: 'checks/create-task.spec.ts:41',
  observedAt: '2026-10-01T00:10:00Z',
  summary: 'The existing create-task regression test passes on the same flow.',
});

export const conditions: ReadonlyArray<AffectedCondition> = [
  { dimension: 'capability', value: 'memory=limitedRecent' },
  { dimension: 'flow', value: 'task/create' },
];

export const confidence: Confidence = {
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
} as Confidence;

export const verification: Verification = {
  id: verificationId('ver-0000abcd'),
  findingId: findingId('fnd-0000abcd'),
  outcome: 'confirmed',
  runId: lineageB.runId,
  identityIds: [alice],
  evidenceRefs: [
    parseEvidenceRef({
      id: 'ev-verify-1',
      channel: 'observer',
      stance: 'supports',
      locator: 'events.ndjson#observer.response[9]',
      observedAt: '2026-10-07T00:08:00Z',
      summary: 'Independent pass reproduced the inert save button.',
    }),
  ],
  rationale: 'A second identity on a later run reproduced the same inert control.',
  verifiedAt: '2026-10-07T00:09:00Z',
} as Verification;

export const pointInTimeLongitudinal = {
  mode: 'pointInTime',
  change: 'unknown',
  baseline: null,
  observed: lineageA,
} as const;

/** A complete, valid finding document. */
export function findingInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'productFinding',
    id: 'fnd-0000abcd',
    title: 'Save button is inert on task creation',
    summary:
      'Entering a title and activating Save leaves the draft in the form; the task is never ' +
      'created and no error is shown.',
    kind: 'workflowBlocker',
    severity: 'high',
    riskClass: 'usability',
    confidence,
    target,
    observedIn: lineageA.runId,
    identityIds: ['idn-alice', 'idn-bob'],
    evidenceRefs: [evidenceObserver, evidenceSelfReport],
    affectedConditions: conditions,
    reproduction: {
      status: 'reproduced',
      steps: [
        'Open the task creation form.',
        'Enter a title and press Save.',
        'Observe that the draft is still in the form and no task appears in the list.',
      ],
    },
    longitudinal: pointInTimeLongitudinal,
    observedAt: '2026-10-01T00:07:00Z',
    verification,
    ...overrides,
  };
}

/** A complete, valid disposition document. */
export function dispositionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dsp-0000abcd',
    findingId: 'fnd-0000abcd',
    kind: 'accepted',
    state: 'decided',
    actor: { kind: 'customer', reference: 'design-partner-alpha' },
    decidedAt: '2026-10-02T09:00:00Z',
    rationale: 'Confirmed by the product owner; the flow is used daily.',
    ...overrides,
  };
}

export type { Finding };
