import { describe, it, expect } from 'vitest';
import { applyParticipantObservation, assertNoPrivilegedLeak } from '../../src/capability/observation-filter.js';
import { parseSimpleHtml } from '../../src/adapter/browser/http-adapter.js';
import type { ObserverObservation } from '../../src/domain/observation.js';

function buildObserverObservation(): ObserverObservation {
  const html = `<!doctype html><html><head><title>Task Tracker</title></head><body><button>Add</button><a href="/settings">Settings</a><input name="title" type="text"></body></html>`;
  const parsed = parseSimpleHtml(html);
  return {
    stepIndex: 3,
    url: 'http://127.0.0.1:0/',
    title: parsed.title,
    capturedAt: '2026-09-21T10:00:00.000Z',
    visual: { width: 1280, height: 800, visibleText: parsed.body, focused: null },
    aria: { role: 'document', name: parsed.title, children: [] },
    domHtml: html,
    console: [{ level: 'warn', text: 'demo', ts: '2026-09-21T10:00:00.000Z' }],
    network: [{ method: 'GET', url: 'http://127.0.0.1:0/', status: 200, ts: '2026-09-21T10:00:00.000Z' }],
    interactiveRegions: parsed.regions.map((r) => ({ selector: r.selector, label: r.label, bbox: r.bbox })),
  };
}

describe('observation-filter', () => {
  it('caps visibleText and drops privileged fields for visual profile', () => {
    const o = buildObserverObservation();
    const p = applyParticipantObservation(o, { observation: 'visual' });
    expect(p.stepIndex).toBe(3);
    expect(p.visual.visibleText.length).toBeGreaterThan(0);
    // Privileged fields must NOT appear on the participant view.
    expect((p as unknown as { domHtml?: unknown }).domHtml).toBeUndefined();
    expect((p as unknown as { console?: unknown }).console).toBeUndefined();
    expect((p as unknown as { network?: unknown }).network).toBeUndefined();
    expect(p.aria).toBeUndefined();
  });

  it('attaches a clamped ARIA summary when visualPlusAria is granted', () => {
    const o = buildObserverObservation();
    const p = applyParticipantObservation(o, { observation: 'visualPlusAria' });
    expect(p.aria).toBeDefined();
    expect(p.aria?.name).toBe('Task Tracker');
  });

  it('assertNoPrivilegedLeak does not flag a clean participant view', () => {
    const o = buildObserverObservation();
    const p = applyParticipantObservation(o, { observation: 'visual' });
    expect(() => assertNoPrivilegedLeak(p, o)).not.toThrow();
  });

  it('assertNoPrivilegedLeak throws if domHtml is reachable from the participant', () => {
    const o = buildObserverObservation();
    const p = applyParticipantObservation(o, { observation: 'visual' });
    const tampered = { ...p, domHtml: o.domHtml };
    expect(() => assertNoPrivilegedLeak(tampered, o)).toThrow();
  });
});
