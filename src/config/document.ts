/**
 * `u-sekai.yml` — the declarative authority surface (ADR-0011, issue #58).
 *
 * ## What this module does
 *
 * It translates a parsed YAML document into the durable product model
 * from #57 (`src/product/**`) plus the two things the domain
 * deliberately does not model: the per-environment **authority
 * envelope** and the **World Operator connectors**. Everything it
 * passes down goes through a `parse*` entry point of the domain, so a
 * value this file accepts is a value the durable model accepts — the
 * two cannot drift.
 *
 * ## The file is the authority
 *
 * There is exactly one way for an authority to enter this process: it
 * was written in the file. `load.ts` refuses every other source, and
 * this module has no parameter through which a caller could supply one.
 * That is a structural property, not a convention: there is no code
 * path here that reads `process.env` for a permission.
 *
 * ## Two rules do the heavy lifting
 *
 * 1. **An unrecognised key is an error, never a discard.** Every block
 *    below is closed. A `model:` or `browser:` key somebody expected to
 *    take effect is refused rather than dropped, so a file cannot look
 *    validated while a setting it names was ignored.
 * 2. **An absent optional is the safe value.** Omitted permission is
 *    denied; omitted origin is the environment's own; omitted cadence
 *    zone is UTC; omitted budget is the smallest ceiling the domain
 *    admits. Defaults are chosen so that deleting a line can only
 *    reduce what u-sekai may do.
 *
 * ## Deliberate divergences from the illustrative shape
 *
 * `docs/product/configuration-and-authority.md` gives an illustrative
 * file and says the exact schema is an implementation decision. Two
 * departures, both to keep authority from being inferred:
 *
 * - **`class` is required on an environment.** The document's example
 *   omits it. Inferring `production` vs `productionLike` from a
 *   directory name would make the most consequential distinction in the
 *   model a function of a word someone typed.
 * - **A budget is a closed block of three fields**, so a
 *   half-declared budget is a parse error rather than a partially
 *   applied ceiling.
 *
 * ## Id derivation
 *
 * Names become durable ids through `names.ts`; the domain owns the
 * grammar. Every mapping is walked in sorted key order so the same file
 * always produces the same arrays — the first acceptance criterion is
 * that a minimal valid configuration loads deterministically.
 */

import {
  DEPLOYMENT_KINDS,
  ENVIRONMENT_CLASSES,
  environmentOrigins,
  parseEnvironment,
  type DeploymentKind,
  type Environment,
  type EnvironmentClass,
} from '../product/environment.js';
import { ALLOWED_STATE_RETENTION, MAX_CONCURRENT_SESSIONS, parseSyntheticIdentity } from '../product/identity.js';
import type { SyntheticIdentity } from '../product/identity.js';
import { parseSyntheticCohort } from '../product/cohort.js';
import { MAX_RUNS_PER_DAY, MAX_RUNS_PER_EVENT, parseReviewProgram } from '../product/program.js';
import { parseProduct } from '../product/product.js';
import type { Product } from '../product/product.js';
import { buildProductModel } from '../product/product-model.js';
import type { ProductModel } from '../product/product-model.js';
import { requireOrigin as requireOriginFromDomain } from '../product/validation.js';
import { parseEnvironmentAuthority, type EnvironmentAuthority } from './authority.js';
import { asConfigError, UseSekaiConfigError } from './errors.js';
import {
  deriveCohortId,
  deriveEnvironmentId,
  deriveProductId,
  deriveReviewProgramId,
  deriveSyntheticIdentityId,
  sortedNames,
} from './names.js';
import { parseSecretRegistry, type DeclaredSecret } from './secrets.js';
import { parseTriggerBlock } from './triggers.js';
import { parseWorldOperatorSurface, type WorldOperatorSurface } from './world.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireFiniteNumber,
  requireInteger,
  requireMapping,
  requireNonEmptyMapping,
  requireNonEmptyString,
  requireNonEmptySequence,
  requireOneOf,
} from './validate.js';

import type { CohortId, EnvironmentId } from '../product/ids.js';

/** Schema version this loader understands. */
export const CONFIG_SCHEMA_VERSION = 1;

