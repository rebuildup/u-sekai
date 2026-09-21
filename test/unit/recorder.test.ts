import { describe, it, expect } from 'vitest';
import { InMemoryRecorder, FileRecorder } from '../../src/evidence/recorder.js';
import type { RunEvent } from '../../src/domain/evidence.js';

const ev = (i: number): RunEvent => ({
  type: 'step.start',
  runId: 'r',
  participantId: 'p',
  stepIndex: i,
  ts: '2026-09-21T10:00:00.000Z',
});

describe('recorder', () => {
  it('InMemoryRecorder stores events in insertion order', async () => {
    const r = new InMemoryRecorder();
    await r.append(ev(0));
    await r.append(ev(1));
    await r.append(ev(2));
    const snap = await r.snapshot();
    expect(snap.map((e) => (e.type === 'step.start' ? e.stepIndex : -1))).toEqual([0, 1, 2]);
  });

  it('FileRecorder concatenates events as one JSON line each', async () => {
    const lines: string[] = [];
    const fr = new FileRecorder(async (l) => { lines.push(l); });
    await fr.append(ev(0));
    await fr.append(ev(1));
    await fr.flush();
    expect(lines.join('').trim().split('\n')).toHaveLength(2);
  });
});
