---
name: worktree-workflow
description: WSL/LinuxでWorktrunkを使ってticket/review worktreeを作成・切替・一覧・cleanupし、共有hostのdev server port/process lifecycleを安全に扱う時に使用する。
---

# Worktree Workflow

WorktrunkをGit worktreeの操作frontendとして使用する。対象の第一優先はWSL2/LinuxとLinux hostであり、native WindowsをこのSkillの必須targetにはしない。

## Invariants

- Worktrunkはworkspace lifecycle toolであり、execution isolation boundaryではない。
- branch/ref/GitHub Issue/PRがcanonical stateであり、worktree pathやWorktrunk local stateをSoTにしない。
- ticket branchはIssue番号のみ、release branchは`release-<major>-<minor>-<patch>`を維持する。
- `wt merge main`等でGitHub PR / release integration / explicit merge authorizationを迂回しない。
- project-shared Worktrunk hookは`.config/wt.toml`へcommitする。
- worktree path等のmachine preferenceはuser configであり、project truthにしない。
- WSLでは高頻度build/watch用worktreeをLinux filesystemへ置き、`/mnt/c`を標準にしない。

## Prerequisites

Worktrunkが未導入なら、repositoryのreproducible toolchainに含められるかを先に確認する。

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
wt switch --create 123
```

作成元はcurrent expected baseでなければならない。stacked ticketではimmediate predecessor snapshot/branchとの関係を`github-delivery` / `parallel-orchestration` policyに従って決める。

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
-> wt switch --create <issue-number>
-> implementation / commit / publish
-> immediate Draft PR
-> review / validation
-> authorized GitHub landing
-> wt remove <issue-number>
```

`wt merge`のlocal integration convenienceは、project-initのticket PR / release PR / protected main / explicit merge authorizationを置き換えない。

## Fallback and recovery

Worktrunkが利用できない場合はnative `git worktree`へ縮退してよい。ただしbranch naming、isolated runtime、port/state uniqueness、Draft PR lifecycle等のsemanticsは維持する。

fresh environmentではGit refs、Issue/PR metadata、committed `.config/wt.toml`、project docsからworkflowを再構成できなければならない。user-level Worktrunk configだけに必要情報を残さない。
