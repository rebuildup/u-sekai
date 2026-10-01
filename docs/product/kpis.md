# KPIs

## Purpose

u-sekai needs metrics that distinguish a useful evaluation service from an expensive stream of AI opinions.

No single UX score is the product KPI. Metrics are grouped by customer value, evaluation quality, economics, adoption, and platform readiness.

Numeric targets should be calibrated from real design-partner data rather than invented before a baseline exists.

## North-star metric

**Unique accepted evidence-backed findings per active Product per month**, guarded by false-positive and cost metrics.

A finding counts only when:

- it is backed by inspectable evidence,
- it is materially distinct from other findings in the measurement window,
- the customer marks it useful/valid or takes an equivalent product action,
- it is not merely a restatement of a known deterministic test failure.

This metric is intentionally harder to inflate than run count, model-token volume, report length, or raw finding count.

## Customer-value KPIs

### Finding acceptance rate

```text
accepted findings / dispositioned findings
```

A customer disposition may include accepted, invalid/false-positive, already-known, won't-fix, needs-human-research, or unresolved.

### Unique accepted finding rate

Accepted findings that were not already known to the team or trivially reported by existing deterministic checks.

This measures incremental value rather than agreement with known problems.

### Action rate

Share of accepted findings that lead to a concrete follow-up such as:

- product/design/code change,
- new deterministic regression test,
- deeper human research,
- instrumentation/monitoring change,
- explicit risk acceptance.

### Persistent-value rate

Share of active Products that receive at least one accepted finding across multiple distinct evaluation periods/releases.

This guards against a one-demo novelty product.

### Time to first useful finding

Elapsed time from a usable Environment being connected to the first accepted finding.

This includes setup friction and therefore matters for self-service viability.

## Evaluation-quality KPIs

### False-positive rate

Findings dispositioned as invalid or unsupported divided by dispositioned findings.

Low false-positive rate protects scarce human attention.

### Reproduction rate

Share of findings that can be reproduced under their recorded environment/identity/configuration lineage.

### Evidence completeness

Share of findings that include all evidence required by the finding contract: relevant trace references, environment/run identity, affected condition/cohort, and enough context to inspect the claim.

### Verification survival rate

Share of candidate findings that survive an independent bounded verification pass.

This can be used internally to optimize model routing and confidence thresholds.

### Stability / novelty balance

Track both:

- repeated detection of a persistent real issue,
- discovery of genuinely new issues.

A system that reports the same finding forever is not producing proportional new value. A system that never repeats anything may be unstable.

### Human/production calibration

Where the customer can provide it, measure correlation with:

- human usability research,
- support incidents,
- product telemetry,
- production regressions,
- customer feedback.

These are calibration signals, not a requirement to claim human representativeness.

## Unit-economics KPIs

### Evaluation compute cost

Direct model, browser/execution, storage, and provider cost per Evaluation Run and Review Program period.

### Cost per verified finding

```text
direct evaluation cost / verified findings
```

Useful for internal routing before customer disposition is available.

### Cost per accepted finding

```text
direct evaluation cost / accepted findings
```

This is a critical service metric. Lowering token price alone is irrelevant if finding quality falls.

### Gross margin contribution

Revenue attributable to the service period minus direct inference, browser/execution, storage, and other variable provider costs.

Human R&D and fixed engineering costs are tracked separately from per-run direct cost.

### Escalation ratio

Share of runs or candidate findings that require an expensive model/provider tier after cheaper scouting.

A healthy cascade should avoid sending every interaction to the highest-cost model.

### Reuse ratio

Share of useful computation/evidence reused across evaluation phases, such as baseline state, environment metadata, screenshots, stable observations, or cached setup.

## Adoption and retention KPIs

- Active Products.
- Active Review Programs.
- Products retained across multiple release periods.
- Environments per retained Product.
- Persistent Cohorts per Product.
- Evaluation executions triggered by customer workflows.
- Setup completion rate.
- Median time to connect the first usable Environment.
- Customer disposition coverage: findings that receive explicit feedback.

Raw GitHub stars, total Synthetic User count, and token volume are visibility/operations metrics, not product-value KPIs.

## Longitudinal-evaluation KPIs

- release transitions observed by persistent identities,
- longitudinal findings accepted,
- persistent issues detected across releases,
- resolved findings that remain absent in later verification,
- returning-user regressions found that fresh-user evaluation did not find.

These determine whether the persistent-cohort thesis creates value beyond ordinary point-in-time browser agents.

## Platform/provider readiness KPIs

For large provider or OEM adoption, measure:

- API/job completion reliability,
- reproducible result identity,
- median and tail completion latency by evaluation class,
- cost predictability,
- provider/model substitution without customer-visible contract breakage,
- bounded failure diagnostics,
- percent of jobs requiring human operational intervention,
- evidence retention/deletion conformance.

Provider readiness is not measured by having many provider-specific integrations.

## Business validation gates

Before claiming product-market fit or scaling infrastructure aggressively, the project should have measured evidence that:

1. customers repeatedly act on findings,
2. accepted findings include problems outside existing tests/known issue lists,
3. false positives do not make the service costly to read,
4. Review Programs remain enabled across releases,
5. direct cost per accepted finding supports sustainable pricing,
6. setup can be performed without bespoke engineering for every customer.

The first design-partner phase exists to establish baselines for these gates.

## Anti-metrics

The following can be useful operationally but must not be optimized as primary success metrics:

- number of agents launched,
- number of browser sessions,
- number of generated personas,
- number of findings before disposition,
- report length,
- total tokens consumed,
- percentage of UI visited,
- a universal scalar UX score.

Optimizing these directly can increase cost or noise without increasing customer value.
