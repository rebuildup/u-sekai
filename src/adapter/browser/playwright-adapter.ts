/**
 * Real browser adapter (Playwright / Chromium).
 *
 * Contract notes that are easy to get wrong and are therefore explicit here:
 *
 * - `VisualObservation.width/height` is the *actual* CSS viewport of the
 *   live page, not a constant. The context is created with
 *   `deviceScaleFactor: 1` so screenshot pixels equal CSS pixels and the
 *   reported size describes the captured image.
 * - `visual.screenshotHash` is a real SHA-256 over the PNG bytes
 *   (hex), matching `src/domain/observation.ts`.
 * - `visual.focused` is the bounding box of `document.activeElement`, or
 *   `null` when nothing meaningful holds focus. It is never a hardcoded
 *   zero rect.
 * - `interactiveRegions[].selector` is a *verified* CSS path: the page
 *   itself resolves the candidate back to the same element before the
 *   value is reported. When that verification fails the field is
 *   omitted rather than fabricated. The selector is observer-only; the
 *   participant view never carries it (ADR-0006 / ADR-0009).
 * - `ActionResult.observedAfter` is re-read from the live page after the
 *   action settles, never echoed from the previous observation.
 * - Failures map onto the existing `ActionResult.code` vocabulary
 *   (`out_of_bounds`, `selector_not_found`, `timeout`, `unknown`) and
 *   `close()` never swallows errors: teardown problems are either
 *   rethrown or attached to the diagnostic that is being raised.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import type { BrowserAdapter } from './interface.js';
import type {
  ObserverObservation,
  VisualObservation,
  AriaObservation,
} from '../../domain/observation.js';
import type { ParticipantAction } from '../../domain/capability.js';
import type { ActionResult } from '../../domain/action.js';
import { AdapterError } from '../../domain/errors.js';
import { sha256Hex } from '../../evidence/hash.js';

export interface PlaywrightAdapterOptions {
  /** Headless by default so CI needs no display server. */
  readonly headless?: boolean;
  /** Viewport used for `open()`; also the reported screenshot size. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Per-operation timeout (navigation, load-state waits) in ms. */
  readonly actionTimeoutMs?: number;
  /**
   * How long to wait for a click to *start* a navigation before
   * treating the page as settled (ms). Real navigation settles far
   * slower; this only covers the gap between dispatching the input and
   * the document swap beginning.
   */
  readonly settleGraceMs?: number;
  /** Upper bound the `wait` primitive is clamped to, in ms. */
  readonly maxWaitMs?: number;
}

export interface RecordedAction {
  readonly ts: string;
  readonly kind: ParticipantAction['kind'];
  readonly status: ActionResult['status'];
  readonly note?: string;
}

export interface CloseDiagnostics {
  /** Errors collected while releasing page / context / browser. */
  readonly errors: ReadonlyArray<string>;
  /** A browser was actually running when close() started. */
  readonly browserWasRunning: boolean;
  /** `browser.isConnected()` observed after teardown. */
  readonly browserConnectedAfter: boolean;
}

/**
 * Diagnostic for the most recent `open()` call. This is deliberately
 * observational only: #37 must capture the real failing phase before it
 * decides whether any launch retry is justified.
 *
 * `phase` separates the two ways `open()` can fail to land on a live
 * page: `goto` is set when `page.goto()` rejects before a document is
 * committed (transport failure, DNS error, refused connection — the
 * network never delivered a response), whereas `navigationStatus` is
 * set when `page.goto()` returned a `Response` whose status is 4xx/5xx
 * (the navigation committed a document, but the server refused it).
 * The two paths need different operator responses, so the diagnostic
 * keeps them apart.
 */
export interface OpenDiagnostics {
  readonly launchAttempts: number;
  readonly status: 'success' | 'failure';
  readonly phase: 'launch' | 'newContext' | 'newPage' | 'goto' | 'navigationStatus' | 'ready';
  readonly message?: string;
}

