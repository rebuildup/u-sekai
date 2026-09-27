# u-sekai

**English** | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | [한국어](./README.ko.md)

> English is the canonical README. Translations follow this file and must not introduce independent specification.

[![CI](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml/badge.svg)](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml)
[![Browser smoke](https://github.com/rebuildup/u-sekai/actions/workflows/browser-smoke.yml/badge.svg)](https://github.com/rebuildup/u-sekai/actions/workflows/browser-smoke.yml)
[![Version](https://img.shields.io/github/package-json/v/rebuildup/u-sekai?branch=main&label=version)](https://github.com/rebuildup/u-sekai/blob/main/package.json)
[![License](https://img.shields.io/github/license/rebuildup/u-sekai)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**A research infrastructure for exploratory user-experience evaluation by capability-constrained Synthetic Users.**

The current release ships a **functional vertical slice**:

```
experiment definition
    -> target Web environment launched
    -> Synthetic User initialised with a runtime capability profile
    -> constrained observation captured
    -> Reasoner chooses next action
    -> action validated against the runtime allowlist
    -> action executed via the constrained adapter
    -> new observation
    -> ... loop ...
    -> termination (step budget / failure / finish)
    -> participant self-report
    -> independent observer evaluation
    -> machine-readable result + human-readable summary
    -> run/ artifact directory on disk
```

> **Synthetic Users are not real users.** This project generates simulated
> participants for research purposes. Outputs are exploratory signals,
> not measurements of human behaviour. See
> [`docs/non-reality.md`](./docs/non-reality.md) for the explicit
> disclaimer.

---

## Vision

The project's conceptual thesis is documented in [`docs/vision.md`](./docs/vision.md).
It describes capability-constrained Synthetic Users, open-ended exploration,
subjective participant evidence, and generative evaluation without making the
current implementation choices part of the permanent product identity.

## What u-sekai actually does

- Loads an `ExperimentDefinition` from a JSON file.
- For each participant profile, runs an inner loop that:
  - observes the target environment through a **capability-filtered** lens,
  - builds a Reasoner request whose memory window is **runtime-enforced**,
  - lets a Reasoner choose the next action,
  - validates the action against an explicit **runtime allowlist** before
    passing it to the environment,
  - emits a structured self-report using the participant's own memory.
- Runs an **independent observer** on the same trace; outputs findings
  as a separate, machine-readable report.
- Persists a self-describing artifact directory per run
  (`manifest.json`, `events.ndjson`, per-step `observations/*.json`,
  `self-report/*.json`, `observer-report.json`, `result.json`,
  `summary.md`).

A fresh clone can reproduce the full flow on a self-contained local
Web environment without any external API key.

## Quick Start (fresh clone)

Requires Node.js >= 20 (tested on Node 24).

```bash
git clone https://github.com/rebuildup/u-sekai.git
cd u-sekai
npm ci
npm run build
node dist/cli/index.js run test/fixtures/experiment.task-tracker.json \
  --reasoner scripted \
  --observer-reasoner scripted \
  --adapter http \
  --out runs
ls runs
```

Expected: a directory whose name starts with `demo-` containing
`manifest.json`, `events.ndjson`, `observations/`, `self-report/`,
`observer-report.json`, `result.json`, and `summary.md`.

### Browser path (real Chromium)

The run above is the deterministic HTTP path and needs no browser. To drive
a real Chromium through the same pipeline, install the browser runtime once
and then run the browser gate and the CLI:

```bash
npx playwright install --with-deps chromium
npm run test:browser
node dist/cli/index.js run test/fixtures/experiment.task-tracker.browser.json \
  --adapter playwright \
  --reasoner scripted \
  --observer-reasoner scripted \
  --out runs
```

The browser suite is deliberately **excluded from `npm test`** so that the
default gate stays fast and needs no browser installed. See
[`docs/browser-runtime.md`](./docs/browser-runtime.md) for the runtime
requirements, the artifact layout, and the troubleshooting paths when a
host is missing Chromium's system libraries.

### Live smoke (real Anthropic model)

The default scripted reasoner needs no API key. To use the real provider:

```bash
export ANTHROPIC_API_KEY=...
node dist/cli/index.js run test/fixtures/experiment.task-tracker.json \
  --reasoner anthropic \
  --observer-reasoner anthropic \
  --adapter http \
  --out runs
```

The CLI never stores the API key in the artifact. See ADR-0005.

The live-provider path is not covered by any automated gate and was **not
exercised during 0.2.0 development** — no API key was available, so no claim
is made about its behaviour.

### CLI

```
u-sekai run <experiment.json> [flags]
u-sekai validate <experiment.json>
u-sekai --version | --help

Flags (run):
  --adapter http|playwright   Browser adapter. Default: http.
  --out <dir>                 Artifact directory.
  --reasoner <provider>       scripted | anthropic
  --observer-reasoner <prov>  scripted | anthropic
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | experiment validation / CLI error |
| 2 | adapter / provider runtime error |
| 3 | capability violation during a participant run |

A participant can also terminate as `reasonerFailure`, when a Reasoner
structured-output failure is recoverable but exhausted. It is recorded as a
`reasoner.failure` evidence event and is deliberately **distinct** from
`capabilityViolation`, so a provider defect is never reported as a
participant capability defect; see ADR-0008. Only a real
`capabilityViolation` maps to exit code 3 — a `reasonerFailure` alone still
exits 0.

### Quality gate

```bash
npm run lint          # eslint flat config
npm run typecheck     # tsc --noEmit
npm run test          # vitest: unit + integration + e2e
npm run test:browser  # vitest: the Playwright suite; needs the browser runtime
npm run build         # tsc emit to dist/
npm run ci            # lint, typecheck, version:check, build, test
```

`npm run test:browser` is **not** part of `npm test` or `npm run ci`: it needs
a Playwright Chromium install (`npx playwright install --with-deps chromium`),
so the default gate stays fast and browser-free. See
[`docs/browser-runtime.md`](./docs/browser-runtime.md).

No external LLM API key is required to pass CI.

### Version source of truth

`package.json#version` is the canonical release version. The CLI and run
artifacts read it directly, the release branch name is checked against it in
CI, and the README version badge reads the same field from GitHub. Run
`npm run version:check` to verify package-lock and release-branch alignment.

After `release-x-y-z -> main` is merged, the same field becomes the release
identity: `npm run release:publish` tags the release commit `v<version>` and
creates the matching GitHub Release. See
[`docs/release-process.md`](./docs/release-process.md).

---

## Example experiment config

```jsonc
{
  "id": "demo-task-tracker",
  "environment": { "kind": "demo", "app": "task-tracker" },
  "userStory": "You have several things due tomorrow. You are using this service for the first time. You want to get organised quickly.",
  "participants": [
    {
      "id": "p-visual-short-memory",
      "personaPrompt": "...",
      "capability": {
        "observation": "visual",
        "action": "visualOnly",
        "memory": { "kind": "limitedRecent", "windowSteps": 2 }
      },
      "reasoner": { "provider": "scripted", "seed": "alpha" }
    },
    {
      "id": "p-full-history",
      "personaPrompt": "...",
      "capability": {
        "observation": "visualPlusAria",
        "action": "visualOnly",
        "memory": { "kind": "fullHistory" }
      },
      "reasoner": { "provider": "scripted", "seed": "beta" }
    }
  ],
  "budget": { "maxStepsPerParticipant": 6 },
  "observer": { "provider": "scripted", "seed": "observer" },
  "outDir": "./runs",
  "seed": "demo"
}
```

A real experiment can override `participants`, `userStory`, `budget`,
`reasoner`, `observer`, `seed`, `environment`. The `capability` axis is
the lever that makes two participants **actually different** at the
runtime layer: see ADR-0006.

---

## Synthetic User capability boundary

The participant runtime enforces three capability axes (ADR-0006):

| Axis | Values | Enforced where |
| --- | --- | --- |
| `observation` | `visual` / `visualPlusAria` | `src/capability/observation-filter.ts` |
| `action` | `visualOnly` | `src/capability/action-allowlist.ts` |
| `memory` | `fullHistory` / `limitedRecent{N}` | `src/capability/memory-controller.ts` |

**What a participant can never reach, regardless of profile, prompt, or
Reasoner output:**

- the privileged adapter internals (full DOM / ARIA tree / console /
  network log),
- selector-based clicking,
- `page.evaluate(() => ...)` style JavaScript execution,
- per-step interior observability beyond what its capability grants.

The **observer** runs in a separate context from the participant; it
sees the full trace but never sees participant memory. See
`docs/architecture.md` and ADRs 0006 / 0007.

---

## Output artifact

```
runs/<runId>/
  manifest.json
  participants.json
  events.ndjson
  observations/<participantId>/step-NNN.json
  screenshots/<participantId>/step-NNN.png     (Playwright adapter only)
  self-report/<participantId>.json
  observer-report.json
  result.json
  summary.md
```

`manifest.json` records the run seed, reasoner / model id, target URL,
capability profiles per participant, package version, and termination
reasons. No API keys are written.

---

## Architecture overview

```
domain/                  pure-typed vocabulary; no third-party imports
capability/              runtime-enforced observation / action / memory
reasoner/                Reasoner interface + scripted + anthropic
adapter/browser/         HttpAdapter + PlaywrightAdapter (constrained)
participant/             inner loop + self-report (memory-controlled)
observer/                independent observer (full trace, no memory)
evidence/                append-only recorder + on-disk artifact layout
experiment/              runner + loader
demo/environment/        self-contained demo Web app + server
cli/                     entry point (u-sekai <cmd>)
```

See [`docs/architecture.md`](./docs/architecture.md) for the full
boundary description and [`docs/adr/`](./docs/adr/) for the recorded
decisions.

## Repository layout

```text
.
├─ README.md
├─ README.ja.md
├─ README.zh-CN.md
├─ README.ko.md
├─ CONTRIBUTING.md
├─ LICENSE
├─ package.json
├─ tsconfig.json         (typecheck: src + test)
├─ tsconfig.build.json   (tsc emit: src -> dist)
├─ vitest.config.ts      (test runner: unit + integration + e2e)
├─ test/vitest.browser.config.ts (test runner: browser)
├─ eslint.config.js      (lint)
├─ src/                  (implementation)
├─ test/
│  ├─ unit/              (capability, scripted reasoner, loader, recorder)
│  ├─ integration/       (demo server + scripted full run)
│  ├─ e2e/               (CLI child process)
│  ├─ browser/           (Playwright adapter, full run, leak checks)
│  └─ fixtures/
├─ docs/
│  ├─ adr/               (ADR-0001 ... ADR-0010)
│  ├─ architecture.md
│  ├─ browser-runtime.md (Playwright / Chromium requirements)
│  ├─ non-reality.md
│  ├─ release-process.md (ticket -> tag -> GitHub Release)
│  └─ research-issues/
├─ .github/workflows/
│  ├─ ci.yml             (lint+type+test+build, no external API)
│  ├─ browser-smoke.yml  (real Chromium smoke, no external API)
│  ├─ release-source-check.yml (release branch name vs package version)
│  ├─ release-publish.yml     (tag + GitHub Release publication)
│  └─ manual-live-smoke.yml  (workflow_dispatch, uses ANTHROPIC_API_KEY)
└─ .claude/skills/       (project-local Skills, pinned upstream)
```

## Current limitations / non-goals

- **Calibration against real users, generative benchmarks, baseline-vs-candidate scoring, universal UX scores, accessibility simulation, advanced cognitive / forgetting models, automatic persona generation, multi-provider matrix, desktop / mobile, GUI dashboard, Firecracker / Kubernetes / distributed execution, large-scale parallel population execution**: all deliberately deferred. See [`docs/research-issues/`](./docs/research-issues/) for the underlying research backlog.
- **Real LLM**: not part of any automated gate. `ci.yml` and `browser-smoke.yml` both run the deterministic scripted reasoner; a manual live-smoke workflow is provided. No API key was available during 0.2.0 development, so the live-provider path is unverified.
- **Real Playwright**: gated, but by a separate workflow. `ci.yml` stays HTTP-only so the default gate needs no browser; `browser-smoke.yml` is the real-Chromium gate. See [`docs/browser-runtime.md`](./docs/browser-runtime.md).
- **Deterministic E2E**: depends on Node's localhost port allocation and the demo HTTP server; we run it under `vitest` with `pool: 'forks'` to avoid port collisions between files.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Implementation contributions
are now accepted; please follow the durable-Issue-per-ticket workflow
described there. Behavioural changes should land with a corresponding
ADR or Issue update.

## AI-agent use

Dispatchers and contributors rely on [`CLAUDE.md`](./CLAUDE.md). Skills
live under `.claude/skills/` and are pinned to a specific upstream
revision recorded in [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md).
