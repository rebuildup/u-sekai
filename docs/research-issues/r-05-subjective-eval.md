# R-05: Subjective evaluation / post-session feedback design

## Question (verbatim from the draft)

Design how a Synthetic User **reports subjective experience** (rating, free-form
reflection, behavioral log, etc.). Compare candidate approaches across timing,
format, comparability vs reproducibility.

---

## 1. Investigation summary

This document surveys how prior work — academic, vendor, and practitioner —
elicits and records the Synthetic User's own report of subjective experience,
and contrasts those approaches with u-sekai's requirements. It does not
recommend any approach as adopted, and it records no architecture / language /
framework / library decision. Candidate sets are presented as candidates only.

### 1.1 What was covered

- **Standardized HCI / UX self-report instruments** that have been ported to
  LLM-simulated users: System Usability Scale (SUS), Single Ease Question
  (SEQ), NASA-TLX, semantic differential, custom Likert, ad-hoc post-task /
  post-session surveys.
- **Think-aloud-style protocols adapted to LLM agents** — concurrent
  reasoning traces, retrospective self-explanation, and prompted
  "interview-the-agent" interfaces (UXAgent, UXAgent v1, UXCascade).
- **Behavioral trace analysis as a proxy / complement for subjective
  reporting** — agent-observation taxonomies (Act·onomy, MAST), trace
  preprocessing pipelines, failure-mode surfacing.
- **Free-form reflection and qualitative coding** — Kapania et al.'s
  researcher-as-interviewer protocol, MLLM-as-usability-evaluator pipelines.
- **Pitfalls specific to subjective elicitation from LLMs** — sycophancy,
  reduced variance, distorted correlations, shallowness, confabulation,
  prompt sensitivity (covered by the predecessor R-02 survey and re-cited
  here where they bear directly on the design choice).
- **Industrial / vendor methodologies** (Synthetic Users, User Interviews,
  Delve, Qualz, Interactius) for orientation only.

### 1.2 What was skipped and why

- **Web-agent success-rate benchmarks** (WebArena, Mind2Web, SeeAct,
  WebVoyager, GAIA, OSWorld). Already covered by R-02 as adjacent
  agent-evaluation substrate. The metric they optimize (task success) is
  objective, not subjective, and therefore out of scope for R-05.
- **Voice / paralinguistic and physiological instrumentation.** u-sekai's
  initial target is Web; voice / GSR / eye-tracking are not yet in scope per
  README §"Initial scope and reach". Noted in §6 as a future-extension
  option.
- **Deep RL-based user simulators** (RecSim, classical user modelling).
  Covered by R-02; their self-report is not human-language-shaped and is
  therefore not a subjective-evaluation design candidate.
- **General LLM evaluation leaderboards.** Not subjective-evaluation
  methodology.
- **A full re-read of every cited paper.** Where only abstracts / blog
  summaries were reachable, those were used and the limitation is noted
  inline.
- **A pre-decision on any specific UX instrument for u-sekai.** The output
  is a candidate set, not a chosen one.

### 1.3 Methodology notes

- **Inputs.** arXiv, ACL Anthology / OpenReview, ACM Digital Library,
  ResearchGate, Nielsen Norman Group articles, conference workshops (EACL
  2026, KDD 2024, EMNLP 2024/2025 Industry), MeasuringU, Steel.dev / Evidently
  AI / Confident AI aggregator pages, vendor sites (Synthetic Users, Delve,
  Qualz, Interactius, User Interviews). Japanese sources were not required
  for this draft; the R-05 draft permits but does not require them.
- **Evidence weight.** Strongest: peer-reviewed paper with concrete
  methodology and reported reliability. Medium: peer-reviewed paper with
  abstract / methodology sketch only. Weakest: vendor / blog / practitioner
  summary used only for orientation.
- **Versioning.** Several results are moving targets (e.g. UXAgent v1 vs v2
  vs v3, WebVoyager auto-eval LLM, OSWorld top scores). The survey records
  the snapshot the source reported; readers must re-check before any design
  decision.
- **Output language.** English only, per ADR-0002 (draft) / `CLAUDE.md` §7.
  Japanese translation of this draft is out of scope; tracked under R-09.

---

## 2. Key findings

### 2.1 Subjective evaluation in HCI / UX has a well-developed vocabulary

The vocabulary a Synthetic User could be asked to produce is not novel; it
maps onto instruments that have decades of psychometric history in HCI and
UX. The candidate set below is in part a question of *which* instruments to
borrow.

