/**
 * Tenancy and authority for the control plane (issue #66).
 *
 * ## Nothing about the caller is ambient
 *
 * A control plane is where privilege leaks, and privilege leaks through
 * *implicitness*: a module-level `currentTenant`, a `process.env` read, a
 * `cwd`-derived config path, a singleton registry a second caller can
 * reach into. So this module exports **values and pure functions only**.
 * There is no setter, no mutable module state, no "default principal"
 * and no way to ask "who is calling?" without being handed a
 * {@link ServicePrincipal}.
 *
 * Every service method takes the tenant on the *request*, not on the
 * service, so a single service instance serves many tenants with no
 * cross-talk, and the store's keys are tenant-prefixed rather than
 * tenant-filtered (see `store.ts`).
 *
 * ## A capability is granted by construction, not inferred
 *
 * {@link ServicePrincipal.capabilities} is the complete authority list.
 * It is never widened by role name, by which id was passed, or by having
 * been granted a neighbouring capability — `product:register` does not
 * imply `job:trigger`, and a principal that can trigger a job cannot
 * cancel someone else's. The check is a set membership test
 * ({@link assertCapability}) and it runs on **every** method call, not
 * once at construction, because a service that authorizes at
 * construction authorizes for the lifetime of whatever it was handed.
 */

import { ServiceError } from './errors.js';

export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type TenantId = Brand<string, 'TenantId'>;
export type JobId = Brand<string, 'JobId'>;

export const TENANT_ID_PATTERN = /^tn-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const JOB_ID_PATTERN = /^jb-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SERVICE_ID_LENGTH = 64;

/**
 * The complete set of things a caller can do here.
 *
 * Enumerated rather than stringly typed so `satisfies` catches a typo at
 * compile time and {@link assertCapability} can reject an unknown
 * capability at the boundary instead of treating it as granted.
 */
export const SERVICE_CAPABILITIES = [
  'product:register',
  'product:read',
  'environment:register',
  'program:register',
  'job:submit',
  'job:read',
  'job:cancel',
  'finding:read',
  'disposition:submit',
] as const;

export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(SERVICE_CAPABILITIES);

export function isServiceCapability(value: unknown): value is ServiceCapability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/**
 * Who is calling, and what they may do.
 *
 * Declared by the transport that authenticated the caller, never
 * derived from the request body: a request that claimed its own
 * capabilities would be a privilege-escalation primitive, which is why
 * `tenantId` appears in the request for *routing* and is checked against
 * the principal for *authority*, and a mismatch is a refusal rather
 * than a silent correction.
 */
export interface ServicePrincipal {
  readonly tenantId: TenantId;
  /** Opaque subject handle, e.g. an API key id. Never a secret value. */
  readonly subject: string;
  readonly capabilities: ReadonlyArray<ServiceCapability>;
}

/** Validate a declared tenant id. Same rule as #57: declared, never generated. */
export function tenantId(value: string): TenantId {
  if (typeof value !== 'string') {
    throw new ServiceError('tenantId must be a string', 'invalid-request', 'tenantId');
  }
  if (value.length > MAX_SERVICE_ID_LENGTH || !TENANT_ID_PATTERN.test(value)) {
    throw new ServiceError(
      `tenantId must match ${TENANT_ID_PATTERN.source} (e.g. "tn-acme")`,
      'invalid-request',
      'tenantId',
      { received: value },
    );
  }
  return value as TenantId;
}

export function parseTenantId(value: unknown, field = 'tenantId'): TenantId {
  if (typeof value !== 'string') {
    throw new ServiceError(`${field} must be a string`, 'invalid-request', field);
  }
  return tenantId(value);
}

/**
 * Validate a declared job id.
 *
 * Declared rather than generated, for #57's reason: a reloaded or
 * re-submitted job must come back as the same identity, so there is no
 * code path in this package that can mint one. A caller that wants two
 * jobs declares two ids.
 */
export function jobId(value: string): JobId {
  if (typeof value !== 'string') {
    throw new ServiceError('jobId must be a string', 'invalid-request', 'jobId');
  }
  if (value.length > MAX_SERVICE_ID_LENGTH || !JOB_ID_PATTERN.test(value)) {
    throw new ServiceError(
      `jobId must match ${JOB_ID_PATTERN.source} (e.g. "jb-2026-10-05-staging")`,
      'invalid-request',
      'jobId',
      { received: value },
    );
  }
  return value as JobId;
}

export function parseJobId(value: unknown, field = 'jobId'): JobId {
  if (typeof value !== 'string') {
    throw new ServiceError(`${field} must be a string`, 'invalid-request', field);
  }
  return jobId(value);
}

/**
 * Whether the principal holds the capability.
 *
 * A capability the API does not declare is `false`, not "held": a
 * caller cannot be granted authority over something that does not
 * exist.
 */
export function principalHasCapability(
  principal: ServicePrincipal,
  capability: ServiceCapability,
): boolean {
  return principal.capabilities.includes(capability);
}

/** Throw unless the principal holds the capability. */
export function assertCapability(principal: ServicePrincipal, capability: ServiceCapability): void {
  if (!principalHasCapability(principal, capability)) {
    throw new ServiceError(
      `principal ${principal.subject} on ${principal.tenantId} is not entitled to ${capability}`,
      'not-authorized',
      'principal.capabilities',
      { capability, tenantId: principal.tenantId },
    );
  }
}

/**
 * Throw unless the request's tenant is the principal's tenant.
 *
 * Refused rather than corrected. Silently serving a request under the
 * caller's own tenant would make a cross-tenant read look successful
 * while returning nothing, which is the "did not run" failure this
 * ticket exists to prevent.
 */
export function assertTenant(principal: ServicePrincipal, requested: TenantId): void {
  if (principal.tenantId !== requested) {
    throw new ServiceError(
      `principal ${principal.subject} belongs to ${principal.tenantId}, not ${requested}`,
      'not-authorized',
      'tenantId',
      { requested, principalTenant: principal.tenantId },
    );
  }
}
