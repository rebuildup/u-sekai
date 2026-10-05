/**
 * Review record materialisation (issue #63).
 *
 * ## The runtime projects; it does not diagnose
 *
 * #61's `Finding` requires a `kind`, a `severity`, a `riskClass` and a
 * `confidence` — four judgements about the product. The runtime has no
 * standing to make any of them: it did not explore anything, a
 * participant did. So every one of those four is **projected from a
 * declared source**:
 *
 * - `kind` and `severity` come from the observer's own finding, through
 *   a mapping the caller supplies (`classifyObserverFinding`). The
 *   default mapping is data — a table from the observer's `category`
 *   and `severity` vocabularies onto #61's — and never a guess.
 * - `riskClass` is derived from `kind` by a second table, because the
 *   two are not independent: a `comprehensionGap` *is* a usability
 *   risk, and asking a caller to state both would be asking for one
 *   fact twice with two spellings that can disagree.
 * - `confidence` is deliberately the weakest honest value the contract
 *   admits: `singleObservation`, source `model`, `calibrated: false`. A
 *   run that made one model-backed observation has made one
 *   observation, and `docs/product/kpis.md` treats an uncalibrated
 *   confidence stated as calibrated as a defect, not a default.
 *
 * ## A finding without evidence does not exist
 *
 * `parseFinding` rejects an empty `evidenceRefs` and an
 * all-inconclusive citation list. Rather than catch that, the
 * materialiser asks the question first: if the run produced no
 * observation for any identity, the run observed nothing about the
 * product and there is nothing to report. A run that could not open the
 * environment therefore produces zero findings — which is the strongest
 * available reading of Issue #63's "setup/runtime failure is
 * distinguishable from a product finding".
 *
 * ## Change classification is a real join or it is `unknown`
 *
 * `classifyChange` compares the current run's finding keys against a
 * caller-supplied baseline finding set. A key present in both is
 * `persisted`; a key only in the current run is `introduced`. Anything
 * less than a genuine join returns `unknown`, because `unknown` is
 * #61's first-class value for "no comparison was made" and saying
 * `unchanged` without having looked is the claim this whole
 * longitudinal layer exists to prevent.
 */

import {
  deriveFindingId,
  parseFinding,
  setupFailureFromRuntimeError,
  type AffectedCondition,
  type ChangeKind,
  type EvaluationMode,
  type EvidenceRef,
  type Finding,
  type FindingKind,
  type LongitudinalChange,
  type Reproduction,
  type ReviewOutcome,
  type RiskClass,
  type SetupFailure,
  type SetupFailureId,
} from '../review/index.js';
import type {
  EvaluationRunId,
  EvaluationTargetRef,
  RunLineage,
  SyntheticIdentityId,
} from '../product/index.js';
import type { ObserverFinding } from '../domain/observer.js';
import type { EvidenceCatalogue } from './evidence.js';
import { DEFAULT_OBSERVER_CLASSIFIER, type ObserverFindingClassifier } from './config.js';
import { setupFailureCauseForRuntimeError } from './setup.js';

/**
 * The `riskClass` each `kind` implies.
 *
 * Not a judgement: a `workflowBlocker` is a usability risk by
 * definition, and a `dataIntegrity` finding is a reliability risk by
 * definition. One table means a caller cannot state a kind and a risk
 * class that disagree.
 */
const RISK_BY_KIND: Readonly<Record<FindingKind, RiskClass>> = Object.freeze({
  workflowBlocker: 'usability',
  reliabilityFailure: 'reliability',
  usabilityDefect: 'usability',
  accessibilityBarrier: 'accessibility',
  comprehensionGap: 'usability',
  trustDefect: 'security',
  dataIntegrity: 'other',
  contentProblem: 'content',
  other: 'other',
});

/** Everything the materialiser needs, already resolved by the caller. */
export interface MaterializeInput {
  readonly runId: EvaluationRunId;
  readonly target: EvaluationTargetRef;
  /**
   * The run's own lineage. Also `longitudinal.observed`, by reference:
   * #61's design is that a baseline and an observation are `RunLineage`
   * *references*, never copies, so this must be the same object the run
   * recorded.
   */
  readonly observed: RunLineage;
  /**
   * Resolved mode. Never inferred here: `releaseTransition` requires a
   * baseline by #61's own rule, and guessing the mode from "a baseline
   * happens to be present" would let a point-in-time run inherit a
   * comparative envelope it never earned.
   */
  readonly mode: EvaluationMode;
  readonly baseline: RunLineage | null;
  /** `undefined` means the caller supplied no baseline findings. */
  readonly baselineFindings: ReadonlyArray<Finding> | undefined;
  readonly catalog: EvidenceCatalogue;
  readonly observerFindings: ReadonlyArray<ObserverFinding>;
  readonly observerCapturedAt: string;
  readonly observedAt: string;
  /** Distinct lifecycles among the identities that actually observed. */
  readonly lifecycles: ReadonlyArray<string>;
  readonly classifier?: ObserverFindingClassifier;
}

