/**
 * Capability isolation, proven with a real browser.
 *
 * Two things are asserted here:
 *
 * 1. With a real Chromium and the real demo page, nothing privileged
 *    reaches a participant: not the observation the participant runtime
 *    filtered, not the artifact that holds it, and not the Reasoner
 *    request the participant's own model actually receives.
 * 2. A leak that *does* happen is caught and turned into a typed
 *    `capability.violation` event plus a `capabilityViolation`
 *    termination, using the real participant runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightAdapter } from '../../src/adapter/browser/playwright-adapter.js';
import { runExperiment } from '../../src/experiment/runner.js';
import { runParticipant } from '../../src/participant/runtime.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import { InMemoryRecorder } from '../../src/evidence/recorder.js';
import {
  applyParticipantObservation,
  assertNoPrivilegedLeak,
} from '../../src/capability/observation-filter.js';
import { DEFAULT_CAPABILITY_PROFILE } from '../../src/domain/capability.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { ObserverObservation, ParticipantObservation } from '../../src/domain/observation.js';
import { assertBrowserRuntimeAvailable } from './support/browser-runtime.js';
import { fakeReasoner } from './support/fake-reasoner.js';
import { startDemoServer, type ServerHandle } from './support/demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.resolve(here, '..', '.tmp', 'browser-leak-runs');

let server: ServerHandle;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
  await fs.rm(outDir, { recursive: true, force: true });
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

/**
 * Simulates a realistic adapter bug: privileged diagnostics attached to
 * `visual.focused`, which `applyParticipantObservation` copies through
 * verbatim. Content that the filter re-projects from the observer view
 * (visible text, title, regions, ARIA) cannot smuggle anything past the
 * projection check, because the check recomputes exactly that
 * projection; a field copied by reference is where a real leak lands.
 */
class LeakyViewAdapter implements BrowserAdapter {
  readonly adapterId = 'playwright-leaky';
  constructor(private readonly inner: PlaywrightAdapter) {}

