/**
 * Independent observer runtime. Separate context from the participant;
 * receives the trace and emits findings.
 *
 * When the observer's Reasoner cannot produce a usable findings payload
 * after bounded recovery, the report says WHY instead of claiming the
 * observer "declined" (ADR-0008).
 */

import type { Reasoner } from '../domain/reasoner.js';
import type { ObserverReport } from '../domain/observer.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { RunEvent } from '../domain/evidence.js';
import { observerSystemPrompt } from './system-prompt.js';
import { fnv1aHex } from '../evidence/hash.js';
import {
  assertReasonerResponseContract,
  completeStructuredWithRecovery,
  requireObserverFindingsContent,
  resolveStructuredOutputPolicy,
  type StructuredAttemptFailure,
  type StructuredOutputPolicy,
  type ValidatedObserverFindingsContent,
} from '../reasoner/structured.js';

export interface ObserverRuntimeOptions {
  readonly runId: string;
  readonly reasoner: Reasoner;
  readonly recorder: EvidenceRecorder;
  readonly userStory: string;
  readonly participants: ReadonlyArray<{ participantId: string; personaPrompt: string }>;
  /** Overrides the structured-output recovery policy (ADR-0008). */
  readonly structuredOutputPolicy?: Partial<StructuredOutputPolicy>;
}

export async function runObserver(opts: ObserverRuntimeOptions): Promise<ObserverReport> {
  const events = await opts.recorder.snapshot();
  const trace = compactifyEvents(events);
  const userContent = [
    `User story: ${opts.userStory}`,
    '',
    'Compact trace:',
    ...trace.map((line) => `- ${line}`),
  ].join('\n');

  const promptDigest = fnv1aHex(observerSystemPrompt() + '\n' + userContent);

  await opts.recorder.append({
    type: 'observer.prompt',
    runId: opts.runId,
    ts: new Date().toISOString(),
    promptDigest,
  });

  const policy = resolveStructuredOutputPolicy(opts.structuredOutputPolicy);

  const recovery = await completeStructuredWithRecovery({
    reasoner: opts.reasoner,
    request: {
      systemPrompt: observerSystemPrompt(),
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 1024,
    },
    expectedKind: 'observerFindings',
    policy,
    validate: (response, outputKind) => {
      assertReasonerResponseContract(response, outputKind, {
        provider: opts.reasoner.providerId,
        modelId: opts.reasoner.modelId,
      });
    },
  });

  await recordReasonerFailures(opts.recorder, opts.runId, recovery.failures);

  const report: ObserverReport =
    recovery.status === 'ok'
      ? toObserverReport(
          requireObserverFindingsContent(recovery.value, {
            provider: opts.reasoner.providerId,
            modelId: opts.reasoner.modelId,
          }),
        )
      : unavailableObserverReport(opts.reasoner.providerId, recovery.failureKind, recovery.attempts);

  await opts.recorder.append({
    type: 'observer.response',
    runId: opts.runId,
    ts: new Date().toISOString(),
    report,
  });

  return report;
}

/**
 * The observer's own report must be honest about an unavailable
 * observation: `observer declined to produce findings` would be
 * indistinguishable from a real negative result.
 */
function unavailableObserverReport(
  provider: string,
  failureKind: string,
  attempts: number,
): ObserverReport {
  return {
    capturedAt: new Date().toISOString(),
    summary: `observer findings unavailable: reasoner ${failureKind} failure after ${attempts} attempt(s) (provider=${provider})`,
    findings: [],
    terminationVerdict: {
      declared: 'unknown',
      plausible: false,
      note:
        `No findings were produced because the observer Reasoner failed the structured-output ` +
        `contract (${failureKind}) after bounded recovery; this is a provider defect, not an ` +
        'observation that the run produced no usability signal.',
    },
  };
}

function toObserverReport(
  content: ValidatedObserverFindingsContent,
): ObserverReport {
  return {
    capturedAt: new Date().toISOString(),
    summary: content.summary,
    findings: content.findings.map((f) => ({
      id: f.id,
      stepIndex: f.stepIndex,
      severity: f.severity,
      category: f.category as ObserverReport['findings'][number]['category'],
      summary: f.summary,
      evidenceRefs: f.evidenceRefs,
    })),
    terminationVerdict: content.terminationVerdict,
  };
}

async function recordReasonerFailures(
  recorder: EvidenceRecorder,
  runId: string,
  failures: ReadonlyArray<StructuredAttemptFailure>,
): Promise<void> {
  for (const f of failures) {
    await recorder.append({
      type: 'reasoner.failure',
      runId,
      ts: f.ts,
      outputKind: f.outputKind,
      channel: f.channel,
      failureKind: f.failureKind,
      provider: f.provider,
      modelId: f.modelId,
      attempt: f.attempt,
      maxAttempts: f.maxAttempts,
      retryable: f.retryable,
      willRetry: f.willRetry,
      recoveryOutcome: f.recoveryOutcome,
      message: f.message,
      ...(f.httpStatus !== undefined ? { httpStatus: f.httpStatus } : {}),
      ...(f.excerpt !== undefined ? { excerpt: f.excerpt } : {}),
    });
  }
}

function compactifyEvents(events: ReadonlyArray<RunEvent>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'run.start': out.push(`run.start ${e.runId} seed=${e.seed}`); break;
      case 'step.start': out.push(`step.start p=${e.participantId} step=${e.stepIndex}`); break;
      case 'observation.captured': out.push(`observation p=${e.participantId} step=${e.stepIndex} url=${e.url} title="${e.title}"`); break;
      case 'action': out.push(`action p=${e.participantId} step=${e.stepIndex} ${JSON.stringify(e.action)}`); break;
      case 'action.result': out.push(`action.result p=${e.participantId} step=${e.stepIndex} ${e.result.status}`); break;
      case 'capability.violation': out.push(`capability.violation p=${e.participantId} axis=${e.axis} reason=${e.reason.slice(0, 60)}`); break;
      case 'reasoner.failure':
        out.push(
          `reasoner.failure channel=${e.channel} kind=${e.failureKind} provider=${e.provider} ` +
          `attempt=${e.attempt}/${e.maxAttempts} retryable=${e.retryable} outcome=${e.recoveryOutcome} ` +
          `message="${e.message.slice(0, 80)}"`,
        );
        break;
      case 'termination': out.push(`termination p=${e.participantId} reason=${e.reason}`); break;
      case 'selfReport.response': out.push(`selfReport p=${e.participantId} confidence=${e.report.confidence} wouldReturn=${e.report.wouldReturn}`); break;
      case 'observer.response': out.push(`observer summary="${e.report.summary.slice(0, 60)}" findings=${e.report.findings.length}`); break;
      case 'reasoner.request': out.push(`reasoner.request p=${e.participantId} step=${e.stepIndex} digest=${e.promptHash}`); break;
      case 'reasoner.response': out.push(`reasoner.response p=${e.participantId} step=${e.stepIndex} kind=${e.response.kind}`); break;
      case 'run.end': out.push(`run.end duration=${e.durationMs}ms`); break;
      case 'selfReport.prompt':
      case 'observer.prompt':
        /* skip (prompt-shaped content could leak participant context if logged at length) */
        break;
    }
  }
  return out;
}
