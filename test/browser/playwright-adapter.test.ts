/**
 * Browser-backed contract tests for `PlaywrightAdapter`.
 *
 * Every assertion here is made against a real Chromium instance driving
 * the real bundled demo environment. The suite fails loudly when the
 * browser runtime is missing; it never degrades into a skip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { PlaywrightAdapter } from '../../src/adapter/browser/playwright-adapter.js';
import { AdapterError } from '../../src/domain/errors.js';
import { sha256Hex } from '../../src/evidence/hash.js';
import type { ParticipantAction } from '../../src/domain/capability.js';
import { assertBrowserRuntimeAvailable, type BrowserRuntime } from './support/browser-runtime.js';
import {
  startDemoServer,
  withIndependentPage,
  regionCenter,
  type ServerHandle,
} from './support/demo.js';

/** Binds an ephemeral port, releases it, and returns a URL nothing serves. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}

let server: ServerHandle;
let runtime: BrowserRuntime;

beforeAll(async () => {
  runtime = await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

describe('PlaywrightAdapter (real Chromium)', () => {
  it('reports the real viewport, a real focus rect and a real sha256 screenshot hash', async () => {
    const adapter = new PlaywrightAdapter({ viewport: { width: 1024, height: 640 } });
    try {
      await adapter.open(server.baseUrl);
      const obs = await adapter.observe(0);

      expect(obs.visual.width).toBe(1024);
      expect(obs.visual.height).toBe(640);
      expect(obs.url).toBe(`${server.baseUrl}/`);
      expect(obs.title).toBe('Task Tracker');

      // The demo's task input is autofocused, so focus must be reported
      // as that input's real rectangle - not a hardcoded zero rect.
      expect(obs.visual.focused).not.toBeNull();
      const input = obs.interactiveRegions.find((r) => r.label === 'What needs doing?');
      expect(input).toBeDefined();
      expect(obs.visual.focused?.width).toBeCloseTo(input?.bbox.width ?? -1, 0);
      expect(obs.visual.focused?.height).toBeCloseTo(input?.bbox.height ?? -1, 0);

      // screenshotHash is documented as sha-256 of the screenshot bytes.
      const png = obs.visual.screenshotPng;
      expect(png).toBeInstanceOf(Uint8Array);
      expect(obs.visual.screenshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.visual.screenshotHash).toBe(sha256Hex(png as Uint8Array));
      // A real PNG, not a placeholder buffer.
      expect(Array.from((png as Uint8Array).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await adapter.close();
    }
  });

  it('emits only selectors that a fresh page resolves back to the same element', async () => {
    const adapter = new PlaywrightAdapter();
    let regions: Awaited<ReturnType<PlaywrightAdapter['observe']>>['interactiveRegions'] = [];
    try {
      await adapter.open(server.baseUrl);
      regions = (await adapter.observe(0)).interactiveRegions;
    } finally {
      await adapter.close();
    }

    expect(regions.length).toBeGreaterThan(0);
    expect(regions.some((r) => r.selector !== undefined)).toBe(true);
    // The old implementation fabricated `[tag][data-uid="n"]` paths that
    // nothing could resolve; no region may carry that fiction.
    for (const region of regions) {
      expect(region.selector ?? '').not.toContain('data-uid');
    }

    // Independent round-trip: a browser page that never saw the adapter
    // must resolve each reported selector to exactly one element whose
    // visible identity matches the reported label.
    const mismatches = await withIndependentPage(server.baseUrl, async (page) =>
      page.evaluate((selectors) => selectors.map(({ selector, label }) => {
        const found = document.querySelectorAll(selector);
        if (found.length !== 1) return { selector, label, resolved: `matched ${found.length} elements` };
        const el = found[0] as HTMLElement;
        const identity = [
          el.getAttribute('aria-label') ?? '',
          el.textContent ?? '',
          el.getAttribute('placeholder') ?? '',
          el.getAttribute('name') ?? '',
          el.getAttribute('type') ?? '',
        ].join(' ').replace(/\s+/g, ' ').trim();
        return { selector, label, resolved: identity.includes(label) ? 'ok' : `identity "${identity}" does not contain "${label}"` };
      }), regions.map((r) => ({ selector: r.selector ?? '', label: r.label }))),
    );
    expect(mismatches.filter((m) => m.resolved !== 'ok')).toEqual([]);
  });

  it('drives the constrained action surface to a real server-side state change', async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(server.baseUrl);
      const first = await adapter.observe(0);
      const input = regionCenter(first, (r) => r.label === 'What needs doing?');
      const add = regionCenter(first, (r) => r.label === 'Add');

      const clickInput = await adapter.execute({ kind: 'clickByCoords', ...input });
      expect(clickInput.status).toBe('ok');
      const typed = await adapter.execute({ kind: 'typeText', text: 'Buy milk' });
      expect(typed.status).toBe('ok');
      const submit = await adapter.execute({ kind: 'clickByCoords', ...add });
      expect(submit.status).toBe('ok');

      const after = await adapter.observe(1);
      // The typed text reached the real form and the demo server stored
      // the task: the page now lists it. A click into empty space could
      // never produce this.
      expect(after.visual.visibleText).toContain('Buy milk');
      const post = after.network.find((n) => n.method === 'POST' && n.url.endsWith('/tasks'));
      expect(post, 'no POST /tasks was observed').toBeDefined();
      expect(post?.status).toBe(303);

      // observedAfter is re-read from the live page, not echoed.
      expect(submit.status === 'ok' ? submit.observedAfter.url : '').toBe(`${server.baseUrl}/`);

      // The recorded action log is real evidence, not an empty stub.
      const recent = adapter.__recentForTest();
      expect(recent.map((r) => r.kind)).toEqual(['clickByCoords', 'typeText', 'clickByCoords']);
      expect(recent.every((r) => r.status === 'ok')).toBe(true);
      expect(recent[1]?.note).toContain('typed 8 chars');
    } finally {
      await adapter.close();
    }
  });

  it('re-reads url and title in observedAfter after a click navigates', async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(server.baseUrl);
      const obs = await adapter.observe(0);
      const settings = regionCenter(obs, (r) => r.label === 'Settings');
      const result = await adapter.execute({ kind: 'clickByCoords', ...settings });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.observedAfter.url).toBe(`${server.baseUrl}/settings`);
      expect(result.observedAfter.title).toBe('Settings - Task Tracker');
      expect(result.note).toContain('navigated to');
    } finally {
      await adapter.close();
    }
  });

  it('reports out-of-bounds coordinates instead of clicking blind', async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(server.baseUrl);
      const result = await adapter.execute({ kind: 'clickByCoords', x: 5000, y: 5000 });
      expect(result.status).toBe('error');
      if (result.status !== 'error') return;
      expect(result.code).toBe('out_of_bounds');
      expect(result.note).toContain('5000, 5000');
      expect(result.note).toContain('1280x800');
    } finally {
      await adapter.close();
    }
  });

  it('reports typeText with nothing focused as a typed failure, not a silent success', async () => {
    const adapter = new PlaywrightAdapter();
    try {
      // /settings has no text field, so nothing holds focus.
      await adapter.open(`${server.baseUrl}/settings`);
      const obs = await adapter.observe(0);
      expect(obs.visual.focused).toBeNull();
      const result = await adapter.execute({ kind: 'typeText', text: 'Buy milk' });
      expect(result.status).toBe('error');
      if (result.status !== 'error') return;
      expect(result.code).toBe('selector_not_found');
      expect(result.note).toContain('no editable target');
      expect(result.note).toContain('Click a text field');
    } finally {
      await adapter.close();
    }
  });

  it('fails an unreachable target with an actionable diagnostic and reclaims the browser', async () => {
    const adapter = new PlaywrightAdapter();
    // A port that was bound and released: guaranteed closed, and above
    // the range Chromium refuses as unsafe (port 1 and friends).
    const deadUrl = await closedPortUrl();
    let message = '';
    try {
      await adapter.open(deadUrl);
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      message = (err as Error).message;
    }
    expect(message).toContain('playwright open failed during goto');
    expect(message).toContain(deadUrl);
    expect(message).toMatch(/ERR_CONNECTION_REFUSED|ECONNREFUSED|refused/i);

    // The failed launch must not leave a browser behind.
    expect(adapter.__isOpenForTest()).toBe(false);
    const close = adapter.__lastCloseForTest();
    expect(close?.browserWasRunning).toBe(true);
    expect(close?.browserConnectedAfter).toBe(false);
    expect(close?.errors).toEqual([]);

    // And the adapter must refuse to pretend it can observe.
    await expect(adapter.observe(0)).rejects.toThrow(/observe called before open/);
    // close() stays safe to call again.
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it('surfaces a real Playwright version so a green run is attributable', () => {
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(runtime.executablePath).not.toBe('');
  });

  it('rejects a second open() on a live browser instead of leaking one', async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(server.baseUrl);
      await expect(adapter.open(server.baseUrl)).rejects.toThrow(/already open/);
      expect(adapter.__isOpenForTest()).toBe(true);
    } finally {
      await adapter.close();
      expect(adapter.__isOpenForTest()).toBe(false);
    }
  });

  it('exposes every supported action primitive through the same surface', async () => {
    const adapter = new PlaywrightAdapter();
    const actions: ParticipantAction[] = [
      { kind: 'wait', milliseconds: 10 },
      { kind: 'scroll', direction: 'down', amount: 50 },
      { kind: 'finish', reason: 'done' },
    ];
    try {
      await adapter.open(server.baseUrl);
      for (const action of actions) {
        const result = await adapter.execute(action);
        expect(result.status, `action ${action.kind} failed: ${JSON.stringify(result)}`).toBe('ok');
      }
    } finally {
      await adapter.close();
    }
  });
});
