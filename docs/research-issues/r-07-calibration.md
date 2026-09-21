# R-07: Calibrating / validating Synthetic Users against real users

> Draft research artifact for issue **R-07** (calibration and validation of
> Synthetic Users against real users, with explicit validity boundaries).
> This is an investigation, not an adoption decision. Nothing in this document
> is "decided" or "adopted". The role of R-07 is to put plausible
> **candidate** calibration / validation mechanisms and explicit boundary
> statements on the table so that R-08 (MVP scope) can decide.

---

## 1. Question (verbatim from the draft)

> Investigate how to calibrate and validate that Synthetic Users are
> acceptable proxies for real users, and how to make the boundaries of
> validity explicit. Distinguish what u-sekai can calibrate from what it
> cannot.

**Acceptance criteria** (from `docs/research-issues/README.md`):

1. Calibration options / metrics comparison table exists in docs.
2. The "what Synthetic cannot validate" boundary is documented.

**Predecessors read first**:

- `docs/research-issues/r-02-synthetic-user-survey.md` (R-02) — synthetic-user
  / persona-simulation research and benchmark inventory, including the
  Validation Methods 4-dimension rubric and the consensus pitfall list.
- `docs/research-issues/r-05-subjective-eval.md` (R-05) — subjective-report
  design and its comparability-vs-reproducibility trade-off.
- `docs/research-issues/r-06-persona-generation.md` (R-06) — persona / task /
  situation generation and the diversity-vs-comparability trade-off.

This document builds on R-02 §3.7 and §4 (calibration / validation
methodology), R-05 §2.6 (comparability vs reproducibility), and R-06 §8.3
(alignment / weighting metrics) and §8.5 (behavioural fidelity metrics). It
does not redo those surveys. Where those documents already document a metric,
this document re-cites it and adds the calibration-specific framing.

---

## 2. Investigation summary

### 2.1 What was covered

- **What "calibration" and "validation" mean for Synthetic Users** — two
  distinct activities: (a) **calibration** binds simulator outputs to a real
  reference distribution; (b) **validation** tests whether the binding
  generalises to held-out stimuli, populations, or domains. The two are
  routinely conflated; this document separates them.
- **The four-dimension calibration rubric** — behavioural fidelity, demographic
  fidelity, process compliance, process fidelity (Validation Methods paper;
  R-02 §4.1).
- **The aggregate vs individual-level gap** — Chen et al. 2026 "When
  Synthetic Users Fail" formalises the failure mode where a synthetic-user
  study can look successful on aggregate distribution metrics while being
  invalid for any individual- or subgroup-level use.
- **The silicon-sampling / algorithmic-fidelity tradition** — Argyle et al.
  2023 (origin of the term), Bail 2024 PNAS critique, Ma 2025 evaluation,
  Lyman et al. 2025 alignment / fidelity trade-off, Twin-2K-500 dataset.
- **Calibration target families** — distributional, coverage, alignment,
  predictive validity, process transparency, sycophancy audit, adversarial
  probe, format-stability probe, persona-consistency probe.
- **The "what Synthetic Users cannot validate" boundary** — drawn from NN/g
  (Nielsen Norman Group) 2024 + 2025, MeasuringU 2024 review, NN/g 2025
  "Evaluating AI-Simulated Behavior" three-study reanalysis, Chen et al.
  2026, Bail 2024, the Wikipedia synthetic-user-research draft, and the
  Validation Methods paper.
- **The cost / privacy / consent surface** of *real-user* calibration data
  (inherited from R-06 §10 / open question §2 and R-02 §4.2).
- **Candidate validation workflow** — pre-register, calibrate on small
  real-user study, run synthetic study, cross-check on held-out real-user
  subset, report divergence, triangulate (R-02 §4.2 / §4.3).

### 2.2 What was skipped and why

- **Final adoption** of any specific rubric, metric, or workflow. The role of
  R-07 is to put candidates on the table; R-08 (MVP) will pick.
- **Privacy / consent mechanics for collecting real-user reference data**
  (Stanford 2-hour interviews × 1,052 participants; Twin-2K-500 provenance).
  Touched in §6 and listed in §10 — the policy detail belongs to a separate
  privacy decision and is already flagged in R-06 open questions.
- **Non-Web substrates** (mobile native, desktop, CLI, API). Surfaced only
  as a future-facing note; the Web-first scope is fixed by `README.md` and
  the R-01 layer model.
- **Multimodal / video / voice** subjective calibration. Surfaced as "give
  up" for the Web MVP; tracked as a follow-up.
- **A full re-read of every cited paper.** Where only abstracts, blog
  summaries, or pre-prints were reachable, those were used and the
  limitation is noted inline.
- **Specific commercial vendor validation claims** (Synthetic Users,
  User Interviews, Delve, Qualz, Interactius). Out of scope per the R-02 / R-06
  drafts; cited only as orientation.
- **A complete review of every synthetic-data validation framework** in the
  broader ML / privacy / fairness literature (dCR, membership inference,
  SynthCity, SDV evaluation suite, etc.). These are referenced where they
  bear on Synthetic-User calibration; the broader survey is out of scope.

### 2.3 Methodology notes

- **Inputs.** English-language academic search (arXiv, PNAS, Cambridge
  Political Analysis, ACL Anthology / EMNLP Findings, ACM DL, ResearchGate,
  Sage Journals), curated GitHub lists (`awesome-llm-human-simulation`),
  project homepages (NN/g, MeasuringU, the `When Synthetic Users Fail` paper
  site), and industry practitioner pages (Minds, Cyberarctica, PyMC Labs,
  Articos, Qualitati, pmtoolkit). Japanese sources were not used for this
  draft because no Japanese-only paper surfaced as essential; the R-07
  draft permits but does not require them.
- **Evidence weight.** Strongest: arXiv / peer-reviewed paper with concrete
  methodology and reported quantitative results. Medium: peer-reviewed paper
  with abstract / methodology sketch only. Weakest: blog / vendor summary
  used only for orientation.
- **Distinction between calibration and validation.** R-07 separates the two:
  calibration binds to a reference; validation tests the binding on
  held-out data. The metric families in §4 each target one or both.
- **Calibration target taxonomy.** Targets are grouped into six families:
  distributional / coverage / alignment / predictive validity / process /
  bias / safety. Each candidate metric in §4 is mapped to its family and
  its target behaviour.
- **Boundary taxonomy.** "What Synthetic Users cannot validate" is grouped
  into four axes (epistemic / behavioural / methodological / product), per
  §5. This is the structure that R-07 reports back to R-08.
- **Output language.** English only, per ADR-0002 (draft) /
  `CLAUDE.md` §7. Japanese translation of this draft is out of scope;
  tracked under R-09.

---

## 3. Conceptual decomposition

### 3.1 Two activities that the literature conflates

| Activity | What it does | What it costs | What it produces | When it is necessary |
| --- | --- | --- | --- | --- |
| **Calibration** | Tune simulator parameters / prompts / sampling until outputs match a *known* reference distribution | Real-user reference data + compute | A calibrated persona / population specification | When u-sekai claims "the synthetic population has X distribution of attitudes / behaviours" |
| **Validation** | Test whether a *calibrated* simulator predicts outcomes on *new* stimuli, populations, or domains | Held-out real-user data + ground-truth tasks | Evidence that the calibration generalises (or does not) | When u-sekai claims "synthetic findings transfer to real users in setting Y" |

