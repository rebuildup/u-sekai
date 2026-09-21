import type { ParticipantAction } from './capability.js';

export type ActionResult =
  | {
      readonly status: 'ok';
      readonly observedAfter: { url: string; title: string };
      readonly note?: string;
    }
  | {
      readonly status: 'noop';
      readonly note: string;
    }
  | {
      readonly status: 'error';
      readonly note: string;
      readonly code: 'selector_not_found' | 'out_of_bounds' | 'timeout' | 'unknown';
    };

export type { ParticipantAction };
