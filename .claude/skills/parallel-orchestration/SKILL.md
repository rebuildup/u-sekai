---
name: parallel-orchestration
description: 複数AIエージェントへtaskを分解・委譲し、immutable snapshot/resultとdependency-aware stacked deliveryで安全に並行統合する時に使用する。
---

# Parallel Orchestration

非自明な実装をdependency graphへ分解し、Readyまたはstack-readyなnodeをresource/WIP制約内で最大限並行実行する。

## Invariants

- 1 implementation worker = 1 isolated mutable runtime。
- shared working tree / Git index / integration branchを複数workerが直接更新しない。
- parent -> child はimmutable snapshot。
- child -> parent はimmutable commit/ref/diff + validation result。
- sandbox lifecycleはworker外のSupervisorが管理する。
- worktree単体をexecution isolationとみなさない。
- WSL/LinuxでSupervisorがlocal branchをworktreeへmaterializeする場合は`worktree-workflow` Skillに従ってWorktrunkを使用できるが、各workerのruntime isolationとimmutable result contractは別に維持する。
- durable planning unitはGitHub Issue、短命な内部subtaskはSupervisor taskとしてよい。
- Issue dependency graphがdurable dependency SoTであり、Git branch topologyだけでdependencyを管理しない。
- child lifecycleはparent model processではなくSupervisorが所有する。
- すべてのmutable worker task/resultに `execution_generation` を必須で付与する。初期generationは `1` とし、recovery/reassignment時にSupervisorが原子的に進める。
- result統合前にcurrent generationとの一致を検証し、stale generationを統合しない。
- validation resultはvalidated SHA/snapshotにpinし、stack rebase/update後の別SHAへ流用しない。
- long-running task / context limit / sandbox recreationでは `agent-recovery` Skillを適用する。
- spawn前に `policy-evaluation` Skillのexecution profileを判定し、mechanical / localized taskへ不要なfan-outを導入しない。

## Execution profile routing

orchestration strengthはtask sizeの印象ではなくexecution profileから決める。

- `mechanical`: solo executionをdefaultとし、deterministic tooling / focused validationを優先する。
- `localized`: bounded scopeをsoloで進め、必要なvalidationと、policy/user-visible riskがある場合のcold final reviewを追加する。
- `cross-boundary`: dependency graphへ分解し、安全なnodeのみparallelizeする。candidate artifact完了後はbuilderと分離したindependent cold reviewを必須とする。
- `judgment-heavy`: evidence / reference / acceptance rubricを先に固定し、candidate artifact完了後はbuilderと分離したindependent cold reviewを必須とする。

複数profileに該当する場合はsafeguardを合成する。特に `cross-boundary` かつ `judgment-heavy` のtaskはdependency decomposition / safe parallelismとevidence/rubric-first executionの両方を適用し、combined routingをorchestration前に記録する。

execution profileは `quality-gate` のverification risk taxonomyを置換しない。orchestration/review強度とtest levelを別々に決定する。

## Dependency readiness

nodeは次のどちらかを満たす場合にspawn可能:

1. unfinished prerequisiteがない
2. hard predecessorが未mergeでも、reviewable immutable predecessor snapshotがあり `stack-ready` と判定できる

`stack-ready` で開始する場合、worker inputへpredecessor Issue/PR identityとexact commit SHA / immutable snapshotを記録する。

predecessorが後から変更された場合はaffected downstream task/branchをstaleとして扱い、base reconciliationとrequired revalidationを行う。

## Flow

1. Issueのobjective / acceptance criteria / dependency / target releaseを読む。
2. `policy-evaluation` に従ってexecution profileを判定し、fan-out / reviewer強度を決める。
3. canonical Issue dependency graphからtask graphを作る。
4. linear hard dependency segmentでstacked PRが適切かを判断する。
5. 各nodeのinput snapshot / predecessor snapshot / output contract / recovery boundaryを決める。
6. Supervisorがmutable taskへcurrent `execution_generation` と実行policyを割り当ててspawnする。
7. Readyまたはstack-readyなnodeをWIP/resource制約内でspawnする。
8. durable ticket branchをworker/subagentが作る場合、first meaningful commitをcanonical remoteへpublishし、remote head SHA一致を確認した直後にDraft PRを作成する。published commit + Draft PRなしでactive implementationを継続しない。
9. meaningful boundaryでcheckpointする。
10. worker resultをinspectし、result generationとbase snapshotがcurrent expected stateに一致することを確認する。
11. Coordinator/Supervisorだけがshared durable integration stateへ順序立てて統合する。
12. integration checkpointごとにrequired validationを行う。
13. predecessor変更でupstack/downstream branchが更新された場合、affected validationを再実行する。
14. Reviewerをclean candidate snapshotから起動する。cross-boundary / judgment-heavy workではbuilderのprivate reasoningではなくobjective / rubric / artifact / validation evidenceを渡すindependent cold reviewを必須とする。
15. GitHub Issue / Project / PR metadataを実行状態と同期する。

