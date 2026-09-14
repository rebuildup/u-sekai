---
name: github-delivery
description: GitHub Issues / Pull Requestsをexecutionの中心に置き、1週間のrelease sprint、dependency-aware stacked PR、durable Draft PR lifecycleでticket-drivenなdeliveryを進める時に使用する。planning control planeはGitHub Projectsまたはoptional Linear profileを使う。
---

# GitHub Delivery

## Source of Truth

- released source state: `main`
- active sprint/release integration state: `release-x-y-z`
- durable implementation work state: GitHub Issues
- dependency state: GitHub Issue dependency metadata
- release planning / portfolio state: GitHub Projects、またはLinear profile採用時はLinear Projects / Initiatives
- ticket review/integration: Pull Requests
- transient execution state: Supervisor

`main` はリリース済み・統合済みの安定状態を表す。
通常のticket PRを直接 `main` へ向けない。

## Merge authorization boundary

PRのquality/readinessとmerge side effectのauthorizationを分離する。

Agent / subagent / Coordinator / Supervisorは、userが対象PRまたは明確に限定したPR集合について明示的にmerge/landを依頼した場合だけ、次を実行できる。

- merge / squash merge / rebase merge
- native stacked PR / contiguous stack landing
- auto-merge有効化
- integration targetへの直接反映等、PR mergeと実質同じlanding side effect

次はauthorizationではない。

- acceptance criteria satisfied
- required checks green
- approval / conversation resolution
- mergeable / Ready for review
- `対応して` / `レビューして` / `conflictを解消して` / `リリース準備して` / `最後まで進めて` 等の一般的な完遂依頼
- repository policyやrelease schedule自体

authorizationがなければ、implementation / push / Draft PR / metadata / review対応 / conflict解消 / validation / Ready化まで進め、**ready-to-merge** で停止する。対象PR、current head SHA、gate state、残るblockerを報告する。merge permissionを得るためだけに不要な質問を先回りして行わない。

authorizationはidentified PR / bounded PR setとtask scopeへ限定し、別PRへ伝播させない。authorization後にexpected review fixでhead SHAが変わった場合はcurrent SHAでrequired validationを再実行する。base / target release / scope / included changes等がmaterialに変わった、unrelated changesが入った、またはauthorization scope内か曖昧になった場合は古いauthorizationを再利用せずuserへ再確認する。

quality gateは「mergeしてよい品質か」を判定する。merge authorizationは「Agentがmerge操作を実行してよいか」を判定する。前者の成功から後者を導出しない。

## Public repository main protection

public repositoryでは`main`をprotected branch / branch rulesetで必ず保護する。

最低限のinvariant:

- `main`へのdirect push / direct web edit / force push / deletionを通常運用で許可しない
- `main`変更にはPull Requestを必須とする
- normal actor/adminが保護を日常的にbypassする運用を作らない
- `main`へmerge可能な正規delivery pathは `release-x-y-z -> main` のrelease PRだけとする
- ticket branchや任意branchから`main`へのPRを正規delivery pathとして認めない
- required checks / review / conversation resolution等、projectで定義したrelease gateを満たしてからmergeする

GitHubのbranch protection/rulesetだけではPRのhead branch名を完全には制約できない場合がある。その場合は、`base == main` のPRについて `head` がcanonical `release-*` patternかつ現在のtarget releaseであることを検証するrequired status check / GitHub Action等を追加し、release branch以外からの`main` mergeを機械的に拒否する。

初期化時にrepository visibilityを確認し、publicなら`main` protection/rulesetの実在と有効性を検証する。設定変更権限がある場合は不足を作成・修復し、権限がない場合は未設定を明示的blockerとして報告する。

## Weekly release sprint

通常のsprint期間は **1週間** とする。

1 sprint = 1 target semantic version = 1 release integration branchを維持する。

canonical format:

`release-<major>-<minor>-<patch>`

例:

- `release-0-1-0`
- `release-0-2-0`
- `release-1-0-0`

release branchはsprint開始時に `main` のrelease基準commitから作成する。

緊急patchや明示的なrelease判断では1週間から外れてよいが、通常planning cadenceは1週間を基準とする。patchでも`main`を直接変更せず、target patch release branch -> `main` のrelease PRを使用する。

## Issue

durable planning unitは原則GitHub Issueにする。

Issueのtitle/bodyは日本語を標準とする。

最低限、該当するものを明示する:

- 目的 / user-visible outcome
- acceptance criteria
- scope / non-scope
- dependency / blocked-by
- priority
- size
- area/component
- target version
- release date
- accountable assignee

短命なresearch/worker subtaskまでIssue化する必要はない。

