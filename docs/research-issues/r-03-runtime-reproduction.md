# R-03: How far can Synthetic User capability limits be reproduced at the runtime layer?

> Draft research artifact for issue **R-03** (runtime reproduction of individual differences).
> This is an investigation, not an adoption decision. Nothing in this document is "decided" or "adopted".
> The goal is to inventory, dimension by dimension, what u-sekai can reproduce at the runtime / agent layer, what can only be done at the prompt / profile layer, and what should be marked "give up" (out of scope or unattainable with current techniques).

---

## 1. Question (verbatim from the draft)

> Inventory how the dimensions of individual difference (capability, perception, operating environment, memory, preference, situation) can be modeled / reproduced at u-sekai's runtime or agent layer.
> Define the runtime-reproduce / prompt-reproduce / give-up boundaries.

**Acceptance criterion** (from `docs/research-issues/README.md`):

1. The runtime-reproduce / prompt-reproduce / give-up boundaries are documented.

**Predecessors read first**:

- `docs/research-issues/r-01-browser-agent-survey.md` (R-01) — browser / computer-use agent ecosystem inventory.
- `docs/research-issues/r-02-synthetic-user-survey.md` (R-02) — synthetic-user / persona-simulation research and benchmark inventory.

This document does **not** redo those surveys. It builds on R-01's layer model (L1 substrate → L7 evaluation environment) and R-02's catalog of how prior art treats individual differences.

---

## 2. Investigation summary

### 2.1 What was covered

- **Dimensions of individual difference** drawn from the u-sekai vision and the draft R-03 text: capability (motor / cognitive), perception (visual acuity, color vision, field of view, hearing as analogue), operating environment (device, browser, viewport, network, locale, time-of-day), memory (working / episodic / long-term, including the "lost in the middle" phenomenon), preference (language, UI style, content preference), and situation (context, distraction, fatigue, urgency).
- **Prior-art persona / agent architecture** relevant to runtime reproduction: Park et al. 2023 (memory stream + retrieval + reflection + planning), UXAgent / SimUser (L3 harness with persona-conditioned actions), Generative-Agent Simulations of 1,000 People (Park et al. 2024), validation methodology literature.
- **L1 / L2 substrate mechanisms** for *enforcing* individual differences at the runtime layer rather than describing them in a prompt: Playwright / Chromium browser-context features (viewport, user-agent, locale, timezone, device-scale-factor, touch), Chrome DevTools network throttling (slow-3G / fast-3G / custom bandwidth + latency), color-vision filter tools, accessibility-tree inspectors, headless display / XTest / pyautogui-style motor simulators.
- **Memory / context-window mechanisms**: long-context attention behaviour (Liu et al. 2023, "lost in the middle"), MemGPT / Letta hierarchical paging (Packer et al. 2023), LangGraph thread + store memory, mem0, Generative-Agents-style memory stream.
- **Pitfalls and constraints** that fix the upper bound: demographic-prompting failure (Patil et al. 2024 style findings), persona collapse, the "no embodiment / no environment" pitfall from R-02, sycophancy, accessibility-tree fidelity, and LLM-as-judge shared-bias risk.

### 2.2 What was skipped and why

- **Final adoption** of any specific L3 harness, L2 provider, or L4 runtime — that belongs to R-04 (environment) and R-08 (MVP). This document only inventories what *can* be reproduced at each layer; it does not pick the stack.
- **Privacy / consent mechanics for collecting real-user data** to seed personas. This is touched lightly in Section 5.3 (the "give up" boundary) but the policy detail belongs to R-06 (persona generation) and a separate privacy decision.
- **Non-Web substrates** (desktop OS, mobile native, CLI, API) — referenced only as future-facing; the Web-first scope is fixed by the README and the R-01 layer model.
- **Multimodal / video / voice** persona conditioning — surfaced as "give up" for the Web MVP because the public browser-agent substrate does not yet support voice / video persona conditioning as a first-class signal; tracked as a follow-up question in Section 7.

### 2.3 Methodology notes

- For each dimension, the document asks: **(a)** can the substrate **enforce** the dimension (i.e., the dimension is reflected in the runtime state of the browser / OS / agent)? **(b)** can only the **LLM** be told about it (prompt / profile)? **(c)** is neither feasible and the dimension must be marked as out of scope or approximated?
- "Runtime" is interpreted as anything that *actually happens at execution time* (browser viewport, network throttle, accessibility tree, screen-reader invocation, color filter, agent loop memory). "Prompt" is the system / persona prompt text passed to the LLM. "Give up" means the dimension is *not* representable in current publicly available substrate + LLM combinations.
- Citations follow the URLs that surfaced during investigation; some links are vendor blogs or summaries, used only for orientation and clearly marked.

---

## 3. Layer model reminder (from R-01)

R-01's layer model is reused. The relevant levels for *this* document are:

| Layer | What lives here | Relevance to individual-difference reproduction |
| --- | --- | --- |
| L1 substrate | Headless browser / OS, DOM / accessibility tree, pixel APIs, viewport, network throttle | Enforces perception, operating environment, and some capability dimensions |
| L2 browser-infra | Hosted Chromium-as-a-service with isolation, anti-detect, per-session state | Enforces session-level persona state (cookies, locale, timezone, persona-local storage) |
| L3 harness | LLM loop that turns observation + goal into next action; persona is a parameter | Implements memory + reflection + planning dimensions |
| L4 runtime | State, control flow, multi-agent orchestration | Holds long-running persona state, persona-conditioned sub-agents |
| L5 model API | First-party computer-use model (Claude Computer Use, OpenAI CUA, Gemini Computer Use) | Provides action space; persona is whatever the calling harness injects |
| L6 SaaS product | Bundled end-user product (Operator, MultiOn, …) | Out of scope for u-sekai (closed, single-session) |
| L7 evaluation environment | Reproducible sites, fixed tasks | Out of scope as a *reproduction* substrate; in scope as a *comparison* target |

