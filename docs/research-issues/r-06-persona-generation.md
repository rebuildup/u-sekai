# R-06: User story / user population generation

> Draft research artifact for issue **R-06** (generation and sampling of diverse Synthetic User personas, tasks, situations, and preferences).
> This is an investigation, not an adoption decision. Nothing in this document is "decided" or "adopted". The role of R-06 is to put plausible **candidate** generation / sampling mechanisms on the table so that R-07 (calibration) and R-08 (MVP scope) can decide.

---

## 1. Question (verbatim from the draft)

> Investigate how to generate and sample diverse Synthetic User personas, tasks, situations, and preferences. Trade off diversity against reproducibility / comparability.

**Acceptance criteria** (from `docs/research-issues/README.md`):

1. A comparison table of persona / task / situation generation options exists in docs.
2. Diversity metrics / bias detection options are documented.

**Predecessors read first**:

- `docs/research-issues/r-02-synthetic-user-survey.md` (R-02) — synthetic-user / persona-simulation research and benchmark inventory.
- `docs/research-issues/r-03-runtime-reproduction.md` (R-03) — runtime reproduction of individual differences.

This document builds on R-02's catalog of persona-generation approaches and R-03's per-dimension reproduction map. It does not redo those surveys. R-01's layer model is reused for cross-referencing.

---

## 2. Investigation summary

### 2.1 What was covered

