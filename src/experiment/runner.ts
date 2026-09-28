/**
 * Experiment runner. Orchestrates participants -> observer -> artifact.
 */

import { promises as fs } from 'node:fs';
import type {
  ExperimentDefinition,
} from '../domain/experiment.js';
import type {
  RunEvent,
  BehavioralEvidence,
  TerminationEvent,
  StoredObservation,
} from '../domain/evidence.js';
import type { RunResult } from '../domain/result.js';
import type { SelfReport } from '../domain/self-report.js';
import type { Reasoner } from '../domain/reasoner.js';
import type { BrowserAdapter } from '../adapter/browser/interface.js';
import { InMemoryRecorder } from '../evidence/recorder.js';
import { FileArtifactIO } from '../evidence/artifact.js';
import { createReasoner } from '../reasoner/interface.js';
import { runParticipant } from '../participant/runtime.js';
import { runObserver } from '../observer/runtime.js';
import { fnv1aHex } from '../evidence/hash.js';
import { VERSION } from '../version.js';

export interface RunExperimentOptions {
  readonly experiment: ExperimentDefinition;
  readonly adapterFactory: (experiment: ExperimentDefinition) => BrowserAdapter;
  /** Resolve the target URL for a given environment + participantId. */
  readonly resolveTargetUrl: (env: ExperimentDefinition['environment']) => string;
  readonly reasonerOverrides?: {
    readonly perParticipant?: Partial<Record<string, { provider: 'scripted' | 'anthropic' }>>;
    readonly observer?: { provider: 'scripted' | 'anthropic' };
  };
}

export interface RunExperimentResult {
  readonly result: RunResult;
  readonly runId: string;
}

/**
 * A participant-scoped failure captured in `evidence.runtimeErrors`.
 */
export interface RuntimeErrorEntry {
  readonly ts: string;
  readonly where: string;
  readonly message: string;
}

/**
 * What the runner keeps from one participant run. `error` is the runtime
 * diagnostic returned by `runParticipant`; it is the only place a failed
 * participant's reason survives, so it must not be dropped here.
 */
interface CollectedParticipant {
  readonly participant: ExperimentDefinition['participants'][number];
  readonly selfReport: SelfReport;
  readonly terminationReason: TerminationEvent['reason'];
  readonly observations: StoredObservation[];
  readonly error?: string;
}

export async function runExperiment(opts: RunExperimentOptions): Promise<RunExperimentResult> {
  const runId = newRunId(opts.experiment.seed);
  const startedAt = new Date().toISOString();
  await fs.mkdir(opts.experiment.outDir, { recursive: true });

  const recorder = new InMemoryRecorder();
  await recorder.append({
    type: 'run.start',
    runId,
    ts: startedAt,
    experimentPath: opts.experiment.outDir,
    seed: opts.experiment.seed,
    packageVersion: VERSION,
  });

  const targetUrl = opts.resolveTargetUrl(opts.experiment.environment);

  const participants: CollectedParticipant[] = [];

  for (const p of opts.experiment.participants) {
    const adapter = opts.adapterFactory(opts.experiment);
    const reasonerOverride = opts.reasonerOverrides?.perParticipant?.[p.id];
    const reasonerCfg = reasonerOverride
      ? { ...p.reasoner, ...reasonerOverride }
      : p.reasoner;
    const reasoner: Reasoner = createReasoner(reasonerCfg, {
      role: 'participant',
      participantLabel: `${opts.experiment.id}:${p.id}`,
    });

    const participantObs = await runParticipantAndCollect(
      runId,
      p,
      targetUrl,
      adapter,
      reasoner,
      recorder,
      opts.experiment.userStory,
      opts.experiment.budget.maxStepsPerParticipant,
    );
    participants.push(participantObs);
  }

  // Observer
  const observerConfig = opts.reasonerOverrides?.observer
    ? { ...opts.experiment.observer, ...opts.reasonerOverrides.observer }
    : opts.experiment.observer;
  const observerReasoner = createReasoner(observerConfig, { role: 'observer' });
  const observerReport = await runObserver({
    runId,
    reasoner: observerReasoner,
    recorder,
    userStory: opts.experiment.userStory,
    participants: opts.experiment.participants.map((p) => ({ participantId: p.id, personaPrompt: p.personaPrompt })),
  });

  const endedAt = new Date().toISOString();

  // Build behavioral evidence and result.
  const evidence = buildBehavioralEvidence(runId, startedAt, endedAt, participants, await recorder.snapshot());
  const result: RunResult = {
    runId,
    experimentPath: opts.experiment.outDir,
    seed: opts.experiment.seed,
    startedAt,
    endedAt,
    terminationReasons: Object.fromEntries(
      participants.map((p) => [p.participant.id, p.terminationReason]),
    ),
    participants: participants.map((p) => ({
      participantId: p.participant.id,
      selfReport: p.selfReport,
    })),
    observer: observerReport,
    evidence,
  };

  await recorder.append({
    type: 'run.end',
    runId,
    ts: endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
  });

  // Persist artifact
  await writeArtifact(opts.experiment.outDir, runId, opts.experiment, recorder, participants, observerReport, result);

  return { result, runId };
}

