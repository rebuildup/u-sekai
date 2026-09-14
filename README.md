# u-sekai

**A research infrastructure for exploratory user-experience evaluation by Synthetic Users — currently in research / design phase.**

---

## The problem this project addresses

Traditional E2E tests for web / app products focus on covering **predefined happy paths** and detecting regressions against **known flows**. They generally cannot evaluate:

- Unexpected or out-of-spec user actions
- Misconceptions and mistakes users actually make
- Individual differences in capability, perception, attention, memory, preference, and situation
- Subjective UX (clarity, confusion, delight, distrust, frustration, etc.)

These phenomena are hard to enumerate as scenarios and rarely admit a single "correct" answer — so they fall through the cracks of both E2E suites and usability tests.

## Exploratory evaluation by Synthetic Users

This repository aims to build a **general-purpose infrastructure that drives Synthetic Users — AI agents standing in for human users with diverse capabilities, perceptions, operating environments, memories, preferences, and situations — to independently explore digital environments** (initially Web) in a way that approximates real user behavior.

The long-term direction is to extract, from these explorations:

- Unanticipated operation paths
- Errors, dead-ends, and friction
- Subjective reports (rating, reflection, free-form feedback)
- Observable indicators (task success, time-on-task, cognitive load proxies, etc.)

## What this project is NOT

- **Not a replacement for fixed E2E tests.** Existing E2E / integration suites continue to own spec-compliance verification.
- **Not a regression suite for canonical happy paths.**
- **Not a production traffic replay / monitoring tool.**
- **Not a test tool locked to one Web framework or SaaS.**
- **Not a place to commit undecided items as "planned specification".** Language / framework / runtime / SDK / browser automation / agent SDK / model / architecture / directory layout remain open and will be settled by the research Issues below.

## Initial scope and reach

- The **initial target** is **Web** (browser-driven environments).
- The concept itself is **not Web-limited**. Future extension to desktop / mobile / CLI / API is conceptually allowed but **not designed for yet**.
- The eventual scope depends on what the research phase concludes.

## Current status

This repository is in **research / design phase**.

- Implementation has not started.
- Architecture, technology selection, directory structure, package layout, language, framework, and infrastructure are **undecided**.
- Undecided items are not described as "adopted" or "planned specification".
- Draft research questions live in [`docs/research-issues/`](./docs/research-issues/). They will be opened as GitHub Issues over time.

## Repository layout (current)

```text
.
├─ README.md                 # this file
├─ LICENSE                   # MIT
├─ CONTRIBUTING.md           # contribution policy (research / design phase)
├─ CLAUDE.md                 # project-local policy for AI coding agents
├─ .gitignore
├─ docs/
│   ├─ research-issues/      # draft research question Issues
│   └─ rebuildup-pin.md      # pinned rebuildup/project-init source
├─ .github/
│   └─ ISSUE_TEMPLATE/       # issue templates
└─ .claude/
   └─ skills/                # Agent Skills (progressive disclosure)
```

The directory layout is **subject to change** as research and design progress. Nothing here is locked in.

## Contributing / joining the discussion

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Discussion is routed through **GitHub Issues** as the durable source of truth (workflow details in [`CONTRIBUTING.md`](./CONTRIBUTING.md)).
Implementation contributions are **not yet accepted**. Contributions in the form of new research questions, refinements of existing drafts, and pointers to relevant literature / OSS / benchmarks are welcome.

## AI-agent use

AI coding agents working in this repository must read [`CLAUDE.md`](./CLAUDE.md) first and follow the project-local policy there.

## License

MIT — see [`LICENSE`](./LICENSE).