const ROOT_KEYS = [
  'version',
  'product',
  'environments',
  'identities',
  'cohorts',
  'reviewPrograms',
] as const;

const PRODUCT_KEYS = ['id', 'displayName', 'description', 'owners', 'labels'] as const;
const ENVIRONMENT_KEYS = [
  'class',
  'name',
  'url',
  'allowedOrigins',
  'deploymentKind',
  'notes',
  'secrets',
  'world',
  'authority',
] as const;
const IDENTITY_KEYS = [
  'lifecycle',
  'persona',
  'displayName',
  'stateRef',
  'stateRetention',
  'maxConcurrentSessions',
  'permittedOrigins',
] as const;
const COHORT_KEYS = ['lifecycle', 'size', 'members', 'notes'] as const;
const PROGRAM_KEYS = [
  'environments',
  'environment',
  'cohort',
  'trigger',
  'budget',
  'name',
  'notes',
] as const;
const BUDGET_KEYS = ['maxRunsPerDay', 'maxRunsPerEvent', 'maxCostUnitsPerDay'] as const;

/**
 * Smallest budget the domain admits, used when `budget:` is absent.
 *
 * A budget is a ceiling, so "unspecified" must mean "as little as
 * possible" — `maxCostUnitsPerDay: 0` states that no spend is
 * authorised until the file says otherwise. This is the same
 * fail-closed rule as an omitted permission, applied to a limit.
 */
export const DEFAULT_PROGRAM_BUDGET: Readonly<{
  maxRunsPerDay: number;
  maxRunsPerEvent: number;
  maxCostUnitsPerDay: number;
}> = Object.freeze({ maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: 0 });

/** Where the configuration file itself was selected from. */
export type ConfigPathSource = 'explicit' | 'environment' | 'default';

export interface ConfigProvenance {
  /** Absolute path of the file that was read. */
  readonly configPath: string;
  /** Which of the three precedence levels chose it. */
  readonly configPathSource: ConfigPathSource;
}

/** A configured environment: the domain `Environment` plus what only the file can say. */
export interface ConfiguredEnvironment {
  readonly id: EnvironmentId;
  /** The key the environment was declared under. */
  readonly name: string;
  /** Every origin the environment answers on, `url` first. */
  readonly origins: ReadonlyArray<string>;
  /** What this environment authorises. Never widened by any other source. */
  readonly authority: EnvironmentAuthority;
  /** Whether the envelope was written out or fell back to denied. */
  readonly authoritySource: 'file' | 'default';
  /** Privileged setup connectors available to the World Operator. */
  readonly world: WorldOperatorSurface;
  /** Secret references, preserved verbatim. Values are never here. */
  readonly secrets: ReadonlyArray<DeclaredSecret>;
}

export interface UseSekaiConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** The durable model. Built by the domain, so its invariants hold. */
  readonly model: ProductModel;
  /** Per-environment authority, World and secrets, ordered by environment id. */
  readonly environments: ReadonlyArray<ConfiguredEnvironment>;
  readonly provenance: ConfigProvenance;
}

/** The configured environment with this durable id, or `undefined`. */
export function findConfiguredEnvironment(
  config: UseSekaiConfig,
  id: EnvironmentId,
): ConfiguredEnvironment | undefined {
  return config.environments.find((environment) => environment.id === id);
}

/** The configured environment declared under `name` (e.g. `staging`). */
export function findConfiguredEnvironmentByName(
  config: UseSekaiConfig,
  name: string,
): ConfiguredEnvironment | undefined {
  return config.environments.find((environment) => environment.name === name);
}

/** The reference declared for a secret registry name, or `undefined`. */
export function findSecretReference(
  config: UseSekaiConfig,
  environmentId: EnvironmentId,
  name: string,
): string | undefined {
  return findConfiguredEnvironment(config, environmentId)?.secrets.find((s) => s.name === name)
    ?.reference;
}

/**
 * Translate a parsed YAML document into a validated configuration.
 *
 * @param raw        the value produced by `readYamlSource`
 * @param provenance how the file was chosen, carried through untouched
 * @param field      dotted path used in diagnostics
 */
