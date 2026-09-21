/**
 * Browser adapter contract.
 *
 * Implementations are responsible for translating between the privileged
 * `ObserverObservation` and the constrained participant-facing view; the
 * participant runtime never reaches the full DOM. Two concrete
 * implementations ship in 0.1.0:
 *
 * - {@link HttpAdapter}  — HTTP-only, no screenshot. Used by CI / scripted tests.
 * - {@link PlaywrightAdapter} — real browser via Playwright. Used for live smoke.
 */

import type {
  ObserverObservation,
} from '../../domain/observation.js';
import type { ParticipantAction } from '../../domain/capability.js';
import type { ActionResult } from '../../domain/action.js';

export interface BrowserAdapter {
  readonly adapterId: string;
  open(url: string, viewport?: { width: number; height: number }): Promise<void>;
  observe(stepIndex: number): Promise<ObserverObservation>;
  execute(action: ParticipantAction): Promise<ActionResult>;
  close(): Promise<void>;
}