## Spawn contract

mutable workerの最低限input:

```text
issue_or_task_id
objective
acceptance_criteria
target_release
base_snapshot
predecessor_issue_or_pr
predecessor_snapshot
immediate_pr_base
branch_identity
expected_draft_pr
assignee_expectation
reviewer_expectation
label_expectation
execution_generation
role
allowed_tools
filesystem_policy
network_policy
budget
expected_result
```

dependency / durable GitHub deliveryを使わない短命taskでは該当しないfieldはnull/omittedでよい。

`filesystem_policy` / `network_policy` はSupervisorが実際にenforceする境界を表す。policy enforcementが別のruntime/provider設定で行われる場合も、spawn contractにはそのpolicy IDまたは解決済みpolicyを記録し、worker inputと実際のsandbox制約が追跡可能でなければならない。

## Durable branch contract

worker/subagentへdurable branch作成権限を与える場合、その権限はremote publication + Draft PR lifecycleとセットで扱う。

canonical sequence:

1. branch作成
2. first meaningful commit
3. canonical remoteへcommitをpublish
4. remote branch head SHAがfirst meaningful commit SHAと一致することを確認
5. immediate Draft PR creation
6. Issue linkage / assignee / reviewer / labels / target release / stack contextを設定
7. implementation継続

GitHub上のPRはremoteでheadを解決でき、head/baseに差分がある必要があるため、branch作成・first commit・remote publication・remote head検証・Draft PR creationを1つのoperational start procedureとして扱う。

workerがremote publishまたはPR mutation権限を持たない場合、first meaningful commit後ただちにSupervisor/Coordinatorへcontrolを返す。Supervisor/Coordinatorがcommitをpublishし、remote head SHA一致を確認し、Draft PR作成を完了するまでそのdurable branchでの追加implementationを進めない。

Ephemeral immutable ref/resultはこのcontractの対象外。

## Result contract

mutable workerの最低限output:

```text
agent_id
issue_or_task_id
target_release
base_snapshot
predecessor_snapshot
execution_generation
result_commit_or_ref
draft_pr_identity
summary
validation_results
known_issues
```

current `execution_generation` と一致しないresultは自動統合しない。

recorded predecessor/base snapshotとcurrent expected baseが異なるresultはstale candidateとしてreconcileし、盲目的に統合しない。

## Review handoff

Reviewer inputはclean candidate snapshotへpinする。

PR review contextには最低限:

- linked Issue / acceptance criteria
- target release
- immediate stack predecessor if any
- current head SHA
- validation evidence for that SHA
- known blockers
- expected reviewer/CODEOWNERS context

review後にhead SHAが変わった場合、古いapproval/validationがcurrent policy上有効かを再評価する。

## Parent failure

parent agentが停止してもsafeなchildを自動破棄しない。

recovered CoordinatorはSupervisorからchildを再発見し、running/completed/failed/orphanedをreconcileする。completed resultはimmutable snapshot/result relationship、predecessor/base identity、current generationを確認してから統合する。

GitHub上のIssue/PR/branch metadataはdurable recovery evidenceであり、active durable ticket branchにpublished remote head + Draft PRがない状態を正常状態として扱わない。zero-diff release branchはDraft release PR invariantの例外だが、first meaningful integrated difference後はDraft release PRを必須とする。

## Fallback

true isolationが使えない場合、shared mutable workspaceで並列実装しない。read-only researchの並列化または安全な直列実装へ縮退する。

stacked PRを安全に維持できない場合もdependency SoTを壊さず、predecessor merge後に通常ticketとして開始する直列workflowへ縮退する。