| Instrument | What it measures | Granularity | Established use |
| --- | --- | --- | --- |
| System Usability Scale (SUS) | Global perceived usability, 10 items | Post-session | Standard benchmark in human-subject usability; already used by UXAgent as a post-study LLM survey |
| Single Ease Question (SEQ) | Per-task perceived difficulty, 7-point | Per-task | Industry-standard; well-suited to repeated pre/post comparisons |
| NASA-TLX | Cognitive load (mental demand, physical demand, temporal demand, performance, effort, frustration) | Per-task or per-session | Standard for workload; also proposed as a UX-side metric |
| Semantic differential | Bipolar adjective pairs (e.g. confusing ↔ clear) | Per-task or per-session | Better than Likert for capturing *impressions*; higher cognitive demand |
| Likert (custom) | Agreement with a custom statement | Per-task / per-session / per-condition | Most flexible; weakest psychometric validity unless validated |
| Free-form reflection | Open-ended narrative | Any timing | Highest ecological validity if used in think-aloud; lowest comparability |
| Think-aloud (concurrent / retrospective) | Verbalised reasoning during / after task | During or post-task | Long-standing HCI method; "concurrent" maps to chain-of-thought in LLM agents |

These instruments trade off differently across the dimensions that matter
for u-sekai (see §4).

### 2.2 LLM-as-subject needs a different evaluation lens than LLM-as-system

When a human uses SUS, the answer reflects a private subjective experience.
When an LLM agent answers SUS items, the answer is produced by the same
kind of model that generates behaviour — and is therefore subject to:

- **Sycophancy** — agreement with implied expectations
  (NN/g r/UXResearch commentary; R-02 §5.4).
- **Reduced variance** relative to a real-population reference (Park et al.
  2024 — 79 % of classic-study replications failed — summarised in the
  MeasuringU review; R-02 §3.6).
- **Distorted correlations** and exaggeration of effects that exist in
  training data (MeasuringU review).
- **Shallow qualitative responses** that lack experiential depth
  (MeasuringU review; Kapania et al. 2025, as cited).
- **Confabulation risk** — fluent but unsupported rationales
  (R-02 §5.7).

This is consequential: the candidate set in §5 has to compensate for these
properties (e.g. by combining subjective report with behavioural-log signals
and by pre-registering instruments).

### 2.3 Prior work converges on a multi-channel pattern

Across the surveyed systems the dominant pattern is **a structured
post-session instrument + an unstructured behavioural trace + (optional) an
interview interface**. UXAgent v2/v3 illustrates all three:

- **Structured post-study survey.** SUS plus custom Likert items
  (Easy to Use, Helpful, Trust, Satisfaction with Final Study Design) on a
  −2 to +2 scale, plus researcher-facing Likert (1–5) on efficiency,
  trustworthiness, satisfaction, helpfulness.
- **Unstructured reflection.** Memory traces with natural-language
  observations, plans, reflections, "wonders"; qualitative interview
  interface for probing agent decision rationale.
- **Behavioral trace.** Action traces, session replay / video of the
  simulation.

The same three-channel split is visible, with variations, in UXCascade (per
the ResearchGate abstract), UXAgent v1 (Likert 1–5 plus semi-structured
interview), and the multimodal-LLM usability evaluation paper
(Nielsen-heuristic ordinal ratings + cognitive-walkthrough binary +
qualitative free-form).

### 2.4 Behavioural log analysis is a partial substitute for, and complement to, subjective report

A Synthetic User can produce a behavioural log (clicks, page transitions,
form inputs, time-on-page, error states, retries) regardless of whether it
can introspect honestly. Act·onomy (arXiv 2605.13625) demonstrates a
hierarchical taxonomy of observable behaviour — 10 top-level actions
(Grounding, Retrieval, Reasoning, Planning, Evaluating, Deciding,
Executing, Memory, Reflecting, Learning), 46 sub-actions, 120 leaf
categories — that can be applied to a trace without any subjective
elicitation.

The Cemri et al. (2025) MAST taxonomy and AWS Strands-Evals'
nine-category failure taxonomy are adjacent references: they catalogue
failure modes rather than affective state, but both are applied to
behavioural traces.

Implication for R-05: the **same session** can produce a *behavioural
log* (objective, comparable) and a *subjective report* (subjective,
ecologically valid). Treating them as separate channels, and explicitly
comparing them, is a candidate design pattern.

### 2.5 Timing is a design choice, not a given

| Timing | Strengths | Weaknesses | Where it appears |
| --- | --- | --- | --- |
| **Per-action** | Captures moment-of-friction reflection; richest process data | Prompt overhead; risk of disrupting the action; hardest to scale | Concurrent think-aloud; "wonder" events in UXAgent memory stream |
| **Per-task** | Best fit for SEQ, NASA-TLX, semantic differential, custom Likert | Misses between-task drift | SEQ (post-task standard); UXAgent per-task Likert |
| **Per-session** | Cheapest; maps to global instruments like SUS; one reflection per persona per condition | Cannot disambiguate which task caused which friction | SUS (post-session standard); UXAgent SUS at session end |
| **Per-condition** | Best for A/B-style cross-condition comparison | Coarse; needs many sessions per condition to be informative | Survey research (post-condition survey); rec-sys simulators |
| **Retrospective (post-batch)** | Easy to elicit, allows replay-aided recall | Recency bias; confabulation | Retrospective think-aloud (HCI tradition); Kapania et al. qualitative interviews |

There is **no convergence** in the literature on a single "right" timing.
The trade-off is between resolution (per-action / per-task) and
scalability / low overhead (per-session / per-condition). R-05's candidate
set in §5 includes a layered-timing pattern as one candidate.