export function parseUseSekaiConfig(
  raw: unknown,
  provenance: ConfigProvenance,
  field = 'u-sekai.yml',
): UseSekaiConfig {
  const root = requireMapping(raw, field);
  rejectUnknownKeys(root, ROOT_KEYS, field);

  // Range-checked loosely so the diagnostic can say *which* versions this
  // build supports, rather than reporting an unexplained bound of 1..1.
  const version = requireInteger(root['version'], `${field}.version`, 1, Number.MAX_SAFE_INTEGER);
  if (version !== CONFIG_SCHEMA_VERSION) {
    throw new UseSekaiConfigError(
      `${field}.version ${version} is not supported by this u-sekai build; expected ${CONFIG_SCHEMA_VERSION}`,
      `${field}.version`,
      { reason: 'unsupported_schema_version', received: version, supported: CONFIG_SCHEMA_VERSION },
    );
  }

  const product = parseProductBlock(root['product'], `${field}.product`);
  const { environments, configured } = parseEnvironmentsBlock(
    root['environments'],
    product.id,
    `${field}.environments`,
  );
  const declaredOrigins = collectDeclaredOrigins(environments);

  const identities = parseIdentitiesBlock(
    root['identities'],
    product.id,
    declaredOrigins,
    `${field}.identities`,
  );
  const identityIds = new Set(identities.map((identity) => identity.id));
  const cohorts = parseCohortsBlock(root['cohorts'], product.id, identityIds, `${field}.cohorts`);
  const programs = parseProgramsBlock(
    root['reviewPrograms'],
    product.id,
    new Set(environments.map((environment) => environment.id)),
    new Set(cohorts.map((cohort) => cohort.id)),
    `${field}.reviewPrograms`,
  );

  const model = asConfigError(
    () =>
      buildProductModel({
        product,
        environments,
        identities,
        cohorts,
        programs,
      }),
    field,
  );

  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    model,
    environments: Object.freeze(configured),
    provenance: Object.freeze({ ...provenance }),
  });
}

// ---------------------------------------------------------------- product

function parseProductBlock(value: unknown, field: string): Product {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, PRODUCT_KEYS, field);

  const name = requireNonEmptyString(raw['id'], `${field}.id`, 48);
  const id = deriveProductId(name, `${field}.id`);
  // The declared name is the slug: one spelling, so `product.id` and
  // `product.slug` can never disagree.
  const built: Record<string, unknown> = {
    id,
    slug: name,
    displayName: raw['displayName'] === undefined ? name : requireNonEmptyString(raw['displayName'], `${field}.displayName`),
  };
  if (raw['description'] !== undefined) {
    built['description'] = requireNonEmptyString(raw['description'], `${field}.description`, 2_000);
  }
  if (raw['owners'] !== undefined) {
    built['owners'] = requireNonEmptySequence(raw['owners'], `${field}.owners`).map((item, i) =>
      requireNonEmptyString(item, `${field}.owners[${i}]`, 200),
    );
  }
  if (raw['labels'] !== undefined) {
    built['labels'] = requireNonEmptySequence(raw['labels'], `${field}.labels`).map((item, i) =>
      requireNonEmptyString(item, `${field}.labels[${i}]`, 64),
    );
  }
  return asConfigError(() => parseProduct(built, field), field);
}

// ------------------------------------------------------------ environments

interface EnvironmentBlockResult {
  readonly environments: ReadonlyArray<Environment>;
  readonly configured: ReadonlyArray<ConfiguredEnvironment>;
}