The Validation Methods paper (R-02 §4.1) defines its four-dimension rubric
(behavioural / demographic / process / process fidelity) in calibration
terms. Chen et al. 2026 ("When Synthetic Users Fail") make the
aggregate-vs-individual distinction concrete: an aggregate-distribution
calibration can pass while individual-level validation fails. The NN/g 2025
three-study reanalysis (NN/g `articles/ai-simulations-studies`) operationalises
validation by re-running a real-user study with a synthetic-user tool and
comparing the conclusions. **R-07 recommends that u-sekai treat calibration
and validation as separate activities with separate metrics, even when the
underlying method overlaps.**

### 3.2 The aggregate / individual / subgroup trichotomy

Chen et al. 2026 — using GSS (14,704 respondents) and WVS Wave 7 (91,774
respondents across 63 countries), four LLMs, two prompt formats — show that
**aggregate fidelity can be reasonable while individual-level and
subgroup-level fidelity both fail**:

- On GSS, the best LLM ties the demographic-lookup-table baseline on
  individual accuracy (0.589). On WVS, all models fall 11–22 percentage
  points below the baseline.
- Models treat identity as roughly 40× more predictive of attitudes than it
  is among real humans (Δη² = +0.05 to +0.7).
- Between-segment differences are inflated 2–4× relative to humans.
- 50–72% of the time, the model picks the *wrong* extreme segment on a
  question.
- 9–23% of predictions *flip* when option order is reversed — a purely
  formatting change.
- Frontier models stereotype *more* than smaller models in this study.

Implication: a calibration that reports *only* aggregate-distribution
agreement can hide any of these failure modes. u-sekai's calibration
methodology should report at least one aggregate metric, one individual-
level metric, and one subgroup metric — unless the use case is one where
only the aggregate is consumed (e.g. population-level coverage estimation),
in which case the limitation must be stated explicitly.

### 3.3 Six calibration-target families

R-07 groups the metrics in §4 into six families. Each family targets a
different question.

| Family | Question it answers | Typical output |
| --- | --- | --- |
| **Distributional** | Do per-variable marginals match a real reference? | KS statistic / Wasserstein distance / JS divergence per variable |
| **Coverage / structural** | Does the synthetic population span the reference space (no mode collapse)? | Monte Carlo coverage, convex hull volume, pairwise distance, dispersion |
| **Alignment / weighting** | After post-hoc reweighting, do marginals / joint distributions match? | Raking weights, IPF, propensity-score overlap, SMD |
| **Predictive validity** | Does the simulator predict held-out real-user responses / behaviours? | Held-out accuracy, MAE, log-loss, Brier, earth-mover's distance |
| **Process / transparency** | Does the simulator's reasoning process look like a real user's reasoning process? | Process compliance, action justification, think-aloud fidelity, persona-consistency over a horizon |
| **Bias / safety** | Does the simulator inherit the simulator-class's known failure modes? | Sycophancy audit, format-stability probe, adversarial probe, demographic-fidelity split, stereotype audit |

### 3.4 Relation to the predecessor documents

- **R-02 §3.7 + §4** already catalogues calibration / validation
  methodology. R-07 extends that with the calibration-vs-validation split
  (§3.1), the aggregate-vs-individual finding (§3.2), and the silicon-
  sampling lineage (§4.4).
- **R-05 §2.6** documents the comparability-vs-reproducibility tension for
  the *subjective* channel. R-07 generalises this to *all* channels
  (subjective + behavioural + population-level), and ties it to the
  distinction between calibration (§3.1) and validation (§3.1).
- **R-06 §8.3** documents alignment / weighting metrics; **R-06 §8.5**
  documents behavioural-fidelity metrics. R-07 re-cites these and adds the
  *predictive-validity* family, which R-06 deferred to R-07.

---

## 4. Calibration / validation options — candidate comparison

Rows = option; columns = capability / cost / reproducibility / safety /
latency / portability. All entries are **candidate**, none are adopted.

### 4.1 Option: Distributional metrics (per-variable agreement with a reference)

**What it is.** For each attribute / behavioural variable, compare the
synthetic marginal to a real marginal using a univariate two-sample test or
divergence.

**Representative prior art.**

- Kolmogorov-Smirnov statistic — non-parametric, sensitive to shape
  differences; YODA Project acceptance criteria document; NannyML
  drift-detection comparison; Yale YODA Project.
