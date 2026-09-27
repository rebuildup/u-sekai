/**
 * Domain-level errors. These never carry provider-shaped data.
 */
export class CapabilityViolation extends Error {
  readonly kind: 'capability_violation' = 'capability_violation' as const;
  constructor(
    message: string,
    readonly axis: 'observation' | 'action' | 'memory',
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CapabilityViolation';
  }
}

export class StepBudgetExceeded extends Error {
  readonly kind: 'step_budget_exceeded' = 'step_budget_exceeded' as const;
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'StepBudgetExceeded';
  }
}

export class ExperimentConfigError extends Error {
  readonly kind: 'experiment_config_error' = 'experiment_config_error' as const;
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExperimentConfigError';
  }
}

export class ProviderError extends Error {
  readonly kind: 'provider_error' = 'provider_error' as const;
  constructor(
    message: string,
    readonly provider: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class AdapterError extends Error {
  readonly kind: 'adapter_error' = 'adapter_error' as const;
  constructor(message: string, readonly adapter: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Structured Reasoner output taxonomy (ADR-0008).
 *
 * `providerTransport`, `providerParse` and `contractValidation` are the
 * three failure kinds a *provider* or *protocol* can produce. A genuine
 * capability violation is NOT one of them: it is raised as
 * `CapabilityViolation` and is deliberately not retryable.
 */
export type StructuredFailureKind =
  | 'providerTransport'
  | 'providerParse'
  | 'contractValidation'
  | 'capabilityViolation';

export type StructuredOutputErrorKind = Exclude<StructuredFailureKind, 'capabilityViolation'>;

export interface StructuredOutputFailureDetail {
  /** Provider identity, e.g. `anthropic` or `scripted`. Never a secret. */
  readonly provider?: string;
  /** Provider model id, e.g. `claude-3-5-sonnet-latest`. */
  readonly modelId?: string;
  /** Which of the three structured outputs was expected. */
  readonly outputKind?: 'action' | 'selfReport' | 'observerFindings';
  /** 1-based attempt number within the recovery sequence. */
  readonly attempt?: number;
  /** Total attempts the recovery policy allowed. */
  readonly maxAttempts?: number;
  /** HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  /** Capability axis, set only for a genuine `capabilityViolation`. */
  readonly axis?: 'observation' | 'action' | 'memory';
  /** `true` when the provider call exceeded the per-attempt deadline. */
  readonly timeout?: boolean;
  /** Short, redacted provider text kept for diagnostics. */
  readonly excerpt?: string;
}

/**
 * A provider returned something that is not a usable domain value.
 *
 * Thrown only at the structured-output boundary. Never reuse
 * `CapabilityViolation` for a parse or contract failure: doing so turns a
 * provider defect into a participant capability defect.
 */
export class StructuredOutputError extends Error {
  readonly kind: 'structured_output_error' = 'structured_output_error' as const;
  constructor(
    message: string,
    readonly failureKind: StructuredOutputErrorKind,
    readonly detail: StructuredOutputFailureDetail = {},
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export interface DomainErrorShape {
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}