function parseEnvironmentsBlock(
  value: unknown,
  productId: Product['id'],
  field: string,
): EnvironmentBlockResult {
  const raw = requireNonEmptyMapping(value, field);

  const environments: Environment[] = [];
  const configured: ConfiguredEnvironment[] = [];
  const names = sortedNames(raw);

  for (const name of names) {
    const nameField = `${field}.${name}`;
    const id = deriveEnvironmentId(name, nameField);
    const body = requireMapping(raw[name], nameField);
    rejectUnknownKeys(body, ENVIRONMENT_KEYS, nameField);

    const environmentClass = requireOneOf(
      body['class'],
      ENVIRONMENT_CLASSES,
      `${nameField}.class`,
    ) as EnvironmentClass;
    const displayName =
      body['name'] === undefined ? name : requireNonEmptyString(body['name'], `${nameField}.name`);
    const baseUrl = requireDeclaredOrigin(body['url'], `${nameField}.url`);
    const additionalOrigins = readAllowedOrigins(
      body['allowedOrigins'],
      baseUrl,
      `${nameField}.allowedOrigins`,
    );
    const deploymentKind = (
      body['deploymentKind'] === undefined
        ? 'continuous'
        : requireOneOf(body['deploymentKind'], DEPLOYMENT_KINDS, `${nameField}.deploymentKind`)
    ) as DeploymentKind;

    const secrets = parseSecretRegistry(body['secrets'], `${nameField}.secrets`);
    const { authority, source: authoritySource } = parseEnvironmentAuthority(
      body['authority'],
      `${nameField}.authority`,
    );
    const world = parseWorldOperatorSurface(
      body['world'],
      `${nameField}.world`,
      new Set(secrets.map((secret) => secret.name)),
      authority,
    );

    const built: Record<string, unknown> = {
      id,
      productId,
      name: displayName,
      environmentClass,
      deploymentKind,
      endpoint: { baseUrl },
    };
    if (additionalOrigins.length > 0) {
      (built['endpoint'] as Record<string, unknown>)['additionalOrigins'] = additionalOrigins;
    }
    if (body['notes'] !== undefined) {
      built['notes'] = requireNonEmptyString(body['notes'], `${nameField}.notes`, 2_000);
    }

    const environment = asConfigError(() => parseEnvironment(built, nameField), nameField);
    environments.push(environment);
    configured.push(
      Object.freeze({
        id,
        name,
        origins: Object.freeze(environmentOrigins(environment)),
        authority,
        authoritySource,
        world,
        secrets,
      }),
    );
  }

  return { environments: Object.freeze(environments), configured: Object.freeze(configured) };
}

/**
 * `allowedOrigins` is the environment's *full* declared origin set, the
 * way the illustrative shape in the 0.4.0 product documents writes it —
 * it includes `url`. `url` is therefore required to be a member, which
 * catches the realistic mistake of listing an unrelated origin under a
 * staging environment.
 *
 * @returns the origins *beyond* `url`, which is what becomes
 *   `endpoint.additionalOrigins`; the domain rejects a list repeating
 *   `baseUrl`, and `url` is already `baseUrl`
 */
function readAllowedOrigins(
  value: unknown,
  baseUrl: string,
  field: string,
): ReadonlyArray<string> {
  if (value === undefined) return Object.freeze([]);

  const items = requireNonEmptySequence(value, field);
  const origins = items.map((item, index) => requireDeclaredOrigin(item, `${field}[${index}]`));
  rejectDuplicates(origins, field);
  if (!origins.includes(baseUrl)) {
    throw new UseSekaiConfigError(
      `${field} must include this environment's url (${baseUrl}); ` +
        'allowedOrigins is the complete set of origins this environment answers on',
      field,
      { reason: 'base_origin_not_declared', baseUrl, declared: origins },
    );
  }
  return Object.freeze(origins.filter((origin) => origin !== baseUrl));
}

/**
 * An origin, with wildcards refused.
 *
 * `new URL('https://*.example.com')` parses happily, so the domain's
 * origin check accepts a host that matches every subdomain. A wildcard
 * host is a cross-origin grant written as a prefix, and 0.4.0 has no
 * bounded form of one, so it is refused here.
 */
function requireDeclaredOrigin(value: unknown, field: string): string {
  const origin = asConfigError(() => requireOriginFromDomain(value, field), field);
  if (origin.includes('*')) {
    throw new UseSekaiConfigError(
      `${field} must name one exact origin; a wildcard host is not a bounded origin`,
      field,
      { reason: 'wildcard_origin' },
    );
  }
  return origin;
}

function collectDeclaredOrigins(environments: ReadonlyArray<Environment>): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const environment of environments) {
    for (const origin of environmentOrigins(environment)) origins.add(origin);
  }
  return origins;
}