Issue dependency graphはcanonical dependency SoTであり、Git branch topologyだけでdependencyを表現しない。

## Planning board / control plane

GitHub Projectsを使う場合の最低限のStatus:

`Backlog -> Ready -> In Progress -> In Review -> Done`

推奨field:

- Priority
- Size
- Target Version
- Area / Component
- Blocked / dependency

WIPを無制限に増やさない。
Readyかつdependency条件を満たすticketからcapacity内で起動する。

Linear profileを採用するprojectでは、GitHub IssueをLinear Issueへ全面mirrorしない。Linearはrelease-level planning / health / portfolio control planeとして使い、詳細は `linear-release-control` Skillに従う。GitHub ProjectsとLinearを併用する場合も同じfieldを両方でcanonicalにしない。

Dependency execution上は必要に応じて次を区別する:

- `blocked`: prerequisite snapshotがまだ利用できない
- `stack-ready`: reviewable immutable predecessor snapshotがあり、dependent workを開始できる
- `integrated`: ticket changesがtarget release trunkへland済み

この3状態はdependency semanticsであり、Project Status自体を必ず増やす必要はない。

## Sprint / release cycle

1. 次version、1週間のsprint window、release dateを決める。
2. `release-x-y-z` branchを `main` から作成する。
3. sprint goalを定義する。
4. Ready ticketを選択する。
5. dependency / stack候補 / capacityを確認する。
6. ticketごとにnumber-only branchを作る。
7. 最初のmeaningful commitをremoteへpublishし、remote head SHA一致を確認した直後にDraft PRを必ず作成し、metadataを設定する。
8. isolated workerをdependency/WIP制約内で並行起動する。
9. independent ticketまたはstacked ticketをreviewし、current landing candidateを検証する。
10. ticket/stackをready-to-mergeへ持っていく。
11. explicit merge authorizationがなければここで停止し、current head SHA / gate state / blockersを報告する。authorizationがある場合だけtarget release trunkへlandし、landing成功を確認する。
12. target release trunkへlandしたticketのlinked Issueを明示的にcloseする。GitHub Projectsをticket boardとして使うprojectではstatusをDoneへ更新する。
13. release branch全体を検証し、release PRをready-to-mergeへ持っていく。Linear profile採用時はGitHub evidenceからrelease Project health / updateをreconcileする。
14. explicit release-merge authorizationがなければrelease merge前で停止する。authorizationがある場合だけrelease PRを `main` へmergeする。
15. version/release処理を完了する。
16. 未完了ticketは次releaseへ明示的に再計画する。

## Ticket branch

原則、1 top-level Issueにつき1 durable ticket branchを作る。

canonical format:

`<issue-number>`

例:

- `123`
- `418`
- `1024`

branch名に `issue/` prefix、slug、title、type等を追加しない。

nested workerが返すephemeral immutable ref/commitはこの命名規則の対象外でよい。

## Branch creation and Draft PR are one start procedure

**active durable ticket branchにはpublished remote headとDraft PRを必ず持たせる。**

GitHubはremoteで解決できないheadやbaseと差分のないbranchにはPRを作れないため、canonical sequenceは次の通り:

1. durable branchを作成する
2. 最初のmeaningful commitを直ちに作る
3. そのcommitをcanonical remoteへpublishする
4. remote branch head SHAがpublishしたcommit SHAと一致することを確認する
5. Draft PRを直ちに作る
6. published commit + Draft PRがない状態でactive implementationを継続しない

「後でpushする」「後でPRを作る」は禁止する。

このruleはhuman / Coordinator / implementation worker / subagentのすべてに適用する。
subagentがdurable branchを作る権限を持つ場合、そのsubagent自身がpublish + remote head検証 + Draft PRまで完了する。remote publicationまたはPR mutation権限がないworkerはfirst meaningful commit後ただちにSupervisor/Coordinatorへcontrolを返し、Supervisor/Coordinatorがcommit publication・remote head SHA確認・Draft PR作成を完了するまで追加implementationを進めない。

Ephemeral immutable worker ref/resultはdurable branchではないため対象外。

## PR metadata is required state

PRはdiffだけではなくdurable work stateである。ただし、durable stateとPR proseを同一視しない。

作成時にrepository evidenceからnative GitHub metadataを評価し、最低限次を設定する。

- linked Issue
- accountable assignee
- reviewer request / CODEOWNERS-derived reviewer
- repositoryで定義済みの適切なlabels
- target release branch
- stacked PRならstack trunk / immediate predecessor / relevant successor context

PR bodyはreviewerがchangeを理解・評価するためのartifactとして書く。必要に応じて次を含める。

