# Configuration and Authority

## Purpose

u-sekai needs enough authority to create meaningful product conditions without turning a Synthetic Participant into an administrator.

The configuration model therefore separates:

1. **Human-declared authority** — what u-sekai is permitted to access or mutate.
2. **World Operator execution** — privileged setup/cleanup performed inside that authority.
3. **Participant exploration** — constrained user-visible actions.
4. **Observer/Evaluator access** — evidence access used to interpret what happened.

No agent may create new authority merely because additional access would make a run easier.

## `u-sekai.yml`

A future repository-controlled `u-sekai.yml` is the declarative configuration surface for normal self-service use.

Illustrative shape:

```yaml
product:
  id: example

environments:
  staging:
    url: https://staging.example.com
    allowedOrigins:
      - https://staging.example.com

    secrets:
      accountFactoryToken: ${secret:ACCOUNT_FACTORY_TOKEN}

    world:
      accounts:
        provider: http
        endpoint: https://staging.example.com/test-support/users

      email:
        provider: test-inbox

      billing:
        provider: stripe
        mode: test

    authority:
      destructiveActions: false
      externalCommunication: false
      realMoney:
        enabled: false
        maxAmount: 0

cohorts:
  new-users:
    size: 10
    lifecycle: ephemeral

  returning-users:
    size: 10
    lifecycle: persistent

reviewPrograms:
  staging-continuous:
    environment: staging
    cohort: returning-users
    trigger:
      cadence: daily
```

The exact schema is an implementation decision for the corresponding ticket. This document defines the authority semantics the schema must preserve.

## Secrets

Secret values do not belong in `u-sekai.yml`, committed fixtures, evidence artifacts, prompts, screenshots where avoidable, or run summaries.

Configuration stores references such as `${secret:ACCOUNT_FACTORY_TOKEN}`.

The managed service resolves those references through its approved secret authority. Local/open-source execution may use an equivalent injected secret mechanism.

A secret reference grants access only when the surrounding configured capability also permits the operation.

## World Operator

The World Operator is a privileged setup boundary, separate from the Participant.

Typical permitted operations may include:

- create or retire test accounts,
- seed customer-approved test data,
- set subscription/entitlement state through a test-support API,
- prepare a test inbox,
- reset a controlled fixture,
- establish team membership,
- create an upgrade/migration starting state,
- clean up resources created by the evaluation.

The preferred mechanism is an explicit customer-provided test-support interface. UI automation is a fallback when no safer setup API exists.

Operator actions are recorded as setup evidence but are not exposed to the Participant as available user actions.

## Participant

The Participant interacts with the product as the configured Synthetic User.

It receives only the observation/action/memory capabilities defined for that identity. Having a World Operator that can create an account does not let the Participant invoke account-factory APIs, inspect the database, read privileged DOM metadata, or bypass the visible product workflow.

## Observer and Evaluator

The Observer/Evaluator may receive richer trace/evidence access than a Participant, but is read-oriented by default.

It may classify, compare, reproduce, or request a bounded follow-up evaluation. It does not gain permission to mutate production state solely because it detected a problem.

## Delegation policy

### Safe to delegate inside declared bounds

Agents may autonomously decide details such as:

- which configured test account to create,
- which allowed seed template to use,
- when to reset an ephemeral identity,
- which exploration path to follow,
- which low-cost model to use internally,
- whether a suspicious trace merits a configured verification run.

### Human-controlled authority

The customer/project owner defines:

- which environments can be accessed,
- which domains/origins are allowed,
- which privileged connectors exist,
- whether persistent accounts/data may be created,
- whether real production state may be mutated,
- whether external messages may be sent,
- whether real money may be spent,
- maximum budgets and rate limits,
- retention/deletion policy for evidence and synthetic identities.

### Explicitly dangerous classes

The following are disabled by default and require explicit narrow enablement:

- real-money purchase or refund,
- destructive production mutation,
- irreversible account deletion,
- contacting real external users,
- posting publicly or sending email/SMS outside a test sink,
- using a real person's identity or credentials,
- crossing configured origins or external services.

When enabled, the configuration must provide an enforceable quantitative or categorical boundary. Natural-language instruction alone is not an adequate authorization mechanism.

## Billing semantics

Billing has two different meanings and must not be conflated.

### Product-under-test billing

A Synthetic Identity may need a subscription state or checkout flow.

Prefer:

1. sandbox/test mode,
2. customer-provided entitlement fixture,
3. reversible test transaction,
4. real transaction only under explicit production authority.

A Participant should experience the visible checkout flow when that is the object of evaluation, while the World Operator may prepare prerequisite state.

### u-sekai service billing

Customer billing for u-sekai itself is a service/control-plane concern and is not part of the Synthetic Participant capability model.

## Identity and audit

Every privileged setup action should be attributable to:

- Product,
- Environment,
- Review Program,
- Synthetic Identity/Cohort where relevant,
- execution/run identity,
- configured authority that permitted the action.

This lineage is required for cleanup, incident analysis, and preventing stale evidence from being treated as current.

## Failure behavior

If required setup cannot be completed within configured authority:

- fail the affected evaluation explicitly,
- preserve a bounded diagnostic,
- do not silently broaden permissions,
- do not convert setup failure into a Participant finding,
- do not claim the product was successfully evaluated.

## Configuration design goal

A normal customer should be able to express **what u-sekai may do** without scripting **how every Synthetic User behaves**.

The configuration file declares the world and the authority envelope. Exploration remains an agent responsibility.