- Wasserstein (earth-mover's) distance — continuous-distribution distance;
  scales with mean shift; standard in DeepPersona, MJV Innovation, Galileo.
- Jensen-Shannon divergence — symmetric, bounded; useful when support is
  limited.
- Cramér's V — coding-invariant association; used in Chen et al. 2026 for
  cross-tab comparisons.
- Chi-squared — for categorical variables.
- Comparing the two tests on synthetic distributions — ResearchGate
  fig. 370856219.

**Strengths.**

- **Closed-form or single solve.** Cheap to compute.
- **High reproducibility.** Given the same reference and the same synthetic
  sample, results are deterministic.
- **High portability.** No model dependency.
- **Communicable.** p-values and effect sizes are familiar to HCI / UX
  practitioners.

**Weaknesses.**

- **Per-variable only.** Joint distributions are not directly tested;
  two populations can agree on every marginal while disagreeing on joint
  structure.
- **Aggregate-fidelity blind spot.** Chen et al. 2026 explicitly show that
  aggregate metrics can pass while individual / subgroup metrics fail.
- **Reference-data required.** The metric is only as good as the reference
  distribution it is compared against.

**u-sekai relevance.** A baseline; required in any calibration report.
Not sufficient.

### 4.2 Option: Coverage / structural metrics (population-level diversity)

**What it is.** Measure how well the synthetic population *spans* a target
space, independently of any reference distribution.

**Representative prior art.**

- Monte Carlo coverage — fraction of a discretized attribute space
  represented by at least one persona (Persona Generators).
- Convex hull volume — multi-dimensional volume of the persona point cloud.
- Minimum / average pairwise distance — dispersion.
- Largest-empty-region dispersion.
- Attribute coverage count — number of distinct attributes per persona
  (DeepPersona).

**Strengths.**

- **Reference-free.** Useful when no reference distribution is available.
- **Quantifies mode collapse.** Catches the failure mode where LLM-prompted
  personas cluster around stereotypical modes.
- **Cheap to compute**; reproducible.

**Weaknesses.**

- **Bounded by attribute choice.** The coverage metric is over the attribute
  space the author chose to measure; gaps in the unmeasured space are
  invisible.
- **No semantic validity.** Two populations can have the same coverage
  while disagreeing on whether the covered cells reflect real users.

**u-sekai relevance.** Required as a sanity check; needed in any
calibration report that uses LLM-prompted generation.

### 4.3 Option: Alignment / weighting (post-stratification)

**What it is.** Generate an over-large pool, then re-weight samples so that
weighted marginals match a reference distribution.

**Representative prior art.**

- Post-stratification raking — iterative proportional fitting to marginals
  (Pew, CASRAI).
- Iterative Proportional Fitting (IPF) — multi-way tables.
- Propensity-score overlap and Standardized Mean Difference (SMD) —
  matched-samples designs (Beyond Personas).
- Design-based variance estimation — survey-methodology standard.

**Strengths.**

- **Standard in survey methodology.** Decades of practice.
- **Quantifies alignment error.** Raking diagnostics are well understood.
- **Composable with other families.** A common final step after
  distributional + coverage checks.

**Weaknesses.**

- **Reference-data required.** Without a sampling frame, raking has no
  target.
- **Reference-bias inheritance.** If the reference distribution is biased
  (e.g. WEIRD populations), the reweighted population inherits that bias.
- **Combinatorial blow-up.** Joint raking over many attributes produces
  empty / unstable cells.

**u-sekai relevance.** The canonical alignment method; needed if u-sekai
commits to a target sampling frame (R-08 territory).

### 4.4 Option: Silicon sampling with algorithmic-fidelity measurement

**What it is.** Condition an LLM on a demographic persona (the
"silicon-sampling" tradition) and measure *algorithmic fidelity* — how
well the LLM's output distribution matches a real population's response
distribution, relative to a non-LLM baseline (demographic lookup,
country-only lookup, class-conditional regression).

**Representative prior art.**

- **Argyle et al. 2023** — "Out of One, Many: Using Language Models to
  Simulate Human Samples" (*Political Analysis*, DOI 10.1017/pan.2023.2);
  the canonical reference for the silicon-sampling paradigm.
- **Bail 2024** — "Can Generative AI improve social science?" (*PNAS*
  121(21) e2314021121); a critical evaluation of LLMs as proxies in social
  science; >750 citations.
- **Ma 2025** — "Evaluating Silicon Sampling: LLM Accuracy in Simulating…";
  finds silicon sampling with demographic information alone is insufficient
  and can be misleading.
- **Lyman et al. 2025** — "Balancing Large Language Model Alignment and
  Algorithmic Fidelity" (*Sociological Methods & Research*, Sage);
  examines refusals, partial responses, and inconsistencies in silicon
  sampling tasks.
- **The conditional superiority of fast silicon sampling** (AlphaXiv 2608.14079) —
  compares algorithmic fidelity across fast vs slow sampling modes.
- **Twin-2K-500 dataset** (Toubia et al. 2025, *Marketing Science* /
  INFORMS) — digital-twins dataset; reports initial tests of predictive
  validity.

**Strengths.**

- **Baseline-relative framing.** Algorithmic fidelity answers the question
  "is the LLM better than the trivial baseline?", which is the *only*
  interpretation of an individual-accuracy number that is meaningful.
- **Quantifies the demographic-conditioning pitfall.** Makes
  demographic-over-determination (stereotyping) measurable.
- **Cross-domain.** Tested on GSS, WVS, ANES, and other public survey
  instruments.

**Weaknesses.**

- **Survey-shaped stimuli only.** Algorithmic fidelity as defined by Argyle
  et al. is for survey-question output; extension to behavioural traces
  or free-form UX interaction is not yet standardised.
- **No embodiment.** Silicon sampling does not exercise the environment;
  it is a text-only check.
- **Data-contamination risk.** If the LLM was trained on the survey items
  being tested, the fidelity is inflated (Bail 2024).

**u-sekai relevance.** Strong candidate for u-sekai's *attitudinal*
calibration; less directly applicable to *behavioural* calibration on a
live web app.

### 4.5 Option: Predictive validity on held-out real-user stimuli

**What it is.** After calibration, run the simulator on stimuli with known
real-user outcomes (held-out survey questions, held-out tasks with
ground-truth evaluation); measure how often the simulator predicts the
human outcome.

**Representative prior art.**

- Validation Methods for LLM-based Synthetic Users — four-dimension rubric;
  recommends predictive validity on held-out stimuli (R-02 §4.1).
- Synthetic User Research Validated Using Real User Data (R-02 §2.1) —
  LLM-simulated users underperform real users on needs-assessment tasks;
  uses a comparative accuracy metric.
- "When Synthetic Users Fail" (Chen et al. 2026) — operationalises
  predictive validity vs. demographic lookup, country-only lookup, and
  LLM conditions; reports that **no LLM beats the baseline on individuals
  in WVS** (best case: −11.1 pp); frontier models stereotype *more*.
- "Augmenting Randomized Controlled Trials with [LLM-generated
  participants]" (Shankar, ACM 2025) — cost-efficiency vs predictive
  validity trade-off; distribution shift challenges.
- UC Berkeley dissertation (Kang et al. 2026) — evaluates against
  fixed-modest-scale human user studies vs synthetic users; reports a
  predictive-validity gap.
- Qualitative analysis with held-out validation (MarTech 2026) —
  usability test reporting predictive validity against a held-out
  human sample.

**Strengths.**

- **The strongest test of generalisation.** A passing calibration that
  fails on held-out stimuli is, by definition, overfit.
- **Cross-domain.** Works for surveys, behavioural tasks, and
  conversational exchanges.
- **Policy-relevant.** "Predicts held-out real-user outcomes" is the
  claim downstream users most want to act on.

**Weaknesses.**

- **Requires held-out real-user data.** IRB-grade infrastructure that
  u-sekai does not have in the research / design phase.
- **Slow.** Held-out studies are expensive per stimulus.
- **Dataset-bias inheritance.** Held-out data drawn from the same population
  as the calibration set can mask cross-population failure.

**u-sekai relevance.** Required if u-sekai claims predictive validity;
required for *any* claim of "synthetic findings transfer to real users
in setting Y". Heavy lift in the research / design phase; can be deferred
to a v2+ if the MVP scope is calibrated-only.

### 4.6 Option: Process / transparency metrics

**What it is.** Inspect the simulator's reasoning process, not just its
output, and compare it to a real-user reasoning process.

**Representative prior art.**

- **Validation Methods paper §4.1** — process compliance + process
  fidelity as the third and fourth dimensions.
- **PersonaGym** — action-justification, expected-action, persona-
  consistency, linguistic-habits tasks (R-02 §3.1).
- **Bauer & Senoner et al. 2024** — think-aloud protocol adapted to LLM
  users; compared against human usability-study transcripts (R-02 §2.1).
- **InCharacter (ACL 2024)** — personality fidelity via psychological
  interviews (R-02 §2.2).

**Strengths.**

- **Detects confabulation.** A simulator that produces the right output
  with the wrong rationale is dangerous; process metrics expose this.
- **Composes with other families.** Cheap to add on top of behavioural
  fidelity.

**Weaknesses.**

- **Process-fidelity is hard to ground.** What counts as a "real-user
  reasoning process" is method-specific (think-aloud, decision trace,
  eye-tracking).
- **Subjective coding cost.** Qualitative protocols require trained coders
  (or a separate LLM-as-judge, which inherits the shared-distribution
  problem).

**u-sekai relevance.** Candidate for the subjective channel (R-05) and for
the cross-channel triangulation pattern (R-05 §5.4).