- purpose / intended outcome
- implementation summary
- acceptance criteriaまたはその参照
- non-obvious design decision / constraint
- review判断に必要なvalidation evidence
- merge後も意味を持つlimitation / migration / compatibility note

current head SHA、ahead/behind、bot status、branch同期履歴、tool invocation、trial-and-error等を、作業contextに存在するという理由だけでPR bodyへ転写しない。GitHub checks、branch state、review status等のmutable stateはnative surfaceをcanonicalにし、proseへ重複させるのはreader判断に必要な場合だけにする。

ownership、scope、stack position、review requirementが変わった場合はmetadataも更新する。

存在しないlabelを勝手に作る、関係のないreviewerを形式的に指定する、PR author自身を自己reviewerとして埋める、という運用はしない。meaningful reviewer不在をPR bodyへ自動記録せず、それがreview/merge semanticsの理解に必要な場合だけ説明する。

PR title/body/review discussionには `writing-discipline` を適用し、Select -> Compose -> Rereadを経てreader-oriented proseへ整える。

Issue/PR title/body/review discussionは日本語を標準とする。

## Independent ticket PR

hard predecessorを持たないticketはtarget release branchをdirect baseにする。

```text
main
└─ release-x-y-z
   └─ 123
```

PR:

`123 -> release-x-y-z`

## Dependency-aware stacked PR

同一repository・同一target release内でlinear hard dependencyを持つtop-level Issuesはstacked PRを使用してよい。

```text
main
└─ release-x-y-z
   └─ 123
      └─ 124
         └─ 125
```

PR:

- `123 -> release-x-y-z`
- `124 -> 123`
- `125 -> 124`

全ticketはtarget release `release-x-y-z` を共通stack trunkとして持つ。

Stack eligibility:

- same repository
- same target release
- real hard dependency
- stacked segmentがordered chainとして表現可能
- predecessorにreviewable immutable commit/snapshotが存在

Issue dependency graphがbranchする場合、無理に1本のlinear stackへ変換しない。
PR stackはIssue dependency graphのlinear pathをexecution/integration topologyへprojectionしたものにすぎない。

`1 top-level Issue = 1 durable ticket branch = 1 ticket PR` はstackでも維持する。
1 Issueを細切れのdurable PRへ分割するためだけにstackを使わない。

## Stack-ready execution

predecessorがrelease branchへ未mergeでも、reviewable immutable snapshotが存在すればdependent ticketを開始してよい。

開始時に少なくとも以下をpinする:

- predecessor Issue/PR identity
- predecessor commit SHA / immutable snapshot
- common target release
- immediate PR base

predecessor reviewで変更が入った場合、downstreamをdependency orderでrebase/updateし、影響したrequired validationを再実行する。

古いgreen resultを異なるSHAへ流用しない。

## Ready for review

DraftからReady for reviewへ移す条件:

- Issue acceptance criteriaを実装済み
- current SHAに対するticket-level integration quality gateを実行済み
- blocking known issueが解消済み、または明示的にscope外
- PR description / assignee / labels / reviewer metadataが現在の実装と一致
- required reviewerをrequest済み、または意味のあるreviewer不在を明記済み
- target release branchまたはimmediate stack predecessorとのstaleness/conflictを処理済み
- predecessor変更によるdownstream revalidationを処理済み

## Ticket landing / Done

IssueのDone条件:

- acceptance criteria satisfied
- required CI/checks green for current landing candidate
- blocking review resolved
- release/stack staleness handled
- ticket changesがtarget release trunkへland済み
- linked Issue explicitly closed after successful trunk landing
- GitHub Projectsをticket boardとして使う場合はProject status moved to Done

independent ticketでは通常のticket PR mergeがそのままtarget release trunkへのlandingになる。ただしAgentがそのmergeを実行できるのは、このPRまたは明確に限定されたPR集合へのexplicit merge authorizationがある場合だけである。authorizationがなければDoneへ進めずready-to-mergeで停止する。

native stacked PRでもstack landing自体がmerge authorization boundaryである。stack内の1 PRへのauthorizationを未指定のsibling / predecessor / successor PRへ拡張しない。

native stacked PRでは、stackはbottom（trunkに最も近いPR）からlandingする。選択したstacked PRをmergeすると、そのPRと未mergeのlower PRがcontiguous groupとしてtarget release trunkへlandする。したがってlanding前に、実際のcontiguous landing setに含まれる各PRへのexplicit authorizationが存在するか、またはその集合全体を明示的に限定したbounded stack authorizationが存在することを確認する。selected PRだけへのauthorizationしかない状態でlower PRを含むnative stack landingを実行してはならない。mid-stack PRだけをintermediate predecessor branchへ孤立してmergeしたものをDone boundaryとして扱わない。

