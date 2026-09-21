/**
 * Independent observer runtime. Separate context from the participant;
 * receives the trace and emits findings.
 */

import type { Reasoner } from '../domain/reasoner.js';
import type { ObserverReport } from '../domain/observer.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { RunEvent } from '../domain/evidence.js';
import { observerSystemPrompt } from './system-prompt.js';
import { fnv1aHex } from '../evidence/hash.js';

export interface ObserverRuntimeOptions {
  readonly runId: string;
  readonly reasoner: Reasoner;
  readonly recorder: EvidenceRecorder;
  readonly userStory: string;
  readonly participants: ReadonlyArray<{ participantId: string; personaPrompt: string }>;
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

  const response = await opts.reasoner.complete({
    systemPrompt: observerSystemPrompt(),
    messages: [
      { role: 'user', content: userContent },
    ],
    maxTokens: 1024,
  });

  let report: ObserverReport;
  if (response.kind === 'observerFindings') {
    report = parseObserverContent(response.content, opts.participants[0]?.participantId ?? '');
  } else {
    report = {
      capturedAt: new Date().toISOString(),
      summary: 'observer declined to produce findings',
      findings: [],
      terminationVerdict: {
        declared: 'unknown',
        plausible: false,
        note: 'observer response was not an observerFindings shape',
      },
    };
  }

  await opts.recorder.append({
    type: 'observer.response',
    runId: opts.runId,
    ts: new Date().toISOString(),
    report,
  });

  return report;
}

function parseObserverContent(content: Record<string, unknown>, _participantHint: string): ObserverReport {
  const summary = typeof content.summary === 'string' ? content.summary : '';
  const findingsRaw = Array.isArray(content.findings) ? content.findings : [];
  const findings = findingsRaw.map((f, idx) => {
    if (typeof f !== 'object' || f === null) {
      return {
        id: `f-${idx}`,
        stepIndex: null,
        severity: 'info' as const,
        category: 'positive' as const,
        summary: 'unparseable finding',
        evidenceRefs: [],
      };
    }
    const o = f as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : `f-${idx}`;
    const stepIndex = typeof o.stepIndex === 'number' ? o.stepIndex : null;
    const severity = (isSeverity(o.severity) ? o.severity : 'info');
    const category = (isCategory(o.category) ? o.category : 'positive');
    const summary = typeof o.summary === 'string' ? o.summary : '';
    const evRaw = Array.isArray(o.evidenceRefs) ? o.evidenceRefs : [];
    const evidenceRefs = evRaw
      .map((e) => {
        if (typeof e !== 'object' || e === null) return null;
        const er = e as Record<string, unknown>;
        if (er.kind !== 'event' && er.kind !== 'observation' && er.kind !== 'selfReport') return null;
        if (typeof er.ref !== 'string') return null;
        return { kind: er.kind, ref: er.ref };
      })
      .filter((x): x is { kind: 'event' | 'observation' | 'selfReport'; ref: string } => x !== null);
    return { id, stepIndex, severity, category, summary, evidenceRefs };
  });

  const verdictRaw = (typeof content.terminationVerdict === 'object' && content.terminationVerdict !== null)
    ? content.terminationVerdict as Record<string, unknown>
    : {};
  const declared = typeof verdictRaw.declared === 'string' ? verdictRaw.declared : '';
  const plausible = Boolean(verdictRaw.plausible);
  const note = typeof verdictRaw.note === 'string' ? verdictRaw.note : '';

  return {
    capturedAt: new Date().toISOString(),
    summary,
    findings,
    terminationVerdict: { declared, plausible, note },
  };
}

function isSeverity(v: unknown): v is 'info' | 'minor' | 'major' | 'critical' {
  return v === 'info' || v === 'minor' || v === 'major' || v === 'critical';
}

function isCategory(v: unknown): v is 'dead_end' | 'friction' | 'confusion' | 'trust' | 'navigation' | 'timing' | 'error' | 'positive' {
  return (
    v === 'dead_end' ||
    v === 'friction' ||
    v === 'confusion' ||
    v === 'trust' ||
    v === 'navigation' ||
    v === 'timing' ||
    v === 'error' ||
    v === 'positive'
  );
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