/**
 * Stable key for "the same problem, seen twice".
 *
 * Kind plus a normalised title. Not the summary: a model restates a
 * summary freely between runs, so keying on it would report a solved
 * problem as newly introduced on every release. Normalisation is
 * case-folding plus whitespace collapsing, which is the most that can be
 * removed without inventing a matcher.
 */
export function findingChangeKey(finding: Pick<Finding, 'kind' | 'title'>): string {
  return `${finding.kind}::${finding.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/**
 * What a finding says about change, given what the baseline said.
 *
 * Returns `unknown` for every case where the comparison could not be
 * made, including a baseline whose findings were simply not supplied.
 * Exported so the classification is testable without a browser.
 */
export function classifyChange(
  current: Pick<Finding, 'kind' | 'title'>,
  baselineFindings: ReadonlyArray<Finding> | undefined,
): ChangeKind {
  if (baselineFindings === undefined || baselineFindings.length === 0) return 'unknown';
  const key = findingChangeKey(current);
  return baselineFindings.some((f) => findingChangeKey(f) === key) ? 'persisted' : 'introduced';
}

/**
 * Project the run into #61 review records.
 *
 * Returns findings and setup failures in one pass over disjoint
 * sources, so a caller cannot receive one without the other. The
 * separation is by discriminant, not by list membership: a caller
 * switches on `outcome`, and the two can never be mistaken for one
 * another even when both lists are non-empty.
 */
export function materializeOutcomes(input: MaterializeInput): ReadonlyArray<ReviewOutcome> {
  return Object.freeze([
    ...materializeFindings(input),
    ...materializeRuntimeSetupFailures(input),
  ]);
}

/** The product findings the run supports. */
export function materializeFindings(input: MaterializeInput): ReadonlyArray<Finding> {
  const classifier = input.classifier ?? DEFAULT_OBSERVER_CLASSIFIER;
  const out: Finding[] = [];

  for (const observerFinding of input.observerFindings) {
    const decision = classifier(observerFinding);
    if (!decision.report) continue;

    const identityIds = attributingIdentities(observerFinding, input);
    // No identity observed anything, so the run produced no product
    // observation. There is nothing to report and nothing that could
    // satisfy `assertSupportsClaim` honestly.
    if (identityIds.length === 0) continue;

    const evidenceRefs = buildEvidenceRefs(observerFinding, identityIds, input);
    if (!evidenceRefs.some((r) => r.stance === 'supports')) continue;

    const title = observerFinding.summary.slice(0, 200);
    const finding: Pick<Finding, 'kind' | 'title'> = { kind: decision.kind, title };

    out.push(
      parseFinding({
        outcome: 'productFinding',
        id: deriveFindingId(input.runId, out.length + 1),
        title,
        summary: observerFinding.summary.slice(0, 2000),
        kind: decision.kind,
        severity: decision.severity,
        riskClass: RISK_BY_KIND[decision.kind],
        confidence: {
          level: 'low',
          basis: 'singleObservation',
          source: 'model',
          provenance: { channel: 'observer', recordedAt: input.observerCapturedAt },
          rationale:
            'Recorded from one observer pass over one run. No independent verification pass ' +
            'ran and no calibration against an outside yardstick exists, so the level is the ' +
            'weakest the contract admits rather than a calibrated number.',
          calibration: { calibrated: false },
        },
        target: input.target,
        observedIn: input.runId,
        identityIds,
        evidenceRefs,
        affectedConditions: buildConditions(input),
        // `notAttempted`, not `attemptedNotReproduced`: the runtime does
        // not re-drive the flow to check, so claiming an attempt would be
        // a claim about work nobody did.
        reproduction: { status: 'notAttempted' } satisfies Reproduction,
        longitudinal: buildLongitudinal(finding, input),
        observedAt: input.observedAt,
      }),
    );
  }

  return Object.freeze(out);
}

/**
 * The run's setup failures, from the run's own runtime-error rollup.
 *
 * A participant that died, or that reached for a primitive its
 * capability profile forbids, produced a `runtimeErrors` entry. #61's
 * `setupFailureFromRuntimeError` exists for exactly this conversion and
 * `src/domain/evidence.ts` is not edited to accommodate it — that is
 * #72's ticket.
 */
export function materializeRuntimeSetupFailures(
  input: MaterializeInput,
): ReadonlyArray<SetupFailure> {
  return Object.freeze(
    input.catalog.runtimeErrors.map((record, index) =>
      setupFailureFromRuntimeError(record, {
        id: `sf-${input.runId}-re-${index + 1}` as SetupFailureId,
        cause: setupFailureCauseForRuntimeError(record),
        target: input.target,
        runId: input.runId,
        identityIds: input.observed.identityIds,
        index,
      }),
    ),
  );
}

function buildEvidenceRefs(
  finding: ObserverFinding,
  identityIds: ReadonlyArray<SyntheticIdentityId>,
  input: MaterializeInput,
): ReadonlyArray<EvidenceRef> {
  const own = input.catalog.byObserverFinding.get(finding.id);
  // Supporting trace evidence from the identities the finding is
  // attributed to. The observer's own report is cited too, but it is a
  // second opinion rather than the primary basis: the structured trace
  // is what a reviewer can re-derive from the artifact alone.
  const trace = identityIds
    .flatMap((id) => input.catalog.evidenceForIdentity(id))
    .filter((r) => r.stance === 'supports');
  return dedupe([...(own === undefined ? [] : [own]), ...trace]);
}

function dedupe(refs: ReadonlyArray<EvidenceRef>): ReadonlyArray<EvidenceRef> {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/**
 * Which identities a finding is about.
 *
 * Derived from the identities that actually observed something in this
 * run, never from the whole cohort: attributing a finding to an identity
 * that produced no observation would make it unreproducible by that
 * identity, which `parseFinding` refuses. When the observer named no
 * step, every observing identity is a candidate; when it named one, the
 * identities that took that step are preferred, falling back to all of
 * them when the step index does not line up with a recorded event.
 */
function attributingIdentities(
  finding: ObserverFinding,
  input: MaterializeInput,
): ReadonlyArray<SyntheticIdentityId> {
  // Narrowed to identities that captured an observation, not to
  // identities that produced any record at all. A participant that never
  // opened the target still leaves a self-report shell behind, and
  // counting that as an observation is how a dead environment produces a
  // product finding.
  const observed = new Set(input.catalog.observedIdentityIds());
  const observing = input.observed.identityIds.filter((id) => observed.has(id));
  if (observing.length === 0) return Object.freeze([]);
  if (finding.stepIndex === null) return Object.freeze(observing);
  const atStep = observing.filter((id) =>
    input.catalog
      .evidenceForIdentity(id)
      .some((r) => r.locator.endsWith(`&step=${finding.stepIndex}`)),
  );
  return Object.freeze(atStep.length > 0 ? atStep : observing);
}

/**
 * The conditions a finding was observed under.
 *
 * All derived from declarations rather than inference. The `synthetic`
 * condition is included deliberately: the observation was made *by a
 * Synthetic Identity*, and ADR-0011's non-reality boundary means a
 * consumer must be able to see that from the record without already
 * knowing it.
 */
function buildConditions(input: MaterializeInput): ReadonlyArray<AffectedCondition> {
  const out: AffectedCondition[] = [
    { dimension: 'environment', value: input.target.environmentId },
    { dimension: 'synthetic', value: 'synthetic-identity' },
  ];
  for (const lifecycle of [...input.lifecycles].sort()) {
    out.push({ dimension: 'lifecycle', value: lifecycle });
  }
  return Object.freeze(out);
}

function buildLongitudinal(
  current: Pick<Finding, 'kind' | 'title'>,
  input: MaterializeInput,
): import('../review/index.js').LongitudinalChange {
  const { baseline } = input;
  // `change` is a comparative claim and needs a baseline to compare
  // against. `resolveLongitudinal` has already refused the two
  // incoherent cases (a release-transition mode with no baseline, a
  // point-in-time mode with one), so reaching here with `baseline ===
  // null` means the mode is `continuous` and the caller simply did not
  // supply an earlier run. That is "we did not compare", which is
  // `unknown` and not `unchanged`.
  const comparative = baseline !== null && input.baselineFindings !== undefined && input.baselineFindings.length > 0;
  const change: LongitudinalChange = {
    mode: input.mode,
    change: comparative ? classifyChange(current, input.baselineFindings) : 'unknown',
    baseline,
    observed: input.observed,
    note: comparative
      ? `Joined to baseline run ${baseline.runId}. A finding key present in both runs is ` +
        'classified `persisted`; one present only in this run is `introduced`.'
      : 'No comparable earlier observation of this program scope was supplied, so no ' +
        'comparative claim is made. `unknown` means "not compared", not "compared and saw no change".',
  };
  return change;
}