  async open(url: string, viewport?: { width: number; height: number }): Promise<void> {
    await this.inner.open(url, viewport);
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    const obs = await this.inner.observe(stepIndex);
    const focused = obs.visual.focused ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      ...obs,
      visual: {
        ...obs.visual,
        focused: { ...focused, domHtml: obs.domHtml } as unknown as ObserverObservation['visual']['focused'],
      },
    };
  }

  async execute(action: Parameters<BrowserAdapter['execute']>[0]) {
    return this.inner.execute(action);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * True when `selector` appears in `payload` as a standalone CSS-path
 * token rather than as part of a longer word. A verified selector may be
 * a bare tag name (`input`), and the payload legitimately contains
 * `inputTokens`, so a plain substring test would be a false alarm.
 */
function containsSelectorToken(payload: string, selector: string): boolean {
  if (selector === '') return false;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(payload);
}

describe('privileged access isolation (real browser)', () => {
  it('keeps selectors, DOM, console and network out of every participant-facing surface', async () => {
    // 1. What the observer really sees, including the verified selectors.
    const probe = new PlaywrightAdapter();
    let privileged: ObserverObservation;
    try {
      await probe.open(server.baseUrl);
      privileged = await probe.observe(0);
    } finally {
      await probe.close();
    }
    const realSelectors = privileged.interactiveRegions
      .map((r) => r.selector)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    expect(realSelectors.length).toBeGreaterThan(0);
    expect(privileged.domHtml).toContain('<input');
    expect(privileged.console.length + privileged.network.length).toBeGreaterThan(0);

    // 2. The participant view derived from that same real observation.
    const participantView: ParticipantObservation = applyParticipantObservation(
      privileged,
      { observation: 'visual' },
    );
    expect(() => assertNoPrivilegedLeak(participantView, privileged)).not.toThrow();
    for (const region of participantView.interactiveRegions) {
      expect(Object.keys(region).sort()).toEqual(['bbox', 'label']);
    }
    const serializedView = JSON.stringify(participantView);
    for (const selector of realSelectors) {
      expect(
        containsSelectorToken(serializedView, selector),
        `selector ${selector} leaked into the participant view`,
      ).toBe(false);
    }
    expect(serializedView).not.toContain('<input');
    expect(serializedView).not.toContain('domHtml');

    // 3. The same for a full browser run: the artifact a participant
    //    could be handed, and the Reasoner request it actually sent.
    const def = await loadExperiment(fixture);
    const { runId } = await runExperiment({
      experiment: { ...def, outDir, budget: { maxStepsPerParticipant: 2 } },
      adapterFactory: () => new PlaywrightAdapter(),
      resolveTargetUrl: () => server.baseUrl,
    });
    const runDir = path.join(outDir, runId);

    for (const p of def.participants) {
      const obsDir = path.join(runDir, 'observations', p.id);
      for (const file of await fs.readdir(obsDir)) {
        const raw = await fs.readFile(path.join(obsDir, file), 'utf8');
        for (const selector of realSelectors) {
          expect(containsSelectorToken(raw, selector), `selector ${selector} leaked into ${file}`).toBe(false);
        }
        expect(raw).not.toContain('data-uid');
        expect(raw).not.toMatch(/<(!doctype|html|body|input|button|form|a )/i);
        expect(raw).not.toContain('"console"');
        expect(raw).not.toContain('"network"');
      }
    }

    const eventsRaw = await fs.readFile(path.join(runDir, 'events.ndjson'), 'utf8');
    const events = eventsRaw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const requestEvents = events.filter((e) => e['type'] === 'reasoner.request');
    expect(requestEvents.length).toBeGreaterThan(0);
    for (const e of requestEvents) {
      const payload = JSON.stringify(e);
      for (const selector of realSelectors) {
        expect(containsSelectorToken(payload, selector), `selector ${selector} leaked into a reasoner.request`).toBe(false);
      }
      expect(payload).not.toContain('data-uid');
      // No markup of any kind reaches the participant's model.
      expect(payload).not.toContain('<');
      expect(payload).not.toContain('domHtml');
      // The request is a closed, documented shape: the participant's own
      // system prompt, the memory-selected messages, the token budget, an
      // optional temperature and a system-prompt digest. Nothing else.
      //
      // NOTE: `ReasonerRequestEvent.request` is declared as
      // `Omit<ReasonerRequest, 'systemPrompt'>` in src/domain/evidence.ts
      // but src/participant/runtime.ts writes the full request, so
      // `systemPrompt` is present in the artifact. Neither file is owned
      // by this change; the assertion follows the runtime's behaviour.
      const request = e['request'] as Record<string, unknown>;
      const allowedRequestKeys = ['systemPrompt', 'maxTokens', 'messages', 'systemPromptDigest', 'temperature'];
      expect(Object.keys(request).filter((k) => !allowedRequestKeys.includes(k))).toEqual([]);
      expect(Array.isArray(request['messages'])).toBe(true);
      const messages = request['messages'] as Array<{ role: string; content: string }>;
      for (const message of messages) {
        expect(typeof message.content).toBe('string');
        // Every message is one of the two memory-controller templates: a
        // recalled step, or the current observation. Nothing else can be
        // in a participant's request.
        expect(message.content).toMatch(/^\[(Current observation|step \d+)\]/);
      }
      const current = messages[messages.length - 1];
      expect(current?.content).toMatch(/\[Current observation\]/);
      expect(current?.content).toMatch(/^url=/m);
      expect(current?.content).toMatch(/^title=/m);
    }
    // The network/console logs exist in the privileged view but never as
    // participant events.
    expect(events.some((e) => e['type'] === 'observation.captured')).toBe(true);
  }, 180_000);

  it('catches a deliberately leaked field on a real observation', () => {
    const privileged = buildRealObservationFixture();
    const clean = applyParticipantObservation(privileged, { observation: 'visual' });

    const cases: Array<{ name: string; tampered: unknown; expectKey: string }> = [
      { name: 'domHtml', tampered: { ...clean, domHtml: privileged.domHtml }, expectKey: 'domHtml' },
      { name: 'console', tampered: { ...clean, console: privileged.console }, expectKey: 'console' },
      { name: 'network', tampered: { ...clean, network: privileged.network }, expectKey: 'network' },
      {
        name: 'selector on a region',
        tampered: {
          ...clean,
          interactiveRegions: [{ ...clean.interactiveRegions[0], selector: 'form > input[name="title"]' }],
        },
        expectKey: 'selector',
      },
      {
        name: 'domHtml nested in visual',
        tampered: { ...clean, visual: { ...clean.visual, domHtml: privileged.domHtml } },
        expectKey: 'domHtml',
      },
      {
        name: 'unrelated internal metadata',
        tampered: { ...clean, internalMetadata: { buildId: 'abc' } },
        expectKey: 'internalMetadata',
      },
      {
        // Nothing was renamed and no privileged key is present: the
        // document HTML simply ended up in visible text. The exact
        // projection check is what catches this shape.
        name: 'document HTML as visible text',
        tampered: { ...clean, visual: { ...clean.visual, visibleText: privileged.domHtml } },
        expectKey: 'visual.visibleText',
      },
    ];

    for (const c of cases) {
      let message = '';
      try {
        assertNoPrivilegedLeak(c.tampered as ParticipantObservation, privileged);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, `${c.name} was not caught`).toContain('privilege leak');
      expect(message).toContain(c.expectKey);
    }
  });

  it('records a capability.violation and terminates the participant when a real leak happens', async () => {
    const recorder = new InMemoryRecorder();
    const adapter = new LeakyViewAdapter(new PlaywrightAdapter());
    const outcome = await runParticipant({
      runId: 'leak-probe',
      participantId: 'p-leaky-adapter',
      personaPrompt: 'You are looking at a page you cannot see the structure of.',
      userStory: 'You want to add a task.',
      capability: DEFAULT_CAPABILITY_PROFILE,
      reasoner: fakeReasoner([{ kind: 'finish', reason: 'leak probe' }], 'leak'),
      adapter,
      targetUrl: server.baseUrl,
      budget: 3,
      recorder,
    });

    expect(outcome.terminationReason).toBe('capabilityViolation');
    expect(outcome.error ?? '').toContain('privilege leak');

    const events = await recorder.snapshot();
    const violation = events.find((e) => e.type === 'capability.violation');
    expect(violation).toBeDefined();
    if (violation?.type === 'capability.violation') {
      expect(violation.axis).toBe('observation');
      expect(violation.reason).toContain('privilege leak');
      expect(violation.participantId).toBe('p-leaky-adapter');
    }
    // The loop stopped instead of continuing on leaked input.
    expect(events.filter((e) => e.type === 'reasoner.request')).toHaveLength(0);
  }, 120_000);
});

/**
 * Reuses the values the existing observation-filter unit test already
 * relies on so both suites describe the same page.
 */
function buildRealObservationFixture(): ObserverObservation {
  const html =
    '<!doctype html><html><head><title>Task Tracker</title></head><body>' +
    '<button>Add</button><a href="/settings">Settings</a><input name="title" type="text" placeholder="What needs doing?">' +
    '</body></html>';
  return {
    stepIndex: 0,
    url: 'http://127.0.0.1:0/',
    title: 'Task Tracker',
    capturedAt: '2026-09-21T10:00:00.000Z',
    visual: { width: 1280, height: 800, visibleText: 'Task Tracker Add Settings', focused: null },
    aria: { role: 'document', name: 'Task Tracker', children: [] },
    domHtml: html,
    console: [{ level: 'warning', text: 'deprecated api used by the demo page', ts: '2026-09-21T10:00:00.000Z' }],
    network: [{ method: 'GET', url: 'http://127.0.0.1:0/', status: 200, ts: '2026-09-21T10:00:00.000Z' }],
    interactiveRegions: [
      { selector: 'body > button', label: 'Add', bbox: { x: 192, y: 167, width: 41, height: 21 } },
      { selector: 'body > a[href="/settings"]', label: 'Settings', bbox: { x: 71, y: 80, width: 64, height: 19 } },
      { selector: 'body > input[name="title"]', label: 'What needs doing?', bbox: { x: 8, y: 167, width: 179, height: 21 } },
    ],
  };
}