function newRunId(seed: string): string {
  return `${seed}-${fnv1aHex(Date.now().toString() + seed)}`;
}

async function runParticipantAndCollect(
  runId: string,
  participant: ExperimentDefinition['participants'][number],
  targetUrl: string,
  adapter: BrowserAdapter,
  reasoner: Reasoner,
  recorder: InMemoryRecorder,
  userStory: string,
  budget: number,
): Promise<CollectedParticipant> {
  const observations: StoredObservation[] = [];

  const outcome = await runParticipant({
    runId,
    participantId: participant.id,
    personaPrompt: participant.personaPrompt,
    userStory,
    capability: participant.capability,
    reasoner,
    adapter,
    targetUrl,
    budget,
    recorder,
    onStepObservation: async (obs) => {
      observations.push({
        participantId: participant.id,
        stepIndex: obs.stepIndex,
        observation: obs,
      });
    },
  });

  const lastEvent = (await recorder.snapshot())
    .filter((e) => e.type === 'termination' && e.participantId === participant.id)
    .at(-1);
  const reason = lastEvent && lastEvent.type === 'termination' ? lastEvent.reason : 'error';

  return {
    participant,
    selfReport: outcome.selfReport,
    terminationReason: reason,
    observations,
    // `outcome.error` is the participant's failure diagnostic. Dropping it
    // here is what made a failed run indistinguishable from a clean one at
    // every consumer surface.
    ...(outcome.error !== undefined && outcome.error !== '' ? { error: outcome.error } : {}),
  };
}

function buildBehavioralEvidence(
  runId: string,
  startedAt: string,
  endedAt: string,
  participants: ReadonlyArray<CollectedParticipant>,
  events: ReadonlyArray<RunEvent>,
): BehavioralEvidence {
  const stepCountByParticipant: Record<string, number> = {};
  const actionSequencesByParticipant: Record<string, import('../domain/capability.js').ParticipantAction[]> = {};
  const navigationsByParticipant: Record<string, Array<{ step: number; from: string; to: string }>> = {};
  const participantConfigurations: Array<{
    participantId: string;
    personaPrompt: string;
    capability: import('../domain/capability.js').CapabilityProfile;
  }> = [];
  const terminationReasonByParticipant: Record<string, TerminationEvent['reason']> = {};

  for (const p of participants) {
    stepCountByParticipant[p.participant.id] = p.observations.length;
    actionSequencesByParticipant[p.participant.id] = events
      .filter((e) => e.type === 'action' && e.participantId === p.participant.id)
      .map((e) => (e as Extract<typeof e, { type: 'action' }>).action);
    const navs: Array<{ step: number; from: string; to: string }> = [];
    let prev: { url: string } | null = null;
    for (const obs of p.observations) {
      const u = obs.observation.url;
      if (prev && prev.url !== u) {
        navs.push({ step: obs.stepIndex, from: prev.url, to: u });
      }
      prev = { url: u };
    }
    navigationsByParticipant[p.participant.id] = navs;
    participantConfigurations.push({
      participantId: p.participant.id,
      personaPrompt: p.participant.personaPrompt,
      capability: p.participant.capability,
    });
    terminationReasonByParticipant[p.participant.id] = p.terminationReason;
  }

  // `runtimeErrors` is the run's runtime-error rollup. It starts from the
  // typed `capability.violation` events and then adds the per-participant
  // runtime diagnostics that `runParticipant` returned, so a failed
  // participant is diagnosable from the artifact alone instead of only from
  // the process exit code.
  const runtimeErrors: RuntimeErrorEntry[] = events
    .filter((e) => e.type === 'capability.violation')
    .map((e) => {
      const ce = e as Extract<typeof e, { type: 'capability.violation' }>;
      return {
        ts: ce.ts,
        where: `participant=${ce.participantId} step=${ce.stepIndex} axis=${ce.axis}`,
        message: ce.reason,
      };
    });

  for (const p of participants) {
    if (p.error === undefined || p.error === '') continue;
    const participantId = p.participant.id;
    if (isRuntimeErrorAlreadyRecorded(events, participantId, p.error)) continue;
    const lastStepIndex = lastStepIndexOf(events, participantId);
    const terminationEvent = events
      .filter((e) => e.type === 'termination' && e.participantId === participantId)
      .at(-1);
    runtimeErrors.push({
      ts: terminationEvent && terminationEvent.type === 'termination' ? terminationEvent.ts : endedAt,
      where: `participant=${participantId}${lastStepIndex === undefined ? '' : ` step=${lastStepIndex}`}`,
      message: p.error,
    });
  }

  return {
    runId,
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    stepCountByParticipant,
    actionSequencesByParticipant,
    navigationsByParticipant,
    runtimeErrors,
    terminationReasonByParticipant,
    participantConfigurations,
    experimentSummaryHash: fnv1aHex(events.map((e) => `${e.type}@${e.ts}`).join('|')),
  };
}

/**
 * Highest step index recorded for a participant, or `undefined` when the
 * participant produced no step event (for example, a target it could not
 * even open).
 */
