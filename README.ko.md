# u-sekai

[English](./README.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | **한국어**

> 이 문서는 [README.md](./README.md)의 한국어 번역입니다. 프로젝트 사양과 상태의 canonical source는 영어 README입니다. 내용이 다를 경우 영어판을 우선합니다.

[![CI](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml/badge.svg)](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/rebuildup/u-sekai?branch=main&label=version)](https://github.com/rebuildup/u-sekai/blob/main/package.json)
[![License](https://img.shields.io/github/license/rebuildup/u-sekai)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**capability boundary가 적용된 Synthetic User를 이용한 탐색적 UX 평가 연구 인프라입니다.**

현재 릴리스는 다음 **functional vertical slice**를 제공합니다.

```text
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

> **Synthetic User는 실제 사용자가 아닙니다.** 이 프로젝트는 연구 목적의 시뮬레이션 participant를 생성합니다. 결과는 탐색적 신호이며 실제 인간 행동의 측정값이 아닙니다. 자세한 제한은 [`docs/non-reality.md`](./docs/non-reality.md)를 참고하세요.

---

## Vision

프로젝트의 개념적 방향은 [`docs/vision.md`](./docs/vision.md)에 정리되어 있습니다.

현재 구현 선택을 영구적인 제품 정체성으로 고정하지 않으면서 capability-constrained Synthetic User, open-ended exploration, participant의 주관적 증거, generative evaluation을 장기 방향으로 정의합니다.

## u-sekai가 실제로 하는 일

- JSON 파일에서 `ExperimentDefinition`을 읽습니다.
- 각 participant profile에 대해 내부 루프를 실행합니다.
  - 대상 환경을 **capability-filtered** 관측으로만 봅니다.
  - Reasoner가 볼 수 있는 memory window를 **runtime에서 강제**합니다.
  - Reasoner가 다음 action을 선택합니다.
  - action을 환경에 전달하기 전에 명시적인 **runtime allowlist**로 검증합니다.
  - participant가 실제로 보유한 memory만 사용하여 structured self-report를 생성합니다.
- participant와 별도의 컨텍스트에서 **independent observer**를 실행하고 동일한 trace로부터 별도 machine-readable report를 생성합니다.
- 각 run마다 `manifest.json`, `events.ndjson`, `observations/*.json`, `self-report/*.json`, `observer-report.json`, `result.json`, `summary.md`를 포함하는 self-describing artifact directory를 저장합니다.

fresh clone에서 외부 API key 없이도 내장된 로컬 Web 환경으로 전체 흐름을 재현할 수 있습니다.

## Quick Start

Node.js >= 20이 필요합니다(Node 24에서 검증).

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

`demo-`로 시작하는 디렉터리가 만들어지고 그 안에 `manifest.json`, `events.ndjson`, `observations/`, `self-report/`, `observer-report.json`, `result.json`, `summary.md`가 생성됩니다.

### Live smoke (실제 모델)

기본 scripted reasoner는 API key가 필요하지 않습니다. 실제 provider를 사용할 때:

```bash
export ANTHROPIC_API_KEY=...
node dist/cli/index.js run test/fixtures/experiment.task-tracker.json \
  --reasoner anthropic \
  --observer-reasoner anthropic \
  --adapter http \
  --out runs
```

CLI는 API key를 artifact에 저장하지 않습니다. 자세한 내용은 ADR-0005를 참고하세요.

### CLI

```text
u-sekai run <experiment.json> [flags]
u-sekai validate <experiment.json>
u-sekai --version | --help

Flags (run):
  --adapter http|playwright   Browser adapter. Default: http.
  --out <dir>                 Artifact directory.
  --reasoner <provider>       scripted | anthropic
  --observer-reasoner <prov>  scripted | anthropic
```

종료 코드:

| Code | 의미 |
| --- | --- |
| 0 | 성공 |
| 1 | experiment validation / CLI error |
| 2 | adapter / provider runtime error |
| 3 | participant run 중 capability violation |

### Quality gate

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run ci
```

CI에는 외부 LLM API key가 필요하지 않습니다.

### Version source of truth

`package.json#version`이 canonical release version입니다. CLI와 run artifact가 이 값을 직접 읽고, CI는 release branch 이름이 이 값과 일치하는지 검사합니다. README의 version badge도 GitHub의 같은 필드를 읽습니다.

`npm run version:check`으로 package-lock과 release branch 정합성을 검증할 수 있습니다.

---

## Experiment config 예시

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

실제 experiment에서는 `participants`, `userStory`, `budget`, `reasoner`, `observer`, `seed`, `environment`를 바꿀 수 있습니다.

`capability`는 participant 간 차이를 role-play prompt가 아니라 **runtime의 실제 차이**로 만드는 축입니다. 자세한 내용은 ADR-0006을 참고하세요.

---

## Synthetic User capability boundary

participant runtime은 세 가지 capability axis를 강제합니다(ADR-0006).

| 축 | 값 | 강제 위치 |
| --- | --- | --- |
| `observation` | `visual` / `visualPlusAria` | `src/capability/observation-filter.ts` |
| `action` | `visualOnly` | `src/capability/action-allowlist.ts` |
| `memory` | `fullHistory` / `limitedRecent{N}` | `src/capability/memory-controller.ts` |

profile, prompt, Reasoner 출력과 관계없이 participant는 다음에 직접 접근할 수 없습니다.

- privileged adapter internals (full DOM / ARIA tree / console / network log)
- selector-based clicking
- `page.evaluate(() => ...)` 형태의 JavaScript 실행
- capability가 허용하지 않은 내부 관측 정보

**observer**는 participant와 별도 컨텍스트에서 실행됩니다. observer는 전체 trace를 볼 수 있지만 participant memory에는 접근하지 않습니다. `docs/architecture.md`, ADR-0006, ADR-0007을 참고하세요.

---

## Output artifact

```text
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

`manifest.json`에는 run seed, reasoner / model id, target URL, participant별 capability profile, package version, termination reason이 기록됩니다. API key는 저장하지 않습니다.

---

## Architecture overview

```text
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

전체 boundary 설명은 [`docs/architecture.md`](./docs/architecture.md), 장기 설계 결정은 [`docs/adr/`](./docs/adr/)를 참고하세요.

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
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ eslint.config.js
├─ src/
├─ test/
├─ docs/
├─ .github/workflows/
└─ .claude/skills/
```

## 현재 제한 / non-goals

- real-user calibration, generative benchmark, baseline-vs-candidate scoring, universal UX score, accessibility simulation, 고급 cognitive / forgetting model, 자동 persona generation, multi-provider matrix, desktop / mobile, GUI dashboard, Firecracker / Kubernetes / distributed execution, 대규모 병렬 population execution은 의도적으로 후속 작업으로 미룹니다.
- real Playwright + real LLM은 구현되어 있지만 CI에는 포함되지 않습니다. CI는 scripted reasoner + HTTP adapter를 사용하며 실제 모델 검증은 manual live-smoke workflow로 수행합니다.
- deterministic E2E는 Node의 localhost port allocation과 demo HTTP server에 의존합니다. 테스트 파일 간 port collision을 피하기 위해 Vitest의 `pool: 'forks'`를 사용합니다.

## Contributing

[`CONTRIBUTING.md`](./CONTRIBUTING.md)를 참고하세요. 구현 contribution을 받고 있으며 durable Issue per ticket workflow를 따릅니다. behavioral change에는 관련 ADR 또는 Issue 업데이트가 함께 포함되어야 합니다.

## AI agent 사용

dispatcher / contributor는 [`CLAUDE.md`](./CLAUDE.md)를 따릅니다. Skill은 `.claude/skills/`에 있으며 [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md)에 기록된 upstream revision에 고정되어 있습니다.