- **Persona generation methods**, organized along three axes: (a) **rule-based / ontology-driven** (e.g. Buyer Persona Expert System, demographic-table sampling), (b) **LLM-prompted zero/few-shot** (PersonaLLM-Survey, persona-conditioned prompts used by SimUser / UXAgent / PersonaEval), (c) **dataset / interview-seeded** (Park et al. 2024/2025 "1,000-people simulation", LLM-PDM, PersonaCite, Implicit-Profile USP).
- **Population sampling methods** that operate *above* the per-persona generator: **taxonomy-guided sampling** (DeepPersona, Wang et al. 2025), **stratified / disproportionate sampling** (Diversity Sampling in Synthetic Persona Generation; "Sampling Methodology for Web-Diverse Synthetic Agents"), **importance-sampling + optimal-transport alignment** (Population-Aligned Persona Generation), **evolutionary program search** (Persona Generators / AlphaEvolve; PPol / OpenEvolve with MAP-Elites), **mixture-of-personas / learned mixing weights** (ACL Findings 2025).
- **Task generation methods**: **seed-and-expand** (Mind2Web's seed descriptions expanded by annotators), **GeneUS RaT prompting** (requirements → user-story → test-case from RE documents), **task-oriented-dialogue (TOD) user simulator** prompts (DAUS, Goal Alignment, USP, Simulating User Diversity in TOD), and **exploratory task injection** (UXAgent's "buy a jacket" starting intent; WebArena/WebVoyager/Mind2Web as canned task corpora).
- **Situation generation methods**: **locale / device / network / timezone injection** at the browser-context level (Playwright `browser.newContext`, Chrome DevTools Protocol throttling; R-03 §4.6–4.8); **session-state pre-seeding** (cookies, localStorage, accounts); **contextual prompt augmentation** (Goal Alignment, situational scenario strings); **discrete-event simulation** (OASIS Time Engine's 24-dimensional hourly activity probability vectors).
- **Diversity / bias detection options**: **distributional** (KS test, Wasserstein, Jensen-Shannon), **coverage** (attribute coverage, convex-hull volume, Monte Carlo coverage, minimum/average pairwise distance, dispersion), **structural** (KL to quasi-random / uniform), **alignment to real populations** (post-stratification raking, IPF, propensity-score matching, SMD), **bias audits** (the Springer 2026 "Too Perfect" bias study, the Patil et al. 2024 demographic gap, the "Bias Auditing Synthetic User Simulations" study that audited 47 papers and found 11% report any sampling methodology), **LLM-as-judge fidelity** (PersonaGym PersonaScore, PPol's 80.4% human-rating).
- **Real-population reference data** that candidate methods could align to: General Social Survey (GSS), Big Five personality inventories, American Trends Panel, census data, web-traffic panel data, and synthetic world-population artifacts from agent-based social simulation.

### 2.2 What was skipped and why

- **Final adoption** of any specific generator, sampler, or diversity metric. The role of R-06 is to put candidates on the table; R-08 (MVP) will pick.
- **Privacy / consent mechanics for collecting real-user reference data** (American Voices Project 2-hour interviews; American Trends Panel enrollment). Touched lightly in §5.3 and §8 — the policy detail belongs to a separate privacy decision (and R-07 calibration).
- **Non-Web substrates** (mobile native, desktop, CLI, API). Surfaced only as a future-facing note; the Web-first scope is fixed by `README.md` and the R-01 layer model.
- **Multimodal / video / voice** persona conditioning. Surfaced as "give up" for the Web MVP; tracked as a follow-up.
- **Full re-reading** of every cited paper. Where only abstracts, blog summaries, or pre-prints were reachable, those were used and the limitation is noted inline.
- **Private enterprise "synthetic customer" platforms** (digital-twin-of-customer suites; vendor-locked synthetic-data platforms). Out of scope per the R-02 / R-06 drafts.

### 2.3 Methodology notes

- **Inputs.** English-language academic search (arXiv, ACL Anthology, NeurIPS / KDD / EMNLP / ICLR proceedings, ACM DL, OpenReview, JASSS, Springer), curated GitHub lists (`awesome-llm-human-simulation`, `PersonaLLM-Survey`, `harshita-chopra/persona-policies`), project homepages (OASIS, DeepPersona, PersonaGym), and survey-methodology references (Pew, CASRAI, MeasuringU, JASSS). Japanese sources were not used for this draft because no Japanese-only paper surfaced as essential; the R-06 draft permits but does not require them.
- **Evidence weight.** Strongest: arXiv paper with reproducible code or hosted demo. Medium: paper with venue and abstract only. Weakest: blog / vendor / Reddit / LinkedIn summary used only for orientation and clearly marked.
- **Three-axis decomposition.** R-06's question is split along **(a) generation method** (rule-based / LLM-prompted / dataset-seeded), **(b) sampling strategy** (random / stratified / taxonomy-guided / alignment-driven / evolutionary), **(c) what is generated** (persona / task / situation / preference). Each candidate mechanism in §4–§7 maps to one or more cells of this 3-axis grid.
- **Diversity vs reproducibility.** This trade-off is treated as a first-class axis throughout (§6 explicitly compares options on it). The trade-off is not resolved here — it is exposed so that R-08 can decide on the MVP's position.
- **Output language.** English only, per ADR-0002 (draft) / `CLAUDE.md` §7. Japanese translation of this draft is out of scope; tracked under R-09.

---

## 3. Conceptual decomposition

### 3.1 Three orthogonal axes

The R-06 question can be decomposed along three axes that are often conflated in the literature.

| Axis | What it decides | Typical mechanisms |
| --- | --- | --- |
| **A. Generation method** | How a single persona / task / situation is produced | Rule-based / ontology; LLM zero-shot; LLM few-shot with seeds; LLM with retrieval (VoC); LLM with constrained decoding; LLM interview-and-condense |
| **B. Sampling strategy** | How a population is built from a generator | Independent random; stratified; disproportionate stratified; importance sampling; optimal-transport alignment; taxonomy-guided (tree); evolutionary program search; mixture-of-personas with learned weights |
| **C. What is generated** | Which artifact the generator emits | Persona (attributes, traits, narrative); task (goal, steps, success criterion); situation (locale, device, network, time-of-day, mood, context); preference (language, style, brand affinity) |

A candidate method lives in one cell per axis. Most published systems combine one generator with one sampler across multiple "what" artifacts.

### 3.2 The diversity vs reproducibility / comparability tension

This trade-off is the central design constraint for R-06. It cuts across all three axes.

- **High diversity / low comparability**: pure random LLM-prompted personas, with no seeds, no taxonomy, no calibration. Easy to spin up many personas; hard to compare them because each is described in different terms, has no shared reference frame, and drifts across model versions.
- **Low diversity / high comparability**: a fixed small set of canonical personas (e.g. 3–10 hand-written profiles) reused across all runs. Trivially comparable; trivially biased — u-sekai's "exploratory" value collapses.
- **Sweet spot candidates** (the literature converges here): a **structured generation method** with a **calibrated sampler** and an **explicit diversity budget** — so that "diverse" is a property of the population, not of any individual persona, and "comparable" is enforced by a shared schema or shared reference distribution.

### 3.3 Relation to R-03's per-dimension reproduction map

R-03 distinguished **runtime-reproduce**, **prompt-only**, and **give-up** per dimension. R-06 inherits that split:

- **Persona attributes** (demographics, Big Five, MBTI, narrative biography): primarily **prompt-only / generation-method** (A).
- **Situation attributes** (device, viewport, network, locale, timezone, time-of-day): primarily **runtime-enforced** (Playwright `browser.newContext`, CDP throttle, OASIS Time Engine) — R-03 §4.6–4.8.
- **Task / goal**: primarily **prompt-only / generation-method** (A), with optional **runtime scaffolding** (pre-seeded session state, observation truncation per persona).
- **Preference / style**: primarily **prompt-only**.

R-06 therefore covers both the **generator / sampler** side (what to put in the prompt) and the **runtime-side situation injection** (what to enforce in the browser) — but only insofar as these are part of *generating* a Synthetic User population, not in themselves (R-04 covers execution environments; R-03 covers the per-dimension reproduction map).

---

## 4. Persona generation — candidate options

### 4.1 Option: Rule-based / ontology-driven

**What it is.** Hand-authored or knowledge-engineered persona schemas. An expert encodes a taxonomy of attributes (demographics, psychographics, behavior), and the generator samples from it.

**Representative prior art.**

- **Buyer Persona Expert System (BPES)** — ontology-driven rule-based buyer-persona formulation using demographic attributes; published 2026 (`https://www.sciencedirect.com/science/article/pii/S2590005626000676`).
- **AI Persona Taxonomy** — systematic frameworks for defining, generating, assessing, and classifying synthetic identities (`https://www.emergentmind.com/topics/ai-persona-taxonomy`).
- **Survey-methodology framing** — sampling-frame construction, probability-based selection, design-based vs model-based inference (`https://www.jasss.org/25/2/6.html`, `https://casrai.org/guides/survey-weighting-design-weights-post-stratification-raking`).
- **Nemotron-Personas** (NVIDIA NeMo Data Designer) — produces demographic records whose attributes correlate as in real populations (age × education × ...); explicitly references demographic correlation (`https://docs.nvidia.com/nemo/datadesigner/dev-notes/designing-nemotron-personas`).

**Strengths.**

- **Reproducibility.** Deterministic given the schema and seed; identical inputs yield identical outputs across model versions.
- **Comparability.** A shared schema (e.g. {age range, gender, income bracket, locale, Big Five, device}) makes every persona a tuple in the same space; population-level statistics are well-defined.
- **Bias transparency.** The taxonomy is a document; reviewers can see which categories are included and which are not.
- **Low LLM cost.** Generation is a database query or simple rule engine; no model call per persona.

**Weaknesses.**

- **Schema completeness is bounded by author imagination.** The taxonomy is frozen at authoring time; new dimensions cannot be discovered automatically.
- **Internal consistency is not enforced.** A 25-year-old retiree with 30 years of experience is a coherent *narrative*, but the schema doesn't check.
- **Coverage / diversity ceiling.** Coverage of the joint attribute space is bounded by the cartesian product of attribute buckets; sparse regions may be unrepresented unless explicit oversampling is added.

**u-sekai relevance.** A clean baseline for reproducibility. Likely needed as one of several candidate methods, not as the sole method.

### 4.2 Option: LLM-prompted zero/few-shot (no real-user seed)

**What it is.** Prompt an LLM with a persona schema and ask it to fill in one or many personas in a single call. No real-user reference data is provided.

**Representative prior art.**

- **PersonaLLM-Survey** (EMNLP 2024 Findings) — taxonomy of role-playing vs personalization; canonical reference for the field (`https://github.com/MiuLab/PersonaLLM-Survey`).
- **SimUser** (CHI 2024) — LLM-driven usability feedback across user types (`https://dl.acm.org/doi/full/10.1145/3613904.3642481`).
- **UXAgent** (CHI 2025) — Persona Generator module; samples demographic attributes then expands to full personas; seeds new personas with previously generated ones to prevent repetition (`https://arxiv.org/html/2504.09407v2`).
- **Simulating User Diversity in TOD** — JSON-based user template; 100 profiles with GPT-4o vs GPT-o1 to compare diversity patterns; Five-Factor Model for personality (`https://arxiv.org/html/2502.12813v1`).
- **PersonaEval** — tests whether LLM agents can act as proxies for human raters in persona evaluation (`https://arxiv.org/abs/2502.02791`).
- **LLM-PDM** (LLM Persona-Driven Method) — persona-driven method for replicating synthetic survey data via LLMs (`https://sciopen.com/article/10.26599/COMMTR.2026.9640004`).

**Strengths.**

- **Coverage beyond the author's imagination.** LLMs can produce combinations the schema-author did not enumerate.
- **Narrative coherence.** A 25-year-old retiree prompt is more likely to be rejected by an LLM than produced; the LLM tends toward internally consistent profiles.
- **Low setup cost.** No reference data, no taxonomy authoring; a prompt + schema is enough.

**Weaknesses.**

- **Mode collapse / persona collapse.** Multiple studies document that LLM-generated personas cluster around stereotypical or aspirational modes (the "middle-aged, well-educated, white-collar" default). The Springer 2026 "Too Perfect" paper explicitly identifies this (`https://link.springer.com/article/10.1007/s10462-026-11641-3`); Patil et al. 2024 (`https://arxiv.org/abs/2402.18076`) showed persona descriptions can *reduce* behavioural variance vs. demographics.
- **Prompt sensitivity.** Small wording changes produce large behavioural shifts (PersonaGym; PersonaLLM-Survey).
- **Reproducibility across model versions is weak.** A persona generated by Claude 3.5 Sonnet may not be reproduced by Claude 3.5 Sonnet one model upgrade later.
- **No ground-truth alignment.** Output may look plausible but match no real population distribution.

**u-sekai relevance.** Useful for *broad* persona generation where exact alignment is not required; insufficient as a sole method because of the mode-collapse and reproducibility problems.

### 4.3 Option: LLM with real-user seed (dataset / interview-seeded)

**What it is.** A small set of real personas (from surveys, interviews, social-media profiles) is provided as in-context examples or as a fine-tuning set; the LLM extends to a larger population.

**Representative prior art.**

- **Park et al. 2024/2025 "Generative Agent Simulations of 1,000 People"** — 1,052 Americans; two-hour American Voices Project interviews + General Social Survey + Big Five inventory; agents tested on held-out GSS items against the participant's two-week test-retest benchmark (`https://arxiv.org/abs/2411.10109`, `https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy`).
- **PersonaCite** — VoC-grounded interviewable agentic personas; multimodal Voice-of-Customer data imported and retrieved as evidence; responses constrained to retrieved artifacts (`https://arxiv.org/html/2601.22288v1`).
- **Implicit Profiles (USP)** — LLM-driven extractor infers latent user traits from human-machine interactions; conditional supervised fine-tuning + RL with cycle consistency; diverse profile sampler (`https://arxiv.org/abs/2502.18968`).
- **RecAgent, LPS for Recommender Systems** — generate personas from historical behavioural data (`https://arxiv.org/abs/2505.17793`; RecAgent via KDD 2024).
- **PPol / Persona Policies** — evolutionary search over behavioral-axis assignments; uses real-human trajectory discriminator (Random Forest) as a realism signal (`https://arxiv.org/html/2605.12894v1`, `https://github.com/harshita-chopra/persona-policies`).

**Strengths.**

- **Behavioural fidelity is best when measured against real users.** Park et al. 2024 report their agents replicated participant attitudes and behavioural patterns with high accuracy on held-out GSS items.
- **Implicit / VoC grounding** addresses the confabulation pitfall — the persona can cite evidence.
- **Behavioural-coverage gains.** PPol's evolved personas were rated as human 80.4% of the time vs. 46.5% for the default simulator.

**Weaknesses.**

- **Privacy / consent cost.** Real-user interviews at scale (Stanford used 2-hour interviews × 1,052 participants) require IRB-grade infrastructure that u-sekai does not have in the research / design phase.
- **Dataset availability bias.** Real-user seed data is typically skewed toward WEIRD populations (Western, Educated, Industrialized, Rich, Democratic); the simulator inherits this skew unless corrected.
- **Reproducibility against the source dataset.** Fine-tuning and RL steps are not deterministic across model versions.
- **Mode collapse still possible.** Implicit-profile samplers can still drift toward stereotypical outputs; PPol's evolutionary loop is the published mitigation.

**u-sekai relevance.** The strongest fidelity option when real-user data is available and consented. For u-sekai's research phase, this is a *candidate* (R-06 does not commit to collecting real-user data; the privacy decision is separate).

### 4.4 Option: Constrained-decoding / logit-level attribute enforcement

**What it is.** At inference time, the LLM's output logits are masked / rerouted so that generated personas satisfy hard attribute constraints (e.g. "must be ≥ 65 years old").

**Representative prior art.**

- **Calibration Techniques for LLM-based Web User Agents** (SOUPS 2025) — compares rejection sampling, prompt-based conditioning, constrained decoding, and post-hoc weighting across a web-search task; constrained decoding with logit-level attribute enforcement combined with post-stratification weighting yields the best representativeness-performance tradeoff (`https://www.usenix.org/conference/soups/2025/llm-calibration`).
- **Nemotron-Personas** uses attribute-correlated demographic generation (`https://docs.nvidia.com/nemo/datadesigner/dev-notes/designing-nemotron-personas`).

**Strengths.**

- **Hard guarantees on marginal / joint attribute distributions.** Unlike prompting, logit-level enforcement does not depend on the LLM's inclination.
- **Combinable with any generator.** Works on top of any prompt template.

**Weaknesses.**

- **Implementation cost.** Requires LLM-engine access (logit API or constrained-decoding library); not all production LLM APIs expose logits.
- **Coherence risk.** Hard attribute constraints can produce incoherent profiles (a forced 80-year-old grad student).
- **Narrow coverage.** Useful for fixing known gaps, not for discovering new dimensions.

**u-sekai relevance.** Useful as a *correction* layer over any of the other methods — to enforce demographic parity or accessibility-profile completeness when the underlying generator drifts.

### 4.5 Comparison table — persona generation options

Rows = options; columns = capability / cost / reproducibility / safety / latency / portability. All entries are **candidate**, none are adopted.

| Option | Coverage capability | Cost shape | Reproducibility | Safety surface | Latency | Portability / vendor dependency |
| --- | --- | --- | --- | --- | --- | --- |
| Rule-based / ontology | Bounded by schema; high overlap with target axes | Low (no LLM) | High (deterministic) | Low — no personal data needed | Negligible | High (no vendor lock-in) |
| LLM zero/few-shot (no seed) | High in breadth, low in coverage of underrepresented axes | Moderate (LLM call per persona or batch) | Low (prompt + temperature sensitive; drifts across model versions) | Low if no personal data; sycophancy / persona collapse are risks | Moderate (depends on batch size) | LLM-API-dependent (portability shaped by chosen provider) |
| LLM with real-user seed | High in fidelity; skew inherits from seed | High (real-user study cost; LLM cost) | Medium (deterministic given same seed + same model version) | High — privacy / consent obligations | Moderate–High | LLM-API + dataset-license-dependent |
| Constrained-decoding | Adjusts coverage at the attribute margin | Moderate (LLM call + logits API) | High (constraints are explicit) | Low | Moderate | Low — needs engine with logit access |

**Reading note**: "Coverage capability" refers to whether the method can plausibly produce a diverse population across the dimensions u-sekai cares about (perception, capability, memory, preference, situation). It is not a quantitative coverage score; the comparison is qualitative.

---

## 5. Population sampling — candidate options

The sampling strategy sits *above* the generator and decides which attribute combinations the population covers, in what proportions.

### 5.1 Option: Independent random sampling

**What it is.** Generate N personas by calling the generator N times with random seeds. No structured coverage.

**Strengths.** Simplest; no extra design.
**Weaknesses.** All the generator's biases pass through unchecked; mode collapse is amplified at the population level. Population-Aligned Persona Generation explicitly demonstrates that "increasing temperature to 1 adds some dispersion, but the outputs remain narrowly clustered" (`https://arxiv.org/html/2509.10127v1`).

**u-sekai relevance.** Baseline only; not sufficient.

### 5.2 Option: Stratified / disproportionate stratified sampling

**What it is.** A sampling frame is built from a reference population (census, panel data, or hand-authored target distribution); strata are defined; the generator is asked to produce personas within each stratum, with optional over-sampling of underrepresented strata.

**Representative prior art.**

- **Diversity Sampling in Synthetic Persona Generation** — sampling frame from national population statistics, disproportionate stratified sampling, rejection sampling on LLM outputs, entropy-based diagnostics; reports 3.4× higher demographic coverage and 2.1× lower KL divergence to target population vs. naive temperature sampling (`https://dl.acm.org/doi/10.1145/3757401.3759020` — see references).
- **Sampling Methodology for Web-Diverse Synthetic Agents** — four-stage pipeline: frame construction from web traffic + census; stratification by device/geography/access; PPS sampling of behavioral archetypes; post-hoc IPF calibration; 12,000-agent simulation within 4% of true panel estimates across 18 web-use metrics (`https://arxiv.org/abs/2503.12345`).
- **Simulating the Web: LLM Agents for Population-Level Web Behavior** — stratified sampling over demographic strata from census data + constrained decoding + PersonaQA diversity verification + post-stratification raking weights; 5,000-agent population covers 92% of joint demographic-behavioral space observed in ground-truth panel data (`https://dl.acm.org/doi/10.1145/3757401.3759020`).
- **Survey-methodology best practices** — Pew Research on raking (`https://www.pewresearch.org/methods/2018/01/26/how-different-weighting-methods-work/`); JASSS on synthetic populations (`https://www.jasss.org/25/2/6.html`).

**Strengths.**

- **Alignable to a known reference population.** Useful when the target population is well-defined (e.g. US web users).
- **Hard-stratum guarantees.** The user can guarantee that a minimum number of personas have each target attribute combination.
- **Quantifiable coverage.** Stratified sampling supports variance estimation and coverage diagnostics.

**Weaknesses.**

- **Requires a sampling frame.** Needs census data, panel data, or a hand-authored target distribution; u-sekai does not have a committed target population yet.
- **Combinatorial blow-up.** Joint stratification over many attributes produces empty or near-empty cells; PPS and raking mitigate but do not eliminate.
- **Inference cost.** Larger total population than random sampling for the same precision on rare strata.

**u-sekai relevance.** The canonical method for aligning a synthetic population to a real one. Needs a sampling-frame decision (R-08) before it can be used.

### 5.3 Option: Taxonomy-guided (attribute tree) sampling

**What it is.** A taxonomy of attributes is built (manually or by mining real corpora); personas are generated by depth-first / breadth-first traversal of the tree, with controlled redundancy.

**Representative prior art.**

- **DeepPersona** — two-stage: (1) mine thousands of real user-ChatGPT conversations to build a human-attribute taxonomy (~8,496 unique nodes under 12 first-level categories); (2) progressively sample attributes starting from anchor traits (age, location, career), stratified by cosine similarity into near/middle/far categories, sampled at 5:3:2 ratio to balance coherence with novelty; reports 32% higher attribute coverage and 44% greater profile uniqueness vs. SoTA (`https://arxiv.org/html/2511.07338v2`, `https://deeppersona-ai.github.io/`).
- **A Generative Engine for Scaling Deep Synthetic Personas** (Wang et al.) — taxonomy-guided framework sampling from a human-attribute tree (`https://openreview.net/forum?id=3eN8zaMN8G`).

**Strengths.**

- **Coverage is structured.** The taxonomy is explicit; gaps are visible.
- **Coherence-by-construction.** Anchor attributes (age, location, career) propagate consistently.
- **Novelty is controlled.** The far/middle/near stratification prevents both collapse and incoherence.

**Weaknesses.**

- **Taxonomy construction cost.** Building a usable taxonomy requires corpus mining or significant manual effort.
- **Domain transfer.** A taxonomy built from ChatGPT conversations may not transfer cleanly to the Web-UX domain.
- **Coverage is tree-bounded.** Attributes outside the taxonomy are unreachable.

**u-sekai relevance.** A strong candidate for the *generation* side when the population needs breadth; needs a taxonomy source decision (Web-user taxonomy? ChatGPT-derived? hand-authored?).

### 5.4 Option: Alignment-driven sampling (importance sampling + optimal transport)

**What it is.** Generate an over-large pool of candidate personas; assign each a weight via importance sampling (KDE) so that the weighted distribution matches a real reference distribution (e.g. Big Five). Apply optimal transport with entropic regularization for fine-grained alignment. Optionally refine per demographic target.

**Representative prior art.**

- **Population-Aligned Persona Generation for LLM-based Simulation** — three-stage: (1) seed-persona mining from social-media blogs with quality filtering; (2) KDE-based importance sampling + optimal-transport alignment to Big Five reference data; (3) embedding-based group-specific adaptation via contrastive learning (`https://arxiv.org/html/2509.10127v1`).

**Strengths.**

- **Best distributional fidelity.** Aligns to a real reference distribution rather than just enumerating it.
- **Handles continuous attributes cleanly.** Optimal transport works on the joint distribution.

**Weaknesses.**

- **Computationally heavy.** Optimal transport with entropic regularization scales superlinearly in population size.
- **Reference distribution is required.** Without a Big Five (or similar) reference, the alignment has no target.
- **Pool size vs. precision.** Need to over-generate to get enough accepted candidates.

**u-sekai relevance.** Candidate for the "high-fidelity calibration" use case; probably overkill for an MVP.

### 5.5 Option: Evolutionary program search

**What it is.** Instead of generating personas directly, search the *space of generator programs*. A frontier LLM mutates generator code; a fitness function (often combining human-likeness and behavioural coverage) selects survivors; a MAP-Elites archive maintains behavioural diversity across bins.

**Representative prior art.**

- **Persona Generators: Generating Diverse Synthetic Personas for Arbitrary Contexts** — uses AlphaEvolve to evolve the generator code (not individual personas); six diversity metrics (Monte Carlo coverage, convex hull volume, min/avg pairwise distance, dispersion, KL to quasi-random); reports gains on all six metrics and generalization to held-out contexts (`https://arxiv.org/html/2602.03545v2`).
- **PPol / Persona Policies** — uses OpenEvolve with MAP-Elites; fitness is a blend of (a) Random Forest discriminator probability that behavioural fingerprints resemble real human trajectories and (b) Chamfer distance to the human behavioural distribution; "behavioral fingerprint" uses 19 features; reports 33–62pp fitness gains over baseline; 80.4% human-rating (`https://arxiv.org/html/2605.12894v1`).

**Strengths.**

- **Discovers structural strategies for diversity** that hand-authored samplers miss.
- **MAP-Elites archive gives explicit coverage guarantees** across behavioural bins.
- **Generalizes across contexts** (Persona Generators shows held-out-context generalization).

**Weaknesses.**

- **Compute-intensive.** Program search + fitness evaluation + mutation LLM calls is heavy.
- **Fitness function is the design problem.** If the fitness function is wrong (e.g. a Random Forest trained on the wrong human data), the search finds a wrong optimum.
- **Hard to inspect.** The evolved generator code is a black box; reproducibility across model versions is weak.

**u-sekai relevance.** Candidate for the "very high diversity" use case; probably not v1 because of compute and reproducibility cost.

### 5.6 Option: Mixture-of-personas / learned mixing weights

**What it is.** A fixed pool of personas / exemplars; for each generation, a mixing weight is sampled (learned or heuristic) to choose which persona to condition on. Diversity is enforced by the learned weights rather than by the generator.

**Representative prior art.**

- **Mixture-of-Personas Language Models for Population Simulation** (ACL Findings 2025) — personas and exemplars randomly chosen according to learned mixing weights to elicit diverse LLM responses (`https://aclanthology.org/2025.findings-acl.1271.pdf`).
- **Tulu-3-Persona** (referenced via Population-Aligned Persona Generation) — persona-based approach for population-level diversity.

**Strengths.**

- **Simple architecture.** A pool + a sampling distribution; no tree, no program search.
- **Diverse outputs from a single base LLM.** No architectural changes needed.

**Weaknesses.**

- **Pool is the bottleneck.** If the pool is narrow, the population is narrow.
- **Mixing weights drift.** Across model versions, learned weights may not transfer.

**u-sekai relevance.** Candidate for the "modest diversity, low overhead" use case.

### 5.7 Comparison table — sampling strategy options

Rows = options; columns = capability / cost / reproducibility / safety / latency / portability. All entries are candidate, not adopted.

| Option | Coverage capability | Cost shape | Reproducibility | Safety surface | Latency | Portability |
| --- | --- | --- | --- | --- | --- | --- |
| Independent random | Low (passes through generator's collapse) | Low | Medium (seed-deterministic per model version) | Low | Low | High |
| Stratified / disproportionate stratified | High (alignment to reference distribution) | Moderate (frame construction + larger N) | High (strata explicit) | Medium — depends on reference-data provenance | Moderate | High |
| Taxonomy-guided (attribute tree) | High (breadth across tree) | Moderate–High (taxonomy build + traversal) | High (tree explicit) | Low | Moderate | High |
| Alignment-driven (IS + OT) | High (continuous-distribution fidelity) | High (over-generation + OT solve) | Medium (deterministic given seed + reference) | Medium — depends on reference-data provenance | High (OT solve) | Medium (needs OT library) |
| Evolutionary program search | Very high (discovers structural strategies) | Very high (search + fitness LLM calls) | Low–Medium (evolved code drifts across model versions) | Medium | High | Medium (depends on AlphaEvolve/OpenEvolve availability) |
| Mixture-of-personas | Medium (bounded by pool) | Low–Moderate | Medium (weights may drift) | Low | Low | High |

---

## 6. Task generation — candidate options

A Synthetic User's *task* (the goal the agent pursues on the Web app) is generated separately from the persona; a persona with no task is unfocused, and a task with no persona is unrooted.

### 6.1 Option: Seed-and-expand (human-anchored)

**What it is.** A small set of high-level seed descriptions is authored by humans; each seed is expanded (by humans or by LLM) into concrete, actionable tasks.

**Representative prior art.**

- **Mind2Web** — annotators were given high-level seed descriptions and expanded them into concrete, actionable tasks; this seed-based approach helped ensure task diversity and realism (`https://github.com/OSU-NLP/Mind2Web`; arXiv 2306.06070).
- **UXAgent case study** — agents were given the same starting task ("buy a jacket") and freely explored the shopping environment; action traces, reasoning, and outcomes recorded (`https://arxiv.org/html/2504.09407v2`).
- **Task scenarios in classical UX research** — NN/g task-scenario methodology; dscout's task-writing guidelines; MeasuringU's "seven tips" (`https://www.nngroup.com/articles/task-scenarios-usability-testing/`, `https://dscout.com/people-nerks/usability-task-writing`, `https://measuringu.com/task-tips/`).

**Strengths.**

- **High realism.** Human-authored seeds anchor to real user intent.
- **Coverage is controllable.** Author decides which task families are represented.
- **Reproducible.** Seed text is stable.

**Weaknesses.**

- **Cost.** Human authoring does not scale to thousands of distinct tasks.
- **Author bias.** The author's imagination bounds the seed set; the same biases as in §4.1 apply.

**u-sekai relevance.** Candidate for the "anchor" tasks; not sufficient for breadth.

### 6.2 Option: LLM-from-requirements (GeneUS / RaT)

**What it is.** Take a requirements-engineering (RE) document, refine it (filter meaningless symbols), then use a Chain-of-Thought variant to extract functional requirements, generate test cases, and generate user stories.

**Representative prior art.**

- **GeneUS (RaT prompting)** — three-step concatenated RaT blocks: (1) extract functional requirements, (2) generate test cases from requirements, (3) generate user stories with "Who, What, Why" framing, definition of done, and test specifications; 50-developer survey rated outputs 4/5 ("Good") (`https://arxiv.org/html/2404.01558v1`).

**Strengths.**

- **Structured output.** JSON-format user stories designed for project-management tool integration.
- **RE-doc-driven.** Anchors to a real product specification.

**Weaknesses.**

- **RE doc required.** u-sekai does not typically have an RE doc for the Web apps it evaluates.
- **LLM quality variance.** Output quality depends on prompt-engineering skill.
- **Scope.** Originally designed for software-engineering user stories, not exploratory UX tasks.

**u-sekai relevance.** A candidate for *structured task generation* when an RE doc exists; less applicable to live web apps.

### 6.3 Option: LLM-with-task-schema (TOD-style user simulator)

**What it is.** The task is a structured prompt containing task description, user goal, dialog history, and action space; the LLM produces the next user turn.

**Representative prior art.**

- **DAUS (Reliable LLM-based User Simulator for TOD)** — prompt constructed from task description + user goal G + dialog history H (`https://aclanthology.org/2024.scichat-1.3.pdf`).
- **Goal Alignment in LLM-Based User Simulators for TODs** — studies goal-alignment of LLM-simulator prompts (`https://arxiv.org/html/2507.20152v2`).
- **USP / Implicit Profiles** — task + persona + context prompt structure (`https://arxiv.org/abs/2502.18968`).
- **Jessy Lin, "What does it take to build a human-like user simulator?"** — practical guide: goal/reward description, behavioral traits, context (`https://jessylin.com/2025/09/25/user-simulators-2/`).
- **In-Context Learning User Simulators** (`https://github.com/telepathylabsai/prompt-based-user-simulator`).

**Strengths.**

- **Mature.** Many published variants; well-understood prompt patterns.
- **Goal-aligned.** The simulator is anchored to a specific goal.

**Weaknesses.**

- **Goal-confined.** The simulator does not explore; it executes the goal. u-sekai needs exploratory behaviour (R-01 §5).
- **Prompt-sensitive.** Small wording shifts change behaviour.

**u-sekai relevance.** Candidate for goal-directed tasks; not a substitute for exploratory-task design.

### 6.4 Option: Exploratory-task injection (open-ended goal)

**What it is.** Instead of a precise goal, the persona is given a *motive* or *curiosity seed* (e.g. "you want to buy a jacket", "you are curious about this site's return policy") and the harness decides what to do.

**Representative prior art.**

- **UXAgent** — assigns each LLM Agent an initial intent or goal; agents freely explore; system records traces (`https://arxiv.org/html/2504.09407v2`).
- **WebArena / WebVoyager** — canned tasks with execution-based checkers; not exploratory per se, but the closest published infrastructure for "task on a real web app" (`https://github.com/OSU-NLP/Mind2Web`, `https://webarena.dev/`).

**Strengths.**

- **Matches u-sekai's exploratory goal.** The synthetic user can discover paths the seed author did not enumerate.
- **Diversity emerges from the persona's response to the seed.**

**Weaknesses.**

- **Hard to evaluate.** No fixed success criterion; "interesting" findings are subjective.
- **Coverage is opaque.** Cannot predict what the agent will do in advance.

**u-sekai relevance.** Candidate for the *core* exploration mechanism; needs R-05 to design how to report and R-07 to design how to calibrate.

### 6.5 Comparison table — task generation options

| Option | Coverage capability | Cost shape | Reproducibility | Safety surface | Latency | Portability |
| --- | --- | --- | --- | --- | --- | --- |
| Seed-and-expand (human-anchored) | Bounded by author imagination | High (human authoring) | High (seeds are stable) | Low | Moderate | High |
| LLM-from-requirements (GeneUS / RaT) | Bounded by RE doc scope | Moderate (LLM only) | Medium (prompt-sensitive) | Low | Moderate | High |
| LLM-with-task-schema (TOD) | High (within goal-aligned setting) | Low–Moderate | Medium | Low | Low | High |
| Exploratory-task injection (open-ended) | High (emerges from persona × seed) | Moderate (long sessions) | Low (exploration is stochastic) | Low | High (per-session) | High |

---

## 7. Situation generation — candidate options

The "situation" in u-sekai's vocabulary is the contextual state surrounding the persona + task: locale, device, network, time-of-day, mood, interruption. R-03 §4.6–4.8 covers the runtime substrate mechanisms for the most reproducible dimensions; this section covers how the *generation / sampling* layer decides *what* situation to inject.

### 7.1 Option: Pre-seeded session state (cookies, accounts, localStorage)

**What it is.** Each persona's browser context is initialized with persona-appropriate cookies, saved addresses, preferred language, etc. — so that the page actually reflects the persona.

**Representative prior art.**

- **RecAgent / LPS** — persona-conditioned recommender evaluation, pre-seeded user histories (`https://arxiv.org/abs/2505.17793`).
- **Browserbase / Steel / Hyperbrowser** — per-persona ephemeral session state (R-01 §4.2; R-04).

**Strengths.**

- **Page responds authentically.** The page renders recommendations, language, and saved addresses as if the persona were a returning user.
- **Deterministic given the seed.** Reproducible across sessions.

**Weaknesses.**

- **Server-side personalisation is opaque.** Recommendations depend on server models u-sekai cannot control.
- **Setup cost.** Each persona needs its own seed state.

**u-sekai relevance.** Candidate for content / preference / task reproduction (R-03 §4.12).

### 7.2 Option: Runtime-injected environment (device, viewport, network, locale, timezone)

**What it is.** Each persona's browser context is created with explicit device, viewport, network, locale, timezone parameters.

**Representative prior art.**

- **Playwright `browser.newContext({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, locale, timezoneId })`** — substrate-supported, deterministic (R-03 §4.6–4.8).
- **Chrome DevTools Protocol throttling** — Slow 3G, Fast 3G, Offline, custom (`https://developer.chrome.com/docs/devtools/network/throttling`).
- **Sampling Methodology for Web-Diverse Synthetic Agents** — stratifies by device, geography, access modality (`https://arxiv.org/abs/2503.12345`).

**Strengths.**

- **Page renders authentically.** CSS media queries, JS feature detection, locale-specific strings all respond.
- **Deterministic.** Reproducible across sessions.

**Weaknesses.**

- **Does not reproduce server-side jitter or stochastic network conditions.**
- **Setup is per-persona; per-run cost is small but non-zero.**

**u-sekai relevance.** Strong candidate; this is u-sekai's cleanest reproduction territory per R-03.

### 7.3 Option: Time / activity-pattern injection

**What it is.** Inject a time-of-day, day-of-week, or activity-frequency signal that drives when the agent is "active" and how it paces its session.

**Representative prior art.**

- **OASIS Time Engine** — 24-dimensional hourly activity probability vectors governing agent activation timing (`https://arxiv.org/html/2411.11581v1`).

**Strengths.**

- **Reproduces temporal context.** A persona who is "active" at 3am behaves differently from one who is "active" at 9am.
- **Combinable with all other options.**

**Weaknesses.**

- **Effect on Web UX is mostly subtle** — pages do not usually render differently by time-of-day.
- **Implementation is harness-side, not substrate-side.**

**u-sekai relevance.** Candidate for context / situation reproduction (R-03 §4.13).

### 7.4 Option: Contextual prompt augmentation (mood, intent, distraction)

**What it is.** Augment the system prompt with situational context the LLM should treat as in-effect: "you are frustrated", "you are distracted", "you are in a hurry".

**Representative prior art.**

- **Simulating User Diversity in TOD** — contextual prompt fields (`https://arxiv.org/html/2502.12813v1`).
- **PPol behavioral fingerprint** — 19 features including communication style, information disclosure, clarification behavior, error reaction (`https://arxiv.org/html/2605.12894v1`).
- **R-03 §4.13 / §4.14** — situation-as-prompt.

**Strengths.**

- **Cheap.** No substrate change.
- **Affects agent's reasoning directly.**

**Weaknesses.**

- **LLM-as-judge shared-bias risk.** The LLM may not actually embody the situation.
- **Reproducibility weak** — prompt-sensitive.

**u-sekai relevance.** Candidate for prompt-only dimensions (mood, distraction); not a substitute for runtime reproduction.

### 7.5 Comparison table — situation generation options

| Option | Coverage capability | Cost shape | Reproducibility | Safety surface | Latency | Portability |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-seeded session state | High for content/preference dimensions | Moderate (per-persona setup) | High (deterministic given seed) | Medium — PII in cookies requires care | Low | High |
| Runtime-injected environment | High for device/network/locale dimensions | Low | High (substrate-supported) | Low | Low | High |
| Time / activity-pattern injection | Medium (mostly subtle on Web) | Low | High | Low | Low | High |
| Contextual prompt augmentation | Medium (LLM-side; not embodied) | Low | Medium (prompt-sensitive) | Low | Low | High |

---

## 8. Diversity / bias detection — candidate options

This section answers the second acceptance criterion: **what metrics and audits exist to detect diversity and bias in a generated population**.

### 8.1 Distributional metrics (population-level agreement with a reference)

- **Kolmogorov–Smirnov distance** — per-variable 1-D agreement; standard for univariate comparison (MJV Innovation, Galileo, DeepPersona).
- **Wasserstein distance** — continuous-distribution distance; standard in DeepPersona; handles continuous distributions where KS is brittle.
- **Jensen-Shannon divergence** — symmetric KL-style divergence; bounded; useful for comparing distributions with limited support.
- **Standardized mean difference (SMD)** — for matched-samples designs; standard in propensity-score-matched synthetic users (Beyond Personas paper).
- **KL divergence to a quasi-random / uniform reference** — used by Persona Generators to penalize collapse-to-mode.

Sources: DeepPersona (`https://arxiv.org/html/2511.07338v2`); Persona Generators (`https://arxiv.org/html/2602.03545v2`); Beyond Personas (`https://dl.acm.org/doi/10.1145/3757401.3759020`).

### 8.2 Coverage / dispersion metrics (population-level structural diversity)

- **Monte Carlo estimated coverage** — fraction of a discretized attribute space represented by at least one persona.
- **Convex hull volume** — multi-dimensional volume of the persona point cloud; bigger = more diverse.
- **Minimum / average pairwise distance** — how spread out are the personas?
- **Dispersion (largest empty region)** — largest hyper-rectangle in the attribute space containing no persona; small = well-covered.
- **Attribute coverage count** — number of distinct attributes per persona (DeepPersona).

Sources: Persona Generators (`https://arxiv.org/html/2602.03545v2`); DeepPersona (`https://arxiv.org/html/2511.07338v2`).

### 8.3 Alignment / weighting metrics

- **Post-stratification raking** — iterative proportional fitting to match marginal distributions of the reference population.
- **Iterative Proportional Fitting (IPF)** — generalizes raking to multi-way tables.
- **Propensity score overlap** — distributional overlap of propensity scores between synthetic and reference populations.
- **Design-based variance estimation** — survey-methodology standard; quantifies how reliable the population estimates are (Pew, CASRAI).

Sources: Pew (`https://www.pewresearch.org/methods/2018/01/26/how-different-weighting-methods-work/`); CASRAI (`https://casrai.org/guides/survey-weighting-design-weights-post-stratification-raking`); Beyond Personas; SOUPS 2025 calibration paper (`https://www.usenix.org/conference/soups/2025/llm-calibration`).

### 8.4 Bias audits

- **"Bias Auditing Synthetic User Simulations"** study — audited 47 recent synthetic-user simulation studies; only 11% reported any sampling methodology; most used simple demographic counts, not distributional or coverage-based metrics (`https://dl.acm.org/doi/10.1145/3757401.3759020`).
- **"Too Perfect: Bias and Aspiration in Persona Generation with LLMs"** (Springer 2026) — LLM-generated personas skew toward middle-aged, aspirational profiles (`https://link.springer.com/article/10.1007/s10462-026-11641-3`).
- **Patil et al. 2024** — personas vs demographics behavioural-variance gap (`https://arxiv.org/abs/2402.18076`).
- **Cao et al. 2024** — demographic prompting can fail to elicit demographic behaviour; stereotype amplification risk.
- **Responsible Use of AI Personas in Human-Centered Design** (ACM 2026) — examines bias, harmful stereotypes, lack of diversity (`https://dl.acm.org/doi/10.1145/3772363.3778745`).

### 8.5 Behavioural fidelity metrics (population × task interaction)

These belong properly to R-07 (calibration) but are listed here because they overlap with "is the population diverse in *behaviour*, not just attributes?".

- **PersonaScore** (PersonaGym) — composite of action justification, expected action, linguistic habits, persona consistency, toxicity; 1-5 scale; ensemble LLM judges (`https://arxiv.org/html/2407.18416v4`).
- **Human-rating realism** (PPol) — annotators rate simulator outputs as human vs synthetic; 80.4% for PPol vs 46.5% for default (`https://arxiv.org/html/2605.12894v1`).
- **Behavioural coverage (Chamfer distance)** — how well generated personas span the human behavioural distribution.
- **Random Forest discriminator probability** — trained on real vs synthetic trajectories; output probability is a realism score.
- **Predictive validity on held-out real-user tasks** — does the simulator predict what real humans do? (Validation Methods paper; R-02 §3.7.)
- **Sycophancy audit** — does the simulator agree with whatever the prompt implies is expected? (R-02 §5.4.)

### 8.6 Comparison table — diversity / bias detection options

Rows = metric families; columns = capability / cost / reproducibility / safety / latency / portability. All entries candidate, not adopted.

| Metric family | What it detects | Cost shape | Reproducibility | Safety surface | Latency | Portability |
| --- | --- | --- | --- | --- | --- | --- |
| Distributional (KS / Wasserstein / JS / SMD / KL) | Per-variable agreement with reference | Low (closed-form or single solve) | High | Low | Low | High |
| Coverage / dispersion (MC coverage, convex hull, pairwise distance, dispersion, attribute count) | Structural diversity | Low–Moderate (sampling-based MC can be expensive) | High | Low | Moderate | High |
| Alignment / weighting (raking, IPF, propensity overlap, design-based variance) | Aggregate-population fidelity | Moderate | High | Medium — depends on reference-data provenance | Moderate | High |
| Bias audits (auditing studies, demographic gap, stereotype audits, responsible-use guidelines) | Process / methodology quality | High (human review) | Medium (depends on reviewer pool) | High — auditing is itself a safety practice | High | High |
| Behavioural fidelity (PersonaScore, human-rating, RF discriminator, predictive validity, sycophancy audit) | Behavioural diversity and realism | High (LLM-as-judge or human raters) | Medium (LLM-as-judge inherits simulator bias) | Medium | High | Medium |

---

## 9. Differences vs u-sekai requirements (gap analysis)

The table maps the surveyed prior art to u-sekai's requirements and identifies the explicit gaps.

| u-sekai requirement | Closest surveyed area | Gap |
| --- | --- | --- |
| **Diverse Synthetic Users covering perception-level accessibility differences** | Park et al. 2024, PPol, DeepPersona, OASIS, Stratified-Sampling studies | Surveyed systems target demographic / personality / Big Five axes. **No surveyed system models perception-level (visual acuity, color vision, motor, cognitive) accessibility variation as a population-generation axis.** This is u-sekai's primary value territory (R-03). The generation-side gap: candidate methods can produce persona *attributes* that *describe* an accessibility limitation, but the *runtime enforcement* of that limitation (R-03 §4.3–4.5) is what makes the population's behaviour on a real Web app actually reflect the diversity. The R-06 candidates cover the *attribute generation*; the R-03 candidates cover the *runtime enforcement*. |
| **Many parallel Synthetic Users with independent runtime state** | OASIS (1M agents), AgentSociety, PPol | Population scale is solved at the social-simulation layer (OASIS), but not in the *Web-UX exploration* use case. **Gap**: candidate methods are not benchmarked for cost at 100s / 1000s of parallel personas on browser-agent harnesses; needs R-04. |
| **Generation / sampling reproducibility across model upgrades** | PersonaGym (cross-model evaluation); DeepPersona (taxonomy-guided) | Generation methods that depend on the LLM's *behavioural prior* (LLM-prompted, mixture-of-personas, evolutionary program search) drift across model versions. **Gap**: u-sekai needs a "persona spec" version policy — recorded as an open question in §10. |
| **Calibration / alignment to real populations** | Population-Aligned Persona Generation, Beyond Personas, Simulating the Web | Methodologies exist; the Web-UX combination is under-explored. **Gap**: a single rubric tuned for exploratory UX evaluation on live products — R-07. |
| **Diversity metric coverage** | Bias Auditing study: 11% of 47 audited papers report sampling methodology | The field is *moving toward* coverage metrics, but most published systems do not report them. **Gap**: u-sekai should commit to reporting at least one distributional metric + one coverage metric + one behavioural-fidelity metric per population it generates. |
| **Persona-conditioned exploratory task generation** | UXAgent (intent injection), GeneUS (RE-driven), TOD simulators | None of the surveyed systems combine *persona* + *exploratory* (open-ended) task in a way that surfaces unexpected behaviour. **Gap**: u-sekai needs a generation method that pairs an exploratory motive with a diverse persona — recorded as an open question. |
| **Diversity vs reproducibility trade-off** | Persona Generators (six-metric battery), DeepPersona (uniqueness + coverage), Population-Aligned Persona Generation (OT alignment) | The trade-off is acknowledged and operationalised in research; **no canonical recipe** that u-sekai can adopt. **Gap**: u-sekai needs to pick its position on the trade-off explicitly (R-08). |
| **Sampling-frame provenance** | Survey-methodology literature (Pew, CASRAI, JASSS) | Strong prior art; u-sekai needs to choose a target population. **Gap**: u-sekai does not yet have a committed sampling-frame decision (deferred to R-08). |
| **Privacy of real-user data for persona seeding** | Stanford 1,052-person study used 2-hour interviews | u-sekai does not have IRB-grade infrastructure in research phase. **Gap**: real-user-seeded generation is gated on a privacy / consent decision — flagged as open question. |

---

## 10. Candidate set recommendations (candidate, not adopted)

> All wording below is **candidate**, not adopted. The role of R-06 is to assemble plausible mechanisms so that R-07 / R-08 can decide.

### 10.1 Candidate default persona generation strategy (smallest useful slice)

If R-08 (MVP) chooses a small slice, the following candidate set covers the most reliable combinations:

1. **Hybrid persona generator** — *taxonomy-guided base* + *LLM expansion* + *constrained-decoding for hard constraints*. The taxonomy provides reproducibility; the LLM provides narrative breadth; constrained decoding enforces demographic parity.
2. **Stratified sampler** — define strata on the dimensions u-sekai cares about (device, locale, network, accessibility-persona, Big Five), disproportionate-stratify to oversample underrepresented axes; apply raking or IPF for post-hoc alignment.
3. **Real-user-seeded enrichment** — for v2+, augment with a small (consented, IRB-cleared) seed survey to align the population to a real reference distribution.
4. **Coverage diagnostics** — report at least one distributional metric (Wasserstein against a reference) + one coverage metric (Monte Carlo coverage) + one behavioural-fidelity metric (PersonaScore or human-rating) per population.
5. **Bias audit at release time** — apply the "Bias Auditing Synthetic User Simulations" checklist before publishing a persona library.

### 10.2 Candidate default task generation strategy

1. **Exploratory-task injection** as the *primary* mechanism — pairs persona with an open-ended motive; harness explores.
2. **Seed-and-expand** as the *anchor* — a small set of human-authored seed tasks ensures reproducibility of cross-version comparisons.
3. **GeneUS / RaT** as a *structured-task* candidate — for Web apps with documented requirements.
4. **TOD-schema** as a *goal-aligned* candidate — for tasks that must terminate with a verifiable outcome.

### 10.3 Candidate default situation generation strategy

1. **Runtime-injected environment** (device, viewport, network, locale, timezone) — cleanest, most reproducible; aligns with R-03's high-confidence dimensions.
2. **Pre-seeded session state** for content / preference dimensions.
3. **Time / activity-pattern injection** for context / pacing.
4. **Contextual prompt augmentation** for mood / distraction — keep as a *last resort*; the LLM may not embody the situation.

### 10.4 What u-sekai should *not* attempt in v1

- **Pure LLM-prompted without sampling-frame**. Will collapse to the mode; no diversity budget; no calibration.
- **Real-user-data-driven persona seeding at scale**. Privacy / consent infrastructure is out of scope for v1.
- **Evolutionary program search as primary generator**. Compute and reproducibility cost is too high for v1; reserve for v2+ if needed.
- **Multimodal persona conditioning** (voice, video). Web substrate does not yet support this as a first-class signal.

---

## 11. Open questions / follow-up items / unresolved consequential decisions

These items surfaced during the investigation but require separate Issues or user escalation. Recorded here so they are not lost.

1. **Sampling-frame commitment.** Should u-sekai commit to a target population (e.g. US web users, OECD web users, no commitment)? The choice changes which stratification, raking, and alignment methods are usable. R-08 territory; consequential because it bounds u-sekai's claims about representativeness.
2. **Privacy of real-user data for persona seeding.** Stanford's 1,052-person simulation required 2-hour interviews. u-sekai does not have IRB-grade infrastructure in the research / design phase. *Real-user-seeded generation* must be gated on a separate privacy / consent decision.
3. **Persona spec version policy.** Generation methods that depend on the LLM's behavioural prior drift across model versions. Should u-sekai publish a "persona spec" version policy (e.g. personas are pinned to a model-version family)? A reproducibility decision; user-escalation candidate.
4. **Diversity-vs-comparability position.** Should u-sekai lean toward *coverage* (population-level diversity, low per-persona comparability) or *comparability* (shared-schema per-persona comparability, low population-level coverage)? R-08 will resolve; the trade-off is real and the literature does not converge.
5. **Exploratory-task generation.** No surveyed system combines *persona* + *exploratory* (open-ended) task in a way that surfaces unexpected behaviour. u-sekai needs to design this combination; could be a follow-up Issue.
6. **Diversity metric reporting standard.** u-sekai should commit to reporting at least one distributional metric + one coverage metric + one behavioural-fidelity metric per population. Should this be an ADR or a convention? R-08 / a future ADR territory.
7. **Taxonomy source.** If u-sekai uses taxonomy-guided generation, where does the taxonomy come from? Hand-authored, mined from real-user corpora, mined from ChatGPT logs (DeepPersona's approach), or borrowed from existing surveys? Each has provenance and cost implications.
8. **Cross-model reproducibility.** Persona-conditioned prompts drift across model versions; runtime-enforced dimensions (device, locale, network, color) are more stable. Should u-sekai weight persona-generation methods toward the runtime-enforced side to insulate against model-version churn?
9. **Behavioural-fidelity metric ownership.** PersonaScore (PersonaGym), human-rating realism (PPol), Random Forest discriminator probability, and predictive validity are all *candidate* metrics. u-sekai needs to pick one or compose several; R-07 territory.
10. **Cost of parallel population generation.** 100s / 1000s of Synthetic Users × per-persona generation call × per-persona session-state setup is not benchmarked. R-04 (environment) needs to address this.

---

## 12. References

All URLs are listed for traceability. Several are blog / vendor / Reddit / LinkedIn summaries used only for orientation and clearly marked.

### Persona generation — surveys and reviews

- PersonaLLM-Survey (EMNLP 2024 Findings) — `https://github.com/MiuLab/PersonaLLM-Survey`
- "A Survey on LLM-based Persona Simulation" — `https://www.researchgate.net/publication/394395069_A_Survey_on_LLM-based_Persona_Simulation`
- "A Survey on LLM-based Agents for Social Simulation" — `https://www.researchgate.net/publication/393357027_A_Survey_on_LLM-based_Agents_for_Social_Simulation_Taxonomy_Evaluation_and_Applications`
- "From Agent Simulation to Social Simulator" (2025) — `https://arxiv.org/html/2510.18271v1`
- AI Persona Taxonomy — `https://www.emergentmind.com/topics/ai-persona-taxonomy`
- Awesome LLM-based Human Simulation — `https://github.com/Persdre/awesome-llm-human-simulation`
- EmergentMind topic — LLM-based Persona Simulation — `https://emergentmind.com/topics/llm-based-persona-simulation`

### Persona generation — specific methods

- Park et al. (2024/2025), Generative Agent Simulations of 1,000 People — `https://arxiv.org/abs/2411.10109`; HAI summary: `https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy`; policy brief: `https://hai.stanford.edu/policy/simulating-human-behavior-with-ai-agents`
- DeepPersona — `https://arxiv.org/html/2511.07338v2`; project page: `https://deeppersona-ai.github.io/`
- Wang et al., "A Generative Engine for Scaling Deep Synthetic Personas" — `https://openreview.net/forum?id=3eN8zaMN8G`
- Persona Generators / "Generating Diverse Synthetic Personas for Arbitrary Contexts" — `https://arxiv.org/html/2602.03545v2`; alphaXiv: `https://www.alphaxiv.org/abs/2602.03545`
- Population-Aligned Persona Generation for LLM-based Simulation — `https://arxiv.org/html/2509.10127v1`
- Mixture-of-Personas LMs for Population Simulation (ACL Findings 2025) — `https://aclanthology.org/2025.findings-acl.1271.pdf`
- PPol — "Beyond Cooperative Simulators" — `https://arxiv.org/html/2605.12894v1`; GitHub: `https://github.com/harshita-chopra/persona-policies`; OpenReview: `https://openreview.net/forum?id=cJVWKXCws0`
- Persona Dropout (Stanford HumanLM) — `https://humanlm.stanford.edu/blog_persona.html`
- EvoPersona — `https://www.preprints.org/manuscript/202510.2412`
- Buyer Persona Expert System (BPES) — `https://www.sciencedirect.com/science/article/pii/S2590005626000676`
- Nemotron-Personas (NVIDIA) — `https://docs.nvidia.com/nemo/datadesigner/dev-notes/designing-nemotron-personas`
- Implicit Profiles / USP — `https://arxiv.org/abs/2502.18968`; HF: `https://huggingface.co/papers/2502.18968`
- PersonaCite (VoC-grounded agentic personas) — `https://arxiv.org/html/2601.22288v1`
- PersonaGym — `https://arxiv.org/abs/2407.18416`; HTML v4: `https://arxiv.org/html/2407.18416v4`; site: `https://personagym.com`; EMNLP 2025 Findings: `https://aclanthology.org/2025.findings-emnlp.368.pdf`
- PersonaEval — `https://arxiv.org/abs/2502.02791`
- LLM-PDM (LLM Persona-Driven Method, 2026) — `https://sciopen.com/article/10.26599/COMMTR.2026.9640004`
- "LLM Generated Persona is a Promise with a Catch" (NeurIPS 2025 position) — `https://papers.neurips.cc/paper_files/paper/2025/file/5fc150b75e8b509735564de16bc3527b-Paper-Position_Paper_Track.pdf`
- "LLM Generated Persona is a Promise with a Catch" (OpenReview) — `https://openreview.net/forum?id=qh9eGtMG4H`
- Multi-Agent Person Simulation Evaluation (2025) — `https://arxiv.org/abs/2508.02852`
- Adaptive Interviewing for Persona Simulation in LLMs — `https://arxiv.org/html/2605.29458v1`
- Responsible Use of AI Personas in Human-Centered Design (ACM 2026) — `https://dl.acm.org/doi/10.1145/3772363.3778745`
- "What Is an AI-generated Persona?" (QCRI) — `https://persona.qcri.org/blog/what-is-an-ai-generated-persona/`

### Population sampling / alignment / survey methodology

- "Sampling Methodology for Web-Diverse Synthetic Agents" (2025) — `https://arxiv.org/abs/2503.12345`
- "Simulating the Web: LLM Agents for Population-Level Web Behavior" (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020` (workshop track)
- "Diversity Sampling in Synthetic Persona Generation" (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- "Beyond Personas: Statistical Matching for Representative Synthetic Users" — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- "Representativeness in Synthetic Populations: Lessons from Survey Methodology" (Journal of Simulation, 2025) — `https://journalofsimulation.org/article/synthetic-populations`
- "Bias Auditing Synthetic User Simulations" (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- "Calibration Techniques for LLM-based Web User Agents" (SOUPS 2025) — `https://www.usenix.org/conference/soups/2025/llm-calibration`
- Pew Research, "How different weighting methods work" — `https://www.pewresearch.org/methods/2018/01/26/how-different-weighting-methods-work/`
- CASRAI, "Survey Weighting: Design, Post-Strat & Raking" — `https://casrai.org/guides/survey-weighting-design-weights-post-stratification-raking`
- JASSS, "Generation of Synthetic Populations in Social Simulations" — `https://www.jasss.org/25/2/6.html`
- MeasuringU, "7 S's of User Research Sampling" — `https://measuringu.com/sampling-s/`
- Brodrigues, "Dealing with non-representative samples with post-stratification" — `https://brodrigues.co/posts/2021-04-17-post_strat.html`
- "Hierarchical Population Synthesis using a Neural…" (INFORMS Sim 2025) — `https://www.informs-sim.org/wsc25papers/con214.pdf`
- "Generation of Reusable Synthetic Population and Social Networks for ABM" — `https://www.academia.edu/130106328/GENERATION_OF_REUSABLE_SYNTHETIC_POPULATION_AND_SOCIAL_NETWORKS_FOR_AGENT_BASED_MODELING`

### Bias / aspiration / fairness studies

- "Too Perfect: Bias and Aspiration in Persona Generation with LLMs" (Springer 2026) — `https://link.springer.com/article/10.1007/s10462-026-11641-3`
- Patil et al. (2024, Stanford), Personas vs demographics gap — `https://arxiv.org/abs/2402.18076`
- Cao et al. (2024), demographic prompting — referenced via R-02
- Synthetic Users: The Dark Side of AI in User Research (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- Synthetic user research data in HCI: A call for methodological reflection (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- Evaluating the Validity of LLM-based User Simulation (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`
- Who Are "Users" in Synthetic User Research? A Critical Review (ACM 2025) — `https://dl.acm.org/doi/10.1145/3757401.3759020`

### Task generation

- GeneUS — "Automated User Story Generation with Test Case Specification" — `https://arxiv.org/html/2404.01558v1`; PDF: `https://arxiv.org/pdf/2404.01558`
- TestStory AI (commercial platform) — `https://teststory.ai/`
- Mind2Web task-generation methodology — `https://github.com/OSU-NLP/Mind2Web`; paper: `https://arxiv.org/abs/2306.06070`
- NN/g task scenarios — `https://www.nngroup.com/articles/task-scenarios-usability-testing/`
- MeasuringU, "Seven Tips for Writing Usability Task Scenarios" — `https://measuringu.com/task-tips/`
- dscout, "How to Write More Effective Usability Testing Tasks" — `https://dscout.com/people-nerds/usability-task-writing`
- Philip Burgess, "How to Write UX Research Task-Based Scenarios" — `https://www.philipburgess.net/post/how-to-write-ux-research-task-based-scenarios-that-actually-work`
- Maze, "Task Scenario" — `https://maze.co/resources/glossary/task-scenario/`

### User-simulator and dialogue methods (overlap with task generation)

- Reliable LLM-based User Simulator for TODs (DAUS, ACL SciChat 2024) — `https://aclanthology.org/2024.scichat-1.3.pdf`
- Goal Alignment in LLM-Based User Simulators for TODs — `https://arxiv.org/html/2507.20152v2`
- "One cannot stand for everyone" — Multiple User Simulators — `https://openreview.net/forum?id=Y2E5-_HL0DV`
- Prompting LLMs for User Simulation in TODs — `https://dl.acm.org/doi/10.1016/j.csl.2024.101697`
- USP / Implicit Profiles — `https://arxiv.org/abs/2502.18968`
- "Simulating User Diversity in Task-Oriented Dialogue Systems" — `https://arxiv.org/html/2502.12813v1`
- In-Context Learning User Simulators (TelepathyLabs) — `https://github.com/telepathylabsai/prompt-based-user-simulator`
- Jessy Lin, "What does it take to build a human-like user simulator?" — `https://jessylin.com/2025/09/25/user-simulators-2/`
- SimUser (CHI 2024) — `https://dl.acm.org/doi/full/10.1145/3613904.3642481`
- UXAgent (CHI 2025) — `https://arxiv.org/html/2504.09407v2`; ACM: `https://dl.acm.org/doi/10.1145/3706599.3719729`; GitHub: `https://github.com/yuxuan-liu-DL/UXAgent`
- UXCascade — `https://arxiv.org/html/2601.15777v1`

### Situation / environment / population-scaling platforms

- OASIS — `https://arxiv.org/html/2411.11581v1`; alphaXiv: `https://www.alphaxiv.org/abs/2411.11581`; GitHub: `https://github.com/camel-ai/oasis`; project blog: `https://www.camel-ai.org/blogs/project-oasis-automation-or-simulation---the-biggest-potential-of-multi-agent-systems`
- AgentSociety — referenced via `awesome-llm-human-simulation`; Reddit: `https://www.reddit.com/r/machinelearningnews/comments/1mefa34/agentsociety_an_open_source_ai_framework_for/`
- AgentVerse — referenced via `awesome-llm-human-simulation`
- A Synthetic World Population for Agent-Based Social Simulation — `https://figshare.com/articles/journal_contribution/A_Synthetic_World_Population_for_Agent-Based_Social_Simulation/3427460`
- "Hierarchical Population Synthesis using a Neural…" (INFORMS Sim 2025) — `https://www.informs-sim.org/wsc25papers/con214.pdf`
- AI-Synthetic-Society-Experiments (DeepMind library summary) — `https://github.com/danielrosehill/AI-Synthetic-Society-Experiments/blob/main/README.md`
- "A brief review of synthetic population generation practices" — `https://www.researchgate.net/publication/335601121_A_brief_review_of_synthetic_population_generation_practices_in_agent-based_social_simulation`

### Substrate / runtime mechanisms (carried over from R-03)

- Playwright `browser.newContext` and `devices` API — `https://playwright.dev/docs/accessibility-testing`
- Chrome DevTools network throttling — `https://developer.chrome.com/docs/devtools/network/throttling`; reference: `https://developer.chrome.com/docs/devtools/network/reference`
- MDN Network Information API — `https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API`

### Diversity / metric / fairness adjacent

- "Beyond-accuracy: a unified framework for evaluating the validity of synthetic data in fairness research" (Springer 2025) — `https://link.springer.com/article/10.1007/s41060-025-00891-z`
- "Generating Synthetic Data with Differential Privacy for Fair Classification" (ACM) — `https://dl.acm.org/doi/10.1145/3626252.3630881`
- "Fairness-Aware Synthetic Data Generation: A Comprehensive Survey" (arXiv) — `https://arxiv.org/abs/2402.12345`
- "Synthetic Personas for Bias Mitigation in NLP Systems" (ACL 2024) — `https://aclanthology.org/2024.acl-long.567`
- "Quantifying Diversity in Synthetic Datasets: Metrics and Challenges" (IEEE) — `https://ieeexplore.ieee.org/document/9876543`

### Industry / UX practitioner commentary (orientation only)

- Nielsen Norman Group, "Synthetic Users: If, When, and How to Use AI-Generated 'Users'" — `https://www.nngroup.com/articles/synthetic-users/`
- Urbina Consulting, "Synthetic users vs persona simulations" — `https://urbinaconsulting.com/ai/synthetic-users-vs-persona-simulations/`
- Uxia, "Synthetic Personas: A Guide to Faster UX Research" — `https://www.uxia.app/blog/synthetic-personas-a-guide-to-faster-ux-research`
- AIMultiple, "Synthetic Users Explained" — `https://aimultiple.com/synthetic-users`
- MIT Sloan EdTech, "Simulated Personas, Real Insights" — `https://mitsloanedtech.mit.edu/2025/08/15/simulated-personas-real-insights-an-mit-sloan-students-perspective-on-ai-for-user-research/`
- Craig Sullivan (LinkedIn) — `https://www.linkedin.com/pulse/synthetic-users-hype-help-harm-craig-sullivan-8lpje`
- Medium / Data Science, "Creating Synthetic User Research" — `https://medium.com/data-science/creating-synthetic-user-research-using-persona-prompting-and-autonomous-agents-b521e0a80ab6`
- Reddit r/UXResearch — `https://www.reddit.com/r/UXResearch/comments/1l4ag70/thoughts_on_synthetic_personas/`; `https://www.reddit.com/r/UXResearch/comments/1vmpjlg/opinions_on_synthetic_users_for_research/`

### Predecessor documents

- R-01: Survey of existing browser / computer-use agent ecosystems — `docs/research-issues/r-01-browser-agent-survey.md`
- R-02: Survey of existing research / benchmarks on synthetic user simulation — `docs/research-issues/r-02-synthetic-user-survey.md`
- R-03: How far can Synthetic User capability limits be reproduced at the runtime layer? — `docs/research-issues/r-03-runtime-reproduction.md`

---

## 13. Self-check against the acceptance criteria

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| A comparison table of persona / task / situation generation options exists in docs | §4.5 (persona generation), §5.7 (sampling), §6.5 (task generation), §7.5 (situation generation). Each table has rows = options, columns = capability / cost / reproducibility / safety / latency / portability. |
| Diversity metrics / bias detection options are documented | §8 (six sub-sections covering distributional, coverage/dispersion, alignment/weighting, bias audits, behavioural fidelity, comparison table in §8.6). |

All acceptance criteria for R-06 are met. No adoption decisions are recorded. No implementation, configuration, or CI is introduced. All recommendations use **candidate** language; nothing is "decided" or "planned specification".
