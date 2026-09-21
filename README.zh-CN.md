# u-sekai

[English](./README.md) | [日本語](./README.ja.md) | **简体中文** | [한국어](./README.ko.md)

> 本文档是 [README.md](./README.md) 的简体中文翻译。英文版是项目规范与状态的 canonical source；如有差异，请以英文版为准。

[![CI](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml/badge.svg)](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/rebuildup/u-sekai?branch=main&label=version)](https://github.com/rebuildup/u-sekai/blob/main/package.json)
[![License](https://img.shields.io/github/license/rebuildup/u-sekai)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**面向能力受限 Synthetic User 的探索式用户体验评估研究基础设施。**

当前版本提供一个可运行的 **functional vertical slice**：

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

> **Synthetic User 不是真实用户。** 本项目生成用于研究的模拟参与者。输出应被视为探索信号，而不是对真实人类行为的测量。请参阅 [`docs/non-reality.md`](./docs/non-reality.md)。

---

## Vision

项目的概念核心记录在 [`docs/vision.md`](./docs/vision.md)。

它定义了能力约束的 Synthetic User、开放式探索、参与者主观证据和生成式评估等长期方向，同时避免把当前实现选择永久固化为产品身份。

## u-sekai 实际做什么

- 从 JSON 文件加载 `ExperimentDefinition`。
- 对每个 participant profile 运行内部循环：
  - 只通过 **capability-filtered** 的视角观察目标环境；
  - 在 runtime 中强制限制 Reasoner 可见的 memory window；
  - 由 Reasoner 决定下一步动作；
  - 在动作交给环境之前，通过明确的 **runtime allowlist** 验证；
  - 仅基于 participant 自身保留的 memory 生成 structured self-report。
- 在独立上下文中运行 **independent observer**，读取同一 trace 并输出独立的 machine-readable report。
- 每次 run 都保存自描述 artifact directory，包括 `manifest.json`、`events.ndjson`、`observations/*.json`、`self-report/*.json`、`observer-report.json`、`result.json` 和 `summary.md`。

fresh clone 后，不需要外部 API key 即可在自带的本地 Web 环境中复现完整流程。

## Quick Start

需要 Node.js >= 20（已在 Node 24 上验证）。

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

预期会生成一个以 `demo-` 开头的目录，其中包含 `manifest.json`、`events.ndjson`、`observations/`、`self-report/`、`observer-report.json`、`result.json` 和 `summary.md`。

### Live smoke（真实模型）

默认 scripted reasoner 不需要 API key。使用真实 provider 时：

```bash
export ANTHROPIC_API_KEY=...
node dist/cli/index.js run test/fixtures/experiment.task-tracker.json \
  --reasoner anthropic \
  --observer-reasoner anthropic \
  --adapter http \
  --out runs
```

CLI 不会把 API key 写入 artifact。详见 ADR-0005。

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

退出码：

| Code | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | experiment validation / CLI error |
| 2 | adapter / provider runtime error |
| 3 | participant run 中发生 capability violation |

### Quality gate

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run ci
```

CI 不需要任何外部 LLM API key。

### Version source of truth

`package.json#version` 是 canonical release version。CLI 和 run artifact 直接读取此值，CI 会检查 release branch 名与其一致，README 的 version badge 也读取同一字段。

运行 `npm run version:check` 可以验证 package-lock 与 release branch 的同步状态。

---

## Experiment config 示例

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

实际 experiment 可以覆盖 `participants`、`userStory`、`budget`、`reasoner`、`observer`、`seed` 和 `environment`。

`capability` 是让 participant 之间产生 **runtime 级真实差异** 而不是仅靠 role-play prompt 的关键轴。详见 ADR-0006。

---

## Synthetic User capability boundary

participant runtime 强制执行三个能力轴（ADR-0006）：

| 轴 | 值 | 强制位置 |
| --- | --- | --- |
| `observation` | `visual` / `visualPlusAria` | `src/capability/observation-filter.ts` |
| `action` | `visualOnly` | `src/capability/action-allowlist.ts` |
| `memory` | `fullHistory` / `limitedRecent{N}` | `src/capability/memory-controller.ts` |

无论 profile、prompt 或 Reasoner 输出如何，participant 都无法直接访问：

- privileged adapter internals（full DOM / ARIA tree / console / network log）
- selector-based clicking
- `page.evaluate(() => ...)` 形式的 JavaScript 执行
- capability 未授权的内部观测信息

**observer** 与 participant 运行在独立上下文中。observer 可以读取完整 trace，但看不到 participant memory。详见 `docs/architecture.md`、ADR-0006 和 ADR-0007。

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

`manifest.json` 记录 run seed、reasoner / model id、target URL、每个 participant 的 capability profile、package version 和 termination reason。不会保存 API key。

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

完整边界说明见 [`docs/architecture.md`](./docs/architecture.md)，长期设计决策见 [`docs/adr/`](./docs/adr/)。

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

## 当前限制 / non-goals

- real-user calibration、generative benchmark、baseline-vs-candidate scoring、universal UX score、accessibility simulation、高级 cognitive / forgetting model、自动 persona generation、multi-provider matrix、desktop / mobile、GUI dashboard、Firecracker / Kubernetes / distributed execution、大规模并行 population execution 都明确推迟到后续阶段。
- real Playwright + real LLM 已实现，但不属于 CI。CI 使用 scripted reasoner + HTTP adapter；真实模型通过 manual live-smoke workflow 验证。
- deterministic E2E 依赖 Node 的 localhost port allocation 和 demo HTTP server。为避免测试文件之间的端口冲突，Vitest 使用 `pool: 'forks'`。

## Contributing

参阅 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。项目已接受实现贡献，请遵循 durable Issue per ticket 的 workflow。behavioral change 应同时更新相应 ADR 或 Issue。

## AI agent 使用

dispatcher / contributor 应遵循 [`CLAUDE.md`](./CLAUDE.md)。Skill 位于 `.claude/skills/`，并固定到 [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) 中记录的 upstream revision。
