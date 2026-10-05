/**
 * `u-sekai.yml` — the declarative customer-controlled configuration and
 * authority surface (ADR-0011, issue #58).
 *
 * ## What this package is
 *
 * The one place a repository declares what u-sekai may do. It reads
 * `u-sekai.yml`, validates it completely, and resolves it into the
 * durable product model from #57 (`src/product/**`) plus the per-
 * environment authority envelope and World Operator connectors the
 * durable model deliberately does not carry.
 *
 * ## The three properties it is built around
 *
 * 1. **Fail closed.** Every permission, origin, budget and reference
 *    that is not written out is denied, absent or empty. Every failure
 *    is a thrown `UseSekaiConfigError`; there is no warning channel, no
 *    partial load and no lenient mode. A configuration surface that
 *    quietly repairs bad input is worse than one without validation,
 *    because the diagnostic says the file was checked.
 * 2. **The file is the authority.** An authority can enter this process
 *    only by being written in `u-sekai.yml`. No option, environment
 *    variable or default can widen what the file grants. See `load.ts`.
 * 3. **Secrets stay references.** Values are never read, resolved,
 *    logged or stored here, and the diagnostics that would otherwise
 *    echo one deliberately do not include the rejected text. See
 *    `secrets.ts`.
 *
 * ## Reading order
 *
 * - `errors.ts` — the error type, and why it is not `ProductDomainError`
 * - `yaml.ts` — the only YAML reader in u-sekai, and why it walks nodes
 * - `validate.ts` / `secrets.ts` / `authority.ts` / `world.ts` / `triggers.ts` — the vocabulary
 * - `names.ts` — declared name → durable id
 * - `document.ts` — the schema
 * - `load.ts` — precedence and I/O
 *
 * Not re-exported from the package entrypoint `src/index.ts`: wiring the
 * new domains into the export map is a separate, single-owner ticket
 * once every 0.4.0 domain exists.
 */

export {
  CONFIG_PATH_ENV_VAR,
  DEFAULT_CONFIG_FILENAME,
  ENV_VAR_PREFIX,
  UseSekaiConfigError,
  asConfigError,
} from './errors.js';

export { readYamlSource } from './yaml.js';

export {
  AUTHORITY_KEYS,
  CROSS_ORIGIN_KEY,
  deniedAuthority,
  parseEnvironmentAuthority,
  type EnvironmentAuthority,
  type RealMoneyAuthority,
} from './authority.js';

export {
  parseSecretReference,
  parseSecretRegistry,
  secretReferenceName,
  type DeclaredSecret,
} from './secrets.js';

export {
  WORLD_BILLING_MODES,
  parseWorldOperatorSurface,
  type WorldAccountConnector,
  type WorldBillingConnector,
  type WorldBillingMode,
  type WorldConnector,
  type WorldOperatorSurface,
} from './world.js';

export {
  DEFAULT_CADENCE_TIME_ZONE,
  SUPPORTED_CADENCE_TOKENS,
  cadenceSummary,
  parseTriggerBlock,
} from './triggers.js';

export { deriveId, sortedNames } from './names.js';

export {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_PROGRAM_BUDGET,
  findConfiguredEnvironment,
  findConfiguredEnvironmentByName,
  findSecretReference,
  parseUseSekaiConfig,
  type ConfigProvenance,
  type ConfigPathSource,
  type ConfiguredEnvironment,
  type UseSekaiConfig,
} from './document.js';

export {
  CONFIG_PATH_ENV_VARS,
  loadUseSekaiConfig,
  parseUseSekaiConfigText,
  resolveConfigPath,
  type LoadConfigOptions,
} from './load.js';
