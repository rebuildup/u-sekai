# 0.4.0 Continuous Product Evaluation implementation plan

## Goal

0.4.0 turns the existing Synthetic User experiment runtime into the first usable vertical slice of the environment-centric Continuous Product Evaluation service defined by ADR-0011.

This plan intentionally decomposes work by mutable file ownership so independent tickets can be implemented in parallel without competing for the same source files.

GitHub Issues remain the durable task and dependency source of truth. This document records the intended decomposition and file-ownership boundary; it does not duplicate mutable ticket status.

## Ticket map

| Issue | Purpose | Owned mutable paths | Size |
| --- | --- | --- | --- |
| #57 | Durable Product / Environment / Synthetic Identity / Cohort / Review Program domain | `src/product/**`, `test/unit/product/**` | M |
| #58 | `u-sekai.yml` loader + authority validation | `src/config/**`, `test/unit/config/**`, `test/fixtures/config/**`, package manifest/lock only if parser dependency is needed | M |
| #59 | World Operator and provisioning authority | `src/operator/**`, `test/unit/operator/**` | M |
| #60 | Persistent Synthetic Identity / Cohort state | `src/cohort/**`, `test/unit/cohort/**`, `test/fixtures/cohort/**` | M |
| #61 | Evidence-backed Finding / disposition contract | `src/review/**`, `test/unit/review/**` | M |
| #62 | Review Program planning / triggers / budgets | `src/program/**`, `test/unit/program/**` | M |
| #63 | Existing experiment/browser runtime integration | `src/runtime/**`, `test/integration/runtime/**` | L |
| #64 | Finding disposition history + KPI primitives | `src/feedback/**`, `test/unit/feedback/**` | S |
| #65 | Usable local CLI / shared entrypoint integration | `src/cli/**`, `src/index.ts`, `test/e2e/continuous-product-evaluation*.test.ts` | M |
| #66 | Managed-service-shaped control plane/API | `src/service/**`, `test/integration/service/**` | L |
| #67 | Persistent-cohort multi-release acceptance scenario | `test/e2e/service-acceptance/**`, `test/fixtures/service-acceptance/**`, `examples/continuous-product-evaluation/**` | M |

## Dependency graph

```text
#55 product/business decision + ADR-0011
                 |
                 v
              #57 domain
      +----------+----------+-----------+-----------+
      |          |          |           |           |
      v          v          v           v           v
    #58        #59        #60         #61         #62
   config    operator    cohort      review      program
                            \          |          /
                             \         |         /
                              +------ #63 ------+
                                      runtime
                                        |
                              +---------+---------+
                              |                   |
                              v                   v
                            #65                 #64
                            CLI               feedback/KPI
                              \                   /
                               \                 /
                                +------ #66 ----+
                                      service
                                        |
                                        v
                                      #67
                                acceptance gate
```

#58, #59, #60, #61, and #62 are designed as the main parallel implementation wave after #57.

#64 depends only on the review contract and can proceed while runtime/CLI integration is in progress.

#63 is the first deliberate convergence point. #65 is the only 0.4.0 ticket that owns the existing CLI/root entrypoint. #67 must not patch production implementation to force the acceptance scenario through; implementation defects found there become explicit blocking tickets.

## Why PR/source-diff integration is absent

A Git provider integration is not required for the first service vertical slice.

Pull requests, commits, and source diffs may later:

- trigger evaluation,
- prioritize exploration,
- explain a finding,
- provide source context to a coding agent.

They do not define the review target. The Environment remains canonical.

This allows the same Review Program model to work with:

- continuous develop/staging environments,
- pre-release promotion,
- released production-like systems,
- manual evaluations,
- non-Git deployment systems,
- future provider/OEM integrations.

## First usable scenario

0.4.0 is useful only if the following can be demonstrated end to end:

```text
u-sekai.yml
    ↓
Product + staging Environment
    ↓
Review Program
    ↓
World Operator creates bounded test state
    ↓
Synthetic Cohort uses real browser environment
    ↓
evidence + findings
    ↓
product changes from A to B
    ↓
same persistent identity returns
    ↓
longitudinal finding
    ↓
customer disposition
    ↓
KPI primitive
```

The deterministic CI path must not require an external model API key.

A manual/live-provider path may additionally prove that a real model can execute the same service contract.

## Parallel-work rule

The path lists above are ownership boundaries for the initial implementation wave.

A worker that discovers it must modify another active ticket's owned path should not silently expand scope. It should:

1. determine whether an interface can remove the cross-ticket mutation,
2. otherwise open or report a blocking integration defect,
3. let the dependency/integration ticket own the shared mutation.

This keeps concurrent work compatible with the project's Mutable Ownership Safety requirement.

## Deferred after the vertical slice

The following are intentionally not prerequisites for #67:

- production-grade distributed queue,
- Kubernetes/browser fleet,
- enterprise SSO,
- customer billing for the u-sekai service,
- production Stripe adapter,
- real-money participant transactions,
- GitHub App / Vercel / Cloudflare deployment triggers,
- cross-provider OEM integration,
- mobile/desktop execution,
- self-improving hypothesis generation,
- a universal UX score.

They should be added from evidence produced by real design-partner usage rather than from infrastructure speculation.

## Validation focus for 0.4.0

The release should prove four things:

1. **Usability** — a fresh user can connect a controlled environment without authoring `ExperimentDefinition` internals.
2. **Longitudinal value** — a persistent Synthetic Identity can produce meaningful A -> B evidence that a fresh-user-only run would miss.
3. **Authority integrity** — privileged setup does not leak into Participant capabilities, and dangerous operations remain disabled by default.
4. **Feedback economics** — findings can be dispositioned and aggregated into the KPI primitives needed to measure value and cost.

The next release should be chosen from the evidence obtained here rather than by automatically expanding every research direction.