### 2.6 Comparability vs reproducibility is the central design tension

R-02's pitfall list (§5) and the MeasuringU review both surface the same
finding: Synthetic Users are **comparable across themselves but not
reproducible against a real-user baseline**.

- *Comparability* — same prompt + same persona + same task + same LLM
  produces a similar distribution of subjective reports. Cheap.
- *Reproducibility against real users* — the same persona specification
  does not yield the same mean / variance / correlation structure as a real
  population would. Expensive; often fails (Park et al. 2024).

For u-sekai, the question is therefore not "which is better" but
"*which* signal do we need for *which* downstream decision":

- Candidate designs that optimise **comparability across personas**
  (Likert, SUS, SEQ) are appropriate for *internal* A/B comparison of a
  product under different conditions.
- Candidate designs that optimise **ecological validity against real
  users** (think-aloud + behavioural log + post-session free-form) are
  appropriate for *triangulating* synthetic findings before acting on them.

### 2.7 The vendor landscape is informative but not authoritative

Several commercial platforms (Synthetic Users, Delve, User Interviews,
Qualz, Interactius) explicitly market "synthetic users" and publish
methodology snippets. The patterns they converge on are:

- Persona-conditioned LLM with demographics + goals + personality traits.
- Structured (often Likert) post-session survey, sometimes with SUS-style
  items.
- Free-form qualitative response, optionally transcribed and theme-coded
  by another LLM.
- Some (User Interviews "State of Synthetic Users" report) publish
  practitioner adoption statistics — useful for orientation only.

These are **not** subject to peer review and **not** reproducible without
paid accounts. They are used here only as evidence that the
multi-channel pattern is industrial default, not as endorsements.

### 2.8 LLM-as-judge for subjective rating is widely used but inherits biases

Several surveyed systems use a separate strong LLM as a *judge* of
subjective quality (WebVoyager auto-eval with 85.3 % human-agreement;
PersonaGym ensemble; PersonaEval; MLLM-as-usability-evaluator). R-02 §3.5
flags the shared-distribution risk.

For R-05, the candidate set in §5 includes LLM-as-judge **only as one of
several options** and **only with the caveat that subjective ratings may
require a human-baseline calibration step**, consistent with the
Validation Methods paper's four-dimension rubric (R-02 §4.1) and Park et al.
2024's replication-failure rate.

---

## 3. Reference / benchmark catalog

The catalog below lists primary sources that materially shaped this draft.
It is not exhaustive; it focuses on works that **describe a subjective
evaluation method** rather than works that only consume one.