### 4.7 Option: Bias / safety audits

**What it is.** Explicit probes for the simulator-class's known failure
modes: sycophancy, format instability, demographic over-determination,
stereotype amplification, demographic-prompt gap, training-data
contamination, persona-consistency drift.

**Representative prior art.**

- **Sycophancy audit** — adversarial / random tasks; Liu et al.; Bauer &
  Senoner (R-02 §5.4).
- **Format-stability probe** — option-order reversal, prompt-paraphrase;
  Chen et al. 2026 reports 9–23% prediction flips on option-order reversal.
- **Demographic-fidelity split** — Patil et al.; Cao et al. (R-02 §3.1).
- **Persona-consistency over a horizon** — PersonaGym task #4 (R-02 §2.2).
- **"Too Perfect" bias audit** — Springer 2026 (R-06 §8.4).
- **"Bias Auditing Synthetic User Simulations"** — audited 47 papers; 11%
  report any sampling methodology (R-06 §8.4).
- **Responsible Use of AI Personas in Human-Centered Design** (ACM 2026)
  (R-06 §8.4).
- **"Synthetic data, synthetic trust"** (PMC 2025).

**Strengths.**

- **Catches failure modes that aggregate metrics miss.** A simulator can
  pass aggregate calibration and still be unsafe / biased.
- **Cheap.** Audits are scripted; can be added to any calibration report.
- **Communicable.** "We audited for sycophancy / stereotyping / format
  instability and found X" is a standard report pattern.

**Weaknesses.**

- **No positive calibration signal.** Audits catch failure modes; they do
  not say whether the simulator is well-calibrated.
- **Audit completeness is unbounded.** New failure modes appear with new
  model versions.

**u-sekai relevance.** Required as a *floor* on any calibration report;
candidate for inclusion in MVP if R-08 accepts the cost.

### 4.8 Option: LLM-as-judge (with caveats)

**What it is.** Use a separate strong LLM as a *judge* of simulator
outputs: persona consistency, action justification, fidelity to a persona,
usability of a session.

**Representative prior art.**

- WebVoyager — GPT-4V auto-eval with 85.3% human-agreement (R-02 §3.5).
- PersonaGym ensemble of LLM judges (R-02 §3.5).
- PersonaEval — whether LLM agents can act as reliable proxies for human
  raters (R-02 §2.2).
- PersonaScore composite (PersonaGym) — 1-5 scale ensemble.

**Strengths.**

- **Scalable.** Cheaper than human raters; consistent across many runs.
- **Compositional.** Can be combined with any of the other families.
- **Multi-task.** PersonaGym-style ensembles cover multiple dimensions
  per session.

**Weaknesses.**

- **Shared-distribution risk.** The judge shares training distribution with
  the simulator; calibration is circular.
- **85% human-agreement is not 100%.** For subjective quality, 14.7%
  disagreement with humans is significant.
- **Prompt-sensitive.** Judge prompts need their own pre-registration.

**u-sekai relevance.** Candidate as a *secondary* calibration channel;
must be paired with at least one human-baseline calibration before claims
are made.

### 4.9 Comparison table — calibration / validation options

| Option | Capability (what it detects) | Cost shape | Reproducibility | Safety surface | Latency | Portability / vendor dep. |
| --- | --- | --- | --- | --- | --- | --- |
| Distributional (KS, Wasserstein, JS, Cramér's V) | Per-variable aggregate agreement | Low | High | Low | Low | High |
| Coverage / structural (MC, convex hull, pairwise, dispersion, attribute count) | Mode collapse; population span | Low–Moderate | High | Low | Moderate | High |
| Alignment / weighting (raking, IPF, propensity, SMD) | Aggregate-population fidelity after reweighting | Moderate | High | Medium — depends on reference provenance | Moderate | High |
| Silicon sampling + algorithmic fidelity (Argyle / Bail / Ma / Lyman) | Per-individual / per-segment fidelity vs. non-LLM baseline | Moderate–High (real-data + LLM) | Medium | Medium | Moderate | Medium (depends on survey data license) |
| Predictive validity on held-out stimuli | Generalisation; aggregate vs individual gap | High (held-out studies) | Medium | High (real-user data) | High | High |
| Process / transparency (Validation Methods, PersonaGym, think-aloud, InCharacter) | Confabulation; process fidelity | Medium–High (coding / qualitative) | Medium | Low | Moderate | Medium |
| Bias / safety audits (sycophancy, format stability, demographic-fidelity split, persona drift, "Too Perfect") | Known failure modes | Low–Moderate | High | High — auditing is itself a safety practice | Low | High |
| LLM-as-judge (WebVoyager, PersonaGym, PersonaEval) | Multi-task composite scalability | Moderate (second model call) | Medium | Low (subject identity stripped) | Moderate–High | Low (tied to judge model) |

**Reading note**: "Capability" describes what a *passing* result means. None
of these rows on its own is a complete calibration report; the candidate
pattern in §7 is to combine at least one distributional + one coverage + one
predictive-validity + one bias / safety metric per study.

---

## 5. The "what Synthetic Users cannot validate" boundary

This section is R-07's second acceptance criterion. The boundary is
organised along four axes: **epistemic**, **behavioural**, **methodological**,
and **product**. Each axis states what Synthetic Users *cannot* validate,
cites the supporting evidence, and notes what u-sekai can or cannot do
about it.

### 5.1 Epistemic boundary — what Synthetic Users cannot *know*

1. **Synthetic Users cannot have unmet needs.** They can only model patterns
   present in their training distribution. New needs, emerging behaviours,
   edge cases, and underrepresented populations are systematically missed.
   *Source:* Wikipedia synthetic-user-research draft (R-02 §5.15).
2. **Synthetic Users cannot introspect honestly.** When an LLM agent answers
   "I found this confusing", the answer is produced by the same kind of
   model that generated the behaviour — and is therefore subject to
   sycophancy, confabulation, and prompt-sensitivity. *Source:* R-02 §5.4,
   §5.7.
3. **Synthetic Users cannot evaluate themselves on dimensions they have not
   been asked to evaluate themselves on.** A persona-conditioned LLM asked
   to "rate accessibility" without an embodiment will produce a stylised
   answer that reflects training-data accessibility discourse, not the
   persona's lived experience. *Source:* R-03 §4.3–4.5 (perception-level
   reproduction gaps); R-05 open question 2.
4. **Synthetic Users cannot detect novel failure modes that the simulator's
   training distribution has never seen.** The boundary of synthetic
   findings is bounded by what the underlying model knows. *Source:* R-02
   §5.15.
5. **Synthetic Users cannot substitute for construct validity.** A synthetic
   finding is a *model* of a population, not a measurement of one. *Source:*
   R-02 §5.16; Wikipedia draft.

**What u-sekai can do.** Explicitly disclaim epistemic limits in every
report. Use Synthetic Users for *hypothesis generation*, not *hypothesis
confirmation*. Triangulate with at least one human study before drawing
conclusions (R-02 §4.2).

**What u-sekai cannot do.** Turn a calibrated Synthetic User into a
ground-truth oracle. There is no calibration that closes the epistemic gap
above.

