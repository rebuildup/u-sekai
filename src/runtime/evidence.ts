/**
 * Evidence materialisation (issue #63).
 *
 * ## Why the runtime has to do this
 *
 * `BehavioralEvidence` in `src/domain/evidence.ts` is a rollup: counts,
 * step sequences and a `runtimeErrors` array. It carries no *handles*.
 * #61's `Finding` requires `evidenceRefs` whose every entry has an
 * `EvidenceId` and a `locator` a reviewer can follow, and
 * `assertSupportsClaim` rejects a finding that cites nothing supporting
 * it. Somebody has to turn a run into those references, and since #72's
 * ticket is explicitly about widening `BehavioralEvidence` itself, this
 * module is the interim seam #61's design anticipated: it reads the
 * existing rollup and the existing event stream and emits #61 references
 * without editing either.
 *
 * ## Determinism
 *
 * Every handle is `deriveEvidenceId(seed)` (#61) over content that is
 * already fixed: the run id, the event family, the participant, the
 * step. Nothing here reads a clock or a counter. Two executions of the
 * same run therefore produce the same handles, which is what lets
 * `recordObservation`'s "replacing any earlier one from the same run"
 * semantics and #64's evidence joins agree with each other.
 *
 * ## Locators are paths, not prose
 *
 * A locator names where inside the run's artifact to look
 * (`events.ndjson#type=action.result&participant=idn-a&step=3`), and the
 * runtime writes exactly those files. A locator that pointed at
 * something the run did not write would satisfy `requireNonEmptyString`
 * and be useless to a reviewer, so the catalogue is constructed
 * alongside the writer and every locator names a file the runtime
 * actually produced.
 */

import {
  deriveEvidenceId,
  parseEvidenceRef,
  type EvidenceRef,
} from '../review/index.js';
import type {
  BehavioralEvidence,
  RunEvent,
  StoredObservation,
  TerminationReason,
} from '../domain/evidence.js';
import type { ObserverReport } from '../domain/observer.js';
import type { SelfReport } from '../domain/self-report.js';
import { fnv1aHex } from '../evidence/hash.js';
import { VERSION } from '../version.js';

/** One identity's contribution to a run. */
export interface IdentityRunRecord {
  /** The durable `SyntheticIdentityId`, which is also the event `participantId`. */
  readonly identityId: string;
  readonly selfReport: SelfReport;
  readonly terminationReason: TerminationReason;
  readonly observations: ReadonlyArray<StoredObservation>;
  /** `runParticipant`'s own failure diagnostic, when it produced one. */
  readonly error?: string;
}

/**
 * Everything the run produced, in the form the catalogue reads.
 *
 * This is a *structural* description, not a re-declaration: it holds
 * the existing run types by reference and adds nothing to them. A
 * finding's evidence reference and the run's own rollup therefore
 * describe the same observations.
 */
export interface RunEvidenceInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly seed: string;
  readonly experimentPath: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly identities: ReadonlyArray<IdentityRunRecord>;
  readonly observer: ObserverReport;
}

/**
 * The evidence handles one run produced, indexed by what produced them.
 *
 * The index exists so a finding can cite the evidence that actually
 * supports *it* rather than everything the run happened to record. An
 * observer finding that concerns a specific step cites that step's
 * trace, not the entire event stream.
 */
export class EvidenceCatalogue {
  readonly all: ReadonlyArray<EvidenceRef>;
  readonly byEventFamily: ReadonlyMap<string, ReadonlyArray<EvidenceRef>>;
  readonly byParticipant: ReadonlyMap<string, ReadonlyArray<EvidenceRef>>;
  readonly byObserverFinding: ReadonlyMap<string, EvidenceRef>;
  readonly bySelfReport: ReadonlyMap<string, EvidenceRef>;
  readonly runtimeErrors: ReadonlyArray<{ ts: string; where: string; message: string }>;
  /** Identities with at least one captured observation. */
  readonly #observed = new Set<string>();