// -------------------------------------------------------------- identities

function parseIdentitiesBlock(
  value: unknown,
  productId: Product['id'],
  declaredOrigins: ReadonlySet<string>,
  field: string,
): ReadonlyArray<SyntheticIdentity> {
  if (value === undefined) return Object.freeze([]);
  const raw = requireMapping(value, field);
  const identities: SyntheticIdentity[] = [];

  for (const name of sortedNames(raw)) {
    const nameField = `${field}.${name}`;
    const id = deriveSyntheticIdentityId(name, nameField);
    const body = requireMapping(raw[name], nameField);
    rejectUnknownKeys(body, IDENTITY_KEYS, nameField);

    const lifecycle = requireNonEmptyString(body['lifecycle'], `${nameField}.lifecycle`, 32);
    const displayName =
      body['displayName'] === undefined ? name : requireNonEmptyString(body['displayName'], `${nameField}.displayName`);
    // A persona is a claim about a simulated person's situation. It has
    // no safe default, so it is required rather than derived from the
    // name: a config that invents personas would produce evidence about
    // nobody.
    const persona = requireNonEmptyString(body['persona'], `${nameField}.persona`, 4_000);

    const stateRetention =
      body['stateRetention'] === undefined
        ? (ALLOWED_STATE_RETENTION[lifecycle as keyof typeof ALLOWED_STATE_RETENTION]?.[0] as string)
        : requireNonEmptyString(body['stateRetention'], `${nameField}.stateRetention`, 32);
    if (stateRetention === undefined || !(lifecycle in ALLOWED_STATE_RETENTION)) {
      throw new UseSekaiConfigError(
        `${nameField}.lifecycle must be one of: ${Object.keys(ALLOWED_STATE_RETENTION).join(', ')}`,
        `${nameField}.lifecycle`,
        { reason: 'not_in_enum', received: lifecycle },
      );
    }

    const stateRef =
      body['stateRef'] === undefined
        ? undefined
        : requireNonEmptyString(body['stateRef'], `${nameField}.stateRef`, 256);
    if (stateRef === undefined && stateRetention !== 'none') {
      throw new UseSekaiConfigError(
        `${nameField}.stateRef is required for an identity that retains state ("${stateRetention}"); ` +
          'u-sekai does not invent a storage location for a durable identity',
        `${nameField}.stateRef`,
        { reason: 'missing_state_ref', stateRetention },
      );
    }

    const permittedOrigins = readPermittedOrigins(
      body['permittedOrigins'],
      declaredOrigins,
      `${nameField}.permittedOrigins`,
    );

    const built: Record<string, unknown> = {
      id,
      productId,
      displayName,
      lifecycle,
      persona,
      capability: {
        maxConcurrentSessions:
          body['maxConcurrentSessions'] === undefined
            ? 1
            : requireInteger(body['maxConcurrentSessions'], `${nameField}.maxConcurrentSessions`, 1, MAX_CONCURRENT_SESSIONS),
        stateRetention,
        permittedOrigins,
      },
    };
    if (stateRef !== undefined) built['stateRef'] = stateRef;

    identities.push(asConfigError(() => parseSyntheticIdentity(built, nameField), nameField));
  }

  return Object.freeze(identities);
}

/**
 * An identity may only operate within origins some environment declares.
 *
 * Defaulting to the union of declared origins is what makes "no
 * implicit cross-origin permission" true by construction: an identity
 * that names nothing is confined to the declared world, and one that
 * names an origin outside it is refused rather than silently widened.
 */
function readPermittedOrigins(
  value: unknown,
  declaredOrigins: ReadonlySet<string>,
  field: string,
): ReadonlyArray<string> {
  if (value === undefined) return Object.freeze([...declaredOrigins].sort());

  const items = requireNonEmptySequence(value, field);
  const origins = items.map((item, index) => requireDeclaredOrigin(item, `${field}[${index}]`));
  rejectDuplicates(origins, field);
  const undeclared = origins.filter((origin) => !declaredOrigins.has(origin));
  if (undeclared.length > 0) {
    throw new UseSekaiConfigError(
      `${field} may only contain origins some environment declares; not declared: ${undeclared.join(', ')}`,
      field,
      { reason: 'undeclared_origin', undeclared, declared: [...declaredOrigins].sort() },
    );
  }
  return Object.freeze(origins);
}