### 5.2 Behavioural boundary — what Synthetic Users cannot *do*

1. **Synthetic Users cannot replicate real-user friction, confusion, motor
   slips, and negative reactions.** They are trained to be helpful, not to
   reproduce the noisy behaviours that real usability depends on. *Source:*
   Bauer & Senoner; Hämäläinen; NN/g 2024 + 2025; MeasuringU review (R-02
   §5.1, §5.5).
2. **Synthetic Users overstate task success.** NN/g's 2025 three-study
   reanalysis found that a synthetic-user tool overstates task success
   rates compared to real users. *Source:* NN/g 2025 three-study article.
3. **Synthetic Users cannot model embodiment.** Screen size, latency,
   interruption, physical / cognitive accessibility, motor / sensory
   impairment — none of which a text-only simulator reproduces. *Source:*
   R-02 §5.5; R-03.
4. **Synthetic Users cannot learn, fatigue, or develop habits over time.**
   Single-turn or single-session evaluations miss longitudinal behaviour.
   *Source:* Liu et al. (R-02 §5.6).
5. **Synthetic Users cannot reproduce longitudinal demographic variance.**
   Park et al. 2024 report 79% of classic social-science replications failed
   with synthetic users; the replication-failure rate is the canonical
   evidence. *Source:* R-02 §5.1; MeasuringU review.
6. **Synthetic Users are more agreeable by design.** Sycophancy and
   instruction-following bias are training-distribution properties, not
   bugs that can be calibrated away. *Source:* NN/g 2024 + 2025; Liu et al.

**What u-sekai can do.** Use the behavioural-log substrate (R-05 §5.2) to
derive friction signals from the trace, not from the subjective report.
Runtime-inject perception-level constraints where R-03 permits (device,
locale, network); explicitly defer embodiment (motor / sensory impairment)
to a later phase.

**What u-sekai cannot do.** Substitute Synthetic Users for usability
testing on accessibility / perception-dependent tasks. The synthesis-class
cannot *have* a perception; it can only *be conditioned to describe* one.
The behavioural log can report what the agent *did*; it cannot report what
the agent *saw*.

### 5.3 Methodological boundary — what Synthetic Users cannot *generalise*

1. **Synthetic Users cannot generalise across populations without re-calibration.**
   A calibration tuned to a US GSS sample does not transfer to a non-US
   population. Chen et al. 2026 show that on WVS, all LLMs fall 11–22 pp
   below the baseline; silicon sampling with demographic information alone
   is insufficient and can be misleading (Ma 2025).
2. **Synthetic Users cannot generalise across prompt / format changes.**
   9–23% of predictions flip when option order is reversed (Chen et al.
   2026); prompt paraphrases produce different behaviour (PersonaGym).
3. **Synthetic Users cannot generalise across model versions.** A persona
   generated by Claude 3.5 Sonnet may not be reproduced by Claude 3.5
   Sonnet one model upgrade later (R-06 §4.2 weakness).
4. **Synthetic Users cannot generalise across questions, tasks, or domains
   outside their training distribution.** The "When Synthetic Users Fail"
   benchmark is built specifically to expose this; NN/g's 2025 three-study
   reanalysis documents this across three real user studies.
5. **Synthetic Users do not benefit monotonically from capability.** Chen et
   al. 2026 report that frontier models stereotype *more* than smaller
   ones on the survey instruments they tested; PersonaGym reports Claude
   3.5 Sonnet only +2.97% PersonaScore over GPT-3.5, and Claude 3 Haiku
   *resists* taking on personas (R-02 §5.12).
6. **Synthetic Users cannot substitute for held-out validation.** A
   calibration that fits the calibration set can fail on the held-out set;
   the validation step is required, not optional (R-02 §4.1; §5.11).

**What u-sekai can do.** Pre-register prompts and persona specifications;
report cross-format / cross-model stability as a calibration output; commit
to a persona-spec version policy (R-06 open question 3).

**What u-sekai cannot do.** Claim that a calibrated Synthetic User is
"validated" without a held-out test. The validation step is the boundary
between calibration and overfitting.

### 5.4 Product boundary — what Synthetic Users cannot *replace*

1. **Synthetic Users are not a replacement for real-user research.** "UX
   without real-user research isn't UX"; "research without real users is
   not research." *Source:* NN/g 2024 + 2025; NN/g AI-work study guide.
2. **Synthetic Users are not appropriate for accessibility / compliance
   decisions.** A population-level accessibility claim requires
   *embodied* disabled users. *Source:* NN/g 2024; R-03.
3. **Synthetic Users are not appropriate for population-wide UX claims.**
   Aggregate-distribution agreement does not imply subgroup-validity
   (Chen et al. 2026).
4. **Synthetic Users are not appropriate as the sole evidence base for
   shipping decisions.** Subjective channels are appropriate for *internal
   A/B* and *hypothesis generation* (R-05 §5.5). Behavioural logs are the
   strongest reproducibility signal; subjective reports are the strongest
   ecological-validity signal. The two together carry the most defensible
   signal — but neither alone is sufficient for shipping.
5. **Synthetic Users are not appropriate for concept / solution validation.**
   NN/g explicitly warns against this use. *Source:* NN/g "Synthetic Users:
   If, When, and How to Use".

**What u-sekai can do.** Be explicit about the use cases for which
Synthetic User findings are appropriate, and those for which they are
not. R-07 candidate use-case partition (candidate, not adopted):

- **Appropriate**: hypothesis generation, internal A/B comparison across
  conditions, exploratory-UX discovery, qualitative pattern surfacing,
  benchmarking one design against another on the same synthetic population.
- **Inappropriate**: shipping decisions, accessibility compliance,
  population-wide claims, concept validation, statistical-significance
  testing against real-user populations.

**What u-sekai cannot do.** Promote a Synthetic-User finding to a claim
about real users without an explicit, recorded calibration / validation
step. The product boundary is the strongest constraint and is the one most
likely to be violated by accident.

### 5.5 Summary of the boundary

The four axes collapse to a single principle:

> **A Synthetic User finding is a *hypothesis* about a real-user
> population until calibration + validation against a real reference has
> been recorded, and even then it is a *bounded* hypothesis — bounded by
> the calibration's coverage, the validation's generalisation, and the
> simulator-class's known failure modes.**

R-07 recommends that u-sekai adopt this principle as a *publication
standard* — every Synthetic-User finding that is reported outside the
project must carry (a) the calibration report, (b) the validation report,
(c) the failure-mode audit, and (d) an explicit statement of the boundary
under which the finding is licensed. None of this is yet an ADR; it is a
candidate principle pending R-08 / user escalation.

---

## 6. Differences vs u-sekai requirements (gap analysis)