function lastStepIndexOf(
  events: ReadonlyArray<RunEvent>,
  participantId: string,
): number | undefined {
  let last: number | undefined;
  for (const e of events) {
    if (!('participantId' in e) || e.participantId !== participantId) continue;
    if (!('stepIndex' in e) || typeof e.stepIndex !== 'number') continue;
    if (last === undefined || e.stepIndex > last) last = e.stepIndex;
  }
  return last;
}

/**
 * True when a `capability.violation` event for this participant already
 * carries exactly this diagnostic, i.e. the runtime error is the same
 * failure and already has its own `runtimeErrors` entry. Matching on the
 * message rather than on the termination reason keeps a *different* failure
 * from being suppressed just because the participant ended in the same way.
 */
export function isRuntimeErrorAlreadyRecorded(
  events: ReadonlyArray<RunEvent>,
  participantId: string,
  message: string,
): boolean {
  return events.some(
    (e) => e.type === 'capability.violation' && e.participantId === participantId && e.reason === message,
  );
}

const PARTICIPANT_IN_WHERE = /(?:^|\s)participant=(\S+)/;

/** The `runtimeErrors` entries that belong to one participant. */
export function runtimeErrorsForParticipant(
  evidence: BehavioralEvidence,
  participantId: string,
): ReadonlyArray<RuntimeErrorEntry> {
  return evidence.runtimeErrors.filter(
    (e) => PARTICIPANT_IN_WHERE.exec(e.where)?.[1] === participantId,
  );
}

async function writeArtifact(
  outDir: string,
  runId: string,
  experiment: ExperimentDefinition,
  recorder: InMemoryRecorder,
  participants: ReadonlyArray<CollectedParticipant>,
  observerReport: import('../domain/observer.js').ObserverReport,
  result: RunResult,
): Promise<void> {
  const io = new FileArtifactIO({ rootDir: outDir, runId });
  const allEvents = await recorder.snapshot();

  await io.writeManifest({
    runId,
    experimentId: experiment.id,
    seed: experiment.seed,
    experimentPath: experiment.outDir,
    packageVersion: VERSION,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    terminationReasons: result.terminationReasons,
    participants: experiment.participants.map((p) => ({
      id: p.id,
      personaPrompt: p.personaPrompt,
      capability: p.capability,
      reasoner: p.reasoner,
    })),
    observer: experiment.observer,
    target: experiment.environment,
  });

  await io.writeParticipants(Object.fromEntries(experiment.participants.map((p) => [p.id, {
    personaPrompt: p.personaPrompt,
    capability: p.capability,
    reasoner: p.reasoner,
  }])));

  await io.writeEvents(allEvents);

  for (const p of participants) {
    for (const obs of p.observations) {
      await io.writeObservation(p.participant.id, obs.stepIndex, obs.observation);
    }
    await io.writeSelfReport(p.participant.id, p.selfReport);
  }

  await io.writeObserverReport(observerReport);
  await io.writeResult(result);
  await io.writeSummary(renderSummary(result, participants));
  await io.finalize();
}

function renderSummary(result: RunResult, participants: ReadonlyArray<CollectedParticipant>): string {
  const diagnosticsByParticipant = new Map<string, string[]>();
  for (const p of participants) {
    if (p.error !== undefined && p.error !== '') {
      diagnosticsByParticipant.set(p.participant.id, [p.error]);
    }
  }

  const lines: string[] = [];
  lines.push(`# Run ${result.runId}`);
  lines.push('');
  lines.push(`- Experiment: ${result.experimentPath}`);
  lines.push(`- Seed: ${result.seed}`);
  lines.push(`- Started: ${result.startedAt}`);
  lines.push(`- Ended: ${result.endedAt}`);
  lines.push('');
  for (const [id, reason] of Object.entries(result.terminationReasons)) {
    // A failed participant must be readable here without opening
    // `result.json`: `terminated (error)` on its own does not say why.
    const diagnostic = diagnosticsByParticipant.get(id);
    const suffix = diagnostic === undefined ? '' : ` -- ${singleLine(diagnostic[0] ?? '')}`;
    lines.push(`- Participant ${id}: terminated (${reason})${suffix}`);
  }
  lines.push('');
  lines.push('## Self-reports');
  for (const p of result.participants) {
    const r = p.selfReport;
    lines.push(`### ${p.participantId}`);
    lines.push(`- Goal: ${r.goal || '(none)'}`);
    lines.push(`- Understanding: ${r.productUnderstanding || '(none)'}`);
    lines.push(`- Confidence: ${r.confidence.toFixed(2)}`);
    lines.push(`- Would return: ${r.wouldReturn ? 'yes' : 'no'}`);
    lines.push(`- Free text: ${r.freeText || '(none)'}`);
    lines.push('');
  }
  lines.push('## Observer findings');
  lines.push(result.observer.summary || '(none)');
  for (const f of result.observer.findings) {
    lines.push(`- [${f.severity}] (${f.category}) ${f.summary}`);
  }
  return lines.join('\n');
}

/** Collapse a diagnostic to one line so a bullet stays one bullet. */
function singleLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : '(no diagnostic recorded)';
}