The central thesis of this document is: **individual-difference reproduction is layered**. L1 enforces physics (you really do see the page at this viewport with this color filter); L2 enforces session state (cookies, locale); L3 enforces process (memory, reflection, action selection); the LLM itself (L5) is asked to *behave* like the persona. The boundaries between "runtime-reproduce", "prompt-reproduce", and "give up" depend on which layer the dimension lives at.

---

## 4. Dimension-by-dimension inventory

For each dimension below, the table summarises:

- **What it is** in u-sekai terms.
- **Runtime-reproduce mechanism(s)** — what physically enforces the dimension in the execution substrate.
- **Prompt-only mechanism(s)** — what the LLM is told.
- **Boundaries / give-up** — what cannot be reproduced with current public substrate + LLM.

A summary cross-dimension table is at the end of this section.

### 4.1 Capability — motor

**What it is.** Motor limitations: tremor, limited dexterity, slow reaction time, single-hand use, no fine pointer control, switch-control users.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Possible at L1: headless / virtualized X11 with `pyautogui`-style "pointer noise" or "pointer smoothing"; action-space mutation in the L3 harness to inject `mouse_move` jitter / delay; `keyboard` event injection instead of `mouse_click` to mimic switch / single-input users. Playwright exposes `mouse.move`, `mouse.down`, `mouse.up` separately, which lets a harness *simulate* a noisy / slow pointer deterministically. |
| **Prompt-only** | "You are a user with hand tremor" — observed in R-02 to produce limited behavioural variance (Patil et al. 2024 style findings; the persona collapses diversity). |
| **Boundaries / give-up** | Real motor limitations are embodied and physical. Simulating a tremor by jittering pointer coordinates in the harness is a *proxy*, not a reproduction. The simulator will not feel fatigue, will not misclick because of joint pain, and cannot be measured against clinical motor assessments. **Recommended candidate classification**: *partially runtime-reproduce via action-space mutation; remainder is prompt-only or give-up.* |

References: <https://playwright.dev/docs/accessibility-testing>; <https://github.com/asweigart/pyautogui> (orientation only).

### 4.2 Capability — cognitive

**What it is.** Cognitive accessibility: short working memory, slow reading, ADHD-style attention fragmentation, dyslexia-style word-recognition difficulty, autism-spectrum interaction patterns, intellectual disability, dementia.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Limited. The runtime can *throttle information density* (smaller chunks of DOM returned to the agent per observation step), or *delay* observation updates, but cannot reproduce the underlying cognitive process. The L3 harness can choose to **truncate** the observation each step to mimic limited working memory, or **skip** non-essential elements. The accessibility tree itself can be filtered (e.g. `aria-hidden` regions treated as absent) to mimic an ADHD-style attention filter. |
| **Prompt-only** | "You have ADHD and get distracted easily", "You have dyslexia and misread short words", "You have a 5-item working memory". R-02 surveys (Validation Methods paper; Cao et al. 2024) note these prompts produce *modest* behavioural shift and risk stereotype amplification. |
| **Boundaries / give-up** | Genuine cognitive accessibility issues (screen-reader navigation order, focus management, cognitive load from animation, language complexity) are **product-side** issues that can only be **detected** by a persona-conditioned agent, not *caused* in the agent itself. **Recommended candidate classification**: *runtime can enforce observation truncation and information-density throttling; the cognitive *process* itself is prompt-only and largely give-up.* |

References: <https://www.w3.org/WAI/cognitive/>; W3C Cognitive Accessibility task force; <https://www.w3.org/WAI/people-use-web/abilities-barriers/>.

### 4.3 Perception — visual acuity and field of view

**What it is.** Low vision, blindness (no pixel input), tunnel vision, light sensitivity, visual fatigue.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | At L1, the runtime can apply CSS filters / OS color filters to the actual rendered page (zoom level, contrast, magnifier, color inversion) and **force** the screenshot observation the LLM sees to be the filtered view. For blindness, the runtime can **strip** the screenshot entirely and feed only the accessibility tree — the LLM is then effectively a screen-reader user. For low vision, the runtime can downsample / blur / reduce contrast. |
| **Prompt-only** | "You are legally blind" — without runtime enforcement, the LLM still sees a high-resolution screenshot, so its behaviour is not authentically low-vision. |
| **Boundaries / give-up** | The "screen-reader user" simulation is **only as good as the accessibility tree**. Pages with poor semantic markup produce a degraded tree, which is precisely the failure mode a Synthetic User *should* surface — but that means the simulator is also subject to the same failure. Real low-vision adaptation involves eye–head coordination, magnifier scanning strategies, and fatigue over a long session; these are not reproducible. **Recommended candidate classification**: *runtime-reproduce (CSS filter, accessibility-tree-only mode, zoom, magnifier), but with explicit caveats.* |

References: <https://www.w3.org/WAI/people-use-web/abilities-barriers/> (visual category); UXAgent notes that accessibility evaluation is referenced via AXNav but not integrated in its prototype (<https://arxiv.org/html/2504.09407v2>).

### 4.4 Perception — color vision

