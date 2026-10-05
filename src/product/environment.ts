/**
 * Environment — a reachable deployable instance being reviewed
 * (ADR-0011).
 *
 * ## The Environment is the review target
 *
 * ADR-0011 makes the deployable environment canonical and explicitly
 * refuses to reduce the review target to a pull request, a commit or a
 * source diff. Accordingly **this type declares no Git-shaped field**:
 * there is no `branch`, `pr`, `commitSha`, `mergeRequest`, `ref` or
 * `diff` on `Environment`, and `parseEnvironment` rejects any input
 * carrying such a key instead of quietly dropping it.
 *
 * That is a deliberate omission, not a gap. A deployment system may
 * describe itself with a branch name, and a review program may *trigger*
 * on a repository event, but neither is environment identity. Modelling
 * them here would couple u-sekai to the customer's branch model, which
 * ADR-0011 lists as a cost to avoid. Where a caller genuinely needs
 * deployment provenance, it belongs in run/evidence lineage
 * (`lineage.ts`) or in configuration owned by #58 — not in the identity
 * of the thing under review.
 *
 * ## Transport neutrality
 *
 * The endpoint is an http(s) origin because that is what a browser can
 * actually reach, not because any particular provider, hosting platform
 * or CI system is assumed. The model carries no browser handle, no
 * provider client and no runtime object of any kind.
 */

import { ProductDomainError } from './errors.js';
import { EnvironmentId, parseEnvironmentId, parseProductId, ProductId } from './ids.js';
import {
  optionalString,
  optionalStringArray,
  rejectDuplicates,
  rejectUnknownKeys,
  requireNonEmptyString,
  requireOrigin,
  requireRecord,
} from './validation.js';

/**
 * Environment classes from ADR-0011: "develop, pre-release, staging,
 * production-like, or explicitly authorized production".
 *
 * `production` is present because ADR-0011 allows it under explicit
 * opt-in; it is a *declaration* only. This model grants no authority to
 * touch a production environment — the authority boundary is #59's and
 * the budget boundary is declared on the Review Program (#62).
 */
export const ENVIRONMENT_CLASSES = [
  'develop',
  'preRelease',
  'staging',
  'productionLike',
  'production',
] as const;

export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** How an environment's current build was produced, as a domain label. */
export const DEPLOYMENT_KINDS = ['continuous', 'versioned', 'static'] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];

export interface EnvironmentEndpoint {
  /** Absolute http(s) entry point, canonicalised (see `requireOrigin`). */
  readonly baseUrl: string;
  /**
   * Further origins the same deployable answers on — regional hosts,
   * aliases, a mobile web origin. Empty or absent means `baseUrl` only.
   */
  readonly additionalOrigins?: ReadonlyArray<string>;
}

export interface Environment {
  readonly id: EnvironmentId;
  /** Owning product. Every environment belongs to exactly one. */
  readonly productId: ProductId;
  readonly name: string;
  readonly environmentClass: EnvironmentClass;
  readonly endpoint: EnvironmentEndpoint;
  /** Whether the endpoint follows the latest deploy continuously. */
  readonly deploymentKind: DeploymentKind;
  /** Optional human-facing note; never a secret. */
  readonly notes?: string;
}

const ENVIRONMENT_FIELDS = [
  'id',
  'productId',
  'name',
  'environmentClass',
  'endpoint',
  'deploymentKind',
  'notes',
] as const;

const ENDPOINT_FIELDS = ['baseUrl', 'additionalOrigins'] as const;

export function parseEnvironment(input: unknown, field = 'environment'): Environment {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ENVIRONMENT_FIELDS, field);

  const id = parseEnvironmentId(raw['id'], `${field}.id`);
  const productId = parseProductId(raw['productId'], `${field}.productId`);
  const name = requireNonEmptyString(raw['name'], `${field}.name`);
  const environmentClass = requireEnvironmentClass(raw['environmentClass'], `${field}.environmentClass`);
  const deploymentKind = requireDeploymentKind(raw['deploymentKind'], `${field}.deploymentKind`);
  const endpoint = parseEnvironmentEndpoint(raw['endpoint'], `${field}.endpoint`);
  const notes = optionalString(raw['notes'], `${field}.notes`, 2_000);

  const result: { -readonly [K in keyof Environment]: Environment[K] } = {
    id,
    productId,
    name,
    environmentClass,
    deploymentKind,
    endpoint,
  };
  if (notes !== undefined) {
    result.notes = notes;
  }
  return Object.freeze(result);
}

export function parseEnvironmentEndpoint(
  input: unknown,
  field = 'environment.endpoint',
): EnvironmentEndpoint {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ENDPOINT_FIELDS, field);

  const baseUrl = requireOrigin(raw['baseUrl'], `${field}.baseUrl`);
  const additional = optionalStringArray(
    raw['additionalOrigins'],
    `${field}.additionalOrigins`,
    (v, f) => requireOrigin(v, f),
  );
  if (additional !== undefined) {
    if (additional.includes(baseUrl)) {
      throw new ProductDomainError(
        `${field}.additionalOrigins must not repeat baseUrl`,
        `${field}.additionalOrigins`,
        { baseUrl },
      );
    }
    rejectDuplicates(additional, `${field}.additionalOrigins`);
  }

  const result: { -readonly [K in keyof EnvironmentEndpoint]: EnvironmentEndpoint[K] } = { baseUrl };
  if (additional !== undefined) {
    result.additionalOrigins = Object.freeze([...additional]);
  }
  return Object.freeze(result);
}

/** Every origin the environment answers on, `baseUrl` first. */
export function environmentOrigins(environment: Environment): ReadonlyArray<string> {
  return [environment.endpoint.baseUrl, ...(environment.endpoint.additionalOrigins ?? [])];
}

/**
 * Whether an origin belongs to this environment.
 *
 * This is the authority check the World Operator (#59) and the runtime
 * (#63) need: an action against any other origin is out of bounds for
 * an identity scoped to this environment.
 */
export function environmentIncludesOrigin(environment: Environment, origin: string): boolean {
  let canonical: string;
  try {
    canonical = requireOrigin(origin, 'origin');
  } catch {
    return false;
  }
  return environmentOrigins(environment).includes(canonical);
}

function requireEnvironmentClass(value: unknown, field: string): EnvironmentClass {
  if (typeof value !== 'string' || !(ENVIRONMENT_CLASSES as readonly string[]).includes(value)) {
    throw new ProductDomainError(
      `${field} must be one of: ${ENVIRONMENT_CLASSES.join(', ')}`,
      field,
      { received: value, allowed: [...ENVIRONMENT_CLASSES] },
    );
  }
  return value as EnvironmentClass;
}

function requireDeploymentKind(value: unknown, field: string): DeploymentKind {
  if (typeof value !== 'string' || !(DEPLOYMENT_KINDS as readonly string[]).includes(value)) {
    throw new ProductDomainError(
      `${field} must be one of: ${DEPLOYMENT_KINDS.join(', ')}`,
      field,
      { received: value, allowed: [...DEPLOYMENT_KINDS] },
    );
  }
  return value as DeploymentKind;
}
