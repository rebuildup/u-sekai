/**
 * A `Finding` builder for the Issue #67 control cases.
 *
 * ## Why this exists
 *
 * `classifyChange` takes real `Finding` values, so a control that wants
 * to prove the longitudinal verdict is a genuine join has to supply two
 * of them. Building them by hand and casting would defeat the point:
 * a cast can produce a shape #61's parser would refuse, and then the
 * control would be asserting against a value no run could ever produce.
 * So every value here goes through `parseFinding`, and a control case
 * that needs a second finding gets one that the real contract accepts.
 *
 * The findings are only ever used as *classifier inputs*. The scenario's
 * own finding is a real one, materialised by the runtime from an actual
 * run; nothing here is presented as an observation.
 */

import {
  deriveEvidenceId,
  parseFinding,
  type EvidenceRef,
  type Finding,
  type FindingKind,
  type Severity,
} from '../../../src/review/index.js';
import {
  cohortId,
  environmentId,
  parseEvaluationTargetRef,
  productId,
  reviewProgramId,
  syntheticIdentityId,
} from '../../../src/product/index.js';

export const CONTROL_PRODUCT = 'prd-task-tracker';

export interface FindingInput {
  readonly findingId: string;
  readonly title: string;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly observedAt: string;
  readonly identityId: string;
  readonly environmentId: string;
  readonly cohortId: string;
  readonly programId: string;
  readonly summary?: string;
  readonly conditionValue?: string;
}

/**
 * A `Finding` through #61's own parser.
 *
 * `changeKey` is what `classifyChange` compares, and it is derived from
 * `kind` and `title` — so two findings differ in the verdict exactly
 * when their `kind` or `title` differ, and no fixture field is being
 * smuggled past the join.
 */
export function makeFinding(input: FindingInput): Finding {
  const target = parseEvaluationTargetRef({
    productId: productId(CONTROL_PRODUCT),
    environmentId: environmentId(input.environmentId),
    cohortId: cohortId(input.cohortId),
    programId: reviewProgramId(input.programId),
  });

  const evidence: EvidenceRef[] = [
    {
      id: deriveEvidenceId(`${input.findingId}|observation`),
      channel: 'structuredTrace',
      stance: 'supports',
      locator: 'events.ndjson#observation.captured',
      observedAt: input.observedAt,
      summary: 'A control-case evidence handle, not an observation of any product.',
    },
  ];

  return parseFinding({
    outcome: 'productFinding',
    id: input.findingId,
    title: input.title,
    summary: input.summary ?? input.title,
    kind: input.kind,
    severity: input.severity,
    riskClass: 'usability',
    confidence: {
      level: 'low',
      basis: 'singleObservation',
      source: 'model',
      provenance: { channel: 'observer', recordedAt: input.observedAt },
      rationale:
        'A control-case value constructed to exercise the change classifier. It records no ' +
        'observation of any product and must never be reported as one.',
      calibration: { calibrated: false },
    },
    target,
    observedIn: 'run-control-classifier',
    identityIds: [syntheticIdentityId(input.identityId)],
    evidenceRefs: evidence,
    affectedConditions: [
      { dimension: 'lifecycle', value: input.conditionValue ?? 'release' },
    ],
    reproduction: { status: 'notAttempted' },
    longitudinal: {
      mode: 'pointInTime',
      change: 'unknown',
      observed: {
        productId: target.productId,
        environmentId: target.environmentId,
        cohortId: target.cohortId,
        programId: target.programId,
        runId: 'run-control-classifier',
        identityIds: [syntheticIdentityId(input.identityId)],
        startedAt: input.observedAt,
        endedAt: input.observedAt,
      },
    },
    observedAt: input.observedAt,
  });
}