export interface ScreenshotCaptureDiagnostics {
  readonly stepIndex: number;
  readonly attempts: number;
  readonly status: 'success' | 'failure';
  readonly failures: ReadonlyArray<string>;
}

type ScreenshotCaptureOutcome =
  | {
      readonly status: 'success';
      readonly png: Uint8Array;
      readonly attempts: number;
      readonly failures: ReadonlyArray<string>;
    }
  | {
      readonly status: 'failure';
      readonly attempts: number;
      readonly failures: ReadonlyArray<string>;
      readonly error: Error;
    };

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_GRACE_MS = 250;
const DEFAULT_MAX_WAIT_MS = 30_000;
/**
 * Screenshot retry budget per `observe()` call: 1 original attempt plus
 * this many retries. Named after the *retry* budget (not the total) so
 * the contract is self-documenting: a contributor reading the loop sees
 * `attempt <= SCREENSHOT_RETRY_BUDGET + 1` and understands the bound.
 */
const SCREENSHOT_RETRY_BUDGET = 1;
/** How far the in-page selector builder may walk up the tree. */
const MAX_SELECTOR_DEPTH = 8;

/**
 * Bounded recovery for the transient Chromium failure captured in #37.
 *
 * Only Chromium `Page.captureScreenshot` protocol failures with the
 * "Unable/Failed to capture screenshot" wording are retried.
 * Browser-closed, timeout, navigation and arbitrary errors fail
 * immediately rather than being papered over.
 *
 * @internal exported so the recovery policy can be proven deterministically.
 */
export async function captureScreenshotWithRecovery(
  capture: () => Promise<Uint8Array>,
): Promise<ScreenshotCaptureOutcome> {
  const failures: string[] = [];

  for (let attempt = 1; attempt <= SCREENSHOT_RETRY_BUDGET + 1; attempt += 1) {
    try {
      return {
        status: 'success',
        png: await capture(),
        attempts: attempt,
        failures,
      };
    } catch (err) {
      const message = describeError(err);
      failures.push(message);
      const retryable = isRetryableScreenshotFailure(message);
      if (!retryable || attempt === SCREENSHOT_RETRY_BUDGET + 1) {
        return {
          status: 'failure',
          attempts: attempt,
          failures,
          error: new Error(
            `screenshot capture failed after ${attempt} attempt(s): ${formatScreenshotFailureHistory(failures)}`,
          ),
        };
      }
    }
  }

  // Defensive: the loop above always returns. This throw exists to make
  // the invariant loud if a future refactor lets the loop fall through.
  throw new Error('unreachable: captureScreenshotWithRecovery fell through the retry loop');
}

/**
 * Renders every attempt's diagnostic, numbered, so the terminal error carries
 * the full history. Without this the first failure exists only in
 * `ScreenshotCaptureDiagnostics.failures`, which lives on the adapter instance
 * and never reaches `evidence.runtimeErrors` — so a reader of the durable
 * artifact would see only the last attempt and lose the transient that
 * triggered the retry in the first place.
 */
function formatScreenshotFailureHistory(failures: ReadonlyArray<string>): string {
  return failures.map((message, index) => `attempt ${index + 1}: ${message}`).join('; ');
}

function isRetryableScreenshotFailure(message: string): boolean {
  // Pin on the Chromium protocol method signature: `Page.captureScreenshot`
  // is the contract, and only that protocol error is the transient we
  // know how to retry. The wording Playwright uses around it has drifted
  // between releases ("Unable to capture screenshot" -> "Failed to
  // capture screenshot", ...), so accept either verb rather than pinning
  // a literal phrase. This keeps a wording tweak from silently turning
  // the bounded recovery into a first-attempt failure.
  return (
    /Page\.captureScreenshot/i.test(message) &&
    /(?:unable|failed)\s+to\s+capture\s+screenshot/i.test(message)
  );
}