// ----------------------------------------------------------------- cohorts

function parseCohortsBlock(
  value: unknown,
  productId: Product['id'],
  identityIds: ReadonlySet<string>,
  field: string,
): ReturnType<typeof parseSyntheticCohort>[] {
  if (value === undefined) return [];
  const raw = requireMapping(value, field);
  const cohorts: ReturnType<typeof parseSyntheticCohort>[] = [];

  for (const name of sortedNames(raw)) {
    const nameField = `${field}.${name}`;
    const id = deriveCohortId(name, nameField);
    const body = requireMapping(raw[name], nameField);
    rejectUnknownKeys(body, COHORT_KEYS, nameField);

    const lifecycle = requireNonEmptyString(body['lifecycle'], `${nameField}.lifecycle`, 32);
    const hasSize = body['size'] !== undefined;
    const hasMembers = body['members'] !== undefined;
    if (hasSize && hasMembers) {
      throw new UseSekaiConfigError(
        `${nameField} must declare either size or members, not both: a cohort is selected by ` +
          'a count or by a list, and both at once is ambiguous',
        nameField,
        { reason: 'ambiguous_membership' },
      );
    }

    let membership: Record<string, unknown>;
    if (hasMembers) {
      const members = requireNonEmptySequence(body['members'], `${nameField}.members`);
      const identityIds2 = members.map((item, index) =>
        deriveSyntheticIdentityId(
          requireNonEmptyString(item, `${nameField}.members[${index}]`, 48),
          `${nameField}.members[${index}]`,
        ),
      );
      rejectDuplicates(identityIds2, `${nameField}.members`);
      for (const identityId of identityIds2) {
        if (!identityIds.has(identityId)) {
          throw new UseSekaiConfigError(
            `${nameField}.members names "${identityId}", which this file's identities: block does not declare`,
            `${nameField}.members`,
            { reason: 'unknown_identity_reference', identityId },
          );
        }
      }
      membership = { kind: 'explicit', identityIds: identityIds2 };
    } else if (hasSize) {
      membership = {
        kind: 'sizeTarget',
        lifecycle,
        targetSize: requireInteger(body['size'], `${nameField}.size`, 1, 10_000),
      };
    } else {
      membership = { kind: 'byLifecycle', lifecycle };
    }

    const built: Record<string, unknown> = {
      id,
      productId,
      // A cohort has no `name:` key: the mapping key is its name, so
      // there is exactly one spelling and it cannot disagree with the id.
      name,
      membership,
    };
    if (body['notes'] !== undefined) {
      built['notes'] = requireNonEmptyString(body['notes'], `${nameField}.notes`, 2_000);
    }

    cohorts.push(asConfigError(() => parseSyntheticCohort(built, nameField), nameField));
  }

  return cohorts;
}

// ---------------------------------------------------------------- programs