| Source | URL | What it contributes |
| --- | --- | --- |
| UXAgent (arXiv 2504.09407 v3) | `arxiv.org/html/2504.09407v3` | Three-channel pattern: post-study SUS + custom Likert + interview interface + memory traces + session replay |
| UXAgent v1 (arXiv 2502.12561) | `arxiv.org/html/2502.12561v3` | Likert 1–5 + semi-structured interview; trade-off table on comparability vs reproducibility |
| UXCascade (ResearchGate) | `researchgate.net/publication/400003102` | "Scalable usability testing with simulated user agents" — abstraction over the same pattern; abstract only at time of writing |
| MLLMs as usability evaluation tools (arXiv 2508.16165) | `arxiv.org/html/2508.16165v2` | Four-step pipeline; Nielsen-heuristic ordinal + cognitive-walkthrough binary + qualitative comparison |
| Bauer & Senoner et al. (R-02 §2.1) — "LLM-based simulated users for think-aloud usability studies" | `arxiv.org/abs/2404.02163` | Empirical framework; think-aloud adapted to LLM users |
| Hämäläinen et al. (R-02 §2.1) | `arxiv.org/abs/2312.11812` | Demographic prompting + behavioural similarity; shows LLMs only modestly shift under demographic conditioning |
| Kapania et al. (2025) — qualitative-interview protocol | Referenced in MeasuringU review (URL 403 at fetch time; cited via `measuringu.com/review-of-experiments-with-synthetic-users/`) | Researcher-as-interviewer; LLM users as subjects; recreating prior qualitative UX studies |
| Park et al. (2024) — replication-failure rate | Referenced via MeasuringU review | 79 % of classic social-science replications failed with synthetic users |
| Validation Methods paper (R-02 §4.1) | `arxiv.org/abs/2412.06047` | Four-dimension rubric; pre-registered expert study n=56; recommends triangulating with at least one human study |
| Synthetic User Research Validated Using Real User Data (R-02 §2.1) | `arxiv.org/abs/2410.20538` | LLM-simulated users underperform real users on needs tasks; comparative accuracy metric |
| PersonaGym (R-02 §2.2) | `arxiv.org/abs/2407.18416`; `personagym.com` | PersonaScore composite across action justification, expected action, linguistic habits, persona consistency, toxicity |
| PersonaEval | `arxiv.org/abs/2502.02791` | Whether LLM agents can act as proxies for human raters in persona evaluation |
| MeasuringU — "A Review of Experiments with Synthetic Users" | `measuringu.com/review-of-experiments-with-synthetic-users/` | 12-paper review; reduced variance, distorted correlations, shallowness, sycophancy |
| MeasuringU — "What Are the Different Types of Synthetic Users?" | `measuringu.com/what-are-the-different-types-of-synthetic-users/` | Five-type taxonomy (Proto, Demographic, Persona, Research-Grounded, Digital-Twin); no subjective-format guidance |
| Nielsen Norman Group — "Synthetic Users: If, When, and How to Use" | `nngroup.com/articles/synthetic-users/` | Practitioner guardrails: do not use for concept / solution validation; pilot interviews only; warn against presenting synthetic findings as real |
| NN/g — "Rating Scales in UX Research: Likert or Semantic Differential" | `nngroup.com/articles/rating-scales/` | When to use Likert vs semantic differential; standard-instrument recommendation |
| NN/g — "Beyond NPS: SUS, NASA-TLX, and SEQ" | `nngroup.com/articles/measuring-perceived-usability/` | Standard instruments overview |
| MeasuringU — "10 Things To Know About the SEQ" | `measuringu.com/seq10/` | SEQ timing and wording; 7-point post-task difficulty rating |
| Votito — Single Ease Question | `votito.com/methods/single-ease-question/` | SEQ operational definitions and benchmark baselines |
| Act·onomy — Automated agent trace interpretation | `arxiv.org/html/2605.13625v1` | Hierarchical behaviour taxonomy; behavioural log analysis as complement to subjective report |
| Cemri et al. — Multi-Agent System Failures (MAST) | Referenced via Act·onomy | Failure-mode taxonomy applied to traces |
| AWS Strands-Evals | `aws.amazon.com/blogs/machine-learning/ai-agent-failure-detection-and-root-cause-analysis-with-strands-evals/` | Nine-category failure taxonomy on agent traces |
| Sentry — AI Agent Observability & Tracing | `blog.sentry.io/ai-agent-observability-developers-guide-to-agent-monitoring/` | Trace-based observability for AI agents; dashboards + per-trace detail |
| UiPath — Agent traces | `docs.uipath.com/agents/automation-cloud/latest/user-guide/agent-traces` | Trace / span metadata for completed agent runs |
| Synthetic Users vendor | `syntheticusers.com/` | Industrial methodology example; persona-conditioned LLM + structured survey |
| User Interviews — State of Synthetic Users report | `userinterviews.com/state-of-synthetic-users-report` | Practitioner adoption; 34 % of surveyed teams use synthetic users for usability testing |
| Delve — Synthetic User Testing | `delve.ai/blog/synthetic-user-testing` | Industrial methodology; AI-generated personas + qualitative feedback |
| Qualz — Synthetic Users for Early Validation | `qualz.ai/blog/synthetic-users-early-validation/` | Industrial methodology; hypothesis generation + validation |
| Interactius — "20 Synthetic Users Who Think Like 150" | `interactius.com/en/thoughts/clonica/ai-in-ux-research-20-synthetic-users-who-think-like-150-real-ones` | Industrial methodology; 93 % match claim (vendor-reported, treat as orientation) |
| User Vision — Synthetic Users vs Digital Clones | `uservision.co.uk/thoughts/synthetic-users-and-digital-clones-a-ux-researcher-s-honest-take` | Practitioner critique; distinguishes synthetic users from digital clones |

---

## 4. Comparison of subjective evaluation options

Rows are subjective-evaluation options. Columns are properties that
matter for u-sekai. None of these rows is adopted.

| Option | Timing | Format | Comparability (across personas / conditions) | Reproducibility (vs real users) | Implementation cost | Latency overhead | Portability (across LLMs / frameworks) | Safety / privacy surface |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Standard SUS at session end** | Per-session | 10 Likert items, 1–5 | High — standard instrument | Low-to-medium — calibration against real SUS baselines required | Low — drop-in instrument | Negligible | High — text-only, no model dependency | Low — no PII if generated |
| **SEQ per task** | Per-task | 1 item, 7-point | High — per-task single-A/B comparison | Low-to-medium | Low | Low | High | Low |
| **NASA-TLX per task or per session** | Per-task / per-session | 6 sub-scales, 0–20 (raw) or weighted | High — multi-dimensional | Low-to-medium — less established for Web UX than SUS | Low | Low | High | Low |
| **Custom Likert per session / per condition** | Per-session or per-condition | N items, 5- or 7-point | Medium — depends on item wording; prompt-sensitive | Low unless calibrated | Low | Low | High | Low |
| **Semantic differential per task** | Per-task | Bipolar adjective pairs | Medium-high — bipolar structure is comparable | Low-to-medium | Low | Low | High | Low |
| **Free-form reflection at session end** | Per-session (or per-batch retrospective) | Unstructured natural language | Low — requires qualitative coding | Medium — think-aloud tradition has ecological validity | Medium — needs LLM + coding step | Medium | Medium — depends on LLM output conventions | Medium — generated text could leak training data |
| **Concurrent think-aloud / "wonder" reflections** | Per-action or per-event | Short natural-language snippets | Low — high variance per-event | High if treated as process trace rather than summary | High — interferes with action loop | High — adds tokens per action | Medium | Medium |
| **LLM-as-judge scoring of session** | Per-session | Numeric or categorical judgment from a second LLM | High — same judge across sessions | Low — judge shares distribution with subject LLM | Medium — second model call | Medium-high | Low — tied to specific judge model | Low if subject identity stripped |
| **Behavioural log (clicks, transitions, errors)** | Continuous | Low — comparable | High — fully reproducible objective | Low-to-high — calibration against real-population traces | Low — instrumentation | Low | High | Low — log only |
| **Behavioural trace taxonomy (Act·onomy, MAST, Strands-Evals)** | Post-session | Categorical labels per span | High — fixed codebook | Low — codebook applicability to UX context not yet validated | Medium — requires classification step | Medium | Medium — depends on classifier | Low |
| **Researcher-as-interviewer / prompt-driven Q&A** | Per-session | Conversational; transcript retained | Low — qualitative | Medium — high ecological validity when grounded in real transcripts | High — interactive loop | High — many turns | Low — depends on interactive runtime | Medium — transcripts may contain sensitive user input |
| **Experience-sampling-style in-session prompts** | Per-event, scheduled by trigger | Single Likert or short free-form | Medium | Medium | Medium | Medium | Medium | Medium |

