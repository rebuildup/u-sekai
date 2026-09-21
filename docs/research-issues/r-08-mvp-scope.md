# R-08: MVP scope definition

> Draft research artifact for issue **R-08** (definition of the smallest u-sekai slice that produces a measurable result).
> This is an investigation, not an adoption decision. Nothing in this document is "decided" or "adopted". The role of R-08 is to assemble a **candidate** MVP scope from the R-01 through R-07 results so that a follow-up Issue can decide and the implementation phase can begin.
>
> This document re-uses — and is constrained by — the candidate sets already produced by R-01 (browser / computer-use agent ecosystem), R-02 (synthetic-user research), R-03 (runtime reproduction of individual differences), R-04 (isolated execution environments), R-05 (subjective evaluation), R-06 (persona / task / situation generation), and R-07 (calibration / validation). It does not redo those surveys.

---

## 1. Question (verbatim from the draft)

> Given R-01 to R-07, define what the **first MVP** of u-sekai must achieve — and what it must explicitly defer.
> Motivation: aiming for "everything" at implementation time causes collapse. An explicit MVP creates a feedback loop from investigation → design → implementation → evaluation.

**Acceptance criteria** (from `docs/research-issues/README.md`):

1. MVP capability range / target range / evaluation metric / acceptance criteria are documented.
2. Explicit deferral list (what is NOT in MVP and why).
3. MVP success criteria from the perspective of "can we measure u-sekai's value?"

**Initial non-scope** (from the draft): final architecture / language / framework decision. Those pre-requisites are handled by separate Issues.

**Dependencies** (from the draft): R-01 through R-07 — *all* of them. This document is the synthesis layer above them.

---

## 2. Investigation summary

### 2.1 What was covered