export class PlaywrightAdapter implements BrowserAdapter {
  readonly adapterId = 'playwright';

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentUrl = '';
  private currentTitle = '';
  private viewport: { width: number; height: number } = { ...DEFAULT_VIEWPORT };
  private consoleLog: Array<{ level: string; text: string; ts: string }> = [];
  private networkLog: Array<{ method: string; url: string; status: number; ts: string }> = [];
  private recentActions: RecordedAction[] = [];
  private lastClose: CloseDiagnostics | null = null;
  private lastOpen: OpenDiagnostics | null = null;
  private screenshotDiagnostics: ScreenshotCaptureDiagnostics[] = [];

  private readonly headless: boolean;
  private readonly defaultViewport: { width: number; height: number };
  private readonly actionTimeoutMs: number;
  private readonly settleGraceMs: number;
  private readonly maxWaitMs: number;

  constructor(opts: PlaywrightAdapterOptions = {}) {
    this.headless = opts.headless ?? true;
    this.defaultViewport = opts.viewport ? { ...opts.viewport } : { ...DEFAULT_VIEWPORT };
    this.actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.settleGraceMs = opts.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.viewport = { ...this.defaultViewport };
  }

  async open(url: string, viewport?: { width: number; height: number }): Promise<void> {
    if (this.browser) {
      throw new AdapterError('playwright open called while a browser is already open', 'playwright', { url });
    }
    this.viewport = { ...(viewport ?? this.defaultViewport) };
    // Cycle-cleanliness is `open()`'s responsibility: a second open()
    // must not inherit the prior session's open() or screenshot
    // diagnostics. `close()` deliberately leaves these populated so
    // tests can read them after the lifecycle ends.
    this.lastOpen = null;
    this.screenshotDiagnostics = [];
    let phase: OpenDiagnostics['phase'] = 'launch';
    let launchAttempts = 0;
    try {
      launchAttempts += 1;
      this.browser = await chromium.launch({ headless: this.headless });
      phase = 'newContext';
      this.context = await this.browser.newContext({
        viewport: this.viewport,
        // Keeps screenshot pixels aligned with the reported CSS viewport.
        deviceScaleFactor: 1,
      });
      this.context.setDefaultTimeout(this.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.actionTimeoutMs);
      phase = 'newPage';
      this.page = await this.context.newPage();
      this.attachPageListeners(this.page);
      phase = 'goto';
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && !response.ok() && response.status() >= 400) {
        // The navigation itself committed (a document came back); the
        // server just refused it. Distinguish from a navigation that
        // never delivered a document so the diagnostic is actionable.
        phase = 'navigationStatus';
        throw new Error(`navigation returned HTTP ${response.status()} for ${url}`);
      }
      this.currentUrl = this.page.url();
      this.currentTitle = await this.page.title();
      this.lastOpen = {
        launchAttempts,
        status: 'success',
        phase: 'ready',
      };
    } catch (err) {
      this.lastOpen = {
        launchAttempts,
        status: 'failure',
        phase,
        message: describeError(err),
      };
      let teardownErrors: string[] = [];
      try {
        await this.close();
      } catch (closeErr) {
        // `close()` already reports every teardown problem; keep them
        // attached to the diagnostic we are raising instead of dropping.
        teardownErrors = (closeErr as AdapterError).detail['errors'] as string[] ?? [];
      }
      const diagnostics = this.lastClose;
      const teardownNote = (teardownErrors.length > 0 || (diagnostics?.errors.length ?? 0) > 0)
        ? `; teardown also reported: ${(diagnostics?.errors ?? []).join('; ')}`
        : '';
      throw new AdapterError(
        `playwright open failed during ${phase} for ${url}: ${describeError(err)}${teardownNote}`,
        'playwright',
        { url, phase, teardownErrors },
      );
    }
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    const page = this.requirePage('observe');
    // `phaseRef.phase` only drives the AdapterError message for the
    // post-screenshot phases. The screenshot phase itself is owned by
    // `captureScreenshotWithRecovery`; if it fails, the diagnostic it
    // throws already carries the attempt history, so the surrounding
    // catch reports `phase: 'screenshot'` as the fallback.
    const phaseRef = { phase: 'screenshot' };
    try {
      const screenshot = await captureScreenshotWithRecovery(() =>
        page.screenshot({
          type: 'png',
          fullPage: false,
          // Deterministic pixels: no CSS animation, no blinking caret.
          animations: 'disabled',
          caret: 'hide',
        }),
      );
      this.screenshotDiagnostics.push({
        stepIndex,
        attempts: screenshot.attempts,
        status: screenshot.status,
        failures: screenshot.failures,
      });
      if (screenshot.status === 'failure') {
        throw screenshot.error;
      }
      const png = screenshot.png;
      const size = page.viewportSize() ?? this.viewport;
      phaseRef.phase = 'title';
      const title = await page.title();
      const url = page.url();
      this.currentTitle = title;
      this.currentUrl = url;
      phaseRef.phase = 'visibleText';
      const visibleText = await page.evaluate(() =>
        document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '',
      );
      phaseRef.phase = 'interactiveRegions';
      const interactive = await this.evaluateInteractiveRegions();
      phaseRef.phase = 'focus';
      const focused = await this.evaluateFocusRect();
      phaseRef.phase = 'aria';
      const aria = await this.evaluateAria();
      phaseRef.phase = 'dom';
      const domHtml = await page.content();
      const visual: VisualObservation = {
        width: size.width,
        height: size.height,
        screenshotPng: png,
        screenshotHash: sha256Hex(png),
        visibleText,
        focused,
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
    } catch (err) {
      throw new AdapterError(
        `playwright observe failed during ${phaseRef.phase} at step ${stepIndex} (url=${this.currentUrl || 'unknown'}): ${describeError(err)}`,
        'playwright',
        { stepIndex, phase: phaseRef.phase, url: this.currentUrl },
      );
    }
  }