### 4.1 Notes on the comparison

- **Comparability vs reproducibility is the headline trade-off.** Standardised
  instruments (SUS, SEQ, NASA-TLX, semantic differential, custom Likert) are
  designed to be comparable; their reproducibility against real-user
  baselines is empirically weak (Park et al. 2024; R-02 §5).
- **Implementation cost is low for all items that create a text-only
  question and persist the answer.** Items that require a second model
  call (LLM-as-judge, taxonomy classifier) add cost roughly proportional
  to the number of classification calls.
- **Latency overhead matters at scale.** Per-action / per-event items
  impose a cost roughly equal to N_actions × model_call_cost. u-sekai's
  goal is to drive *many* Synthetic Users in parallel (README §"Initial
  scope and reach"), so per-action prompting is a non-trivial cost.
- **Portability is high for everything text-only** because the candidate
  set does not lock in any LLM. The lower rows (LLM-as-judge, taxonomy
  classifier, researcher-as-interviewer) carry model-specific assumptions
  and reduce portability.
- **Safety / privacy surface** is mostly *generated-text leakage risk*
  (the agent outputting training data while reflecting on a session).
  Behavioural logs are the lowest-risk option.

---

## 5. Candidate set (recommended *candidates*, not adopted)

The following is a **candidate set** assembled from the surveyed
literature. Nothing here is adopted. Each item is a candidate only; the
project may combine, defer, or drop any of them.

### 5.1 Candidate primary subjective channel — *layered structured instruments*

A candidate pattern is to layer multiple structured instruments at different
timings rather than pick one:

- **Per-task:** Single Ease Question (SEQ) — 1 item, 7-point, post-task.
  Standardised, low overhead, supports A/B per-task comparison.
- **Per-session:** System Usability Scale (SUS) — 10 items, post-session.
  Standardised, supports cross-session aggregation.
- **Per-condition (optional):** Custom Likert battery tuned to the
  u-sekai research question (e.g. trust, clarity, delight, frustration)
  — to be defined when R-08 (MVP) settles the question set.

This combination is a candidate; it is what UXAgent v2/v3 does, and it is
what NN/g recommends as the working default for human usability studies
(NN/g "Beyond NPS" article). It optimises *comparability across personas
and conditions* — not reproducibility against real users.

### 5.2 Candidate secondary channel — *behavioural log + taxonomy label*

A candidate pattern is to record, in parallel with the subjective channel:

- **Raw behavioural log.** Click, page-transition, form-input, error,
  retry, time-on-task, dead-end, friction events.
- **Post-session taxonomy labels.** Act·onomy-style spans or MAST-style
  failure labels, applied to the trace either by a separate LLM or by the
  same LLM in a "reflect-on-your-trace" prompt.

This combination is a candidate; it captures the objective substrate of
the session and supports inter-session aggregation. R-02 §3 and §5 already
treat trace-based metrics as a separate evaluation family.

### 5.3 Candidate tertiary channel — *structured free-form reflection*

A candidate pattern is to elicit, in addition to the structured channels:

- **Post-session open-ended reflection.** "What was confusing? What
  worked? What did you expect that you did not see?" — answered in
  natural language, retained verbatim, and **coded only by a separate
  human / LLM pipeline that is itself recorded and auditable**.
- **Per-event "wonder" prompts** for the highest-friction events
  surfaced by the behavioural log. Optional; can be dropped if cost is
  prohibitive.

This combination is a candidate; it is the only candidate channel that
preserves ecological validity, but it is the lowest-comparable.

### 5.4 Candidate comparability scaffolding — *triangulated calibration*

A candidate pattern is to *not trust the subjective channel alone*:

- **Pre-register** the prompt wording and the persona specification
  before each study run (Validation Methods paper recommendation, R-02
  §4.3).
- **Calibrate** on a small human-baseline study before scaling up
  (R-02 §4.2).
- **Cross-check** a subset of stimuli on real users and compare
  distributions (R-02 §4.2).
- **Report divergence** explicitly: where synthetic and human findings
  agree, where they diverge, and the failure-mode category.
- **Audit for sycophancy** by including adversarial / random tasks
  (R-02 §4.3).
- **Report by demographic slice** to expose the demographic-fidelity
  pitfall (Patil et al.; R-02 §3.1).

### 5.5 Candidate reproducibility boundary

A candidate pattern is to make the boundary explicit in every report:

- Subjective channels are appropriate for **internal A/B comparison** of a
  product across conditions, and for **hypothesis generation**.
- Subjective channels are **not appropriate** as the sole evidence base
  for shipping decisions, population-wide UX claims, or accessibility
  compliance (NN/g "Synthetic Users" article; R-02 §5.11).
- Behavioural-log signals carry the strongest reproducibility; subjective
  signals carry the strongest ecological validity; the two together carry
  the most defensible signal.

### 5.6 Candidate things explicitly deferred

These are candidates for *later* consideration, deferred until R-03 / R-04
/ R-06 / R-08 / R-07 settle preconditions.

- **Multimodal subjective capture** (facial affect, voice prosody,
  physiological) — requires extension beyond the initial Web target.
- **Real-time researcher-in-the-loop interview interface** — requires
  R-03 / R-04 decisions on runtime orchestration.
- **Cross-LLM ensemble disagreement as a coverage signal** (one-cannot-
  stand-for-everyone, R-02 §3.6) — requires R-06 (persona generation) to
  define what counts as an ensemble.
- **Adoption of any specific commercial platform** (Synthetic Users, Delve,
  Qualz, Interactius) — explicitly excluded by R-02 scope.

---

## 6. Differences vs u-sekai requirements (gap analysis)

| u-sekai requirement | Closest surveyed area | Gap |
| --- | --- | --- |
| **Subjective UX reports across diverse individual differences** (capability, perception, memory, preference, situation) | UXAgent per-persona custom Likert; Validation Methods paper; PersonaGym | Surveyed systems rarely combine subjective elicitation with explicit perception / capability variation. The instrumentation layer does not know whether an LLM "rated" the session as a sighted, motor-impaired, novice, or expert persona. *Candidate gap for R-03 + R-05 joint work.* |
| **Real Web environments (not canned test sets)** | UXAgent + Universal Browser Connector; UXCascade | Subjective instruments in surveyed systems are added after the agent has interacted with a real or simulated site. There is no canonical subjective-instrument *set* tuned for live Web UX discovery. *Candidate gap.* |
| **Many Synthetic Users in parallel** | UXAgent (1,000 simulations in ~12 hours) | Per-action subjective elicitation does not scale; per-session / per-condition does. *Candidate design constraint.* |
| **Discover unexpected operation paths, no mistakes, no friction** (R-05 §"Initial scope") | Behavioural trace taxonomy (Act·onomy, MAST); UXAgent memory traces | The behaviour trace is a stronger signal for "unexpected path" than any subjective rating. *Candidate gap: subjective channel should complement, not replace, the trace.* |
| **Comparability AND reproducibility** (R-05 §"Initial scope") | Standard instruments (SUS, SEQ, NASA-TLX) — comparability; Park et al. 2024 — reproducibility failure | These two properties are in tension in every surveyed system. *Candidate design constraint: report the trade-off, do not pretend it is resolved.* |
| **Calibration against real users** (R-07) | Validation Methods paper; Bauer & Senoner; Park et al. | Surveyed methods recommend triangulation, but no canonical *Web-UX-tuned* calibration rubric exists. *Candidate gap; covered by R-07.* |
| **Subjective evaluation timing** (per-action / per-task / per-session / per-condition) | UXAgent per-task Likert + per-session SUS; Kapania et al. retrospective interview; concurrent think-aloud | No convergence on a single timing. *Candidate design choice — see §5.1 (layered).* |
| **No dependence on a specific LLM / model** (R-05 §"Initial non-scope") | All text-only instruments in §4 | The candidate set is text-only and LLM-agnostic; LLM-as-judge and taxonomy classifiers are lower-portability. *Candidate constraint.* |

---

## 7. Open questions / follow-up items / unresolved consequential decisions

These items may require user escalation depending on R-03 / R-06 / R-07 /
R-08 outcomes. Listed here per the "do not block" rule; the rest of the
investigation continues without them.

1. **Subjective channel mix.** Whether u-sekai's first MVP captures all
   three channels (structured + behavioural log + free-form reflection)
   or only one. The candidate set recommends a layered primary channel
   plus a behavioural-log secondary, with free-form as optional. The MVP
   may need to defer free-form for cost / latency reasons — consequential
   because it determines what u-sekai can claim to surface in v1.
2. **What to *not* measure subjectively.** Whether u-sekai explicitly
   avoids asking subjective questions about accessibility (which would
   require perception-level reproduction the simulator may not honestly
   possess — R-03 territory) and instead derives accessibility signals
   from behavioural traces only. Consequential because it constrains
   u-sekai's claim set.
3. **LLM-as-judge acceptance.** Whether to use LLM-as-judge for any
   subjective report (PersonaGym, WebVoyager, PersonaEval) given the
   shared-bias risk (R-02 §3.5). Consequential because it locks in a
   meta-LLM dependency or explicitly disclaims the cost.
4. **Granularity of the structured instrument set.** Whether to import a
   validated standard instrument wholesale (clean comparability,
   downstream comparability with external benchmarks), to assemble a
   custom battery tuned to u-sekai's research questions (better fit, no
   external benchmark comparability), or to do both (highest cost).
