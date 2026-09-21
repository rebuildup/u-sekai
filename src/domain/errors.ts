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

export interface DomainErrorShape {
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}