  constructor(input: RunEvidenceInput) {
    const byEventFamily = new Map<string, EvidenceRef[]>();
    const byParticipant = new Map<string, EvidenceRef[]>();
    const byObserverFinding = new Map<string, EvidenceRef>();
    const bySelfReport = new Map<string, EvidenceRef>();

    const add = (ref: EvidenceRef, family: string, participant?: string): void => {
      const familyBucket = byEventFamily.get(family);
      if (familyBucket === undefined) byEventFamily.set(family, [ref]);
      else familyBucket.push(ref);
      if (participant !== undefined) {
        const participantBucket = byParticipant.get(participant);
        if (participantBucket === undefined) byParticipant.set(participant, [ref]);
        else participantBucket.push(ref);
      }
    };

    // --- Structured trace: one handle per event that carries an observation.
    for (const event of input.events) {
      if (event.type !== 'observation.captured') continue;
      const ref = makeRef({
        seed: `${input.runId}|observation|${event.participantId}|${event.stepIndex}`,
        channel: 'structuredTrace',
        stance: 'supports',
        locator:
          `events.ndjson#type=observation.captured&participant=${event.participantId}` +
          `&step=${event.stepIndex}`,
        observedAt: event.ts,
        summary: `step ${event.stepIndex} observed "${event.title}" at ${event.url}`,
      });
      add(ref, 'observation.captured', event.participantId);
      this.#observed.add(event.participantId);
    }

    // --- Structured trace: one handle per action result, which is where a
    // dead end, a no-op and a refused action actually become visible.
    for (const event of input.events) {
      if (event.type !== 'action.result') continue;
      const detail =
        event.result.status === 'ok'
          ? 'ok'
          : event.result.status === 'noop'
            ? `noop: ${event.result.note}`
            : `error: ${event.result.note}`;
      const ref = makeRef({
        seed: `${input.runId}|action.result|${event.participantId}|${event.stepIndex}`,
        channel: 'structuredTrace',
        stance: event.result.status === 'ok' ? 'inconclusive' : 'supports',
        locator:
          `events.ndjson#type=action.result&participant=${event.participantId}&step=${event.stepIndex}`,
        observedAt: event.ts,
        summary: `step ${event.stepIndex} action result ${detail}`,
      });
      add(ref, 'action.result', event.participantId);
    }

    // --- Structured trace: terminations, so "how it ended" is citable.
    for (const event of input.events) {
      if (event.type !== 'termination') continue;
      const ref = makeRef({
        seed: `${input.runId}|termination|${event.participantId}`,
        channel: 'structuredTrace',
        stance: 'inconclusive',
        locator: `events.ndjson#type=termination&participant=${event.participantId}`,
        observedAt: event.ts,
        summary: `${event.participantId} terminated (${event.reason})`,
      });
      add(ref, 'termination', event.participantId);
    }

    // --- Participant self-report, one handle per identity.
    for (const record of input.identities) {
      const ref = makeRef({
        seed: `${input.runId}|selfReport|${record.identityId}`,
        channel: 'participantSelfReport',
        stance: 'supports',
        locator: `self-report/${record.identityId}.json`,
        observedAt: record.selfReport.capturedAt,
        summary:
          record.selfReport.confusionPoints.length > 0
            ? `self-report: ${record.selfReport.confusionPoints.length} confusion point(s); ` +
              `${record.selfReport.confusionPoints[0] ?? ''}`.slice(0, 500)
            : `self-report: goal "${record.selfReport.goal || '(none)'}", ` +
              `would return: ${record.selfReport.wouldReturn ? 'yes' : 'no'}`,
      });
      bySelfReport.set(record.identityId, ref);
      add(ref, 'selfReport', record.identityId);
    }

    // --- Observer findings, one handle each.
    for (const finding of input.observer.findings) {
      const ref = makeRef({
        seed: `${input.runId}|observer|${finding.id}`,
        channel: 'observer',
        stance: 'supports',
        locator: `observer-report.json#findings[${finding.id}]`,
        observedAt: input.observer.capturedAt,
        summary: `[${finding.severity}/${finding.category}] ${finding.summary}`.slice(0, 500),
      });
      byObserverFinding.set(finding.id, ref);
      add(ref, 'observer');
    }

    // --- The observer's own report, citable on its own so a finding whose
    // summary is the summary can still be evidence-backed.
    const reportRef = makeRef({
      seed: `${input.runId}|observer|report`,
      channel: 'observer',
      stance: 'supports',
      locator: 'observer-report.json',
      observedAt: input.observer.capturedAt,
      summary: input.observer.summary.slice(0, 500) || '(observer produced no summary)',
    });
    add(reportRef, 'observerReport');

    this.all = Object.freeze([...byEventFamily.values()].flat());
    this.byEventFamily = freezeMap(byEventFamily);
    this.byParticipant = freezeMap(byParticipant);
    this.byObserverFinding = new Map(byObserverFinding);
    this.bySelfReport = new Map(bySelfReport);
    this.runtimeErrors = Object.freeze(
      rollUpRuntimeErrors(input.events, input.identities, input.endedAt).map((e) =>
        Object.freeze({ ...e }),
      ),
    );
  }