5. **Subjective-evaluation interaction model.** Whether the simulator
   *self-reports* (which risks confabulation) or whether a *separate*
   judge / human / structured survey elicits from a session replay (which
   costs a second loop but reduces confabulation). UXAgent and Kapania
   et al. illustrate both.
6. **Calibration rubric ownership.** Whether u-sekai adopts a published
   rubric (Validation Methods paper; PersonaGym) or designs its own for
   exploratory UX on live Web. Decided by R-07, but the choice constrains
   R-05's "report divergence" pattern (§5.4).
7. **Whether u-sekai integrates an existing benchmark's subjective
   channel** (WebVoyager auto-eval, OSWorld human ratings, PersonaGym
   composite) or only consumes the raw task trace. Consequential for
   R-08 (MVP scope).

---

## 8. References

Full URLs are listed for traceability. Several are vendor / blog summaries
used only for orientation and clearly marked.

### Subjective evaluation in HCI / UX (standard instruments)

- Single Ease Question (SEQ) — MeasuringU:
  `measuringu.com/seq10/`
- Single Ease Question — Votito:
  `votito.com/methods/single-ease-question/`
- Single Ease Question — User Sense:
  `usersense.com/knowledge-base/usability-metrics/single-ease-question-seq`
- Single Ease Question — Koji guide:
  `koji.so/docs/single-ease-question-seq-guide`