  async execute(action: ParticipantAction): Promise<ActionResult> {
    const page = this.requirePage('execute');
    const now = new Date().toISOString();
    try {
      switch (action.kind) {
        case 'clickByCoords':
        case 'tapByCoords':
          return await this.executeClick(page, action, now);
        case 'typeText':
          return await this.executeTypeText(page, action.text, now);
        case 'scroll':
          return await this.executeScroll(page, action.direction, action.amount, now);
        case 'wait': {
          const requested = Math.max(0, Math.min(action.milliseconds, this.maxWaitMs));
          await page.waitForTimeout(requested);
          const observed = await this.readCurrentPage(page);
          return this.record(now, action.kind, {
            status: 'ok',
            observedAfter: observed,
            note: `waited ${requested}ms${requested === this.maxWaitMs && action.milliseconds > this.maxWaitMs ? ' (clamped)' : ''}`,
          });
        }
        case 'finish': {
          const observed = await this.readCurrentPage(page);
          return this.record(now, action.kind, {
            status: 'ok',
            observedAfter: observed,
            note: 'finish',
          });
        }
      }
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      return this.record(now, action.kind, {
        status: 'error',
        note: `playwright ${action.kind} failed: ${describeError(err)}`,
        code: 'unknown',
      });
    }
  }

  /**
   * Releases page, context and browser. Teardown problems are collected
   * and rethrown as a single `AdapterError` instead of being dropped, so
   * a leaked browser process or a half-closed context cannot hide behind
   * a green result.
   */
  async close(): Promise<void> {
    const errors: string[] = [];
    const browserWasRunning = this.browser !== null;

    if (this.page) {
      const page = this.page;
      this.page = null;
      try {
        await page.close();
      } catch (err) {
        errors.push(`page.close: ${describeError(err)}`);
      }
    }
    if (this.context) {
      const context = this.context;
      this.context = null;
      try {
        await context.close();
      } catch (err) {
        errors.push(`context.close: ${describeError(err)}`);
      }
    }
    let browserConnectedAfter = false;
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      try {
        await browser.close();
      } catch (err) {
        errors.push(`browser.close: ${describeError(err)}`);
      }
      browserConnectedAfter = browser.isConnected();
      if (browserConnectedAfter) {
        errors.push('browser still reports isConnected() after close()');
      }
    }

