/**
 * Playwright-backed browser adapter (ADR-0006). Exposes ONLY constrained
 * primitives to participants; the privileged DOM / network / console
 * information is collected server-side in the observer view and never
 * reaches the participant runtime.
 *
 * The adapter is intentionally driven by the runtime with `x, y`
 * coordinates; the runtime itself cannot reach Playwright selectors.
 */

import { chromium, type Page } from 'playwright';
import type { BrowserAdapter } from './interface.js';
import type {
  ObserverObservation,
  VisualObservation,
  AriaObservation,
} from '../../domain/observation.js';
import type { ParticipantAction } from '../../domain/capability.js';
import type { ActionResult } from '../../domain/action.js';
import { AdapterError } from '../../domain/errors.js';

interface RecordedEntry {
  ts: string;
  kind: ParticipantAction['kind'];
}

export class PlaywrightAdapter implements BrowserAdapter {
  readonly adapterId = 'playwright';

  private browser = null as unknown as Awaited<ReturnType<typeof chromium.launch>>;
  private context = null as unknown as Awaited<ReturnType<NonNullable<typeof this.browser>['newContext']>>;
  private page = null as unknown as Page;
  private currentUrl = '';
  private currentTitle = '';
  private consoleLog: Array<{ level: string; text: string; ts: string }> = [];
  private networkLog: Array<{ method: string; url: string; status: number; ts: string }> = [];

  async open(url: string, viewport: { width: number; height: number } = { width: 1280, height: 800 }): Promise<void> {
    try {
      this.browser = await chromium.launch();
      this.context = await this.browser.newContext({ viewport });
      this.page = await this.context.newPage();
      this.page.on('console', (msg) => {
        this.consoleLog.push({
          level: msg.type(),
          text: msg.text(),
          ts: new Date().toISOString(),
        });
      });
      this.page.on('response', (res) => {
        this.networkLog.push({
          method: res.request().method(),
          url: res.url(),
          status: res.status(),
          ts: new Date().toISOString(),
        });
      });
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      this.currentUrl = this.page.url();
      this.currentTitle = await this.page.title();
    } catch (err) {
      await this.close();
      throw new AdapterError(`playwright open failed: ${(err as Error).message}`, 'playwright');
    }
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    if (!this.page) throw new AdapterError('playwright observe before open', 'playwright');
    const png = await this.page.screenshot({ fullPage: false });
    const domHtml = await this.page.content();
    const title = await this.page.title();
    const url = this.page.url();
    this.currentTitle = title;
    this.currentUrl = url;
    const visibleText = await this.evaluateVisibleText();
    const interactive = await this.evaluateInteractiveRegions();
    const aria = await this.evaluateAria();
    const visual: VisualObservation = {
      width: 1280,
      height: 800,
      screenshotPng: png,
      screenshotHash: hashBytes(png),
      visibleText,
      focused: { x: 0, y: 0, width: 0, height: 0 },
    };
    return {
      stepIndex,
      url,
      title,
      capturedAt: new Date().toISOString(),
      visual,
      aria,
      domHtml,
      console: [...this.consoleLog],
      network: [...this.networkLog],
      interactiveRegions: interactive,
    };
  }

  async execute(action: ParticipantAction): Promise<ActionResult> {
    if (!this.page) throw new AdapterError('playwright execute before open', 'playwright');
    switch (action.kind) {
      case 'clickByCoords':
      case 'tapByCoords':
        await this.page.mouse.click(action.x, action.y);
        return { status: 'ok', observedAfter: { url: this.currentUrl, title: this.currentTitle } };
      case 'typeText':
        await this.page.keyboard.type(action.text);
        return { status: 'ok', observedAfter: { url: this.currentUrl, title: this.currentTitle } };
      case 'scroll':
        await this.evaluateScroll(action.direction, action.amount);
        return { status: 'ok', observedAfter: { url: this.currentUrl, title: this.currentTitle } };
      case 'wait':
        await this.page.waitForTimeout(Math.max(0, Math.min(action.milliseconds, 30_000)));
        return { status: 'ok', observedAfter: { url: this.currentUrl, title: this.currentTitle } };
      case 'finish':
        return { status: 'ok', observedAfter: { url: this.currentUrl, title: this.currentTitle }, note: 'finish' };
    }
    return { status: 'error', note: 'unknown', code: 'unknown' };
  }

  async close(): Promise<void> {
    try {
      if (this.page) await this.page.close();
    } catch { /* ignore */ }
    try {
      if (this.context) await this.context.close();
    } catch { /* ignore */ }
    try {
      if (this.browser) await this.browser.close();
    } catch { /* ignore */ }
    this.page = null as unknown as Page;
    this.context = null as unknown as Awaited<ReturnType<NonNullable<typeof this.browser>['newContext']>>;
    this.browser = null as unknown as Awaited<ReturnType<typeof chromium.launch>>;
    this.consoleLog = [];
    this.networkLog = [];
  }

  private async evaluateVisibleText(): Promise<string> {
    if (!this.page) return '';
    return this.page.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '');
  }

  private async evaluateInteractiveRegions(): Promise<Array<{ selector: string; label: string; bbox: { x: number; y: number; width: number; height: number } }>> {
    if (!this.page) return [];
    const list = await this.page.evaluate(() => {
      const out: Array<{ selector: string; label: string; bbox: { x: number; y: number; width: number; height: number } }> = [];
      let i = 0;
      const targets = Array.from(document.querySelectorAll('button, a, input, textarea, select')) as HTMLElement[];
      for (const el of targets) {
        i += 1;
        const rect = el.getBoundingClientRect();
        out.push({
          selector: `[${el.tagName.toLowerCase()}][data-uid="${i}"]`,
          label: el.textContent?.trim().slice(0, 60) || el.getAttribute('aria-label') || el.tagName.toLowerCase(),
          bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        });
      }
      return out;
    });
    return list;
  }

  private async evaluateAria(): Promise<AriaObservation> {
    if (!this.page) return { role: 'document', name: '', children: [] };
    const a = await this.page.evaluate(() => {
      function summarise(el: Element, depth: number): { role: string; name: string; children: Array<{ role: string; name: string }> } {
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 80);
        const children: Array<{ role: string; name: string }> = [];
        if (depth > 0) {
          for (const c of Array.from(el.children).slice(0, 10)) {
            children.push({ role: (c.getAttribute('role') ?? c.tagName.toLowerCase()), name: (c.textContent ?? '').trim().slice(0, 60) });
          }
        }
        return { role, name, children };
      }
      return summarise(document.body, 1);
    });
    return a;
  }

  private async evaluateScroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(
      ({ direction: d, amount: a }) => {
        const x = d === 'left' ? -a : d === 'right' ? a : 0;
        const y = d === 'up' ? -a : d === 'down' ? a : 0;
        window.scrollBy(x, y);
      },
      { direction, amount },
    );
  }

  __recentForTest(): ReadonlyArray<RecordedEntry> {
    return [];
  }
}

function hashBytes(bytes: Uint8Array): string {
  // Tiny FNV-1a 32-bit; not cryptographic, just a stable per-step id.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