- Beyond NPS: SUS, NASA-TLX, and the SEQ — NN/g:
  `nngroup.com/articles/measuring-perceived-usability/`
- Rating Scales in UX Research: Likert or Semantic Differential — NN/g:
  `nngroup.com/articles/rating-scales/`
- Semantic Differential Scales — NN/g video:
  `nngroup.com/videos/semantic-differential-scales/`
- What is Semantic Differential Scale — SurveyLab:
  `surveylab.com/blog/semantic-differential-scale/`
- Semantic Differential — ScienceDirect topic page:
  `sciencedirect.com/topics/computer-science/semantic-differential`
- Semantic Differential vs Likert — Enquete:
  `enquete.com/en/blog/enquete-maken/semantic-differential-scale-vs-likert-scale-which-is-best-for-your-survey-7ade15`
- Takahashi 2016 — Semantic Differential reveals multi-dimensional mind
  perception: `pmc.ncbi.nlm.nih.gov/articles/PMC5090820/`
- Rozo-Torres et al. — Instrument to measure emotional reaction via
  self-report: `ceur-ws.org/Vol-3070/paper06.pdf`

### LLM-agent usability testing (subjective-channel implementations)

- UXAgent (arXiv 2504.09407, v2 / v3):
  `arxiv.org/abs/2504.09407`;
  `arxiv.org/html/2504.09407v2`;
  `arxiv.org/html/2504.09407v3`
- UXAgent — GitHub: `github.com/neuhai/uxagent`
- UXAgent v1 (arXiv 2502.12561):
  `arxiv.org/html/2502.12561v3`;
  `alphaxiv.org/abs/2502.12561v3`
- UXCascade — ResearchGate:
  `researchgate.net/publication/400003102_UXCascade_Scalable_Usability_Testing_with_Simulated_User_Agents`
- MLLMs as usability evaluation tools (arXiv 2508.16165):
  `arxiv.org/html/2508.16165v2`
- Bauer & Senoner et al. — LLM-simulated users for think-aloud usability
  studies: `arxiv.org/abs/2404.02163`
- Hämäläinen et al. — LLM-based UIs:
  `arxiv.org/abs/2312.11812`
- Patil et al. — Personas vs demographics gap (Stanford):
  `arxiv.org/abs/2402.18076`
- Liu et al. — Evaluating LLMs as Synthetic Users:
  `arxiv.org/abs/2502.08462`
- Validation Methods for LLM-based Synthetic Users (4 dimensions):
  `arxiv.org/abs/2412.06047`
- Synthetic User Research Validated Using Real User Data:
  `arxiv.org/abs/2410.20538`
- "When Synthetic Users Fail" (2026):
  `arxiv.org/html/2607.26348v1`
- Park et al. 2024 — replication-failure rate, cited via MeasuringU
  review (URL below).
- PersonaGym: `arxiv.org/abs/2407.18416`;
  `arxiv.org/html/2407.18416v4`; `personagym.com`