function parseProgramsBlock(
  value: unknown,
  productId: Product['id'],
  environmentIds: ReadonlySet<EnvironmentId>,
  cohortIds: ReadonlySet<CohortId>,
  field: string,
): ReturnType<typeof parseReviewProgram>[] {
  if (value === undefined) return [];
  const raw = requireMapping(value, field);
  const programs: ReturnType<typeof parseReviewProgram>[] = [];

  for (const name of sortedNames(raw)) {
    const nameField = `${field}.${name}`;
    const id = deriveReviewProgramId(name, nameField);
    const body = requireMapping(raw[name], nameField);
    rejectUnknownKeys(body, PROGRAM_KEYS, nameField);

    const environmentNames = readProgramEnvironments(body, nameField);
    const declaredEnvironmentIds = environmentNames.map((environmentName, index) => {
      const itemField = `${nameField}.environments[${index}]`;
      const environmentId = deriveEnvironmentId(environmentName, itemField);
      if (!environmentIds.has(environmentId)) {
        throw new UseSekaiConfigError(
          `${itemField} names "${environmentName}", which this file's environments: block does not declare`,
          itemField,
          { reason: 'unknown_environment_reference', environmentId },
        );
      }
      return environmentId;
    });

    if (body['cohort'] === undefined) {
      throw new UseSekaiConfigError(`${nameField} must declare a cohort`, `${nameField}.cohort`, {
        reason: 'missing_cohort',
      });
    }
    const cohortId = deriveCohortId(
      requireNonEmptyString(body['cohort'], `${nameField}.cohort`, 48),
      `${nameField}.cohort`,
    );
    if (!cohortIds.has(cohortId)) {
      throw new UseSekaiConfigError(
        `${nameField}.cohort names "${cohortId}", which this file's cohorts: block does not declare`,
        `${nameField}.cohort`,
        { reason: 'unknown_cohort_reference', cohortId },
      );
    }

    if (body['trigger'] === undefined) {
      throw new UseSekaiConfigError(
        `${nameField} must declare a trigger; a Review Program with no trigger never runs`,
        `${nameField}.trigger`,
        { reason: 'missing_trigger' },
      );
    }
    const triggers = parseTriggerBlock(body['trigger'], `${nameField}.trigger`);
    const budget = parseBudgetBlock(body['budget'], `${nameField}.budget`);

    const built: Record<string, unknown> = {
      id,
      productId,
      name: body['name'] === undefined ? name : requireNonEmptyString(body['name'], `${nameField}.name`, 200),
      environmentIds: declaredEnvironmentIds,
      cohortId,
      triggers,
      budget,
    };
    if (body['notes'] !== undefined) {
      built['notes'] = requireNonEmptyString(body['notes'], `${nameField}.notes`, 2_000);
    }

    programs.push(asConfigError(() => parseReviewProgram(built, nameField), nameField));
  }

  return programs;
}

/**
 * `environment:` (one name) and `environments:` (a list) are both
 * accepted because the illustrative shape uses the singular and a
 * release-transition program must be able to name two environments. The
 * two are mutually exclusive, so the field is never ambiguous.
 */
function readProgramEnvironments(body: Record<string, unknown>, nameField: string): ReadonlyArray<string> {
  const hasList = body['environments'] !== undefined;
  const hasSingle = body['environment'] !== undefined;
  if (hasList && hasSingle) {
    throw new UseSekaiConfigError(
      `${nameField} must declare either environment or environments, not both`,
      nameField,
      { reason: 'ambiguous_environments' },
    );
  }
  if (hasSingle) {
    return Object.freeze([requireNonEmptyString(body['environment'], `${nameField}.environment`, 48)]);
  }
  if (!hasList) {
    throw new UseSekaiConfigError(
      `${nameField} must declare the environment(s) this program evaluates`,
      `${nameField}.environments`,
      { reason: 'missing_environments' },
    );
  }
  return requireNonEmptySequence(body['environments'], `${nameField}.environments`).map(
    (item, index) => requireNonEmptyString(item, `${nameField}.environments[${index}]`, 48),
  );
}

function parseBudgetBlock(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return { ...DEFAULT_PROGRAM_BUDGET };
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, BUDGET_KEYS, field);
  return {
    maxRunsPerDay:
      raw['maxRunsPerDay'] === undefined
        ? DEFAULT_PROGRAM_BUDGET.maxRunsPerDay
        : requireInteger(raw['maxRunsPerDay'], `${field}.maxRunsPerDay`, 1, MAX_RUNS_PER_DAY),
    maxRunsPerEvent:
      raw['maxRunsPerEvent'] === undefined
        ? DEFAULT_PROGRAM_BUDGET.maxRunsPerEvent
        : requireInteger(raw['maxRunsPerEvent'], `${field}.maxRunsPerEvent`, 1, MAX_RUNS_PER_EVENT),
    // The domain bounds this with a floor only, so this layer does not
    // restate a ceiling that does not exist.
    maxCostUnitsPerDay:
      raw['maxCostUnitsPerDay'] === undefined
        ? DEFAULT_PROGRAM_BUDGET.maxCostUnitsPerDay
        : requireFiniteNumber(raw['maxCostUnitsPerDay'], `${field}.maxCostUnitsPerDay`, 0),
  };
}
