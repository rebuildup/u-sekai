/**
 * Durable Synthetic Identity and Cohort state (ADR-0011, issue #60).
 *
 * Public surface of `src/cohort/**`.
 *
 * ## What this package is responsible for
 *
 * Persistence and lifecycle, and nothing else. ADR-0011's separation
 * holds: the store controls *persistence*; what the Reasoner actually
 * receives remains the Participant memory enforcement, and the authority
 * to create accounts or seed data remains the World Operator boundary
 * (#59). Nothing exported here grants a capability.
 *
 * ## Reading order
 *
 * - `record.ts` — why a key is stable across releases, and how a record
 *   survives a schema change. Start here.
 * - `identity.ts` — what an identity record holds and which lifecycle
 *   transitions are legal.
 * - `cohort.ts` — how a cohort's selection rule resolves to members.
 * - `service.ts` — the read-modify-write surface tying them together.
 */

export {
  COHORT_STATE_ERROR_CODES,
  CohortStateError,
  isCohortStateError,
  type CohortStateErrorCode,
} from './errors.js';

export {
  applyMigrationChain,
  buildDurableRecord,
  DURABLE_RECORD_KINDS,
  DURABLE_RECORD_SCHEMA_VERSION,
  durableRecordKey,
  isDurableRecordKind,
  parseDurableRecord,
  projectDeclaredKeys,
  type DurableRecord,
  type DurableRecordKind,
  type RecordMigration,
} from './record.js';

export { InMemoryRecordStore, type RecordStore } from './store.js';

export { FileRecordStore, type FileRecordStoreOptions } from './file-store.js';

export {
  ACCOUNT_REF_KINDS,
  closeReleaseWindow,
  initialIdentityState,
  isEligibleForRun,
  isOpenWindow,
  isRetired,
  MAX_ACCOUNT_REF_LENGTH,
  MAX_ENVIRONMENT_OBSERVATIONS,
  MAX_VERSION_LENGTH,
  openReleaseWindow,
  parseAccountRef,
  parseIdentityState,
  parseVersionLabel,
  recordObservation,
  resetRetainedState,
  retireIdentity,
  serializeIdentityState,
  touchRetainedState,
  type AccountRef,
  type AccountRefKind,
  type EnvironmentObservation,
  type IdentityState,
  type RecordedObservation,
  type ReleaseWindow,
  type RetainedIdentityState,
  type VersionLabel,
} from './identity.js';

export {
  canonicalJson,
  cohortDefinitionDigest,
  cohortIsResolvable,
  parseCohortState,
  resolveMembership,
  serializeCohortState,
  type CohortState,
  type ExcludedIdentity,
  type ResolveOptions,
  type ResolvedMembership,
} from './cohort.js';

export {
  CohortStateService,
  cohortStateKey,
  identityStateKey,
  type CohortStateServiceOptions,
  type SaveOptions,
} from './service.js';