**What it is.** Deuteranopia, protanopia, tritanopia, achromatopsia, and partial / anomalous trichromacy.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | At L1 / OS level: apply a color-matrix filter to the rendered page (Sim Daltonism open-source macOS app, <https://michelf.ca/projects/sim-daltonism/>; the Chrome "Spectrum" / "NoCoffee" extensions apply similar filters in the browser). For a Synthetic User, the runtime must **mutate the screenshot observation itself** so the LLM only ever sees the post-filter image. The filter is a deterministic matrix, so it is reproducible across sessions. |
| **Prompt-only** | "You are red-green color blind" — without the filter, the LLM still sees the unfiltered page; prompt-only is not a real reproduction. |
| **Boundaries / give-up** | Color vision is one of the *cleanest* runtime-reproduce cases — the simulation is mathematically exact. **Recommended candidate classification**: *runtime-reproduce, no significant give-up.* |

References: <https://michelf.ca/projects/sim-daltonism/>; NoCoffee Chrome extension (orientation); Spectrum Chrome extension (orientation).

### 4.5 Perception — auditory (Web analogue)

**What it is.** Deafness / hard-of-hearing. On the Web this maps to: no audio autoplay assumption, caption availability, visual alternatives for audio cues.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | The runtime can **disable** audio output entirely (mute the browser context) and refuse to feed any audio channel to the LLM. The harness can detect elements with audio cues (via DOM / ARIA) and **refuse** to interpret non-textual cues. |
| **Prompt-only** | "You are deaf" — without runtime enforcement, the LLM may still be tempted to comment on audio cues that are present in the page. |
| **Boundaries / give-up** | On the Web, auditory perception is largely *about what the page requires*, not what the user can hear; a Synthetic User can reproduce the *consequence* (page requires captions) without reproducing the *cause* (deafness). **Recommended candidate classification**: *runtime can enforce no-audio-channel; the dimension itself is partly out of scope because Web evaluation is mostly visual / textual.* |

### 4.6 Operating environment — device / viewport

**What it is.** Mobile vs. desktop, phone vs. tablet, foldable, small viewport, low DPI, touch vs. pointer.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Strongly runtime-reproducible. Playwright / Chromium expose `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, `locale`, `timezoneId` directly on `browser.newContext(...)`. The `devices` presets (iPhone 13, Pixel 5, iPad, …) make mobile / tablet / desktop personas a one-line configuration. The site will actually render differently under each persona because the CSS media queries and JS feature detection respond to these values. |
| **Prompt-only** | "Imagine you are on a phone" — without viewport / user-agent changes, the page renders the desktop layout, the prompt is fiction. |
| **Boundaries / give-up** | Touch-target size, gesture patterns, and foldable transitions are reproducible at L1; *physical* touch (palm rejection, multi-finger gestures, foldable posture changes) is not. **Recommended candidate classification**: *runtime-reproduce, low give-up.* |

References: <https://playwright.dev/docs/accessibility-testing> (Playwright `accessibility` snapshot); Playwright `devices` API; Chrome DevTools mobile-emulation docs (orientation).

### 4.7 Operating environment — network

**What it is.** Broadband vs. slow 3G vs. offline, high latency, packet loss.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Strongly runtime-reproducible via Chrome DevTools network throttling, exposed via the Chrome DevTools Protocol and available in Playwright through `page.route` interception + custom latency, or in hosted browsers (Browserbase / Steel / Hyperbrowser per R-01) via CDP-equivalent APIs. Built-in profiles include "Slow 3G", "Fast 3G", "Offline"; custom profiles allow arbitrary bandwidth + latency. |
| **Prompt-only** | "Imagine the network is slow" — the LLM cannot meaningfully slow itself; pages either load or they don't. |
| **Boundaries / give-up** | Real-world network is stochastic; throttling profiles are deterministic. **Recommended candidate classification**: *runtime-reproduce via CDP / Playwright throttling; the simulator never sees genuine jitter, but the systematic effect is reproducible.* |

References: <https://developer.chrome.com/docs/devtools/network/throttling>; <https://developer.chrome.com/docs/devtools/network/reference>; <https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API>.

### 4.8 Operating environment — locale / timezone / language

**What it is.** User language, country, region, currency, timezone, date format, RTL layout.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Strongly runtime-reproducible. Playwright `browser.newContext({ locale, timezoneId })` propagates to `Accept-Language`, `Intl.*` JS APIs, and CSS `:lang()` selectors. The page actually renders localized strings, dates, and layouts. RTL personas are reproducible by setting document direction or using Arabic / Hebrew locales. |
| **Prompt-only** | "You prefer English" — without locale, the LLM sees the page in whatever the developer wrote. |
| **Boundaries / give-up** | Locale is one of the *cleanest* runtime-reproduce dimensions because the page genuinely behaves differently under different locales. **Recommended candidate classification**: *runtime-reproduce, no significant give-up.* |

### 4.9 Memory — working / short-term

**What it is.** How much the agent can hold in mind at once (context-window limits, attention in the middle, working-memory degradation).

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | The runtime can **enforce** the working-memory limit by truncating the observation / action-history each step to mimic a small working memory. The harness can explicitly cap the number of recent steps surfaced to the LLM, simulating an n-item working memory (e.g. 4 ± 1). |
| **Prompt-only** | "You can only remember the last 3 steps" — effective for behaviour shaping but easy for the LLM to "violate" because the actual context window still contains more. |
| **Boundaries / give-up** | The fundamental U-shaped "lost in the middle" attention pattern (Liu et al. 2023) is a property of the underlying LLM and is *not* a tunable persona dimension — every persona suffers from it. u-sekai can simulate it as a persona attribute (e.g. "you forget details in the middle of a long page") but cannot remove it from the model itself. **Recommended candidate classification**: *runtime can truncate observation; underlying LLM behaviour is fixed.* |

References: <https://arxiv.org/abs/2307.03172> (Liu et al., "Lost in the Middle"); Anthropic effective-context-engineering write-up <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>.

### 4.10 Memory — long-term / episodic

**What it is.** Cross-session recall of past interactions, returning-user behaviour, learning over time.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Strongly runtime-reproducible. The L3 / L4 harness can maintain a **memory stream** (Generative Agents pattern; Park et al. 2023), a **hierarchical memory** (MemGPT / Letta, Packer et al. 2023), or a thread-scoped state + long-term store (LangGraph). The persona-conditioned retrieval is implemented in code; the agent's "memories" are first-class data. |
| **Prompt-only** | Not really meaningful — long-term memory is a system property, not a prompt property. |
| **Boundaries / give-up** | Memory *content* depends on what the agent observed, which depends on what the persona-conditioned observation policy allowed through. A persona that forgets everything mid-session cannot build genuine long-term memory. The interaction between persona-conditioned memory *capacity* and persona-conditioned memory *content* is non-trivial and needs design attention (R-06 will cover generation; R-07 will cover calibration). **Recommended candidate classification**: *runtime-reproduce via explicit memory architecture; the *persona-conditioned* shape is the design question.* |

References: <https://arxiv.org/abs/2304.03442> (Generative Agents); <https://arxiv.org/abs/2310.08560> (MemGPT); <https://www.letta.com/>; <https://www.langchain.com/langgraph>; mem0 documentation (orientation).

### 4.11 Preference — language and style

**What it is.** What language the user reads / writes; terse vs. verbose; technical vs. lay vocabulary; formality register.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Partial. The runtime can force a locale (4.8), which enforces what the page shows, but cannot force the *agent's* writing style. Style is a property of the LLM and is shaped via system prompt. |
| **Prompt-only** | "Reply in concise technical Japanese"; "You are a 70-year-old retired teacher". Style is most reliably prompt-reproduced. |
| **Boundaries / give-up** | Style is not measurable at the runtime layer in a way that matters for *exploratory UX evaluation*; u-sekai cares about *what the user did on the page*, not *how the user would describe it later*. Style is therefore relevant mainly for R-05 (subjective evaluation), not R-03. **Recommended candidate classification**: *primarily prompt-only; not a primary R-03 concern.* |

### 4.12 Preference — content and task

**What it is.** What the user is shopping for, reading, looking up; brand affinity, political lean, hobby.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | The runtime can pre-seed cookies / localStorage / persona-specific accounts so that the page *shows* the persona (recommended items, language preferences, saved addresses). This is the L2 isolation layer's natural use: each Synthetic User gets its own session state. |
| **Prompt-only** | "You are a 28-year-old female mechanical engineer looking for a new laptop under $1500" — effective at behaviour-shaping but the page may not actually reflect the persona (no personalised recommendations, no saved addresses). |
| **Boundaries / give-up** | Personalised recommendations depend on server-side models, which u-sekai cannot control. The Synthetic User is evaluating the *front-end* UX, not the back-end personalisation. **Recommended candidate classification**: *hybrid — runtime can pre-seed session state, prompt shapes task motivation; back-end personalisation is give-up.* |

### 4.13 Situation — distraction, fatigue, time pressure, interruption

**What it is.** Real users are distracted, tired, rushed, interrupted by notifications, working on the go.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | Partial. The runtime can **inject** competing signals (a fake notification, a delayed observation, a tab switch) to model distraction; can **throttle** the observation frequency to mimic a user who isn't paying attention; can **inject** a "back to the tab" event after a delay. None of these reproduce the *cause* (real distraction). |
| **Prompt-only** | "You are distracted and will not read every word", "You are in a hurry and will click the first thing that looks right". The literature notes persona-prompted LLMs do shift behaviour but with the caveats in R-02 §5 (sycophancy, modest shift, demographic prompting can fail). |
| **Boundaries / give-up** | Real distraction is embodied, time-coupled, and stochastic; simulator-side approximation is necessarily a *fiction*. The simulator will not get genuinely fatigued, will not be interrupted by a real phone call, will not lose track of state because of context-switch cost. **Recommended candidate classification**: *runtime can inject interruptions; the *condition* itself is largely prompt-only and partly give-up.* |

References: R-02 §5.5 (no embodiment / no environment pitfall).

### 4.14 Situation — mood / emotional state

**What it is.** Calm vs. frustrated, curious vs. sceptical, confident vs. anxious.

| Aspect | Status |
| --- | --- |
| **Runtime-reproduce** | None meaningful. Mood is not a runtime property of the browser. |
| **Prompt-only** | "You are frustrated because you have been on this checkout page for 10 minutes"; "You are sceptical of unfamiliar brands". Effective for shaping the agent's behaviour and reporting. |
| **Boundaries / give-up** | Genuine emotion cannot be reproduced; LLM-reported emotion is partly a confabulation. R-05 covers how to design subjective reporting; R-03 marks this as prompt-only and notes that reported emotion is *itself a calibration question* (R-07). **Recommended candidate classification**: *prompt-only; calibration is R-07's problem.* |

### 4.15 Cross-dimension summary

| Dimension | Runtime-reproduce | Prompt-only | Give up (out of scope) |
| --- | --- | --- | --- |
| Capability — motor | Action-space mutation (jitter, delay, keyboard-only) | Persona description | Embodied motor fatigue, clinical assessment fidelity |
| Capability — cognitive | Observation truncation, info-density throttle, accessibility-tree filtering | Persona description | Underlying cognitive process, language comprehension limits |
| Perception — visual acuity | CSS / OS filter, accessibility-tree-only mode | Persona description | Eye–head coordination, magnifier scanning strategies, session-long fatigue |
| Perception — color vision | Color-matrix filter on observation screenshot | n/a | n/a (clean reproduction) |
| Perception — auditory | Disable audio channel, refuse non-text cues | Persona description | Most auditory cues are out-of-scope on Web |
| Operating environment — device / viewport | `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent` | n/a | Real touch dynamics, foldable posture |
| Operating environment — network | CDP / Playwright throttle (slow-3G, custom) | n/a | Stochastic real-world jitter |
| Operating environment — locale | `locale`, `timezoneId`, RTL via document direction | n/a | n/a (clean reproduction) |
| Memory — working | Truncate observation, cap recent-step count | Persona description | Underlying LLM attention pattern (lost in the middle) |
| Memory — long-term | Memory stream / hierarchical paging / thread + store | n/a | Persona-conditioned content vs. capacity interaction |
| Preference — language / style | Locale forces page language; style is LLM-side | Persona description | Mostly give-up for UX purposes (R-05 concern) |
| Preference — content / task | Pre-seeded session state (cookies, accounts) | Persona description | Server-side personalisation |
| Situation — distraction / fatigue / interruption | Inject competing signals, throttle observation | Persona description | Embodied fatigue, genuine interruption |
| Situation — mood | None | Persona description | Genuine emotion (calibration is R-07) |

---

## 5. Boundaries between runtime, prompt, and give-up

### 5.1 When runtime reproduction is the right call

The runtime layer should reproduce the dimension when:

1. **The page itself responds to the dimension.** Viewport, locale, user-agent, color filter, network throttle, accessibility tree, cookies. If the page changes shape under the dimension, runtime is the only authentic way.
2. **The dimension has a deterministic, reproducible implementation.** Color matrix, network profile, browser context parameters, observation truncation.
3. **Prompt-only reproduction would be fiction.** Telling the LLM "imagine you are on a phone" while the page renders the desktop layout is not a reproduction.

### 5.2 When prompt-only reproduction is the right call

The prompt / profile layer should reproduce the dimension when:

1. **The page does not respond to the dimension.** Mood, distraction, cognitive style, intent / task motivation, brand affinity.
2. **The dimension is a property of the LLM's behaviour, not the substrate.** Style, register, vocabulary.
3. **The cost of a runtime mechanism is disproportionate to the value.** A full eye-tracker simulator for "visual attention order" is not justified for v1; prompt-shaping is good enough.

### 5.3 When to give up

The dimension should be marked "give up" (out of scope or not attempted) when:

1. **The phenomenon is embodied and physical** (real fatigue, real tremor, real distraction, real emotion).
2. **Reproducing it would require a substrate we do not control** (server-side personalisation, A/B-test bucketing, recommendation models).
3. **The reproduction is *more authentic* by being a probe than a simulation.** u-sekai's value is partly *discovering* what an accessibility user experiences on a poorly-built page. The simulator that "is" low-vision by construction (CSS-filtered screenshot) is testing a known-fixed problem; the simulator that "pretends" to be low-vision via prompt is testing what happens when accessibility fails. Both are useful; the second is the genuinely exploratory case.
4. **The dimension cannot be calibrated against a real-user reference.** Without a ground-truth to compare to (R-07), runtime reproduction of the dimension is unfalsifiable; better to mark it as give-up than to ship a fake.
5. **Privacy / consent forbids the data needed.** Real-user interviews to seed a persona (Stanford's 1,000-person simulation used 2-hour interviews with 1,052 participants; <https://arxiv.org/abs/2411.10109>) require IRB / consent infrastructure that u-sekai does not have in this phase.

References: <https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy> (Park et al. 2024 / 2025).

### 5.4 The three-tier rule of thumb

For each dimension, ask in this order:

1. **Does the page respond to it?** If yes → runtime.
2. **Is it a property of the LLM's behaviour?** If yes → prompt.
3. **Is it embodied, server-side, or unmeasurable?** → give up (or partially simulate with explicit caveats).

This rule is *not* a hard policy — R-08 (MVP scope) will choose which dimensions to invest in for v1.

---

## 6. Comparison table — candidate mechanisms by layer

This table maps the dimensions to candidate mechanisms **at each layer**. All entries are *candidates*; none are adopted. The role of R-03 is to put plausible mechanisms on the table.

| Dimension | L1 substrate | L2 isolation | L3 harness | L4 runtime | L5 model API |
| --- | --- | --- | --- | --- | --- |
| Motor | Headless display, `pyautogui`, action-space mutation | Per-persona ephemeral session | Inject jitter / delay into action emission | Persona-keyed action profile | (out of scope) |
| Cognitive | Observation truncation, accessibility-tree filtering | n/a | Cap observation length; filter aria-hidden | Persona-keyed observation policy | n/a |
| Visual acuity | CSS / OS color and zoom filters; accessibility-tree-only | n/a | Force screenshot-vs-tree mode | Persona-keyed input modality | CUA / Computer Use accepts the filtered observation as input |
| Color vision | Color matrix on rendered pixels | n/a | Force post-filter screenshot | Persona-keyed color profile | (same as above) |
| Auditory | Mute audio channel | n/a | Refuse audio cues | Persona-keyed modality set | n/a |
| Device / viewport | `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent` | Per-persona browser context | Choose `devices` preset | Persona-keyed profile map | n/a |
| Network | CDP throttle | Provider-managed throttle | Inject `page.route` delay | Persona-keyed network profile | n/a |
| Locale | `locale`, `timezoneId`, RTL | Per-persona locale state | n/a | Persona-keyed locale map | n/a |
| Working memory | (n/a) | (n/a) | Truncate observation per step | Cap recent-step buffer | Underlying attention is fixed (lost in the middle) |
| Long-term memory | (n/a) | Per-persona persistent store | Memory stream (Generative Agents pattern) | Hierarchical paging (MemGPT / Letta) or thread + store (LangGraph) | (n/a) |
| Language / style | (n/a) | (n/a) | Persona-conditioned system prompt | Persona-keyed prompt template | LLM is the substrate |
| Content / task | Pre-seeded cookies / localStorage | Per-persona account | Persona-conditioned task description | Persona-keyed task seed | n/a |
| Distraction / fatigue | Inject competing events | Per-persona event stream | Throttle observation frequency | Persona-keyed pacing | n/a |
| Mood | (n/a) | (n/a) | Persona-conditioned system prompt | Persona-keyed prompt template | n/a |

**Reading the table**: rows are dimensions; columns are the u-sekai / R-01 layers. The cells describe the *candidate* mechanism at that layer. Multiple cells per row are normal — most dimensions are reproduced across more than one layer.

---

## 7. Differences vs u-sekai requirements (gap analysis)

This section answers: where does the surveyed prior art fall short of what u-sekai needs?

| u-sekai axis (from README + R-01 §5 + R-02 §6) | Prior-art coverage | Gap |
| --- | --- | --- |
| Diverse Synthetic Users covering **perception-level** individual differences (visual, motor, cognitive) | R-01 / R-02: surveyed systems focus on demographic / personality / Big-Five dimensions. UXAgent explicitly references AXNav for accessibility but does not integrate it. VLM-based visual-perception simulation exists for low vision (referenced in literature; one ACM study, <https://dl.acm.org/doi/full/10.1145/3663547.3759715>) but is not a general-purpose runtime. | **Gap**: no surveyed system provides a *runtime-enforced* accessibility-persona layer for browser agents. This is u-sekai's primary value territory. |
| **Long-running, persona-conditioned memory** | Generative Agents (Park et al. 2023), MemGPT / Letta, LangGraph, mem0, Park et al. 2024 1,000-person simulation | Covered by L3/L4 candidates. *Gap*: persona-conditioned memory *capacity* (e.g. a persona with 3-item working memory) is not a first-class feature in any surveyed system — only the *content* of memory is persona-shaped. |
| **Many parallel Synthetic Users with independent runtime state** | R-01 §5: Browserbase / Steel / Hyperbrowser provide per-session ephemeral state | Covered at L2 candidates. *Gap*: cost at 100s / 1000s of parallel personas is uncalibrated; needs R-04. |
| **Calibration of runtime-enforced persona dimensions against real-user data** | No prior art found that calibrates a runtime-enforced persona (e.g. CSS-filtered screenshot) against real low-vision user behaviour on the same page. | **Gap**: methodology missing — R-07. |
| **Reproducibility of persona-conditioned runs** | Memory stream + retrieval scoring (Generative Agents) and MemGPT paging are deterministic given the same seed; persona-conditioned prompt is not deterministic across model versions. | Partial coverage. *Gap*: persona-conditioned runs may not be reproducible across model upgrades; needs explicit "persona spec" version control. |
| **Subjective evaluation under runtime-enforced personas** | R-05 territory; LLM-as-judge pipelines (WebVoyager 85% agreement, PersonaGym) | Out of R-03 scope; flagged as a follow-up. |
| **Situation / context (distraction, fatigue, time pressure)** | Surveyed systems do not systematically model situation | **Gap**: situation is the dimension with the *least* prior-art coverage; needs design attention before v1. |

---

## 8. Candidate recommendations (candidate set only — not adopted)

> All wording below is **candidate**, not adopted. The role of R-03 is to assemble plausible mechanisms so that R-04 / R-06 / R-08 can decide.

### 8.1 Candidate runtime-reproduction mechanisms (per dimension)

| Dimension | Candidate runtime mechanism | Confidence |
| --- | --- | --- |
| Device / viewport | Playwright `browser.newContext({ ...devices['iPhone 13'], userAgent, viewport, deviceScaleFactor, isMobile, hasTouch })` | High — substrate-supported |
| Locale / timezone | Playwright `browser.newContext({ locale, timezoneId })` | High — substrate-supported |
| Network | Chrome DevTools Protocol throttling via Playwright `page.route` or provider-CDP | High — substrate-supported |
| Color vision | Color-matrix filter applied to the observation screenshot (the LLM never sees unfiltered pixels) | High — deterministic |
| Visual acuity | Accessibility-tree-only mode (no screenshot at all) + optional CSS zoom/contrast filter on rendered page | High for tree-only; medium for partial-vision |
| Motor | Action-space mutation in the L3 harness (jitter, delay, keyboard-only) | Medium — proxy, not reproduction |
| Cognitive | Observation truncation in the L3 harness; accessibility-tree filtering (drop aria-hidden regions) | Medium — proxy, not reproduction |
| Working memory | Cap recent-step buffer per persona; explicitly truncate context | High — substrate-supported |
| Long-term memory | Memory stream (Generative Agents pattern) or hierarchical paging (MemGPT / Letta) at L4 | High — substrate-supported, well-documented |
| Distraction / interruption | Inject competing events at L1 (tab-switch, fake notification) + throttle observation frequency at L3 | Medium — proxy, not reproduction |
| Content / task | Pre-seeded per-persona session state at L2 (cookies, localStorage, account) | High for session state; server-side personalisation is give-up |
| Mood | None — prompt only | n/a |
| Language / style | None — prompt only (locale forces page language; style is LLM-side) | n/a |

### 8.2 Candidate *default* persona dimensions for v1 (smallest useful slice)

If R-08 (MVP scope) chooses a small slice, the following candidate set covers the dimensions where runtime reproduction is most reliable and most informative:

1. **Device / viewport persona** (mobile / desktop / tablet) — clean runtime reproduction, high information value (responsive design bugs).
2. **Locale persona** (en-US / ja-JP / ar-SA for RTL) — clean runtime reproduction, high information value (i18n bugs).
3. **Network persona** (broadband / slow-3G / offline) — clean runtime reproduction, high information value (performance UX).
4. **Color-vision persona** (none / deuteranopia / protanopia / tritanopia / achromatopsia) — clean runtime reproduction, high information value (accessibility UX).
5. **Visual-acuity persona** (sighted / accessibility-tree-only) — high information value for screen-reader UX.
6. **Working-memory persona** (full context / truncated) — medium-confidence runtime reproduction; tests how the agent copes with information density.

The remaining dimensions (motor, cognitive, distraction, mood, long-term memory, content / task) are **deferred to v2 or later** unless R-06 (persona generation) and R-07 (calibration) change the picture.

### 8.3 What u-sekai should *not* attempt in v1

- **Server-side personalisation reproduction** — u-sekai does not control back-end models.
- **Real-user-data-driven persona seeding at scale** — privacy / consent infrastructure is out of scope for v1; persona seeding should be rule-based or LLM-based (R-06).
- **Multimodal persona conditioning** (voice, video, gesture) — Web substrate does not yet support this as a first-class signal.
- **Genuine embodiment** (fatigue, tremor, attention drift over hours) — not reproducible; prompt-only approximations are not credible.

---

## 9. Open questions / follow-up items / unresolved consequential decisions

The following items surfaced during the investigation but require separate Issues or user escalation. They are recorded here so they are not lost, per the "do not block" rule.

1. **Which persona dimensions belong in v1?** This is consequential because it determines what the Synthetic User layer can claim to evaluate. R-08 will resolve it; R-03's candidate set is §8.2.
2. **Runtime-enforced personas need calibration methodology.** A CSS-filtered low-vision persona is only as good as its calibration against a real low-vision user on the same page. R-07 will design this; until then, runtime-enforced dimensions are unfalsifiable.
3. **Persona-conditioned memory capacity** is a non-trivial design question: the LLM's working memory is *also* the persona's working memory, so a persona with 3-item working memory cannot realistically do much. Needs design attention in R-06 / R-07.
4. **Server-side personalisation** is a hard give-up. Should u-sekai explicitly document this as "Synthetic Users evaluate front-end UX only, not back-end personalisation"? A public contract decision; user escalation candidate.
5. **Distraction / interruption / mood** are the dimensions with the *least* prior-art coverage. Should u-sekai attempt a v1 persona for these, or defer entirely? R-08 / R-06 will resolve; the gap is real either way.
6. **Cost of parallel runtime-enforced personas.** 100s / 1000s of Synthetic Users × per-persona isolated browser context × per-persona CDP throttle is not benchmarked. R-04 (environment) needs to address this.
7. **Reproducibility of runtime-enforced personas across model upgrades.** Persona-conditioned prompts drift across model versions; runtime-reproduce dimensions (viewport, locale, network, color) are more stable. Should u-sekai publish a "persona spec" version policy?
8. **Privacy of real-user data for persona seeding.** Stanford's 1,000-person simulation required 2-hour interviews with 1,052 participants (<https://arxiv.org/abs/2411.10109>). u-sekai does not have this infrastructure in the research / design phase; persona seeding must be rule-based or LLM-based until a privacy / consent decision is made.
9. **Accessibility-tree fidelity as a Synthetic User signal.** A "screen-reader user" persona that gets a *good* accessibility tree on a *bad* page is a useful signal. A screen-reader persona that gets a *bad* accessibility tree on a *bad* page is partially confounded (the failure is in the tree, not the page). Should u-sekai treat the accessibility-tree fidelity as a separate metric? Probably yes; needs an R-07 follow-up.

---

## 10. References

All URLs are listed for traceability. Vendor / blog / summary links are used only for orientation and clearly marked.

### Persona / agent architecture

- Park, J.S. et al. (2023). *Generative Agents: Interactive Simulacra of Human Behavior* — <https://arxiv.org/abs/2304.03442>; ACM/UIST: <https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763>; site: <https://generative-agents.stanford.edu/>
- Park, J.S. et al. (2024). *Generative Agent Simulations of 1,000 People* — <https://arxiv.org/abs/2411.10109>; HAI news: <https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy>; policy brief: <https://hai.stanford.edu/policy/simulating-human-behavior-with-ai-agents>
- Packer, C. et al. (2023). *MemGPT: Towards LLMs as Operating Systems* — <https://arxiv.org/abs/2310.08560>
- Letta (MemGPT project) — <https://www.letta.com/>; memory blog: <https://www.letta.com/blog/benchmarking-ai-agent-memory/>
- mem0 — orientation only.
- LangGraph — <https://www.langchain.com/langgraph>; <https://docs.langchain.com/oss/python/langgraph/overview>

### Persona-simulation surveys and individual-difference work

- *PersonaLLM-Survey: Two Tales of Persona in LLMs* (EMNLP 2024 Findings) — <https://github.com/MiuLab/PersonaLLM-Survey>
- *A Survey on LLM-based Persona Simulation* — <https://www.researchgate.net/publication/394395069_A_Survey_on_LLM-based_Persona_Simulation>
- *How Well Can Vision Language Models Simulate the Visual Perception of Individuals with Low Vision?* (ACM 2025) — <https://dl.acm.org/doi/full/10.1145/3663547.3759715>
- Patil et al. (Stanford, 2024) — personas vs. demographics gap — referenced via R-02 (link: <https://arxiv.org/abs/2402.18076>)
- *Validating Synthetic Users: A Multi-Dimensional Framework for LLM-Based Synthetic User Validation* (CHI 2024) — <https://dl.acm.org/doi/10.1145/3706599.3716271>; arXiv: <https://arxiv.org/abs/2408.00870>
- *Validation Methods for LLM-based Synthetic Users* — <https://arxiv.org/abs/2412.06047>
- *LLMs can downplay their cognitive abilities* (Milička et al., PMC) — <https://pmc.ncbi.nlm.nih.gov/articles/PMC10936766/>
- *Persona-prompted LLM agents achieve modest but …* (Nature Scientific Reports, 2026) — <https://www.nature.com/articles/s41598-026-66277-8>
- *Do LLMs Have Distinct and Consistent Personality? TRAIT* (NAACL 2025 Findings) — <https://aclanthology.org/2025.findings-naacl.469.pdf>
- *Patterns, Not People: Personality Structures in LLM-powered Persona Agents* (Turing Institute, 2025) — <https://cetas.turing.ac.uk/publications/patterns-not-people-personality-structures-llm-powered-persona-agents>
- *Challenging the Validity of Personality Tests for Large Language Models* (ACM 2025) — <https://dl.acm.org/doi/10.1145/3757887.3763016>
- *Adaptive Interviewing for Persona Simulation in LLMs* — <https://arxiv.org/html/2605.29458v1>
- First Workshop on LLM Persona Modeling (NeurIPS 2025) — <https://neurips.cc/virtual/2025/workshop/127829>

### Usability-testing LLM agents (the closest prior art to u-sekai's use case)

- *SimUser: Generating Usability Feedback by Simulating Various Users Interacting with Mobile Applications* (CHI 2024) — <https://dl.acm.org/doi/full/10.1145/3613904.3642481>
- *UXAgent: A System for Simulating Usability Testing of Web Applications* (2025) — <https://arxiv.org/html/2504.09407v2>; CHI 2025: <https://dl.acm.org/doi/10.1145/3706599.3719729>; GitHub: <https://github.com/yuxuan-liu-DL/UXAgent>
- *UXCascade: Scalable Usability Testing with Simulated Users* — <https://arxiv.org/html/2601.15777v1>
- *Large Language Models for the Simulation of Human …* (HAL) — <https://hal.science/hal-05484009v1/document>

### LLM attention / context window

- Liu, N.F. et al. (2023). *Lost in the Middle: How Language Models Use Long Contexts* — <https://arxiv.org/abs/2307.03172>; TACL: <https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00683/119631/>
- Anthropic — *Effective context engineering for AI agents* — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- *Cognitive Overload Attack: Prompt Injection for Long Context* — <https://arxiv.org/html/2410.11272v1>

### Substrate mechanisms (L1)

- Playwright accessibility testing — <https://playwright.dev/docs/accessibility-testing>
- Playwright `browser.newContext` / `devices` (orientation)
- `pyautogui` — <https://github.com/asweigart/pyautogui> (orientation)
- Chrome DevTools network throttling — <https://developer.chrome.com/docs/devtools/network/throttling>; <https://developer.chrome.com/docs/devtools/network/reference>
- MDN Network Information API — <https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API>

### Accessibility simulation tools

- Sim Daltonism (open-source macOS color-blindness simulator) — <https://michelf.ca/projects/sim-daltonism/>
- Funkify disability simulator (paid Chrome extension) — <https://www.funkify.org/>
- NoCoffee vision-impairment simulator (Chrome extension) — orientation only
- Spectrum color-blindness simulator (Chrome extension) — orientation only
- Web Disability Simulator (Chrome extension) — orientation only
- WebAIM WAVE — <https://wave.webaim.org/>
- axe DevTools / axe-core — <https://www.deque.com/axe/devtools/>
- Polypane — <https://polypane.app/>
- TPGi Color Contrast Analyser — <https://www.tpgi.com/color-contrast-checker/>
- Who Can Use — <https://www.whocanuse.com/>
- Accesstive disability-simulator overview — <https://accesstive.com/blog/disability-simulator/>
- Netz-Barrierefrei simulation of disability — <https://www.netz-barrierefrei.de/en/simulation.html>

### W3C / WCAG references (disability category frameworks)

- W3C WAI — *Diverse Abilities and Barriers* — <https://www.w3.org/WAI/people-use-web/abilities-barriers/>
- W3C Cognitive Accessibility — <https://www.w3.org/WAI/cognitive/>
- WCAG 2.1 — <https://www.w3.org/TR/WCAG21/>
- WCAG 2.2 overview (AbilityNet) — <https://abilitynet.org.uk/factsheets/what-you-need-know-about-wcag-22>
- WCAG 3.0 working draft — <https://www.w3.org/TR/wcag-3.0/>

### Predecessor documents

- R-01: *Survey of existing browser / computer-use agent ecosystems* — `docs/research-issues/r-01-browser-agent-survey.md`
- R-02: *Survey of existing research / benchmarks on synthetic user simulation* — `docs/research-issues/r-02-synthetic-user-survey.md`

### Other useful adjacent work

- *Simulating Human Satisfaction for the Evaluation of Task-Oriented Dialogue Systems* — <https://arxiv.org/html/2105.03748v1>
- *MetaSim: Metaphorical User Simulators for Evaluating Task-oriented Dialogue Systems* — <https://dl.acm.org/doi/full/10.1145/3596510>
- *What does it take to build a human-like user simulator?* (Jessy Lin, 2025) — <https://jessylin.com/2025/09/25/user-simulators-2/>
- *Generative User Simulators in Recommendation: A Survey* — <https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID7269678>
- *AutoEval / accessibility agent with screen-reader simulation* (test-lab.ai) — <https://www.test-lab.ai/blog/accessibility-testing-agent>
- *AI Accessibility Testing Tools 2026* (qaskills) — <https://qaskills.sh/blog/ai-accessibility-testing-tools-2026>
- *Automated Accessibility Testing with AI and axe-core* (test-lab.ai) — <https://www.test-lab.ai/blog/accessibility-testing-agent>

---

## 11. Self-check against the acceptance criterion

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| The runtime-reproduce / prompt-reproduce / give-up boundaries are documented | §4 (per-dimension inventory), §5 (the three-tier rule), §6 (layer-by-layer mechanism table), §8 (candidate set for v1) |

The acceptance criterion for R-03 is met. No adoption decisions are recorded. No implementation, configuration, or CI is introduced. All recommendations use **candidate** language; nothing is "decided" or "planned specification".