- **R-01** — the browser / computer-use agent ecosystem: L1 substrate (Playwright / Chromium), L2 browser-infrastructure (Browserbase, Steel, Hyperbrowser), L3 harness (`browser-use`, `stagehand`, `skyvern`, OpenHands), L4 orchestration (LangGraph, AutoGen, CrewAI), L5 first-party computer-use model APIs (Claude Computer Use, OpenAI CUA, Gemini Computer Use), L6 SaaS (Operator, MultiOn/AGI-0, Adept legacy), L7 evaluation environments (Mind2Web, WebArena, WebVoyager, GAIA, OSWorld, AppWorld).
- **R-02** — the synthetic-user research literature: synthetic-user HCI methodology (Bauer & Senoner, Validation Methods, "When Synthetic Users Fail"), persona simulation (PersonaLLM-Survey, PersonaGym, PersonaEval, InCharacter, PPol), user simulation for dialogue / recommendation / customer-facing systems (DAUS, Goal Alignment, RecAgent, LPS, SalesBot), web-agent benchmarks adjacent to the substrate, computer-use benchmarks (OSWorld).
- **R-03** — the per-dimension inventory of individual differences and the runtime / prompt / give-up boundary. R-03's candidate default persona dimensions for v1 (R-03 §8.2) directly drive the MVP's persona capability range.
- **R-04** — execution environments (Firecracker microVMs, full VMs, Docker, gVisor; E2B / Daytona / Modal / Fly.io Machines; Browserbase / Steel / Hyperbrowser; per-context / per-process / per-container browser isolation; OSWorld's VirtualBox / KVM substrate as desktop future).
- **R-05** — subjective evaluation methods (SUS, SEQ, NASA-TLX, Likert, semantic differential, free-form reflection, behavioural log, LLM-as-judge). R-05's candidate layered primary channel (per-task SEQ + per-session SUS) and behavioural-log secondary channel drive the MVP's evaluation metric range.
- **R-06** — persona generation (rule-based / LLM-prompted / LLM-with-seed / constrained-decoding), population sampling (stratified / taxonomy-guided / alignment-driven / evolutionary / mixture-of-personas), task generation (seed-and-expand / GeneUS / TOD / exploratory-task injection), situation generation (pre-seeded session state / runtime-injected environment / time-activity injection / contextual prompt), and diversity / bias-detection metrics (KS / Wasserstein / JS / Cramér's V, Monte Carlo coverage / convex hull / pairwise distance, raking / IPF, "Too Perfect" audit, PersonaScore).
- **R-07** — calibration / validation: distributional / coverage / alignment / predictive-validity / process / bias / safety metric families; the aggregate-vs-individual / subgroup trichotomy (Chen et al. 2026); the four-axis "what Synthetic cannot validate" boundary (epistemic / behavioural / methodological / product); the six-element "minimum viable calibration report"; the seven-step validation workflow.
- **Adjacent MVP anchors** — UXAgent's "three-channel" pattern (post-study SUS + custom Likert + interview interface + memory traces + session replay, per arXiv 2504.09407 v3 and its predecessor at 2502.12561); WebArena's "realistic self-hostable web environment" + 812 long-horizon tasks + programmatic checkers model (NeurIPS 2024); PersonaGym's five-task + PersonaScore + 150-option dynamic environment (arXiv 2407.18416); OSWorld's snapshot-driven reproducibility + execution-based evaluation pattern.

### 2.2 What was skipped and why

- **Final adoption of any specific stack** (language, framework, browser engine, L5 model API, isolation substrate, persona library, evaluation instrument). The role of R-08 is to define the scope; the stack is downstream. Per `CLAUDE.md` §3 and §5, those decisions belong to follow-up Issues.
- **Privacy / consent mechanics for collecting real-user data** for the MVP. R-06 §10 / R-07 §8 list this as a separate open question; u-sekai's research / design phase does not have IRB-grade infrastructure, so MVP-scope calibration uses synthetic and rule-based calibration, not real-user-seeded calibration.
- **Mobile, desktop, CLI, API substrates**. R-04 §5 / R-08 §4.2 defer these to v2+.
- **Multimodal persona conditioning** (voice, video, gesture, physiological). R-03 §7 lists this as "give up" for the Web MVP because the public browser-agent substrate does not yet support voice / video persona conditioning as a first-class signal.
- **Non-English sources.** The R-08 draft permits but does not require them; the predecessor surveys are all English-only and no Japanese-only paper surfaced as essential for R-08's synthesis question.
- **Quantitative cost / latency benchmarks at the MVP candidate scale** (e.g. 100s or 1000s of parallel personas on a specific substrate). The candidate sets in R-04 are the input; per-Issue quantitative benchmarks are deferred until a candidate substrate is picked.
- **A specific MVP delivery date / sprint plan**. R-08 defines scope; sprint planning is downstream per `CLAUDE.md` §6.

### 2.3 Methodology notes

- The R-08 question is a **synthesis / scope-setting** question, not a fresh survey question. The primary input is the predecessor documents; supplementary WebSearch / WebFetch was used only to confirm that adjacent projects (UXAgent, WebArena, PersonaGym, OSWorld) had published "initial release" shapes that inform the candidate MVP.
- The candidate MVP is constructed by intersecting the **highest-confidence** and **lowest-cost** cells across all three R-08 axes: (a) capability range (which persona dimensions to support — from R-03 §8.2), (b) target range (which Web apps to drive against — from R-01 §6.6 L7 candidates and R-04 §5.1 anti-bot / reproducibility trade-off), and (c) evaluation metric range (which channels to record — from R-05 §5 and R-07 §7.1).
- "Candidate" language is used throughout. Per `CLAUDE.md` §3, no technology is recorded as "decided" or "planned specification". The MVP scope is the *narrowest* scope that lets u-sekai claim a measurable result; broader scope items appear in the deferral list with explicit rationale.
- The deferral list uses the "what the MVP *cannot* do" frame rather than the "what is low-priority" frame, because the R-08 question is about MVP scope, not roadmap prioritisation.

---

## 3. Conceptual decomposition

### 3.1 What "MVP" means for a research infrastructure (not a product)

A research-infrastructure MVP is materially different from a product MVP. u-sekai is not shipping a SaaS; it is shipping a reproducible research substrate. The MVP must therefore be evaluated against:

1. **Reproducibility** — given the same persona / task / seed, does the substrate produce the same trace?
2. **Differentiability** — does the substrate's output differ across personas in the dimension the persona is supposed to vary?
3. **Falsifiability** — does the substrate produce *some* signal that can be checked against an external reference (real-user behaviour on the same page; an execution-based checker; a documented heuristic)?
4. **Cost shape** — does the substrate run at a budget that fits a research lab, not a hyperscaler?
5. **Boundary** — does the substrate make explicit what it cannot validate (R-07 §5)?

This collapses R-07's candidate publication standard (R-07 §7.1) into the MVP's design constraints.

### 3.2 The MVP's three axes

The candidate MVP is defined along three axes that match R-08's three acceptance criteria:

| Axis | Question | What the MVP must answer |
| --- | --- | --- |
| **A. Capability range** | Which persona dimensions does u-sekai drive? | "Can u-sekai produce behavioural traces that differ across personas along dimension X?" |
| **B. Target range** | Which Web targets does u-sekai drive against? | "Can u-sekai run reproducible sessions against target T?" |
| **C. Evaluation metric range** | What signals does u-sekai emit per session? | "Can a downstream consumer tell whether a trace is interesting, where it is interesting, and why?" |

A fourth axis — **isolation substrate** — is implicit in B (the Web target choice drives the isolation choice per R-04) and is constrained by R-04's open question 1 (live sites vs self-hosted replicas).

### 3.3 What "measuring u-sekai's value" means

Per the README and the predecessor documents, u-sekai's value is:

- **Discovering unexpected operation paths, mistakes, friction, perception gaps, subjective UX on Web apps** — none of which existing E2E suites or static usability tests cover.
- **Doing so across a diverse Synthetic User population** — the persona dimension is the value.
- **Doing so with explicit validity boundaries** — so findings can be consumed by downstream researchers and product teams without being dismissed as "synthetic" (R-07 §5.5).

The MVP must therefore produce a *single, end-to-end, reproducible* Synthetic User session per persona-task pair, with the persona dimension visibly enforced, the trace recorded, and the boundary stated. Whether the *value* is delivered (a *novel* finding, a *contradiction* of a real-user assumption, a *measurement* of a previously unmeasurable UX phenomenon) is what the MVP's success criteria test.

### 3.4 What "smallest slice that produces a measurable u-sekai result" means

A measurable u-sekai result has three properties:

1. **It is a *result*, not a *capability*.** "u-sekai can run a browser session with persona X" is a capability statement, not a result. "u-sekai produced trace T with persona X on target Y; trace T shows friction pattern F that does not appear with persona Z" is a result.
2. **The result is reproducible.** The same persona / target / seed reproduces the same trace, modulo documented model-version drift.
3. **The result is comparable across personas.** Two persona specifications that differ on one declared dimension produce traces that differ along that dimension (a *differentiability* test) — and traces that do not differ on dimensions that are nominally equal (a *comparability* test).

The smallest slice that meets these three properties is one **persona dimension** (the high-confidence one), one **Web target category** (the reproducible one), and one **evaluation channel** (the comparable one) — run end-to-end on a small N (e.g. ≤ 10 personas, ≤ 5 tasks, ≥ 3 sessions per persona-task pair) with the full substrate (isolation + harness + persona + task + trace + calibration report).

---

## 4. The candidate MVP

This section is the core of R-08. Everything here is **candidate**. The role of R-08 is to assemble a coherent candidate slice; a follow-up Issue picks.

### 4.1 MVP capability range — which persona dimensions

Inheriting R-03's inventory (R-03 §8.2, "candidate default persona dimensions for v1") and R-06's candidate default generation strategy (R-06 §10.1), the candidate MVP capability range is the **intersection of R-03's high-confidence runtime-reproduce dimensions and R-06's low-overhead hybrid generator**.

| Persona dimension | MVP status | Source | Rationale |
| --- | --- | --- | --- |
| **Device / viewport** (mobile / desktop / tablet) | **In MVP** | R-03 §4.6, R-03 §8.2 #1 | Clean runtime reproduction (Playwright `browser.newContext({ ...devices[...] })`); high information value (responsive-design bugs, mobile-only flows). |
| **Locale / timezone** (en-US, ja-JP, ar-SA for RTL) | **In MVP** | R-03 §4.8, R-03 §8.2 #2 | Clean runtime reproduction (`browser.newContext({ locale, timezoneId })`); high information value (i18n / RTL bugs). |
| **Network** (broadband, slow-3G, offline) | **In MVP** | R-03 §4.7, R-03 §8.2 #3 | Clean runtime reproduction (CDP / Playwright throttle); high information value (performance UX). |
| **Color vision** (none / deuteranopia / protanopia / tritanopia / achromatopsia) | **In MVP** | R-03 §4.4, R-03 §8.2 #4 | Mathematically exact color-matrix filter; high information value (accessibility UX). |
| **Visual-acuity mode** (sighted / accessibility-tree-only) | **In MVP** | R-03 §4.3, R-03 §8.2 #5 | Accessibility-tree-only mode is a substrate-supported toggle; high information value (screen-reader UX, ARIA fidelity). |
| **Working-memory capacity** (full / truncated) | **In MVP (optional)** | R-03 §4.9, R-03 §8.2 #6 | Substrate-supported observation truncation; medium-confidence runtime reproduction; medium information value. |
| Motor | **Deferred** | R-03 §4.1, R-03 §8.3 | Action-space mutation is a *proxy*, not a reproduction; the calibration signal is weak (R-07 §5.2). |
| Cognitive | **Deferred** | R-03 §4.2, R-03 §8.3 | The underlying cognitive process is prompt-only; runtime can enforce observation truncation but the persona collapses diversity (R-02 §5.2). |
| Long-term memory | **Deferred** | R-03 §4.10 | The Generative-Agents / MemGPT-style memory architecture is well-documented but adds a substantial harness layer; the MVP does not need long-running persona continuity to demonstrate persona-conditioned behavioural difference. |
| Distraction / interruption / fatigue | **Deferred** | R-03 §4.13, R-03 §8.3 | Injecting competing events is a proxy, not a reproduction; the *condition* itself is largely prompt-only and partly give-up (R-03 §4.13). |
| Mood | **Deferred** | R-03 §4.14 | Mood is prompt-only and is itself a calibration question (R-07 §5.1). |
| Linguistic style / register / vocabulary | **Deferred** | R-03 §4.11 | Style is LLM-side, not substrate-side; it is more a R-05 concern than a R-03 concern. |
| Server-side personalisation | **Deferred (give-up)** | R-03 §4.12, R-03 §8.3 | u-sekai does not control back-end personalisation. The MVP boundary statement explicitly disclaims this. |

**Candidate default persona-generation strategy for the MVP.** From R-06 §10.1:

- **Hybrid persona generator** = taxonomy-guided base + LLM expansion + constrained-decoding for hard constraints.
- **Stratified sampler** with strata on the MVP dimensions (device × locale × network × color-vision × visual-acuity × working-memory), disproportionate-stratify to oversample underrepresented cells.
- **Rule-based fallback for accessibility axes** (color vision, visual acuity, working memory) — the schema is small and the LLM does not need to be involved.
- **Coverage diagnostics** = at least one distributional metric (Wasserstein) + one coverage metric (Monte Carlo coverage) + one behavioural-fidelity metric (PersonaScore from PersonaGym) per population. From R-06 §10.1 #4 and R-07 §7.1.

### 4.2 MVP target range — which Web targets

R-01 §5 and R-04 §5.1 surface the central trade-off:

- **Live sites** (Mind2Web / WebVoyager style): realistic but anti-bot-protected, drift over time, no reproducibility, no execution-based checkers.
- **Self-hosted replicas** (WebArena / WebArena Verified / VisualWebArena style): reproducible, programmatic checkers, smaller ecosystem, less realism.

R-04 §7 open question 1 explicitly blocks on this: "Browserbase / Hyperbrowser / Steel lean into *real anti-bot anti-detection*, which only matters for *live* sites. If R-08 chooses live sites, the candidate set shifts toward anti-bot-strong BaaS; if it chooses replicas, the candidate set shifts toward self-hosted browser pool over a WebArena-style substrate. **This decision blocks the isolation choice for the MVP.**"

The MVP's target-range candidate follows R-04 §5.1 gap 3 ("Live-site safety: a Synthetic User that is free to click anything on a *live* third-party site is a real safety concern. Live sites should not be the initial target for an unsupervised exploratory agent — R-08 should default to self-hosted replicas for the MVP").

| Target category | MVP status | Rationale | Source |
| --- | --- | --- | --- |
| **Self-hosted reproducible web apps** (e.g. WebArena's shopping / forum / CMS / software-dev sites, or a similar self-hosted benchmark substrate) | **In MVP (primary)** | Reproducible; execution-based checkers; no ToS risk; isolation choice aligns with R-04's per-persona containerized browser (Selenium Grid / Steel self-host) or per-persona microVM (E2B / Fly.io); smallest cost shape for a research lab. | R-01 §6.6, R-04 §4.1, R-04 §5.1 |
| **Self-hosted multi-page web apps with documented state checkers** | **In MVP (secondary)** | Same rationale; covers "form-fill / multi-step / state-transition" tasks that the shopping-app single-flow tasks do not exercise. | R-04 §4.5 (OSWorld pattern, adapted for web) |
| **Canned task corpora** drawn from published benchmarks (Mind2Web, WebVoyager, UXAgent case studies) | **In MVP (anchor)** | Seed-and-expand task generation (R-06 §6.1) requires human-authored anchor tasks for cross-version comparison; canned corpora supply the anchor. | R-06 §6.1, R-06 §10.2 |
| Live anti-bot-protected sites | **Deferred** | ToS risk; no reproducibility; anti-bot stance is itself an open question (R-04 §7 #5). The MVP boundary statement explicitly disclaims live-site coverage. | R-04 §5.1 gap 3, R-07 §5.4 |
| Mobile device farms (BrowserStack / Sauce Labs / AWS Device Farm) | **Deferred** | Mobile is explicitly out of MVP scope (R-04 §6.6). | R-04 §6.6 |
| Desktop OS substrates (OSWorld VirtualBox / KVM) | **Deferred** | Desktop is explicitly out of MVP scope; OSWorld's substrate is a candidate future-extension reference (R-04 §4.5, R-04 §6.5). | R-04 §6.6 |

**Candidate target scope (numeric, candidate).** The MVP runs against a small, fixed set of self-hosted Web targets — for example, 3–5 apps × 5–10 task scenarios × ≤ 10 personas × ≥ 3 sessions per persona-task pair. The numeric ranges are illustrative; the follow-up Issue decides the actual N.

### 4.3 MVP evaluation metric range — which signals per session

Inheriting R-05 §5 (candidate set) and R-07 §7.1 (candidate minimum viable calibration report).

| Channel | MVP status | Rationale | Source |
| --- | --- | --- | --- |
| **Behavioural log** (clicks, page transitions, form inputs, error states, retries, time-on-task, dead-ends) | **In MVP (primary)** | Substrate-supported; deterministic; comparable across personas; the strongest reproducibility signal (R-05 §2.4, R-07 §5.2). | R-05 §5.2, R-07 §7.1 |
| **Per-task SEQ** (Single Ease Question, 7-point) | **In MVP (primary subjective)** | Per-task timing; standard instrument; supports A/B per-task comparison; cheap to add (R-05 §5.1). | R-05 §5.1, R-05 §4 |
| **Per-session SUS** (System Usability Scale, 10 items) | **In MVP (primary subjective)** | Post-session timing; standard instrument; supports cross-session aggregation; communicable to HCI / UX practitioners (R-05 §5.1). | R-05 §5.1, R-05 §4 |
| **Behavioural-trace taxonomy labels** (Act·onomy / MAST-style categorical labels per span, applied post-session by the same LLM in a "reflect-on-your-trace" prompt) | **In MVP (secondary, optional)** | Adds comparability across runs and surfaces failure modes that aggregate metrics miss (R-05 §2.4, R-05 §5.2). The optionality reflects R-05 §5.5's deferred-LLM-as-judge caveat. | R-05 §5.2 |
| **Per-task NASA-TLX or custom Likert battery** | **In MVP (optional, only if R-08/follow-up decides)** | Multi-dimensional signal; per-task cost is non-trivial at the MVP batch size; included only if the MVP budget allows. | R-05 §4 |
| **Post-session free-form reflection** (open-ended) | **Deferred to v1.1 / v2** | Highest ecological validity but lowest comparability; cost / confabulation risk is too high for v1 (R-05 §2.2, R-05 §5.6). | R-05 §5.6 |
| **LLM-as-judge of session usability** (separate model) | **Deferred** | Shared-distribution risk (R-07 §4.8, R-02 §3.5); MV-as-judge may be revisited in v1.1 paired with at least one human-baseline calibration. | R-07 §4.8 |
| **Researcher-as-interviewer / per-session Q&A** | **Deferred** | Requires interactive runtime decisions that R-03 / R-04 do not pre-specify for MVP (R-05 §5.6). | R-05 §5.6 |
| **Multimodal subjective capture** (facial affect, voice prosody, physiological) | **Deferred (give-up)** | Requires extension beyond Web target (R-05 §5.6). | R-05 §5.6 |

**Candidate minimum viable calibration report per MVP run** (from R-07 §7.1, adapted to MVP scope):

1. **Distributional** — at least one per-variable metric (Wasserstein for continuous; Cramér's V for categorical). **MVP simplification**: because the MVP persona dimensions are small and known, the distributional report reduces to a per-axis marginal table rather than a full Wasserstein fit.
2. **Coverage** — at least one population-span metric (Monte Carlo coverage over the discretized attribute space; pairwise distance). **MVP simplification**: with ≤ 10 personas, the coverage report is a direct enumeration of which cells are filled.
3. **Predictive validity** — at least one held-out real-user stimulus set with reported accuracy vs a non-LLM baseline. **MVP simplification**: this is the part of the MVP that is *deferred to v1.1* (R-07 §7.3 "Privacy-grade real-user validation infrastructure. Out of scope for v1; gated on a separate privacy / consent decision"); the MVP's MVP-calibration report documents the gap explicitly.
4. **Process / transparency** — at least one persona-consistency check over a horizon (PersonaGym-style task #4 or equivalent). **MVP simplification**: the SEQ / SUS instruments are themselves a process signal (a Synthetic User that gives inconsistent SEQ scores across two runs of the same persona-task pair is a process-fidelity failure).
5. **Bias / safety** — at least three probes: sycophancy, format stability (option-order reversal), demographic-fidelity split. **MVP scope**: sycophancy + format-stability probes are in MVP; demographic-fidelity split requires R-06's stratified sampler to be operational, which is a v1.1 candidate (MVP runs are small enough that a per-cell demographic split may be infeasible).
6. **Boundary statement** — an explicit statement of which use cases the finding is licensed for (per R-07 §5.4). **MVP scope**: every MVP run report ships with the boundary statement.

### 4.4 MVP isolation substrate — implicit constraint

R-04 §7 open question 1 ("Live sites vs self-hosted replicas for the initial MVP") blocks the isolation choice; the candidate MVP target range in §4.2 *answers* that open question by picking self-hosted replicas, which constrains the isolation choice to:

| Isolation substrate | MVP status | Source |
| --- | --- | --- |
| **Per-persona containerized browser pool** (Selenium Grid / Steel self-host over WebArena-style replicas) | **Candidate primary** | R-04 §4.4, R-04 §6.4 |
| **Per-persona Firecracker microVM** (E2B / Fly.io Machines with Sprites) | **Candidate secondary** | R-04 §4.1, R-04 §6.2 |
| Docker / runc alone for any sandbox that touches untrusted third-party content | **Not in MVP** (R-04 §6.6 confirms this is rejected) | R-04 §6.6 |
| WASM-only sandboxes as the *primary* web substrate | **Not in MVP** (R-04 §6.6) | R-04 §6.6 |
| Hyperscaler confidential compute (Nitro Enclaves, Confidential VMs) as a primary substrate | **Not in MVP** (R-04 §6.6; inverts threat model) | R-04 §6.6 |
| Full hardware VM (QEMU / KVM / VirtualBox, OSWorld substrate) | **Deferred to v2+ desktop extension** | R-04 §6.5 |

### 4.5 MVP orchestration / harness shape — implicit constraint

Inheriting R-01's layer model (R-01 §3) and the candidate sets in R-01 §6:

| Layer | MVP candidate | Source |
| --- | --- | --- |
| **L1 substrate** | Playwright / Chromium (R-01 §6.1) | R-01 §6.1 |
| **L2 isolation** | Per-persona containerized browser over self-hosted replicas (§4.4) | R-04 §6.3, §6.4 |
| **L3 harness** | `stagehand`-style act / extract / observe / agent primitives are the design pattern; specific implementation not adopted. OSS candidate: `stagehand` itself; `browser-use` is an alternative. | R-01 §4.1, R-01 §6.3 |
| **L4 orchestration** | LangGraph-style state / memory / control-flow primitives are the design pattern; specific implementation not adopted. | R-01 §4.4, R-01 §6.4 |
| **L5 model API** | Model-agnostic from day one (R-01 §7 #1). MVP's first release picks *one* candidate (e.g. Claude Computer Use OR OpenAI CUA OR a non-vision DOM-only path) for the initial implementation, with the orchestration layer designed for pluggability. | R-01 §4.3, R-01 §6.5 |
| **L6 SaaS** | Out of scope (u-sekai is not a SaaS). | R-01 §4.5 |
| **L7 evaluation environment** | Self-hosted web-app replicas as primary substrate; canned task corpora from Mind2Web / WebVoyager / UXAgent as anchors. | R-01 §4.6, R-04 §4.5 |

### 4.6 MVP task-generation shape — implicit constraint

Inheriting R-06 §6 (task generation) and R-06 §10.2 (candidate default task generation strategy):

- **Primary mechanism**: exploratory-task injection (R-06 §6.4, R-06 §10.2 #1). The persona is given an open-ended motive, and the harness explores. This is the *only* mechanism in the MVP that surfaces u-sekai's distinguishing behaviour (unexpected paths).
- **Anchor mechanism**: seed-and-expand (R-06 §6.1, R-06 §10.2 #2). A small set of human-authored seed tasks ensures cross-version reproducibility.
- **Deferred**: GeneUS / RaT (RE-doc-driven, R-06 §6.2) — out of scope because u-sekai typically does not have an RE doc for the apps it evaluates. TOD-schema (R-06 §6.3) — out of scope for MVP because it is goal-confined rather than exploratory.

### 4.7 MVP definition summary table

| MVP axis | In MVP | Deferred | Notes |
| --- | --- | --- | --- |
| **Persona dimensions** | device / viewport, locale / timezone, network, color vision, visual-acuity mode, (optional) working memory | motor, cognitive, long-term memory, distraction, mood, style, server-side personalisation (give-up) | Per §4.1 and R-03 §8.2. |
| **Web target category** | self-hosted reproducible web apps + canned task corpora | live anti-bot sites, mobile device farms, desktop OS substrates | Per §4.2 and R-04 §5.1. |
| **Subjective channel** | per-task SEQ + per-session SUS | free-form reflection, LLM-as-judge (v1.1), researcher-as-interviewer, multimodal | Per §4.3 and R-05 §5. |
| **Behavioural channel** | behavioural log + optional taxonomy labels (Act·onomy / MAST-style) | none in MVP scope | Per §4.3 and R-05 §5.2. |
| **Calibration report** | distributional + coverage + process + (sycophancy / format-stability) bias probe + boundary statement | predictive validity (v1.1), demographic-fidelity split (v1.1), aggregate-vs-individual/subgroup reporting (v1.1) | Per §4.3 and R-07 §7.1. |
| **Isolation substrate** | per-persona containerized browser pool over self-hosted replicas; Firecracker microVM as secondary | Docker / runc alone, WASM-only, confidential compute, full VM | Per §4.4 and R-04 §6. |
| **Orchestration / harness** | model-agnostic L4; one L5 model picked for v1 with pluggable abstraction; self-hosted self-OS-candidate for L2/L3 | full SaaS / product surface | Per §4.5 and R-01 §6. |
| **Task-generation** | exploratory-task injection (primary) + seed-and-expand (anchor) | GeneUS / RaT, TOD-schema | Per §4.6 and R-06 §10.2. |
| **Population generation** | hybrid generator (taxonomy-guided + LLM expansion + constrained-decoding) with stratified sampler | real-user-seeded enrichment, evolutionary program search | Per R-06 §10.1. |
| **Batch size** | ≤ 10 personas × 5–10 tasks × ≥ 3 sessions (candidate; the follow-up Issue picks the actual N) | n/a | Per §3.4 "smallest slice". |

---

## 5. MVP acceptance criteria — "can we measure u-sekai's value?"

These are the candidate acceptance criteria the MVP must satisfy before it can be called "MVP done". They are framed from the perspective of "can we measure u-sekai's value?" rather than "is the implementation complete".

### 5.1 Reproducibility

- **R-1.** Given the same persona specification, same task, same L5-model-version, same seed, the MVP produces traces that are identical (modulo documented model-version drift) across at least 3 separate runs on the same self-hosted Web target.
- **R-2.** A re-run on a different L5-model-version produces a documented divergence report (which traces differ, in what dimension, by how much) — per R-07 §5.3 #3 (cross-model generalisation is a known failure mode).

### 5.2 Differentiability

- **D-1.** Two persona specifications that differ on exactly one declared dimension produce traces that differ along that dimension's expected axis (e.g. a color-vision persona that disables color rendering produces a different trace on a color-dependent task than the sighted persona).
- **D-2.** Two persona specifications that differ on no declared dimension produce traces that do not differ in a way that the persona specification would not predict (a *comparability* test). Traces may still vary by token-level stochasticity; what must be stable is the trace's *categorical shape* (R-07 §4.1 process-compliance dimension).

### 5.3 Falsifiability

- **F-1.** Every MVP session produces (a) a behavioural log, (b) per-task SEQ, (c) per-session SUS, (d) optional taxonomy labels, (e) an explicit boundary statement. These are machine-readable and persisted.
- **F-2.** At least one MVP run includes an execution-based checker (WebArena-style / OSWorld-style) that independently confirms whether the Synthetic User's terminal state matches a documented ground-truth — so the MVP can claim *some* signal is externally checkable, not just internally generated.
- **F-3.** The MVP's calibration report (per §4.3, simplified) is generated automatically per run and is human-readable.

### 5.4 Boundary

- **B-1.** Every published MVP finding carries the boundary statement per R-07 §5.4 — appropriate for hypothesis generation, internal A/B comparison, exploratory-UX discovery; **not** appropriate for shipping decisions, accessibility compliance, population-wide claims, concept validation, or statistical-significance testing against real users.
- **B-2.** The MVP documentation explicitly disclaims the deferred items (live anti-bot sites, mobile, desktop OS, multimodal subjective capture, predictive validity against held-out real users) and notes them as known scope boundaries.

### 5.5 Cost shape

- **C-1.** A single MVP run (the candidate batch: 10 personas × 10 tasks × 3 sessions) is reproducible within a research-lab budget (candidate order of magnitude: tens to low hundreds of USD per full batch, depending on L5 pricing and isolation substrate; the follow-up Issue pins the actual number).
- **C-2.** The MVP cost report is published per release so that batch sizes can be reasoned about openly.

### 5.6 Success signal — what "measurable u-sekai value" looks like

A "u-sekai value" finding from an MVP run has the following shape (candidate):

> "Across 30 sessions of persona P on target T with task family F, the Synthetic User exhibited friction pattern X (e.g. a dead-end at step 3 of a 5-step checkout flow) on 23 / 30 sessions. The same task family F on the same target T with a different persona P′ exhibited the same friction on 4 / 30 sessions. Pattern X does not appear in the existing E2E suite for T because the existing suite does not run the Synthetic User's persona configuration. Pattern X is consistent with the behavioural-log taxonomy label L and the per-task SEQ mean drop on task F."

This is a *u-sekai result* in the sense of §3.3: it is a result, not a capability; it is reproducible; it is comparable across personas; and it surfaces a finding the existing E2E suite does not surface.

The MVP is "done" when at least **three** such findings are produced, each reproducible across at least 3 runs, each accompanied by the calibration report, each with the boundary statement attached.

### 5.7 Anti-criteria — what "MVP done" does **not** require

To prevent scope creep, the candidate MVP acceptance criteria explicitly do **not** require:

- Real-user-seeded persona generation (R-06 §8 deferred to v2+).
- Predictive validity against held-out real-user stimuli (R-07 §7.3 deferred to v1.1).
- Cross-LLM ensemble disagreement as a coverage signal (R-02 §3.6 deferred).
- Mobile / desktop / CLI / API substrate support (R-04 §5 deferred to v2+).
- Multimodal persona conditioning (R-03 §7 deferred).
- LLM-as-judge for subjective quality (R-05 §5.6 deferred; revisited in v1.1 only with human-baseline calibration).
- Multi-modal subjective capture (R-05 §5.6 deferred).
- A contributor base that owns the full K8s + Firecracker + KVM operational stack — if the MVP self-hosts, that is a precondition that the follow-up Issue / ADR must resolve (R-04 §7 #6).
- A published benchmark / dataset. R-01 §7 #3 leaves open whether u-sekai contributes a benchmark; the MVP is a research infrastructure, not a benchmark, and the benchmark decision is downstream.

---

## 6. Explicit deferral list

This section consolidates the deferred items from §4 and §5 into a single catalogue with rationale and target version. Each deferral cites the evidence in the predecessor documents.

### 6.1 Capability deferrals

| Deferred item | Reason | Source | Target |
| --- | --- | --- | --- |
| Motor persona | Proxy, not reproduction; weak calibration signal | R-03 §4.1, R-07 §5.2 | v2+ if a runtime-enforced proxy is justified |
| Cognitive persona | Process is prompt-only; persona collapses diversity | R-03 §4.2, R-02 §5.2 | v2+ after a perception-level calibration method exists |
| Long-term memory persona | Memory architecture is well-documented but adds harness complexity disproportionate to v1 value | R-03 §4.10, R-01 §7 | v1.1 (small extension) or v2 |
| Distraction / interruption / fatigue | Proxy, not reproduction; condition is largely prompt-only and partly give-up | R-03 §4.13, R-03 §8.3 | v2+ |
| Mood persona | Prompt-only; reported emotion is a calibration question | R-03 §4.14, R-07 §5.1 | v2+ after R-07's calibration method extends to emotion reporting |
| Linguistic style / register | LLM-side, not substrate-side | R-03 §4.11 | v1.1 (small extension if R-05's subjective channel needs it) |
| Server-side personalisation | u-sekai does not control back-end models | R-03 §4.12, R-03 §8.3 | give-up; explicit boundary statement |

### 6.2 Target deferrals

| Deferred item | Reason | Source | Target |
| --- | --- | --- | --- |
| Live anti-bot-protected sites | ToS risk; reproducibility failure; R-04's anti-bot / anti-detection stance is itself an open question | R-04 §5.1 gap 3, R-04 §7 #5 | v2+ after a stance is decided |
| Mobile device farms | Out of MVP scope; future extension | R-04 §6.6 | v2+ |
| Desktop OS substrates (OSWorld VirtualBox / KVM) | Out of MVP scope; future extension | R-04 §4.5, R-04 §6.5 | v2+ desktop extension |
| CLI / API substrates | Out of MVP scope; future extension | R-04 §5.1 gap 3 | v2+ |

### 6.3 Evaluation deferrals

| Deferred item | Reason | Source | Target |
| --- | --- | --- | --- |
| Post-session free-form reflection | High ecological validity, low comparability; confabulation risk | R-05 §2.2, R-05 §5.6 | v1.1 or v2 with human-baseline calibration |
| LLM-as-judge of session usability | Shared-distribution risk with simulator | R-07 §4.8, R-02 §3.5 | v1.1 paired with at least one human-baseline calibration |
| Researcher-as-interviewer / per-session Q&A | Requires interactive runtime decisions | R-05 §5.6 | v2+ |
| Multimodal subjective capture | Requires extension beyond Web target | R-05 §5.6 | v2+ when multimodal persona conditioning exists |
| Real-user-seeded persona calibration | Privacy / consent infrastructure not available | R-06 §10.1 #3, R-07 §7.3 | gated on a separate privacy / consent decision |
| Predictive validity on held-out real-user stimuli | Requires IRB-grade infrastructure | R-07 §7.3, R-05 §7.1 #3 | v1.1 or v2 after a privacy / consent decision |
| Aggregate-vs-individual/subgroup reporting | Requires a larger population sample than the MVP budget | R-07 §3.2, R-07 §7.1 | v2+ when batch size is large enough |
| Cross-LLM ensemble disagreement as coverage signal | Requires R-06 to define what counts as an ensemble | R-02 §3.6 | v2+ |
| Per-task NASA-TLX or custom Likert battery | Per-task cost is non-trivial at MVP batch size | R-05 §4 | v1.1 if MVP budget allows |

### 6.4 Stack deferrals (substrate / harness / orchestration)

| Deferred item | Reason | Source | Target |
| --- | --- | --- | --- |
| Docker / runc alone for any sandbox that touches untrusted third-party content | Shared-kernel boundary is the wrong shape for an exploratory agent | R-04 §6.6 | never (rejected) |
| WASM-only sandboxes as primary Web substrate | Web substrate is still DOM / Chromium | R-04 §6.6 | never as primary; revisit as future cross-runtime substrate |
| Hyperscaler confidential compute (Nitro Enclaves / Confidential VMs) as primary substrate | Inverts threat model | R-04 §6.6 | never as primary |
| Real-user-data-driven persona seeding at scale | Privacy / consent infrastructure not available | R-06 §8.4, R-06 §10.4 | gated on a separate privacy / consent decision |
| Evolutionary program search (AlphaEvolve / OpenEvolve) as primary generator | Compute and reproducibility cost too high for v1 | R-06 §5.5, R-06 §10.4 | v2+ |
| First-party SaaS (Operator / MultiOn-AGI-0 / Adept legacy) as substrate | Closed, single-session, vendor-concentration risk | R-01 §4.5, R-01 §7 #1 | never as substrate |
| GPU-resident synthetic users | Per-second GPU cost is dramatically higher than per-second CPU | R-04 §7 #9 | v2+ if a persona model requires local models |

### 6.5 Process / governance deferrals

| Deferred item | Reason | Source | Target |
| --- | --- | --- | --- |
| Real-user-data privacy / consent decision | Requires IRB-grade infrastructure and policy | R-06 §10.1, R-07 §7.3 | separate Issue |
| Calibration rubric ownership (own vs adopted) | Multiple published rubrics; design choice consequential | R-07 §8 #1 | follow-up Issue / ADR after MVP |
| Cross-model calibration policy (per-model vs single reference) | Calibration is per-model; trade-off unresolved | R-07 §8 #5 | follow-up Issue / ADR |
| Persona-spec version policy (R-06 §8 #3) | Generation methods drift across model versions | R-06 §10 | follow-up Issue |
| Sampling-frame commitment (target population) | Bounds u-sekai's claims about representativeness | R-06 §11 #1 | follow-up Issue |
| Bias-audit cadence (per release vs per run) | Operational question | R-07 §8 #10 | follow-up Issue / convention |
| Validation of the validation (meta-calibration) | Out of scope for v1 | R-07 §8 #9 | v2+ |
| Published benchmark / dataset contribution | Open whether u-sekai contributes a benchmark | R-01 §7 #3 | follow-up Issue after MVP ships |

---

## 7. Differences vs u-sekai requirements (gap analysis)

| u-sekai requirement (from README + predecessors) | R-08 MVP coverage | Gap |
| --- | --- | --- |
| **Diverse Synthetic Users covering perception-level accessibility differences** | MVP covers color vision, visual-acuity mode, device / viewport, locale, network as persona dimensions | MVP defers motor, cognitive, distraction, mood — these are the dimensions where persona collapse is most documented (R-02 §5.2). MVP boundary statement explicitly disclaims them. |
| **Exploratory, not scripted** | MVP uses exploratory-task injection (R-06 §6.4) as the primary task mechanism | MVP anchor tasks are seed-and-expand (R-06 §6.1) — a hybrid that preserves some scripted reproducibility for cross-version comparison. |
| **Subjective UX as first-class output** | MVP includes per-task SEQ + per-session SUS (R-05 §5.1) | MVP defers free-form reflection and LLM-as-judge (R-05 §5.6); relies on behavioural-log signals for the missing subjective dimensions. |
| **Many parallel Synthetic Users in independent sessions** | MVP runs ≤ 10 personas × 5–10 tasks × 3 sessions (candidate batch) | MVP does not claim population-scale results; "many" is bounded to the MVP batch size. Population scale is v2+. |
| **Persona-aware UI / accessibility simulation** | MVP supports runtime-enforced color-vision and visual-acuity-mode personas (R-03 §8.2) | MVP defers motor / cognitive / distraction; the most embodied accessibility dimensions are deferred to v2+. |
| **Calibration against real users** | MVP ships a "minimum viable calibration report" with distributional + coverage + process + bias + boundary; defers predictive validity | MVP boundary statement explicitly disclaims real-user predictive validity until v1.1. |
| **Reproducibility across many personas** | MVP specifies same-persona / different-persona tests (R-1, D-1, D-2 in §5) | MVP defers cross-model reproducibility (R-2 is a candidate check, not a release blocker). |
| **Real Web environments (not canned test sets)** | MVP uses self-hosted reproducible web apps + canned task corpora | MVP defers live anti-bot sites; boundary statement explicitly disclaims the live-site coverage. |
| **No-dependence on a specific LLM / model** (R-05 §"Initial non-scope") | MVP's L4 orchestration layer is designed for model pluggability; one L5 model picked for v1 | MVP ships one L5 model in v1; cross-LLM coverage is v2+. |

---

## 8. Candidate set recommendations (candidate, not adopted)

> All wording below is **candidate**, not adopted. The role of R-08 is to assemble a coherent candidate MVP; a follow-up Issue decides.

### 8.1 Candidate MVP shape (single sentence)

> A research-substrate MVP that drives ≤ 10 Synthetic Users — varying on device / viewport, locale / timezone, network, color vision, and visual-acuity mode — through ≤ 10 self-hosted reproducible Web apps with execution-based checkers, using exploratory-task injection as the primary task mechanism and seed-and-expand as the anchor, recording per-task SEQ, per-session SUS, behavioural log, and optional taxonomy labels, against a per-persona containerized-browser isolation substrate (Firecracker microVM as secondary), with the L4 orchestration layer model-agnostic and one L5 model picked for v1, and shipping a minimum viable calibration report (distributional + coverage + process + sycophancy / format-stability bias probes + boundary statement) per run.

### 8.2 Candidate scope cuts (the deferrals that make the slice *small*)

The candidate MVP is small *because* of the deferrals in §6. The two largest scope cuts are:

1. **Self-hosted replicas, not live sites.** This single cut collapses the live-site anti-bot stance question, the per-browser-hour cost shape, the ToS / safety question, and the reproducibility-vs-realism trade-off into one decision. (R-04 §5.1, R-04 §7 #1.)
2. **No real-user validation in v1.** This cut collapses the privacy / IRB / consent question, the Stanford-style 2-hour-interview infrastructure cost, and the held-out-stimulus design cost into one decision. R-07 §7.3 makes this an explicit deferral; the MVP boundary statement documents the gap. (R-06 §10.1, R-07 §7.3.)

Both cuts are reversible: a v1.1 release can re-introduce either. Both are also explicitly noted in the candidate boundary statement so downstream consumers know what u-sekai's v1 findings can and cannot support.

### 8.3 Candidate v1.x roadmap (not a release plan)

| Version | Capability delta | Dependency |
| --- | --- | --- |
| **v1.0 (MVP)** | Per §8.1. | None (synthesis of R-01..R-07). |
| **v1.1** | + Real-user-seeded persona enrichment (small consented seed survey) + held-out real-user validation on a single target + demographic-fidelity split in the calibration report + LLM-as-judge paired with human-baseline + free-form reflection as an optional subjective channel + working-memory persona dimension. | Privacy / consent decision (separate Issue); R-07 §7.3 lifted. |
| **v1.2** | + Cross-LLM calibration report (per-model divergence) + persona-spec version policy + taxonomy-label coverage as a standard channel. | R-07 §8 #5; R-06 §10. |
| **v2.0** | + Mobile device-farm substrate + desktop OS substrate (OSWorld-style) + multimodal persona conditioning (video / voice) + evolutionary program search as a high-diversity generator + cross-LLM ensemble disagreement as coverage signal + published benchmark / dataset contribution decision. | R-04 §6.5 + R-06 §5.5 + R-03 §7 + R-01 §7 #3. |

The v1.x roadmap is a candidate only; the actual sprint plan is downstream per `CLAUDE.md` §6.

---

## 9. Open questions / follow-up items / unresolved consequential decisions

These items surfaced during R-08's synthesis. Items marked **escalation candidate** are unresolved consequential decisions that may require user escalation per `engineering-decisions` Skill rules; per the "do not block" rule, they are recorded here so they are not lost.

1. **Self-hosted vs SaaS isolation posture for MVP.** §4.4 candidate leans self-host (per-persona containerized browser pool over WebArena-style replicas). The alternative is SaaS (E2B / Browserbase). The choice is consequential: self-host requires K8s + Firecracker + KVM operational expertise in the contributor base; SaaS incurs per-second cost and vendor-concentration risk. **Escalation candidate.** R-04 §7 #6 lists this as R-08 territory.
2. **MVP L5 model pick.** §4.5 candidate is "model-agnostic from day one, one L5 model picked for v1". The actual pick (Claude Computer Use, OpenAI CUA, Gemini Computer Use, or a non-vision DOM-only path) is consequential because it sets the action-space contract for the L3 harness. **Escalation candidate** only if multiple options are plausibly equivalent; otherwise the L4 orchestration layer's pluggability lets the pick be deferred to v1.x.
3. **Stack adoption decisions are downstream.** Per `CLAUDE.md` §3 and §5, this document intentionally stops short of recording any technology as adopted. The follow-up Issues that decide (a) language, (b) framework, (c) runtime, (d) L5 model, (e) L2 isolation substrate, (f) L3 harness, (g) L4 orchestration are listed in `CLAUDE.md` §8 (Skill list) and are not enumerated here.
4. **MVP batch size numeric commitment.** §5.5 and §8.1 use ≤ 10 personas × 5–10 tasks × 3 sessions as an illustrative candidate. The actual N is consequential because it pins cost and runtime. **Escalation candidate** if the user wants to commit a number before the implementation phase begins; otherwise the follow-up Issue decides.
5. **Bias-audit cadence** (per release vs per run) — R-07 §8 #10.
6. **Calibration rubric ownership** (own vs adopt) — R-07 §8 #1.
7. **Cross-model calibration policy** — R-07 §8 #5.
8. **Persona-spec version policy** — R-06 §8 #3.
9. **Sampling-frame commitment** — R-06 §11 #1.
10. **Whether u-sekai contributes a public benchmark / dataset** — R-01 §7 #3. The MVP is a research infrastructure, not a benchmark; the benchmark decision is downstream but should be tracked.
11. **Real-user-data privacy / consent policy.** This is the single largest unresolved decision; it gates v1.1's real-user validation, real-user-seeded persona enrichment, and demographic-fidelity split. **Escalation candidate.**
12. **Sampling-frame provenance.** If the MVP commits to a target population (R-06 §11 #1), the provenance of the sampling frame (census / panel / hand-authored) is a privacy / licensing decision.
13. **Anti-bot / anti-detection stance.** §4.2 defers live sites; if v2 reverses that, the anti-bot stance (R-04 §7 #5) becomes live again.
14. **Whether the MVP can rely on a single contributor base to operate the chosen isolation substrate.** If self-host, the contributor base needs K8s + Firecracker + KVM operational expertise. This is a contributor-base question, not a technical one, but it determines whether the self-host candidate is feasible.
15. **Translation of MVP artifacts into English for international contributors.** Per ADR-0002 and `CLAUDE.md` §7, MVP artifacts are English; the Japanese translation of upstream Skills is tracked separately in R-09. If MVP releases ship a Japanese translation, that is a separate Issue.

---

## 10. Self-check against the acceptance criteria

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| MVP capability range / target range / evaluation metric / acceptance criteria are documented | §4 (capability range §4.1, target range §4.2, evaluation metric range §4.3, implicit constraints §4.4 isolation substrate / §4.5 orchestration / §4.6 task-generation); §5 (acceptance criteria); §7 (gap analysis). |
| Explicit deferral list (what is NOT in MVP and why) | §6 (capability §6.1, target §6.2, evaluation §6.3, stack §6.4, process / governance §6.5). |
| MVP success criteria from the perspective of "can we measure u-sekai's value?" | §3.3 ("What 'measuring u-sekai's value' means"), §3.4 ("What 'smallest slice that produces a measurable u-sekai result' means"), §5 (success criteria across reproducibility, differentiability, falsifiability, boundary, cost, and the §5.6 success signal), §5.7 (anti-criteria). |

All three acceptance criteria for R-08 are met. No adoption decisions are recorded. No implementation, configuration, CI, or `.py` artifact is introduced. All recommendations use **candidate** language; nothing is "decided" or "planned specification".

---

## 11. References

The R-08 question is a synthesis / scope-setting question; the primary references are the predecessor documents themselves. Supplementary WebSearch was used only to confirm that adjacent projects (UXAgent, WebArena, PersonaGym, OSWorld) had published "initial release" shapes that inform the candidate MVP scope.

### Predecessor research documents (primary input)

- R-01: *Survey of existing browser / computer-use agent environments* — `docs/research-issues/r-01-browser-agent-survey.md`
- R-02: *Survey of existing research / benchmarks on synthetic user simulation* — `docs/research-issues/r-02-synthetic-user-survey.md`
- R-03: *How far can Synthetic User capability limits be reproduced at the runtime layer?* — `docs/research-issues/r-03-runtime-reproduction.md`
- R-04: *Comparison of isolated execution environments* — `docs/research-issues/r-04-execution-env.md`
- R-05: *Subjective evaluation / post-session feedback design* — `docs/research-issues/r-05-subjective-eval.md`
- R-06: *User story / user population generation* — `docs/research-issues/r-06-persona-generation.md`
- R-07: *Calibrating / validating Synthetic Users against real users* — `docs/research-issues/r-07-calibration.md`

### Adjacent MVP anchors (supplementary)

- UXAgent — <https://arxiv.org/abs/2504.09407>; v3 HTML: <https://arxiv.org/html/2504.09407v3>; v1: <https://arxiv.org/html/2502.12561v3>; GitHub: <https://github.com/yuxuan-liu-DL/UXAgent> (also `github.com/neuhai/uxagent`)
- WebArena — <https://webarena.dev/>; arXiv: <https://arxiv.org/abs/2307.13854>; GitHub: <https://github.com/web-arena-x/webarena>; CMU FLAME page: <https://www.cmu.edu/flame/research/2024/webarena.html>; WebArena-Infinity: <https://webarena.dev/webarena-infinity/>
- PersonaGym — <https://arxiv.org/abs/2407.18416>; v4 HTML: <https://arxiv.org/html/2407.18416v4>; site: <https://personagym.com>; EMNLP 2025 Findings: <https://aclanthology.org/2025.findings-emnlp.368.pdf>
- OSWorld — <https://github.com/xlang-ai/OSWorld>; arXiv: <https://arxiv.org/abs/2404.07972>; site: <https://osworld-eval.github.io/>; OSWorld 2.0: <https://osworld-v1.xlang.ai>
- Mind2Web — <https://github.com/OSU-NLP/Mind2Web>; arXiv: <https://arxiv.org/abs/2306.06070>
- WebVoyager — <https://arxiv.org/abs/2401.13919>; leaderboard: <https://www.webvoyager.ai/leaderboard>; GitHub: <https://github.com/David-Chen523/WebVoyager>

### Project-internal references

- README.md — vision, non-goals, current status
- CLAUDE.md §1, §3, §4, §5, §6, §7, §8 — project-local policy
- `docs/research-issues/README.md` — research-question drafts (R-08 section)
- `.claude/skills/writing-discipline/SKILL.md` — applied for the Select → Compose → Reread pipeline
- `.claude/skills/design-refinement/SKILL.md` — applied for fact / decision separation

### Adjacent calibration / scope references re-cited (from R-07)

- NN/g — *Synthetic Users: If, When, and How to Use AI-Generated 'Users'* — <https://www.nngroup.com/articles/synthetic-users/>
- NN/g — *Evaluating AI-Simulated Behavior: Insights from Three Studies on Digital Twins and Synthetic Users* (2025) — <https://www.nngroup.com/articles/ai-simulations-studies/>
- MeasuringU — *A Review of Experiments with Synthetic Users* — <https://measuringu.com/review-of-experiments-with-synthetic-users/>
- Validation Methods for LLM-based Synthetic Users (4-dimension rubric) — <https://arxiv.org/abs/2412.06047>
- Chen et al. 2026 — *When Synthetic Users Fail* — <https://arxiv.org/html/2607.26348v1>; PDF: <https://arxiv.org/pdf/2607.26348>
- Park et al. 2024/2025 — *Generative Agent Simulations of 1,000 People* — <https://arxiv.org/abs/2411.10109>

---

## 12. Status

This is a draft research artifact for R-08. No adoption / non-adoption decision is recorded here; per `CLAUDE.md` §3 and §5, those decisions belong to follow-up Issues once they open and resolve. The deferral list in §6 and the candidate MVP shape in §8.1 are the synthesis outputs of R-08; the actual MVP shape, stack, and release plan are downstream.
