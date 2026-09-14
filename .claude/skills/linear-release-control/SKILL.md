---
name: linear-release-control
description: Linearをoptionalなrelease planning / health / portfolio control planeとして使い、GitHub Issue / PR中心のexecution stateと二重管理せずreconcileする時に使用する。
---

# Linear Release Control

## Use this Skill when

- release Projectを作成・更新する
- release health / target date / blockerを整理する
- 複数repositoryのrelease状態を俯瞰する
- Linear Project Updateを作成する
- LinearとGitHubの状態差分をreconcileする
- Initiative / Milestone / Cycle / Linear Issueを使うか判断する

通常のimplementationだけならこのSkillを読み込まない。

## Source of Truth

- source / integration: Git
- implementation scope / acceptance criteria: GitHub Issue
- implementation dependency: GitHub Issue dependency metadata
- code review / CI / merge evidence: GitHub PR / checks
- release integration evidence: release PR
- release goal / date / health / portfolio: Linear Project / Initiative
- durable project knowledge: repository-controlled docs

Linearの値からGitHub execution stateを推測しない。矛盾時はGitHub evidenceを確認してLinear側をreconcileする。

## Object mapping

### Project

`1 release train = 1 Linear Project` をdefaultにする。

同じversion / release date / release decisionを共有する複数repositoryは1 Projectへまとめてよい。独立versionなら分ける。

最低限:

- release goal
- version
- target date when known
- health
- release PR / repository / release docs links
- release-level blockers / limitations

### Initiative

複数release Projectを束ねるproduct / roadmap goalだけに使う。単一releaseのためだけに作らない。

### Milestone

release-level checkpointだけに使う。

- Scope frozen
- Implementation complete
- Release candidate verified
- Released

必要なcheckpointだけ作る。ticket groupingには使わない。

### Cycle

defaultでは使わない。weekly release sprintとLinear Cycleを二重化しない。

次の場合のみ検討する:

- releaseが複数planning windowを跨ぐ
- 複数Project間のteam capacityを見たい
- release cadenceとは別のiteration metricが必要

### Linear Issue

GitHub Issueを全面mirrorしない。

Linear Issueは次のようなrelease-level / coordination workに限定する:

- cross-repository blocker
- external dependency
- release decision
- signing / distribution / store review
- non-code deliverable
- operational coordination

code changeのscope / acceptance criteriaはGitHub Issueへ置き、Linear Issueからlinkする。

## Release lifecycle

### Start

1. target version / release goal / target dateを確認する。
2. Linear Projectを作成または既存Projectをreconcileする。
3. relevant repositories / release docsをresourceとしてlinkする。
4. GitHubでrelease branchを作成する。
5. release branchにmeaningful diffが入ったらDraft release PRを作成し、Linear Projectからlinkする。

### During implementation

1. implementationはGitHub Issue / ticket PRで追跡する。
2. LinearへPR本文・CI log・review discussionを複製しない。
3. release判断へ影響するblockerだけProject / optional Linear Issueへ反映する。
4. Project UpdateはGitHub actual stateを確認してから作成する。

Project Updateの標準内容:

- health: `onTrack / atRisk / offTrack`
- completed / integrated highlights
- current blockers
- release gate state
- next checkpoint / decision
- canonical evidence links

### Completion

1. release PRのmergeとrelease-level gateをGitHubで確認する。
2. tag / package / deploy / store等、projectで定義したactual availabilityを確認する。
3. final Project Updateを作成する。
4. `Released` milestoneを完了する。
5. actual releaseが確認できた時点でProjectをCompletedへ移す。

## Agent / MCP policy

Interactive PM操作ではChatGPT等のLinear connector/pluginを使用してよい。

external agentがLinearへ直接アクセスする場合はLinear公式remote MCPをoptional capabilityとして使える。

- Coordinator / release manager: `https://mcp.linear.app/mcp`
- read-only worker: `https://mcp.linear.app/mcp/readonly`

implementation workerは原則Linear write不要。planning contextが必要ならread-onlyを優先する。

MCP auth / API key / user-global client configをrepository truthにしない。credentialをcommitしない。

## Mutation rules

Linearへwriteする前にcanonical GitHub evidenceを確認する。

禁止:

- unmerged PRをDone / implementation completeと推測
- failing / unknown CIを無視してhealthを楽観更新
- Linearだけにtechnical dependencyを追加してGitHub dependency graphと分岐
- acceptance criteriaをGitHubとLinearで別々に保守
- full GitHub Issue mirrorを自動作成

## Built-in Linear agents

Linear coding sessionsはbaseline execution pathにしない。Supervisor isolation、number-only ticket branch、Draft PR lifecycle、release/stack topology、current-SHA validation contractを満たせるadapterとして明示導入した場合のみ使用する。

Loopsもbaselineにしない。利用する場合はstatus summarization / notification等のderived automationに限定し、canonical execution stateを変更するautomationは個別reviewする。

## Failure / unavailable fallback

Linearが利用不能でもimplementation / release integrationを止めない。

GitHub Issue / PR / release branch / repository docsからcanonical execution stateを復旧し、Linear復旧後にProject stateをreconcileする。