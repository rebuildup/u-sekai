---
name: worktree-workflow
description: current release-driven profileでWorktrunkをWSL/Linux workspace lifecycle Practiceとして使い、同等以上のguaranteeを持つalternativeへのrefinementも判断する時に使用する。
---

# Worktree Workflow

Layer: **Practice**

Current release-driven profileではWorktrunkをGit worktreeの標準操作frontendとして使用する。WSL2/LinuxまたはLinux hostでWorktrunkが利用可能なら、日常のworktree作成・切替・一覧・review checkout・cleanupは原則 `wt` 経由で行う。

Worktrunk自体はConstitutionではない。採用理由はworkspace lifecycle / recoverability / process-port ergonomicsであり、native agent workspace等が同等以上のguaranteeを提供する場合はADR-0017のrefinement contractに従って置換できる。

単にagentがnative `git worktree` に慣れていることはdeviation evidenceにならない。native WindowsをこのSkillの必須targetにはしない。

このSkillは主に**authoring workspace lifecycle**を扱う。ADR-0020のverification-only executorへworktree作成を機械的に要求しない。Windows native等でproject/tooling constraintによりworktreeが使えない検証は`sandbox-runtime` / `quality-gate`のverification contractへrouteする。

## Current practice guarantees

- Worktrunkはworkspace lifecycle toolであり、execution isolation boundaryではない。
- branch/ref/GitHub Issue/PRがcanonical stateであり、worktree pathやWorktrunk local stateをSoTにしない。
- ticket branchはIssue番号のみ、release branchは`release-<major>-<minor>-<patch>`を維持する。
- `wt merge main`等でGitHub PR / release integration / explicit merge authorizationを迂回しない。
- project-shared Worktrunk hookは`.config/wt.toml`へcommitする。
- worktree path等のmachine preferenceはuser configであり、project truthにしない。
- WSLでは高頻度build/watch用worktreeをLinux filesystemへ置き、`/mnt/c`を標準にしない。

## Prerequisites

最初に `wt --version` で利用可否を確認する。未導入ならrepositoryのreproducible toolchainに含められるかを確認し、安全にprovision可能なら導入する。導入不能・非対応・権限不足の場合だけnative `git worktree`へfallbackし、恒常的な制約ならproject documentationへ理由を残す。

Cargoで導入する例:

```bash
cargo install worktrunk
wt config shell install
```

shell integrationは`wt switch`でcurrent shell directoryを切り替えるために必要。

導入後:

```bash
wt --version
wt config show
```

で利用可能性とconfig locationを確認する。

## Standard operations

現在のrelease branchへ移動:

```bash
wt switch release-0-2-0
```

Issue #123用ticket branch/worktreeを作成:

```bash
wt switch --create 123 --base=release-0-2-0
```

`wt switch --create <name>` は `--base` を指定しないとdefault branch（通常 `main`）をbaseにするため、release branchやpredecessor branchから派生させたい場合は必ず `--base` を明示する。

- current HEADから派生: `wt switch --create <name> --base=@`
- 指定release branchから派生: `wt switch --create <name> --base=release-x-y-z`
- stacked ticketでimmediate predecessor branchから派生: `wt switch --create <dependent-issue> --base=<predecessor-issue>`

default branchからの派生はtarget release trunkへ直接stackできないticketを作るため、`github-delivery` policy違反になる。作成元はcurrent expected baseでなければならない。stacked ticketではimmediate predecessor snapshot/branchとの関係を`github-delivery` / `parallel-orchestration` policyに従って決める。

worktree一覧:

```bash
wt list
wt list --full
```

PR review用checkout:

```bash
wt switch pr:123
```

PR checkoutはreview workspaceを分離するための操作であり、review対象SHAとvalidation evidenceは別途pinする。

branchが不要になった後のcleanup:

```bash
wt remove <branch>
```

削除前にPR / release landing state、未commit変更、必要artifactを確認する。

## Project configuration

repository-specific hookが必要なら:

```bash
wt config create --project
```

で`.config/wt.toml`を作成し、実際のproject stackへ合わせて編集・commitする。

universalなdev commandを決め打ちしない。initializerはpackage scripts、framework docs/config、existing startup commandを調査して、port override方法を特定する。

共有host上でdev serverをworktreeごとに起動する場合のshape:

```toml
# .config/wt.toml
[post-start]
server = "wt step tether -- <project-specific command using {{ branch | hash_port }}>"

[list]
url = "http://localhost:{{ branch | hash_port }}"
```

例のplaceholderをそのままcommitしてはいけない。Vite / Next.js / backend CLI / env-based server等、実際のcommand semanticsへ変換する。

## Port allocation

`{{ branch | hash_port }}`はbranch名からdeterministicなhost portを生成する。共有WSL/Linux hostで複数worktreeのdev serverを並行起動する時の標準候補とする。

ただしhash-based allocationは絶対的なuniqueness guaranteeではない。dev server / runtimeはbind failureを明示的に検出し、必要ならproject-specificなport reservationまたはcollision-resolutionを追加する。既に別processが占有しているportを「自分のbranch用」と仮定して継続してはいけない。

適用境界:

- hostへ直接bindするprocess: dev commandのportへ適用
- container/sandbox: host-published portへ適用し、container内部portは通常固定でよい
- preview URL: 同じport templateから構築できる
- DB等の別service: service identityを別namespaceにし、必要なら`('db-' ~ branch) | hash_port`のようにdev serverと異なるinputへ分離する

portが一意でもprocess/database/filesystem/credential isolationが成立したとは扱わない。

## Process lifecycle

long-running dev server/watch processをWorktrunk hookから起動する場合は、適切なら:

```bash
wt step tether -- <command>
```

を使用する。

tethered processはworktree lifecycleへ結び付け、worktree removal後のorphan processやstale port ownershipを減らす。

これはprocess cleanup mechanismであり、sandbox security boundaryではない。

## Mutable services and state

同一hostへ複数worktreeをmaterializeする場合、次を共有しない設計にする:

- writable DB/schema
- Redis namespace / queue
- container name
- Unix socket
- app-local mutable state
- generated runtime state
- credentials with broader authority than the worker requires

Worktrunkの`sanitize_db` / `hash_port`等はdeterministic identifierとして利用できるが、実際のservice isolationは`sandbox-runtime` policyに従う。

## Delivery boundary

Worktrunk commandはGitHub deliveryのergonomic frontendに限定する。

許可される典型操作:

```text
wt switch release-x-y-z
-> wt switch --create <issue-number> --base=release-x-y-z
-> implementation / commit / publish
-> immediate Draft PR
-> review / validation
-> authorized GitHub landing
-> wt remove <issue-number>
```

`wt merge`のlocal integration convenienceは、project-initのticket PR / release PR / protected main / explicit merge authorizationを置き換えない。

## Fallback and recovery

### Authoring

Worktrunkが利用できないmutable authoring workerではnative `git worktree`へ縮退してよい。ただしbranch naming、mutable ownership、runtime state safety、Draft PR lifecycle等のapplicable semanticsは維持する。

worktree自体を作れないauthoring environmentでは、同じshared checkoutへ複数workerを並行配置しない。isolated clone / sandbox / serialized ownership等、同等以上のmutable ownership guaranteeを選ぶ。

### Verification-only

verification-only executionはworktree fallback chainの対象ではない。immutable candidate artifactをcleanにmaterializeできれば、package / installed build / clean checkout / disposable clone / serialized singleton checkout等を利用できる。

singleton checkoutを使う場合はdirty stateを暗黙に上書きせず、exclusive ownershipとbefore/after state auditを行う。validation中にsource authoringへ移行した場合はmutable worker policyへpromotionする。

fresh environmentではGit refs、Issue/PR metadata、committed `.config/wt.toml`、project docsからworkflowを再構成できなければならない。user-level Worktrunk configだけに必要情報を残さない。


## Refinement / deviation

Worktrunkから外れる場合は、少なくとも次を確認する。

- canonical task/source identityがlocal pathに依存しない
- concurrent workspaceのmutable-state safetyを悪化させない
- current expected baseからmaterializeできる
- review/recoveryがtool-local hidden stateだけに依存しない
- dev process / port / mutable service lifecycleについて必要なguaranteeを維持する

同等以上ならalternativeを許容する。Worktrunk command shapeそのものをorganizational correctnessとして扱わない。

## Remove / re-evaluate

- agent/runtimeがnativeに同等以上のworkspace lifecycleを提供する
- Worktrunk固有hookがproject stackと不整合になる
- host worktreeを使わないruntime modelへ移行する
- comparative evalでWorktrunk-specific instructionの追加価値が消える