    this.currentUrl = '';
    this.currentTitle = '';
    this.consoleLog = [];
    this.networkLog = [];
    // `lastOpen` and `screenshotDiagnostics` are intentionally NOT cleared
    // here: tests read them via the `__*ForTest()` accessors AFTER
    // `close()` (see `playwright-full-run.test.ts` and the failure
    // diagnostics suite). Cycle-cleanliness is the responsibility of
    // `open()`: it clears both fields at the start so a second cycle
    // does not inherit the prior session's data.
    this.lastClose = { errors, browserWasRunning, browserConnectedAfter };

    if (errors.length > 0) {
      throw new AdapterError(`playwright close failed: ${errors.join('; ')}`, 'playwright', { errors });
    }
  }

  // --- diagnostic accessors (tests / operators) -------------------

  /** Executed actions with their real outcome, newest last. */
  __recentForTest(): ReadonlyArray<RecordedAction> {
    return this.recentActions;
  }

  __isOpenForTest(): boolean {
    return this.browser !== null && this.page !== null;
  }

  __lastCloseForTest(): CloseDiagnostics | null {
    return this.lastClose;
  }

  __lastOpenForTest(): OpenDiagnostics | null {
    return this.lastOpen;
  }

  __screenshotDiagnosticsForTest(): ReadonlyArray<ScreenshotCaptureDiagnostics> {
    return this.screenshotDiagnostics;
  }

  /**
   * Clears the per-session diagnostic state accumulated by `open()` and
   * `observe()` so a test can reuse the adapter instance across scenarios
   * without seeing the prior cycle's data. Does not touch the
   * console / network logs or the most-recent close diagnostic; those
   * are owned by the `close()` lifecycle and remain meaningful between
   * cycles.
   */
  __resetDiagnosticsForTest(): void {
    this.recentActions = [];
    this.lastOpen = null;
    this.screenshotDiagnostics = [];
  }

  // --- internals --------------------------------------------------

  private requirePage(operation: string): Page {
    if (!this.page || !this.browser) {
      throw new AdapterError(
        `playwright ${operation} called before open() completed (browser is not running)`,
        'playwright',
        { operation },
      );
    }
    return this.page;
  }

  private attachPageListeners(page: Page): void {
    page.on('console', (msg) => {
      this.consoleLog.push({ level: msg.type(), text: msg.text(), ts: new Date().toISOString() });
    });
    page.on('response', (res) => {
      this.networkLog.push({
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        ts: new Date().toISOString(),
      });
    });
    page.on('pageerror', (err) => {
      this.consoleLog.push({ level: 'pageerror', text: err.message, ts: new Date().toISOString() });
    });
  }

  private record(now: string, kind: ParticipantAction['kind'], result: ActionResult): ActionResult {
    const note = result.note;
    this.recentActions.push({
      ts: now,
      kind,
      status: result.status,
      ...(note !== undefined ? { note } : {}),
    });
    return result;
  }

  private async executeClick(
    page: Page,
    action: { kind: 'clickByCoords' | 'tapByCoords'; x: number; y: number },
    now: string,
  ): Promise<ActionResult> {
    const size = page.viewportSize() ?? this.viewport;
    if (action.x < 0 || action.y < 0 || action.x >= size.width || action.y >= size.height) {
      return this.record(now, action.kind, {
        status: 'error',
        note: `coordinates (${action.x}, ${action.y}) are outside the ${size.width}x${size.height} viewport; nothing was clicked`,
        code: 'out_of_bounds',
      });
    }
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') ?? el.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40),
        };
      },
      [action.x, action.y] as const,
    );
    if (!hit) {
      return this.record(now, action.kind, {
        status: 'error',
        note: `no element at (${action.x}, ${action.y}) inside the ${size.width}x${size.height} viewport; nothing was clicked`,
        code: 'out_of_bounds',
      });
    }
    const before = { url: this.currentUrl, title: this.currentTitle };
    // Arm the navigation watcher BEFORE dispatching the click: a click
    // that triggers a document swap would otherwise settle on the
    // outgoing document and report a stale url/title.
    const navigation = this.waitForMainFrameNavigation();
    // A navigation can also fail *before* it commits (DNS error, reset
    // connection). Nothing then swaps the document, so the load state of
    // the old page would look like a success. Watch for it explicitly.
    const navigationFailures = this.watchMainFrameNavigationFailures(page);
    await page.mouse.click(action.x, action.y);
    const settled = await this.settleAfterAction(navigation, 'click');
    const failures = navigationFailures.stop();
    if (!settled.ok) {
      const observed = await this.readCurrentPage(page);
      return this.record(now, action.kind, {
        status: 'error',
        note: `click at (${action.x}, ${action.y}) on <${hit.tag}> did not settle within ${this.actionTimeoutMs}ms (url now ${observed.url}): ${settled.detail}`,
        code: 'timeout',
      });
    }
    const observed = await this.readCurrentPage(page);
    if (failures.length > 0) {
      // The click asked the page to navigate and that navigation never
      // delivered a document. Chromium usually commits an error page
      // (`chrome-error://...`) in that case, so the URL does change -
      // reporting `ok` here would be a false success in the evidence.
      return this.record(now, action.kind, {
        status: 'error',
        note: `click at (${action.x}, ${action.y}) on <${hit.tag}> started a navigation that failed before it committed: ${failures.join('; ')}. The page is now at ${observed.url}.`,
        code: 'timeout',
      });
    }
    const navigated = observed.url !== before.url ? `; navigated to ${observed.url}` : '';
    return this.record(now, action.kind, {
      status: 'ok',
      observedAfter: observed,
      note: `clicked <${hit.tag}${hit.label ? ` "${hit.label}"` : ''}> at (${action.x}, ${action.y})${navigated}`,
    });
  }

  /**
   * Records main-frame navigation requests that failed before commit.
   * A client-side cancellation (`net::ERR_ABORTED`) is not a delivery
   * failure and is ignored. Returns a `stop()` that detaches the
   * listener and yields what was collected.
   */
  private watchMainFrameNavigationFailures(page: Page): { stop: () => string[] } {
    const failures: string[] = [];
    const onFailure = (request: Request): void => {
      if (!request.isNavigationRequest()) return;
      if (request.frame() !== page.mainFrame()) return;
      const errorText = request.failure()?.errorText ?? 'unknown error';
      if (errorText.includes('ERR_ABORTED')) return;
      failures.push(`${request.method()} ${request.url()} failed: ${errorText}`);
    };
    page.on('requestfailed', onFailure);
    return {
      stop: () => {
        page.off('requestfailed', onFailure);
        return failures;
      },
    };
  }

  private async executeTypeText(page: Page, text: string, now: string): Promise<ActionResult> {
    const focus = await this.evaluateFocusTarget();
    if (!focus.editable) {
      return this.record(now, 'typeText', {
        status: 'error',
        note: `typeText has no editable target: focus is on <${focus.tag ?? 'nothing'}>. Click a text field before typing; nothing was typed.`,
        code: 'selector_not_found',
      });
    }
    // Measure the field before typing. Comparing the final length to
    // `text.length` would misreport a field that already held a value
    // (or one that transforms input): what matters is that the typing
    // produced exactly the characters we sent.
    const before = await this.readFocusedValueLength(page);
    if (before === null) {
      return this.record(now, 'typeText', {
        status: 'error',
        note: 'typeText lost its editable target between the focus check and typing; nothing was typed.',
        code: 'selector_not_found',
      });
    }
    await page.keyboard.type(text, { delay: 0 });
    const after = await this.readFocusedValueLength(page);
    if (after === null || after.length !== before.length + text.length) {
      return this.record(now, 'typeText', {
        status: 'error',
        note: `typed ${text.length} chars into a field holding ${before.length} but it now reports ${after?.length ?? 'no element'}; the page may have swallowed or rewritten the input`,
        code: 'unknown',
      });
    }
    const observed = await this.readCurrentPage(page);
    return this.record(now, 'typeText', {
      status: 'ok',
      observedAfter: observed,
      note: `typed ${text.length} chars into <${after.tag}>`,
    });
  }

  /** Length of the focused element's text, or `null` if focus is gone. */
  private async readFocusedValueLength(page: Page): Promise<{ length: number; tag: string } | null> {
    return page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const value = 'value' in el && typeof (el as HTMLInputElement).value === 'string'
        ? (el as HTMLInputElement).value
        : (el.textContent ?? '');
      return { length: value.length, tag: el.tagName.toLowerCase() };
    });
  }

  private async executeScroll(
    page: Page,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    now: string,
  ): Promise<ActionResult> {
    const before = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    await page.evaluate(
      ({ direction: d, amount: a }) => {
        const x = d === 'left' ? -a : d === 'right' ? a : 0;
        const y = d === 'up' ? -a : d === 'down' ? a : 0;
        window.scrollBy(x, y);
      },
      { direction, amount },
    );
    const after = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const observed = await this.readCurrentPage(page);
    const moved = after.x !== before.x || after.y !== before.y;
    return this.record(now, 'scroll', {
      status: 'ok',
      observedAfter: observed,
      note: moved
        ? `scrolled ${direction} ${amount} (offset ${before.x},${before.y} -> ${after.x},${after.y})`
        : `scrolled ${direction} ${amount} but the offset stayed at ${after.x},${after.y} (page is not scrollable here)`,
    });
  }

  /**
   * Waits for the page to reach `load` after an action.
   *
   * `armedNavigation` is the watcher started before the input was
   * dispatched; it resolves `true` once the main frame swapped
   * documents and `false` when the page simply stayed put. After the
   * load state is reached we look once more for a follow-up navigation,
   * because a redirect can land after the first document committed.
   *
   * A timeout is *returned*, not swallowed, so the caller can turn it
   * into a typed `timeout` result instead of reporting a stale page.
   */
  private async settleAfterAction(
    armedNavigation: Promise<boolean>,
    trigger: string,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const page = this.page;
    if (!page) return { ok: false, detail: `${trigger}: page is gone before settle` };
    await armedNavigation;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.waitForLoadState('load', { timeout: this.actionTimeoutMs });
      } catch (err) {
        const readyState = await page
          .evaluate(() => document.readyState)
          .catch(() => 'unavailable' as const);
        if (readyState === 'complete') return { ok: true };
        return {
          ok: false,
          detail: `${trigger} left the document at readyState=${readyState}: ${describeError(err)}`,
        };
      }
      if (attempt === 0 && !(await this.waitForMainFrameNavigation())) {
        return { ok: true };
      }
    }
    return { ok: true };
  }

  /**
   * Resolves `true` when the main frame navigates within the grace
   * window, `false` when the page stayed on the same document. Never
   * rejects, so it is safe to await after the fact.
   */
  private async waitForMainFrameNavigation(): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    return page
      .waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: this.settleGraceMs,
      })
      .then(() => true, () => false);
  }

  private async readCurrentPage(page: Page): Promise<{ url: string; title: string }> {
    const url = page.url();
    const title = await page.title();
    this.currentUrl = url;
    this.currentTitle = title;
    return { url, title };
  }

  private async evaluateFocusRect(): Promise<VisualObservation['focused']> {
    const page = this.page;
    if (!page) return null;
    return page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
  }

  private async evaluateFocusTarget(): Promise<{ editable: boolean; tag: string | null }> {
    const page = this.page;
    if (!page) return { editable: false, tag: null };
    return page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { editable: false, tag: null };
      const tag = el.tagName.toLowerCase();
      const isTextField = tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'password', ''].includes(
        (el as HTMLInputElement).type ?? '',
      );
      const editable = isTextField || tag === 'textarea' || el.isContentEditable === true;
      return { editable, tag };
    });
  }

  private async evaluateInteractiveRegions(): Promise<Array<{
    selector?: string;
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
  }>> {
    const page = this.page;
    if (!page) return [];
    return page.evaluate((maxDepth) => {
      interface Region {
        selector?: string;
        label: string;
        bbox: { x: number; y: number; width: number; height: number };
      }
      const out: Region[] = [];
      const targets = Array.from(
        document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"]'),
      );
      for (const el of targets) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (window.getComputedStyle(el).visibility === 'hidden') continue;
        const region: Region = {
          label: labelOf(el),
          bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        };
        // Only report a selector the page itself can resolve back to this
        // exact element. An unverifiable path is omitted, never faked.
        const selector = verifiedSelectorFor(el, maxDepth);
        if (selector) region.selector = selector;
        out.push(region);
      }
      return out;

      function labelOf(el: Element): string {
        const clean = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();
        const aria = clean(el.getAttribute('aria-label'));
        if (aria) return aria.slice(0, 60);
        const text = clean(el.textContent);
        if (text) return text.slice(0, 60);
        const placeholder = clean(el.getAttribute('placeholder'));
        if (placeholder) return placeholder.slice(0, 60);
        const name = clean(el.getAttribute('name'));
        if (name) return `${el.tagName.toLowerCase()} named "${name}"`.slice(0, 60);
        const type = clean(el.getAttribute('type'));
        if (type) return `${type} input`.slice(0, 60);
        return el.tagName.toLowerCase();
      }

      function verifiedSelectorFor(el: Element, maxDepth: number): string | null {
        const escape = (s: string): string =>
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`);
        const unique = (candidate: string): boolean => {
          try {
            return document.querySelectorAll(candidate).length === 1;
          } catch {
            return false;
          }
        };
        // Most specific first, so the reported path is informative to a
        // human reading the artifact rather than a bare tag name.
        for (const hint of attributeHints(el)) {
          if (unique(hint)) return hint;
        }
        const parts: string[] = [];
        let node: Element | null = el;
        let depth = 0;
        while (node && depth < maxDepth) {
          let part = node.tagName.toLowerCase();
          if (node !== el && node.id) {
            parts.unshift(`#${escape(node.id)}`);
            const candidate = parts.join(' > ');
            if (unique(candidate)) return candidate;
            break;
          }
          const parent: Element | null = node.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
            if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          const candidate = parts.join(' > ');
          if (unique(candidate)) return candidate;
          node = parent;
          depth += 1;
        }
        return null;
      }

      /** `name` / `type` / `aria-label` discriminators, most stable first. */
      function attributeHints(el: Element): string[] {
        const tag = el.tagName.toLowerCase();
        const hints: string[] = [];
        if (el.id) hints.push(`#${el.id.replace(/[^\w-]/g, (c) => `\\${c}`)}`);
        for (const attribute of ['name', 'aria-label', 'type', 'href', 'placeholder', 'role']) {
          const value = el.getAttribute(attribute);
          if (value) hints.push(`${tag}[${attribute}=${JSON.stringify(value)}]`);
        }
        return hints;
      }
    }, MAX_SELECTOR_DEPTH);
  }

  private async evaluateAria(): Promise<AriaObservation> {
    const page = this.page;
    if (!page) return { role: 'document', name: '', children: [] };
    return page.evaluate(() => {
      function summarise(el: Element, depth: number): { role: string; name: string; children: Array<{ role: string; name: string }> } {
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 80);
        const children: Array<{ role: string; name: string }> = [];
        if (depth > 0) {
          for (const c of Array.from(el.children).slice(0, 10)) {
            children.push({
              role: (c.getAttribute('role') ?? c.tagName.toLowerCase()),
              name: (c.textContent ?? '').trim().slice(0, 60),
            });
          }
        }
        return { role, name, children };
      }
      return summarise(document.body, 1);
    });
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (cause: ${cause.message})` : '';
    return `${err.name}: ${err.message}${causeText}`;
  }
  return String(err);
}