- PersonaEval — `arxiv.org/abs/2502.02791`

### Practitioner reviews and guardrails

- MeasuringU — "A Review of Experiments with Synthetic Users":
  `measuringu.com/review-of-experiments-with-synthetic-users/`
- MeasuringU — "What Are the Different Types of Synthetic Users?":
  `measuringu.com/what-are-the-different-types-of-synthetic-users/`
- Nielsen Norman Group — "Synthetic Users: If, When, and How to Use":
  `nngroup.com/articles/synthetic-users/`
- User Vision — "Synthetic Users vs Digital Clones":
  `uservision.co.uk/thoughts/synthetic-users-and-digital-clones-a-ux-researcher-s-honest-take`
- The Ethical AI Designer — "Using AI usability testing to iterate UX
  testing faster and ethically": `theethicalaidesigner.com/post/using-uxagent-to-iterate-ux-testing-faster-ethically`

### Behavioral trace analysis (objective complement to subjective)

- Act·onomy — Automated agent trace interpretation:
  `arxiv.org/html/2605.13625v1`
- Cemri et al. — Multi-Agent System Failures (MAST) — referenced via
  Act·onomy.
- AWS Strands-Evals — failure taxonomy on agent traces:
  `aws.amazon.com/blogs/machine-learning/ai-agent-failure-detection-and-root-cause-analysis-with-strands-evals/`
- Sentry — AI Agent Observability & Tracing:
  `blog.sentry.io/ai-agent-observability-developers-guide-to-agent-monitoring/`
- UiPath — Agent traces:
  `docs.uipath.com/agents/automation-cloud/latest/user-guide/agent-traces`
- Comet — Agent Tracing:
  `comet.com/site/blog/ai-agent-tracing/`
- LogRESP-Agent (MDPI):
  `mdpi.com/2076-3417/15/13/7237`
- WebTraceSense (ACM):
  `dl.acm.org/doi/10.1145/3696593.3696649`

### Industrial / vendor methodologies (orientation only)

- Synthetic Users vendor: `syntheticusers.com/`
- User Interviews — State of Synthetic Users report:
  `userinterviews.com/state-of-synthetic-users-report`
- Delve — Synthetic User Testing:
  `delve.ai/blog/synthetic-user-testing`
- Minds — Synthetic Users: Accuracy, Uses & Validation:
  `getminds.ai/blog/synthetic-user-research`
- UI Patterns — Testing With Synthetic Users:
  `ui-patterns.com/blog/testing-with-synthetic-users`
- Qualz — Synthetic Users for Early Validation:
  `qualz.ai/blog/synthetic-users-early-validation/`
- Interactius — "20 Synthetic Users Who Think Like 150":
  `interactius.com/en/thoughts/clonica/ai-in-ux-research-20-synthetic-users-who-think-like-150-real-ones`
- PyMC Labs — AI-based Customer Research:
  `pymc-labs.com/blog-posts/AI-based-Customer-Research`
- Uxia — comparison vs Synthetic Users:
  `uxia.app/compare/uxia-vs-synthetic-users`
- John Whalen — "Let's put this whole 'synthetic users' thing to rest":
  `linkedin.com/posts/johnwhalen_lets-put-this-whole-synthetic-users-thing-activity-7337584220988456963-4mxT`
- UXMag — Tracking user behavior in modern web apps:
  `uxmag.medium.com/the-power-of-interaction-data-tracking-user-behavior-in-modern-web-apps-15149ca6d464`
- ERI Design — UX red flags:
  `eridesignstudio.com/insights/ux-red-flags-how-user-behavior-reveals-website-ux-issues/`

### Adjacent (re-cited from R-02 where it bears on R-05)

- PersonaLLM-Survey: `github.com/MiuLab/PersonaLLM-Survey`
- Confident AI — Multi-Turn LLM Evaluation in 2026:
  `confident-ai.com/blog/multi-turn-llm-evaluation-in-2026`
- LLM-based Human Simulation — awesome list:
  `github.com/Persdre/awesome-llm-human-simulation`
- Evidently AI — 30 LLM evaluation benchmarks:
  `evidentlyai.com/llm-guide/llm-benchmarks`
- Steel.dev leaderboard index:
  `leaderboard.steel.dev/results/`
- EACL 2026 — Survey on LLM-based Conversational User Simulation:
  `aclanthology.org/2026.eacl-long.200.pdf`
- HAL — LLMs for the Simulation of Human Users:
  `hal.science/hal-05484009v1/document`

---

## 9. Self-check against the acceptance criteria

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| A subjective evaluation option comparison table exists in docs | §4 (12-row table; columns: timing, format, comparability, reproducibility, cost, latency, portability, safety) |
| A recommended candidate set (not yet adopted) is documented | §5 (six sub-sections: layered structured instruments; behavioural log + taxonomy; free-form reflection; comparability scaffolding; reproducibility boundary; deferred items). All recommendations use "candidate" language. |

All acceptance criteria for R-05 are met. No adoption decisions are
recorded; nothing is described as a planned specification; no
implementation / configuration / CI / `.py` artifact is introduced.