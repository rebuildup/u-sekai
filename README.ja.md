# u-sekai

[English](./README.md) | **日本語** | [简体中文](./README.zh-CN.md) | [한국어](./README.ko.md)

> この文書は [README.md](./README.md) の日本語訳です。仕様・プロジェクト状態の canonical source は英語版です。差異がある場合は英語版を優先してください。

[![CI](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml/badge.svg)](https://github.com/rebuildup/u-sekai/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/rebuildup/u-sekai?branch=main&label=version)](https://github.com/rebuildup/u-sekai/blob/main/package.json)
[![License](https://img.shields.io/github/license/rebuildup/u-sekai)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**能力境界を持つ Synthetic User による探索的UX評価のための研究基盤です。**

現在のリリースでは、次の **functional vertical slice** が動作します。

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

> **Synthetic User は実在のユーザーではありません。** このプロジェクトは研究用のシミュレートされた参加者を生成します。出力は探索のためのシグナルであり、人間行動の測定値ではありません。明示的な注意事項は [`docs/non-reality.md`](./docs/non-reality.md) を参照してください。

---

## Vision

u-sekai の概念的な中核は [`docs/vision.md`](./docs/vision.md) に記録されています。

現在の実装方式そのものを恒久的なプロダクトアイデンティティにせず、能力制約付き Synthetic User、オープンエンドな探索、参加者の主観的証拠、生成的評価という方向性を定義しています。

## u-sekai が実際に行うこと

- JSON ファイルから `ExperimentDefinition` を読み込みます。
- 各 participant profile ごとに内部ループを実行します。
  - **capability-filtered** な観測だけを対象環境から取得します。
  - Reasoner に渡す memory window を **runtime で強制**します。
  - Reasoner が次の操作を決めます。
  - 環境へ渡す前に、操作を明示的な **runtime allowlist** で検証します。
  - participant 自身が保持している memory だけを使って structured self-report を生成します。
- 同じ trace を、participant とは別コンテキストの **independent observer** が評価し、machine-readable な report として保存します。
- run ごとに自己記述的な artifact directory を保存します（`manifest.json`, `events.ndjson`, `observations/*.json`, `self-report/*.json`, `observer-report.json`, `result.json`, `summary.md`）。

fresh clone から、外部APIキーなしで自己完結したローカルWeb環境に対して全フローを再現できます。

## Quick Start

Node.js >= 20 が必要です（Node 24 で検証）。

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

`demo-` で始まるディレクトリが作成され、その中に `manifest.json`, `events.ndjson`, `observations/`, `self-report/`, `observer-report.json`, `result.json`, `summary.md` が生成されます。

### Live smoke（実モデル）

標準の scripted reasoner にはAPIキーは不要です。実プロバイダーを使用する場合:

```bash
export ANTHROPIC_API_KEY=...
node dist/cli/index.js run test/fixtures/experiment.task-tracker.json \
  --reasoner anthropic \
  --observer-reasoner anthropic \
  --adapter http \
  --out runs
```

CLI は API key を artifact に保存しません。詳細は ADR-0005 を参照してください。

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

終了コード:

| Code | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | experiment validation / CLI error |
| 2 | adapter / provider runtime error |
| 3 | participant run 中の capability violation |

### Quality gate

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run ci
```

CI の通過に外部LLM APIキーは不要です。

### Version の source of truth

`package.json#version` が canonical release version です。CLI と run artifact はこの値を直接読み、release branch 名も CI でこの値と照合されます。README の version badge も GitHub 上の同じ値を表示します。

`npm run version:check` で package-lock と release branch の整合性を検証できます。

---

## Experiment config の例

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

実際の experiment では `participants`, `userStory`, `budget`, `reasoner`, `observer`, `seed`, `environment` を変更できます。

`capability` が participant 間の差を role-play ではなく **runtime 上の実際の差**として作る軸です。詳細は ADR-0006 を参照してください。

---

## Synthetic User の capability boundary

participant runtime は3つの能力軸を runtime で強制します（ADR-0006）。

| 軸 | 値 | 強制箇所 |
| --- | --- | --- |
| `observation` | `visual` / `visualPlusAria` | `src/capability/observation-filter.ts` |
| `action` | `visualOnly` | `src/capability/action-allowlist.ts` |
| `memory` | `fullHistory` / `limitedRecent{N}` | `src/capability/memory-controller.ts` |

profile・prompt・Reasoner出力にかかわらず、participant は次へ直接到達できません。

- privileged adapter internals（full DOM / ARIA tree / console / network log）
- selector を直接指定するクリック
- `page.evaluate(() => ...)` のような JavaScript 実行
- capability が許可していない内部観測情報

**observer** は participant と別コンテキストで動作します。observer は完全な trace を参照できますが participant memory は参照しません。詳細は `docs/architecture.md` と ADR-0006 / ADR-0007 を参照してください。

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

`manifest.json` には run seed、reasoner / model id、target URL、participant ごとの capability profile、package version、termination reason が保存されます。API key は保存されません。

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

境界の詳細は [`docs/architecture.md`](./docs/architecture.md)、設計判断は [`docs/adr/`](./docs/adr/) を参照してください。

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

## 現在の制約 / non-goals

- real user との calibration、generative benchmark、baseline-vs-candidate scoring、universal UX score、accessibility simulation、高度な cognitive / forgetting model、自動 persona generation、multi-provider matrix、desktop / mobile、GUI dashboard、Firecracker / Kubernetes / distributed execution、大規模並列 population execution は意図的に後続へ延期しています。
- real Playwright + real LLM は実装されていますが CI の一部ではありません。CI は scripted reasoner + HTTP adapter を使用し、実モデル用には manual live-smoke workflow を提供します。
- deterministic E2E は Node の localhost port allocation と demo HTTP server に依存します。テストファイル間のport collisionを避けるため `vitest` の `pool: 'forks'` を使用します。

## Contributing

[`CONTRIBUTING.md`](./CONTRIBUTING.md) を参照してください。実装 contribution を受け付けています。durable Issue per ticket の workflow に従ってください。behavioral change には対応する ADR または Issue の更新を伴わせてください。

## AI agent の利用

dispatcher / contributor は [`CLAUDE.md`](./CLAUDE.md) に従います。Skill は `.claude/skills/` にあり、[`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) に記録された upstream revision に固定されています。
