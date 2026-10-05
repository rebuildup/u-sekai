/**
 * World Operator — the privileged setup boundary (ADR-0011, issue #59).
 *
 * The public surface of `src/operator/**`. Owned by #59 and stacked on
 * #57 (`src/product/**`, branch `57`).
 *
 * ## What is deliberately absent
 *
 * There is no way to reach a connector from this surface. `createWorldOperator`
 * takes a connector and keeps it in an ECMAScript `#private` field; the
 * only entry points to a privileged effect are `WorldOperator.provision`
 * and `WorldOperator.cleanup`, and both authorise the whole operation
 * before dispatching anything. `ScriptedProvisioningProvider` is exported
 * so a *caller* can construct one and hand it in — never as a way to
 * dispatch one directly.
 *
 * ## What is deliberately absent elsewhere
 *
 * Nothing here is re-exported from `src/index.ts`. The package entrypoint
 * is #65's ticket, and Participant / browser / config surfaces are not
 * this ticket's to touch. The module also imports nothing from
 * `src/domain/**`, `src/capability/**`, `src/participant/**` or
 * `src/reasoner/**`, which is what makes "Participant capabilities cannot
 * call World Operator interfaces" a structural property rather than a
 * convention.
 */

export {
  isOperatorProductFailure,
  isOperatorSetupFailure,
  OPERATOR_FAILURE_SUBJECTS,
  OPERATOR_FAILURE_SUBJECT,
  OPERATOR_PRODUCT_FAILURE_KINDS,
  OPERATOR_SETUP_FAILURE_KINDS,
  OperatorError,
  type OperatorFailure,
  type OperatorFailureKind,
  type OperatorFailureSubject,
  type OperatorProductFailure,
  type OperatorProductFailureKind,
  type OperatorSetupFailure,
  type OperatorSetupFailureKind,
} from './errors.js';

export {
  compareRisk,
  isOperatorStepKind,
  MAX_BILLING_UNITS,
  MAX_INBOX_MESSAGES,
  OPERATOR_RISK_CLASSES,
  OPERATOR_STEP_KINDS,
  OPERATOR_STEP_RISK,
  operatorStepRisk,
  parseOperatorStep,
  riskAtLeast,
  stepConsumesResource,
  stepProducesResource,
  type AccountCreateStep,
  type AccountRetireStep,
  type BillingRealChargeStep,
  type BillingSandboxChargeStep,
  type EntitlementGrantStep,
  type EntitlementRevokeStep,
  type FixtureResetStep,
  type FixtureSeedStep,
  type InboxReadStep,
  type OperatorRiskClass,
  type OperatorStep,
  type OperatorStepKind,
} from './steps.js';

export {
  grantOrigins,
  MAX_ENVIRONMENT_GRANTS,
  MAX_GRANTED_STEPS,
  MAX_STEPS_PER_DAY,
  MAX_UNITS_PER_DAY,
  parseEnvironmentGrants,
  parseOperatorAuthorityPolicy,
  parseOperatorBudget,
  parseRealMoneyAuthority,
  stepCost,
  type OperatorAuthorityPolicy,
  type OperatorBudget,
  type OperatorEnvironmentGrant,
  type RealMoneyAuthority,
} from './policy.js';

export {
  authorizeStep,
  denialAuthorityRef,
  findEnvironmentGrant,
  type AuthorityDecision,
  type OperatorAuthorityRef,
} from './authority.js';

export {
  lineageProgramKey,
  parseOperatorLineage,
  parseProvisionRequest,
  parseProvisionRequestId,
  provisionRequestId,
  requestDigest,
  requestJournalKey,
  type OperatorLineage,
  type ProvisionRequest,
  type ProvisionRequestId,
} from './request.js';

export {
  parseResourceHandle,
  type ConnectorCommand,
  type ConnectorOutcome,
  type ConnectorReleaseCommand,
  type ConnectorReleaseOutcome,
  type ProvisioningConnector,
  type ResourceHandle,
} from './connector.js';

export {
  isSetupProjection,
  OPERATOR_AUDIT_KINDS,
  projectOperatorFailure,
  type OperatorAuditKind,
  type OperatorAuditRecord,
  type OperatorCleanupCompletedRecord,
  type OperatorFailureProjection,
  type OperatorPlanDeniedRecord,
  type OperatorPlanFailedRecord,
  type OperatorPlanProvisionedRecord,
  type OperatorPlanReplayedRecord,
  type OperatorStepRolledBackRecord,
} from './evidence.js';

export {
  createWorldOperator,
  type CreateWorldOperatorOptions,
  type OperatorCleanupResult,
  type OperatorClock,
  type OperatorDeniedResult,
  type OperatorFailedResult,
  type OperatorFailureResult,
  type OperatorProvisionedResult,
  type OperatorRejectedRequestResult,
  type OperatorResult,
  type WorldOperator,
} from './operator.js';

export {
  script,
  ScriptedProvisioningProvider,
  type ScriptedProviderOptions,
} from './scripted-provider.js';