native stack landingを使えずordinary nested PRへfallbackする場合、例えば `124 -> 123` の通常mergeはintermediate integrationにすぎない。#124のchangesがtarget `release-x-y-z` へ到達するまでIssue #124をclose/Doneにしない。

contiguous stack groupまたはstack全体を一括landingする場合、含まれるすべてのticketが個別にacceptance criteria / review / current-SHA validationを満たしていることを確認する。landing後に各Issueと、利用中のplanning projection（GitHub Projects等）を明示的にreconcileする。Linear profileではticketを全面mirrorしないため、release-level stateだけを必要に応じてreconcileする。

`main`へのmergeをIssue単位のDone条件にはしない。Issue Done boundaryはtarget release trunkである。

GitHubのclosing keywordはdefault branch向けPRでのみ自動closeに使えるため、release trunkへのlanding成功確認後にCoordinatorまたはdelivery automationがIssueを明示的にcloseする。

## Release integration

release branchは複数ticketの統合結果を保持するsprint integration lineである。

release branchはsprint開始時に作成する。GitHubは`main`と差分がない状態ではPRを作れないため、release branchに最初のmeaningful integrated differenceが入った直後にDraft release PRを作成する。zero-diff release branchだけはDraft PR invariantの例外である。

Draft release PRにもassignee / reviewer / labels / release goal / included Issuesを設定し、release期間中維持する。validationのmutable stateはGitHub checks等のcanonical surfaceで追跡し、PR proseにはrelease判断に必要な意味だけを書く。

release完了前にrelease branch上でfull applicable quality gateを実行する。

release PR:

`release-x-y-z -> main`

最低限:

- release goal
- included Issues/PRs
- breaking changes
- migration notes
- release判断に必要なverification scope / evidence
- durable known limitations
- version/release metadata

public repositoryでは`main` protectionにより、このrelease PR以外の経路で`main`を更新できない状態を維持する。

release gate成功はrelease PRをready-to-mergeにするquality evidenceであり、Agentへのmerge authorizationではない。explicit release-merge authorizationがなければ、release PRをReadyにできる状態まで整えて停止し、current head SHA / release gate / blockersを報告する。authorizationがある場合だけmergeを実行する。

release PRがmergeされた時点で `main` がそのversionのreleased source stateになる。

Linear profile採用時は、release PR merge後もtag / deploy / package / store等のproject-defined actual availabilityを確認し、final Project Update / `Released` checkpointを反映してからLinear ProjectをCompletedへ進める。

## Version / tag-triggered release consistency

versionはSemantic Versioning `MAJOR.MINOR.PATCH` をcanonical formとする。external ecosystem上の明確な理由がない限り省略形式を使わない。

tag pushをpublish/release triggerとして使用するprojectでは、tag versionとauthoritative package/project versionを必ず一致させる。

例:

- tag: `v1.4.2`
- authoritative version: `1.4.2`

release automationは不一致を自動修正して続行せずfailする。

conditional minimum sequence:

1. tag format validation
2. semantic version extraction
3. authoritative version comparison
4. current release SHAに対するfull applicable release gate
5. release build/package
6. successful validation後のみpublish/release

複数release unitを持つprojectではauthoritative version sourceまたはunitごとのversion policyを明示する。

weekly release branch modelとtag releaseは競合しない。release branch/PRがsource delivery、tag/publishがartifact deliveryに使われる場合、両者が同じintended version/SHAを指すことを検証する。

## Multi-agent integration

- 1 top-level Issue = 1 ticket branch = 1 ticket PRを基本とする。
- independent ticket PR base = target `release-x-y-z`。
- stacked dependent ticket PR base = immediate predecessor ticket branch。
- all stack members share one target release trunk。
- implementation workerはticket branchを複数agentで直接共有しない。
- nested workerはresolved immutable identityへpinされたcommit/ref resultを返す。
- durable branchを作るworker/subagentにはremote publication + Draft PR creation / metadata contractも適用する。
- Coordinator/Supervisorだけがshared durable integration stateへ順序立てて統合する。
- merge/landing前にtarget release / predecessor / current validation SHAを確認する。
- Doneへ移す前にactual target release trunk上のlandingを確認する。
- public repositoryでは`main` protection/rulesetとrelease-only main merge checkを初期化・検証する。

## Language policy

- Issue title/body: 日本語
- PR title/body/review discussion: 日本語
- internal planning docs: 日本語
- commit message: 英語
- source code: 英語

commit format:

`<work-prefix>: <extremely concise title>`
