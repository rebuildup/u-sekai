# u-sekai

**A research infrastructure for exploratory user-experience evaluation by capability-constrained Synthetic Users.**

0.1.0 ships a **functional vertical slice**:

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

## What u-sekai actually does in 0.1.0

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

Expected: a directory whose name starts with `demo-0.1.0-` containing
`manifest.json`, `events.ndjson`, `observations/`, `self-report/`,
`observer-report.json`, `result.json`, and `summary.md`.

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

### Quality gate

```bash
npm run lint       # eslint flat config
npm run typecheck  # tsc --noEmit
npm run test       # vitest: unit + integration + e2e
npm run build      # tsc emit to dist/
npm run ci         # all of the above, in order
```

No external LLM API key is required to pass CI.

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
  "seed": "demo-0.1.0"
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
├─ CONTRIBUTING.md
├─ LICENSE
├─ package.json
├─ tsconfig.json         (typecheck: src + test)
├─ tsconfig.build.json   (tsc emit: src -> dist)
├─ vitest.config.ts      (test runner: unit + integration + e2e)
├─ eslint.config.js      (lint)
├─ src/                  (implementation)
├─ test/
│  ├─ unit/              (capability, scripted reasoner, loader, recorder)
│  ├─ integration/       (demo server + scripted full run)
│  ├─ e2e/               (CLI child process)
│  └─ fixtures/
├─ docs/
│  ├─ adr/               (ADR-0001 ... ADR-0007)
│  ├─ architecture.md
│  ├─ non-reality.md
│  └─ research-issues/
├─ .github/workflows/
│  ├─ ci.yml             (lint+type+test+build, no external API)
│  └─ manual-live-smoke.yml  (workflow_dispatch, uses ANTHROPIC_API_KEY)
└─ .claude/skills/       (project-local Skills, pinned upstream)
```

## Current limitations / non-goals

- **Calibration against real users, generative benchmarks, baseline-vs-candidate scoring, universal UX scores, accessibility simulation, advanced cognitive / forgetting models, automatic persona generation, multi-provider matrix, desktop / mobile, GUI dashboard, Firecracker / Kubernetes / distributed execution, large-scale parallel population execution**: all deliberately deferred. See [`docs/research-issues/`](./docs/research-issues/) for the underlying research backlog.
- **Real Playwright + real LLM**: shipped but not part of CI. CI runs scripted reasoner + HTTP adapter only. A manual live-smoke workflow is provided.
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