| u-sekai requirement | Closest surveyed area | Gap |
| --- | --- | --- |
| **Calibrate Synthetic Users against real users** | Validation Methods paper; Argyle et al. 2023; Bail 2024; Ma 2025; Lyman et al. 2025; Chen et al. 2026; NN/g 2024 + 2025 | Methodologies exist; the *Web-UX* combination is under-explored. Silicon sampling is for surveys, not for live web exploration. **Gap**: a calibration rubric tuned for exploratory UX evaluation on live products — candidate for an ADR after R-08. |
| **Validate (not just calibrate)** | NN/g 2025 three-study reanalysis; Validation Methods paper; Predictive-validity literature (Chen et al. 2026; Shankar 2025) | The validation step is standard in survey methodology but rare in UX-simulation work. **Gap**: u-sekai must operationalise validation explicitly, with held-out real-user stimuli. |
| **Aggregate vs individual / subgroup gap** | Chen et al. 2026; Bail 2024 | The gap is documented. **Gap**: u-sekai must report per-subgroup metrics, not only aggregate, when making subgroup claims. |
| **Perception-level (visual / motor / cognitive) calibration** | R-03; persona generation (R-06) | Synthetic Users cannot be calibrated against a population they cannot *be* a member of. **Gap**: u-sekai must explicitly defer accessibility / perception-level claims until R-03's runtime-enforcement options are exercised and validated. |
| **Real Web environments (not canned test sets)** | WebArena / Mind2Web / WebVoyager / Online-Mind2Web (R-02 §2.4) | These benchmarks evaluate the *system under test*, not the *Synthetic User*. **Gap**: no surveyed calibration rubric covers the live-web substrate. |
| **Cross-model reproducibility of calibration** | Chen et al. 2026; Lyman et al. 2025; PersonaGym | Calibration is reported per-model; cross-model reproducibility is weak. **Gap**: u-sekai must adopt a persona-spec version policy (R-06 open question 3). |
| **Held-out real-user data for validation** | Stanford 1,052-person study (R-02 §2.1); Twin-2K-500 (Toubia et al. 2025); ANES; GSS | Real-user data exists but requires IRB-grade infrastructure. **Gap**: real-user validation is gated on a privacy / consent decision — flagged in R-06 open question 2. |
| **Make the boundary explicit** | NN/g 2024 + 2025; Chen et al. 2026; Bail 2024; Wikipedia draft; NN/g AI-work study guide | Multiple boundary statements exist. **Gap**: u-sekai needs an *internal* publication standard — §5 above is the candidate. |
| **Privacy / consent for real-user data** | Stanford American Voices Project 2-hour interviews; ANES enrollment | Out of scope for u-sekai's research / design phase. **Gap**: real-user-seeded calibration is gated on a separate privacy / consent decision — flagged in R-06 open question 2. |
| **Cost / latency of parallel calibration** | OASIS (1M agents); AgentSociety | Population scale is solved at the social-simulation layer. **Gap**: not benchmarked for parallel calibration runs on browser-agent harnesses; R-04 territory. |
| **Calibration rubric ownership** | Validation Methods paper; PersonaGym; Chen et al. 2026 four-dimension rubric | Published rubrics exist. **Gap**: which rubric u-sekai adopts (or whether it designs its own) is R-08 territory. |

---

## 7. Candidate set recommendations (candidate, not adopted)

> All wording below is **candidate**, not adopted. The role of R-07 is to
> assemble plausible mechanisms so that R-08 can decide.

### 7.1 Candidate default calibration pattern — *minimal viable calibration report*

For any synthetic-user study that u-sekai publishes or consumes, the
following minimum calibration report is a candidate:

1. **Distributional** — at least one per-variable metric (Wasserstein for
   continuous; Cramér's V for categorical; KS for univariate testing).
2. **Coverage** — at least one population-span metric (Monte Carlo coverage
   over the discretized attribute space; pairwise distance).
3. **Predictive validity** — at least one held-out real-user stimulus set
   with reported accuracy vs a non-LLM baseline (demographic lookup is the
   minimum baseline; Chen et al. 2026 use this pattern).
4. **Process / transparency** — at least one persona-consistency check over
   a horizon (PersonaGym-style task #4 or equivalent).
5. **Bias / safety** — at least three probes: sycophancy, format stability
   (option-order reversal), demographic-fidelity split.
6. **Boundary statement** — an explicit statement of which use cases the
   finding is licensed for (per §5.4).

This six-element report is a candidate. It is heavier than the 11%-of-47-
papers baseline that R-06 §8.4 reports; the candidate is intentionally
heavier because u-sekai is publishing a *research* artefact, not a vendor
demo.

### 7.2 Candidate default validation pattern — *held-out real-user study*

For any synthetic-user claim of the form "synthetic findings transfer to
real users in setting Y":

1. **Pre-register** the prompt, the persona specification, and the
   stimulus set (Validation Methods paper; R-02 §4.3).
2. **Calibrate** on a small real-user study (R-02 §4.2 / §4.3).
3. **Run** the synthetic study at the target population scale.
4. **Cross-check** on a held-out real-user subset; report aggregate,
   individual-level, and subgroup-level agreement separately (Chen et al.
   2026).
5. **Report divergence** explicitly — where synthetic and human findings
   agree, where they diverge, and the failure-mode category.
6. **Triangulate** with at least one independent human study before drawing
   conclusions (R-02 §4.2).
7. **Audit** for the four R-07 axes (epistemic / behavioural /
   methodological / product); the audit checklist is itself recorded.

This seven-step pattern is a candidate. It is the operational form of the
"boundary statement" from §5.5.

### 7.3 Candidate things explicitly deferred

These are candidates for *later* consideration, deferred until R-08 / a
future ADR:

- **Multimodal calibration** (facial affect, voice prosody, physiological).
  Requires extension beyond the initial Web target.
- **Privacy-grade real-user validation infrastructure.** Out of scope for
  v1; gated on a separate privacy / consent decision.
- **Cross-LLM ensemble disagreement as a calibration signal.** Requires
  R-06 (persona generation) to define what counts as an ensemble.
- **Adoption of any specific commercial calibration platform.**
  Explicitly excluded by R-02 scope.

### 7.4 Candidate things u-sekai should *not* attempt in v1

- **Pure aggregate-distribution calibration without individual / subgroup
  metrics.** Will miss the failure modes that Chen et al. 2026 document.
- **Silicon sampling with demographic information alone.** Ma 2025 finds it
  insufficient and potentially misleading.
- **Calibration without a held-out validation step.** Calibration that fits
  the calibration set can fail on the held-out set.
- **Real-user-data-driven calibration at scale.** Privacy / consent
  infrastructure is out of scope for v1.
- **LLM-as-judge as the sole calibration signal.** Shared-distribution
  risk; must be paired with at least one human-baseline calibration.
- **Cross-population generalisation claims.** A US-calibrated Synthetic User
  is not validated for non-US populations; claims of cross-population
  transfer require explicit re-calibration.

---

## 8. Open questions / follow-up items / unresolved consequential decisions

These items surfaced during the investigation but require separate Issues
or user escalation. Recorded here so they are not lost.

1. **Calibration rubric ownership.** Should u-sekai adopt a published rubric
   (Validation Methods 4-dimension; PersonaGym PersonaScore; Chen et al.
   2026 four-rubric) or design its own for exploratory Web UX? R-08 territory;
   consequential because it determines what "calibrated Synthetic User"
   means for downstream consumers.
2. **Real-user-data policy for validation.** Stanford's 2-hour interviews
   × 1,052 participants and Twin-2K-500 represent a privacy / consent cost
   u-sekai does not have in the research / design phase. Real-user
   validation is gated on a separate privacy / consent decision — flagged
   in R-06 open question 2.
3. **Aggregate-vs-individual reporting policy.** Should u-sekai commit to
   reporting per-subgroup metrics even when only the aggregate is consumed?
   Consequential because it determines the cost of every calibration report.
4. **Boundary publication standard.** Should u-sekai adopt the §5.5
   publication standard as an ADR (so that every Synthetic-User finding is
   accompanied by the calibration / validation / failure-mode audit /
   boundary statement)? Consequential because it is the project's strongest
   claim about how its findings should be consumed.
5. **Cross-model calibration policy.** Calibration is per-model; should
   u-sekai run calibration on every supported model and report per-model
   divergence? Or pick a single reference model? Consequential because the
   cross-model reproducibility gap is one of the strongest methodological
   failure modes (R-06 open question 3).
6. **Silicon-sampling applicability to Web UX.** Silicon sampling is
   designed for survey-question output; extension to behavioural traces on
   live web apps is not yet standardised. Candidate for a future Issue.
7. **Held-out stimulus design.** What constitutes a valid held-out stimulus
   set for a Synthetic-User Web-UX claim? Consequential because it determines
   what u-sekai can claim after a validation run.
8. **The "demographic-fidelity split" as a v1 floor.** Whether the
   demographic-fidelity split (Patil et al.) is required in every
   calibration report, or only when subgroup claims are made. Candidate
   for a convention rather than an ADR.
9. **Validation of the validation.** When the validation step is performed
   against real-user data, who validates the validation? A
   meta-calibration question. Out of scope for v1 but worth recording.
10. **Bias audit cadence.** Whether the bias / safety audit (§4.7) runs on
    every calibration or only at release time. R-08 territory.

---

## 9. References

All URLs are listed for traceability. Several are blog / vendor summaries
used only for orientation and clearly marked.

### Calibration / validation methodology — primary sources

- Validation Methods for LLM-based Synthetic Users (4-dimension rubric) —
  `https://arxiv.org/abs/2412.06047`
- "When Synthetic Users Fail: A Cross-Domain Benchmark" (Chen et al. 2026) —
  `https://arxiv.org/html/2607.26348v1`; PDF: `https://arxiv.org/pdf/2607.26348`
- "Synthetic User Research Validated Using Real User Data" —
  `https://arxiv.org/abs/2410.20538`
- "Augmenting Randomized Controlled Trials with [foundation-model users]"
  (Shankar, ACM 2025) — `https://dl.acm.org/doi/pdf/10.1145/3765612.3767256`
- Bauer & Senoner et al. — LLM-simulated users for think-aloud usability
  studies — `https://arxiv.org/abs/2404.02163`
- Hämäläinen et al. — LLM-based UIs — `https://arxiv.org/abs/2312.11812`
- Patil et al. (Stanford) — Personas vs demographics gap —
  `https://arxiv.org/abs/2402.18076`
- Liu et al. — Evaluating LLMs as Synthetic Users —
  `https://arxiv.org/abs/2502.08462`
- PersonaGym — `https://arxiv.org/abs/2407.18416`;
  `https://arxiv.org/html/2407.18416v4`; `https://personagym.com`
- PersonaEval — `https://arxiv.org/abs/2502.02791`
- LLM-PDM — `https://sciopen.com/article/10.26599/COMMTR.2026.9640004`
- WebVoyager — `https://arxiv.org/abs/2401.13919`
- Park et al. (2024) — Generative Agent Simulations of 1,000 People —
  `https://arxiv.org/abs/2411.10109`; HAI summary:
  `https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy`

### Silicon sampling / algorithmic fidelity

- Argyle et al. 2023 — "Out of One, Many: Using Language Models to Simulate
  Human Samples" — Cambridge *Political Analysis*:
  `https://www.cambridge.org/core/journals/political-analysis/article/out-of-one-many-using-language-models-to-simulate-human-samples/035D7C8A55B237942FB6DBAD7CAA4E49`;
  arXiv: `https://arxiv.org/abs/2209.06899`;
  AlphaXiv: `https://www.alphaxiv.org/abs/2209.06899`;
  ResearchGate: `https://www.researchgate.net/publication/368699890_Out_of_One_Many_Using_Language_Models_to_Simulate_Human_Samples`
- Bail 2024 — "Can Generative AI improve social science?" (*PNAS* 121(21)
  e2314021121) — `https://www.pnas.org/doi/10.1073/pnas.2314021121`;
  preprint:
  `http://nlp-css-601-672.cs.jhu.edu/sp2024/files/Can_Generative_AI_Improve_Social_Science_Preprint_October_2023.pdf`;
  ResearchGate: `https://www.researchgate.net/publication/380475248_Can_Generative_AI_improve_social_science`
- Ma 2025 — "Evaluating Silicon Sampling: LLM Accuracy in Simulating…"
  — `https://alexandria.unisg.ch/bitstreams/cf75a694-d374-4da6-b07a-55156e2346eb/download`
- Lyman et al. 2025 — "Balancing Large Language Model Alignment and
  Algorithmic Fidelity" (*Sociological Methods & Research*) —
  `https://journals.sagepub.com/doi/10.1177/00491241251342008`;
  PDF: `https://sail.byu.edu/00000199-88eb-df8c-abf9-baffef6d0000/lyman-et-al-2025-balancing-large-language-model-alignment-2-pdf`
- "The conditional superiority of fast silicon sampling" (AlphaXiv) —
  `https://www.alphaxiv.org/abs/2608.14079`
- "Algorithmic Fidelity of Large Language Models in Generating…" —
  Semantic Scholar:
  `https://www.semanticscholar.org/paper/Algorithmic-Fidelity-of-Large-Language-Models-in-A-Ma-Yoztyurk/17d898ea659dccedd58e0d124cf47f00a77e450a`
- Twin-2K-500 dataset (Toubia et al. 2025, INFORMS) —
  `https://pubsonline.informs.org/doi/10.1287/mksc.2025.0262`

### Boundary statements (what synthetic users cannot validate)

- NN/g — "Synthetic Users: If, When, and How to Use AI-Generated 'Users'"
  (2024) — `https://www.nngroup.com/articles/synthetic-users/`
- NN/g — "Evaluating AI-Simulated Behavior: Insights from Three Studies
  on Digital Twins and Synthetic Users" (2025) —
  `https://www.nngroup.com/articles/ai-simulations-studies/`;
  UXLift mirror: `https://www.uxlift.org/articles/evaluating-ai-simulated-behavior-insights-from-three-studies-on-digital-twins-and-synthetic-users/`
- NN/g — "Using AI for UX Work: Study Guide" (2026 update) —
  `https://www.nngroup.com/articles/ai-work-study-guide/`
- MeasuringU — "A Review of Experiments with Synthetic Users" —
  `https://measuringu.com/review-of-experiments-with-synthetic-users/`
- MeasuringU — "What Are the Different Types of Synthetic Users?" —
  `https://measuringu.com/what-are-the-different-types-of-synthetic-users/`
- User Vision — "Synthetic Users and Digital Clones: A UX Researcher's
  Honest Take" —
  `https://uservision.co.uk/thoughts/synthetic-users-and-digital-clones-a-ux-researcher-s-honest-take`
- Qualitati — "Digital Twins in User Research: When to Trust Them
  (2026)" — `https://qualitati.com/blog/digital-twins-user-research-2026`
- pmtoolkit.ai — "Synthetic Users: What AI Participants Can and Cannot
  Tell You" —
  `https://pmtoolkit.ai/learn/experimentation/synthetic-users-promise-and-trap`
- MarTech — "Synthetic research is a promise with a catch" (2026) —
  `https://martech.org/synthetic-research-is-a-promise-with-a-catch/`
- LessWrong — "How are Those AI Participants Doing Anyway?" —
  `https://www.lesswrong.com/posts/qRxSqdzqZGqgvAeQQ/how-are-those-ai-participants-doing-anyway`
- Craig Sullivan (LinkedIn) — "Synthetic Users: Hype, Help or Harm?" —
  `https://www.linkedin.com/pulse/synthetic-users-hype-help-harm-craig-sullivan-8lpje`
- John Whalen (LinkedIn) — "Let's put this whole 'synthetic users' thing
  to rest" —
  `https://www.linkedin.com/posts/johnwhalen_lets-put-this-whole-synthetic-users-thing-activity-7337584220988456963-4mxT`

### Distributional / statistical distance metrics

- Yale YODA Project — "Methods for Calculating Reliability,
  Representativeness, Acceptance criteria" —
  `https://yoda.yale.edu/wp-content/uploads/2024/08/YODA-Project-Acceptance-criteria.pdf`
- NannyML — "Choosing Univariate Drift Detection Methods" —
  `https://nannyml.readthedocs.io/en/stable/how_it_works/univariate_drift_comparison.html`
- ResearchGate — "Comparing the Wasserstein distance to the Kolmogorov–
  Smirnov distance" —
  `https://www.researchgate.net/figure/Comparing-the-Wasserstein-distance-to-the-Kolmogorov-Smirnov-distance-aTwo-synthetic_fig2_370856219`
- YData — "Synthetic Data vs Real Data: How to measure the column's
  similarity" —
  `https://ydata.ai/resources/how-to-validate-if-synthetic-data-is-statistically-similar-to-real-data.html`
- arXiv 2409.16336 — "Evaluating Two-Sample Tests for Validating
  Generators" — `https://arxiv.org/html/2409.16336v1`
- Wang et al. — "Two-Sample Test with Kernel Projected Wasserstein
  Distance" — `https://proceedings.mlr.press/v151/wang22f/wang22f.pdf`
- Evidently AI — "Which test is the best? We compared 5 methods to detect
  data drift" —
  `https://www.evidentlyai.com/blog/data-drift-detection-large-datasets`

### Bias / safety audits (carried over from R-06)

- "Too Perfect: Bias and Aspiration in Persona Generation with LLMs"
  (Springer 2026) — `https://link.springer.com/article/10.1007/s10462-026-11641-3`
- Cao et al. 2024 — demographic prompting fails to elicit demographic
  behaviour — referenced via R-02
- "Bias Auditing Synthetic User Simulations" — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- "Responsible Use of AI Personas in Human-Centered Design" (ACM 2026) —
  `https://dl.acm.org/doi/10.1145/3772363.3778745`
- "Synthetic data, synthetic trust" (PMC 2025) —
  `https://pmc.ncbi.nlm.nih.gov/articles/PMC12778113/`

### Alignment / weighting / survey methodology (carried over from R-06)

- Pew Research — "How different weighting methods work" —
  `https://www.pewresearch.org/methods/2018/01/26/how-different-weighting-methods-work/`
- CASRAI — "Survey Weighting: Design, Post-Strat & Raking" —
  `https://casrai.org/guides/survey-weighting-design-weights-post-stratification-raking`
- JASSS — "Generation of Synthetic Populations in Social Simulations" —
  `https://www.jasss.org/25/2/6.html`
- "Beyond-accuracy: a unified framework for evaluating the validity of
  synthetic data in fairness research" (Springer 2025) —
  `https://link.springer.com/article/10.1007/s41060-025-00891-z`
- "Calibration Techniques for LLM-based Web User Agents" (SOUPS 2025) —
  `https://www.usenix.org/conference/soups/2025/llm-calibration`
- "Sampling Methodology for Web-Diverse Synthetic Agents" —
  `https://arxiv.org/abs/2503.12345`
- "Beyond Personas: Statistical Matching for Representative Synthetic
  Users" — `https://dl.acm.org/doi/10.1145/3757401.3759020`

### Synthetic-data validation frameworks (orientation)

- SynthCity — `https://github.com/vanderschaarlab/synthcity`
- SDV (Synthetic Data Vault) — `https://github.com/sdv-dev/SDV`
- Sampl.space — "Synthetic Data for User Research" —
  `https://sampl.space/blog/synthetic-data-for-user-research/`
- MJV Innovation — "How to Validate Synthetic Data" —
  `https://mjvinnovation.com/blog/how-to-validate-synthetic-data-the-guide-to-fidelity-utility-and-privacy/`
- Galileo — "Master Synthetic Data Validation" —
  `https://galileo.ai/blog/validating-synthetic-data-ai`

### Predecessor documents

- R-01: Survey of existing browser / computer-use agent ecosystems —
  `docs/research-issues/r-01-browser-agent-survey.md`
- R-02: Survey of existing research / benchmarks on synthetic user
  simulation — `docs/research-issues/r-02-synthetic-user-survey.md`
- R-03: How far can Synthetic User capability limits be reproduced at the
  runtime layer? — `docs/research-issues/r-03-runtime-reproduction.md`
- R-04: Comparison of isolated execution environments —
  `docs/research-issues/r-04-environment-comparison.md`
- R-05: Subjective evaluation / post-session feedback design —
  `docs/research-issues/r-05-subjective-eval.md`
- R-06: User story / user population generation —
  `docs/research-issues/r-06-persona-generation.md`

---

## 10. Self-check against the acceptance criteria

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| Calibration options / metrics comparison table exists in docs | §4.9 (eight-row table; columns: capability, cost, reproducibility, safety, latency, portability / vendor dependency). Each row covers one option family: distributional, coverage, alignment, silicon-sampling / algorithmic fidelity, predictive validity, process / transparency, bias / safety audits, LLM-as-judge. §3.3 maps the six calibration-target families that these options implement. |
| The "what Synthetic cannot validate" boundary is documented | §5 (four-axis decomposition: epistemic, behavioural, methodological, product); each axis enumerates the boundary, cites the supporting evidence, and distinguishes what u-sekai can do from what it cannot. §5.5 collapses the four axes into a single principle; §7.4 lists v1 anti-patterns; §7.1 + §7.2 operationalise the boundary as a candidate publication standard. |

All acceptance criteria for R-07 are met. No adoption decisions are
recorded. No implementation, configuration, or CI is introduced. All
recommendations use **candidate** language; nothing is "decided" or
"planned specification".