  /** Handles for one identity's own contribution to the run. */
  evidenceForIdentity(identityId: string): ReadonlyArray<EvidenceRef> {
    return this.byParticipant.get(identityId) ?? Object.freeze([]);
  }

  /**
   * Identities that actually observed the product, ascending.
   *
   * Deliberately narrower than "identities that have any evidence at
   * all". A participant that could not open the target still gets a
   * self-report shell and a termination record, so a has-any-evidence
   * test would count it as having observed something — and a finding
   * would then be attributed to a run that saw no page. The test is
   * therefore specifically for a captured observation, which is the
   * only event that means "this identity saw the product".
   */
  observedIdentityIds(): ReadonlyArray<string> {
    return Object.freeze([...this.#observed].sort());
  }

  /** Handles for one event family, in event order. */
  evidenceForFamily(family: string): ReadonlyArray<EvidenceRef> {
    return this.byEventFamily.get(family) ?? Object.freeze([]);
  }

  /** Every handle, for the run lineage. */
  evidenceIds(): ReadonlyArray<import('../product/index.js').EvidenceId> {
    return Object.freeze(this.all.map((r) => r.id));
  }
}

function makeRef(input: {
  readonly seed: string;
  readonly channel: EvidenceRef['channel'];
  readonly stance: EvidenceRef['stance'];
  readonly locator: string;
  readonly observedAt: string;
  readonly summary: string;
}): EvidenceRef {
  return parseEvidenceRef({
    id: deriveEvidenceId(input.seed),
    channel: input.channel,
    stance: input.stance,
    locator: input.locator,
    observedAt: input.observedAt,
    summary: input.summary,
  });
}

function freezeMap<T>(map: Map<string, T[]>): ReadonlyMap<string, ReadonlyArray<T>> {
  const out = new Map<string, ReadonlyArray<T>>();
  for (const [key, value] of map) out.set(key, Object.freeze([...value]));
  return out;
}

/**
 * The run's runtime-error rollup.
 *
 * Mirrors what `src/experiment/runner.ts` does for an experiment run,
 * from the same two sources — typed `capability.violation` events, then
 * each participant's own failure diagnostic — and adds one thing: a
 * participant diagnostic that a `capability.violation` already carries
 * is not counted twice.
 *
 * The reason this is reimplemented rather than imported is that
 * `buildBehavioralEvidence` is private to the experiment runner and its
 * public entry point, `runExperiment`, owns the whole experiment shape
 * (definition, artifact layout, observer wiring) that this ticket is not
 * allowed to change. #63 is a *different* entry point into the same
 * Participant / observer primitives, so it needs its own rollup. The
 * semantics are kept identical so a consumer cannot tell the two
 * apart by shape.
 */
function rollUpRuntimeErrors(
  events: ReadonlyArray<RunEvent>,
  identities: ReadonlyArray<IdentityRunRecord>,
  endedAt: string,
): ReadonlyArray<{ ts: string; where: string; message: string }> {
  const errors: { ts: string; where: string; message: string }[] = events
    .filter((e): e is Extract<RunEvent, { type: 'capability.violation' }> => e.type === 'capability.violation')
    .map((e) => ({
      ts: e.ts,
      where: `participant=${e.participantId} step=${e.stepIndex} axis=${e.axis}`,
      message: e.reason,
    }));

  for (const record of identities) {
    if (record.error === undefined || record.error === '') continue;
    if (alreadyRecorded(events, record.identityId, record.error)) continue;
    const lastStep = lastStepIndexOf(events, record.identityId);
    const termination = events
      .filter(
        (e): e is Extract<RunEvent, { type: 'termination' }> =>
          e.type === 'termination' && e.participantId === record.identityId,
      )
      .at(-1);
    errors.push({
      ts: termination?.ts ?? endedAt,
      where: `participant=${record.identityId}${lastStep === undefined ? '' : ` step=${lastStep}`}`,
      message: record.error,
    });
  }

  return Object.freeze(errors);
}

function alreadyRecorded(
  events: ReadonlyArray<RunEvent>,
  participantId: string,
  message: string,
): boolean {
  return events.some(
    (e) =>
      e.type === 'capability.violation' &&
      e.participantId === participantId &&
      e.reason === message,
  );
}

function lastStepIndexOf(events: ReadonlyArray<RunEvent>, participantId: string): number | undefined {
  let last: number | undefined;
  for (const e of events) {
    if (!('participantId' in e) || e.participantId !== participantId) continue;
    if (!('stepIndex' in e) || typeof e.stepIndex !== 'number') continue;
    if (last === undefined || e.stepIndex > last) last = e.stepIndex;
  }
  return last;
}

/**
 * Roll a run up into the `BehavioralEvidence` shape the artifact writer
 * and #63's own diagnostics share.
 *
 * `experimentSummaryHash` uses the same `type@ts` recipe as
 * `src/experiment/runner.ts` so a consumer that correlates two runs
 * sees one convention.
 */
export function rollUpBehavioralEvidence(input: {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly identities: ReadonlyArray<IdentityRunRecord>;
  readonly catalog: EvidenceCatalogue;
  readonly participantConfigurations: ReadonlyArray<{
    readonly participantId: string;
    readonly personaPrompt: string;
    readonly capability: import('../domain/capability.js').CapabilityProfile;
  }>;
}): BehavioralEvidence {
  const stepCountByParticipant: Record<string, number> = {};
  const actionSequencesByParticipant: Record<
    string,
    ReadonlyArray<import('../domain/capability.js').ParticipantAction>
  > = {};
  const navigationsByParticipant: Record<
    string,
    ReadonlyArray<{ step: number; from: string; to: string }>
  > = {};
  const terminationReasonByParticipant: Record<string, TerminationReason> = {};

  for (const record of input.identities) {
    stepCountByParticipant[record.identityId] = record.observations.length;
    actionSequencesByParticipant[record.identityId] = Object.freeze(
      input.events
        .filter(
          (e): e is Extract<RunEvent, { type: 'action' }> =>
            e.type === 'action' && e.participantId === record.identityId,
        )
        .map((e) => e.action),
    );
    const navs: { step: number; from: string; to: string }[] = [];
    let previous: { url: string } | null = null;
    for (const obs of record.observations) {
      if (previous && previous.url !== obs.observation.url) {
        navs.push({ step: obs.stepIndex, from: previous.url, to: obs.observation.url });
      }
      previous = { url: obs.observation.url };
    }
    navigationsByParticipant[record.identityId] = Object.freeze(navs);
    terminationReasonByParticipant[record.identityId] = record.terminationReason;
  }

  return {
    runId: input.runId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Date.parse(input.endedAt) - Date.parse(input.startedAt),
    stepCountByParticipant,
    actionSequencesByParticipant,
    navigationsByParticipant,
    runtimeErrors: input.catalog.runtimeErrors,
    reasonerFailures: Object.freeze(
      input.events
        .filter(
          (e): e is Extract<RunEvent, { type: 'reasoner.failure' }> => e.type === 'reasoner.failure',
        )
        .map((f) =>
          Object.freeze({
            ts: f.ts,
            where:
              `channel=${f.channel} outputKind=${f.outputKind} participant=${f.participantId ?? 'n/a'} ` +
              `step=${f.stepIndex ?? 'n/a'} attempt=${f.attempt}/${f.maxAttempts}`,
            channel: f.channel,
            outputKind: f.outputKind,
            failureKind: f.failureKind,
            provider: f.provider,
            modelId: f.modelId,
            attempt: f.attempt,
            maxAttempts: f.maxAttempts,
            retryable: f.retryable,
            recoveryOutcome: f.recoveryOutcome,
            message: f.message,
          }),
        ),
    ),
    terminationReasonByParticipant,
    participantConfigurations: input.participantConfigurations,
    experimentSummaryHash: fnv1aHex(
      `${input.events.map((e) => `${e.type}@${e.ts}`).join('|')}|${VERSION}`,
    ),
  };
}
