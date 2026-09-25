---
name: security-audit
description: source codeから未知のsecurity invariant failureを能動的に探索し、coverageを明示しながら独立検証されたfindingへ変換する時に使用する。
---

# Security Audit

このSkillは、既知advisoryを継続管理する `security-maintenance` とは別に、**project sourceから未知の脆弱性を探索・検証するapplication security audit** を定義する。

目的は「怪しいコードを列挙する」ことではない。principal、trust boundary、entry surface、security invariant、sink/resultをsourceから追跡し、監査coverageを残し、候補をfresh verifierが反証したうえでのみfindingとして確定する。

## 1. Responsibility boundary

このSkillが所有する:

- source-visible architecture / principal / trust boundaryのreconnaissance
- entry surfaceからsecurity-relevant sinkまでのtrace
- projectに適用可能なattack class選定
- coverage unitの計画・実行・gap管理
- vulnerability candidateの発見
- bounded local evidenceによる候補検証
- hunterと独立したfresh verifierによる反証
- structured findings / needs-validation / rejected record
- remediation invariantと最小修正方針の提示
- confirmed findingのproject delivery workflowへのhandoff

このSkillが所有しない:

- framework/runtime/dependency advisory intake と継続monitoring
- target sourceの修正そのもの
- release priorityの最終決定
- live/shared/production environmentへの攻撃的probe
- provider / deployment factの推測
- security/privacy risk acceptance

接続先:

- advisory起点のsecurity work -> `security-maintenance`
- agent/runtime isolation -> `sandbox-runtime`
- hunter/verifier orchestration -> `parallel-orchestration`
- invariant / precondition / postcondition reasoning -> `correctness-assurance`
- remediation後のregression / integration / E2E -> `quality-gate`
- Issue / branch / PR / target release -> `github-delivery`
- risk acceptance / irreversible decision -> `engineering-decisions`

## 2. Audit invariants

監査中は次を破らない。

1. findingには具体的なlower-trust principalまたはuntrusted inputが必要。
2. findingには守るべきsecurity invariantと、破られたboundary/resultが必要。
3. best practice不足だけをvulnerabilityとして扱わない。
4. sourceで確認できないdeployment/provider/browser/IAM/runtime factを推測しない。
5. source外factが決定的なら `needs_validation` とする。
6. self-impactや同一principalに許可されたauthorityをcross-boundary vulnerabilityへ膨らませない。
7. severityはconfirmed findingだけに付ける。
8. observed resultより強いimpactを推測しない。
9. target-controlled executionはapproved sandboxの内部だけで行う。
10. production/shared endpoint、他user data、real credential、paid API、live control planeをprobeしない。
11. audit自身はtarget sourceを変更しない。finding確定後にdelivery workflowへhandoffする。
12. audit coverageが部分的ならcomplete auditと表現しない。

## 3. Audit profiles

scopeとstakesに応じてprofileを明示する。

### quick

小規模target、再監査、diff audit、初回screening向け。

- coarse coverage unit
- 1 hunting wave
- 1 independent verifier per candidate
- uncovered / deferred areaを明示
- complete coverageを主張しない

### standard

通常のrepository audit。

- subsystem / boundary単位のcoverage
- reconnaissance
- coverage-led hunting
- gap review
- independent candidate verification
- structured reporting

### deep

高stakes、大規模、security-sensitive target向け。

- subsystem / lifecycle modeまでcoverageを分割
- gap reviewをcleanになるまで反復
- candidate validationとfinal record verificationを別agentへ分離
- prior covered areaもsource変更やriskに応じて再検証

profileはevidence barを弱めるために使わない。

## 4. Phase 1 — Reconnaissance

実装を探す前にsecurity architectureを作る。

最低限確認:

### Product / stack

- product type / users / operators
- language / framework / runtime / SDK
- deploy / package / execution model
- subsystem / process boundary
- persistence / queue / cache / filesystem / network
- locally runnable test/build path

### Principal / authority

- unauthenticated actor
- authenticated user
- tenant / organization member
- admin/operator
- browser origin / webview / extension
- local process / plugin / helper
- CI actor / release actor
- model / agent / tool caller
- external service / webhook sender
- device / app component

各principalについて通常authorityと禁止されるauthorityを区別する。

### Entry surface

projectに存在するものを列挙する:

- HTTP / browser / WebSocket
- RPC / GraphQL / messaging / webhook
- file / archive / parser / document
- CLI / env / config
- database / migration / import/export
- plugin / extension / generated input
- CI / release / dependency
- cloud event / IAM selector / IaC
- LLM context / tool argument / MCP
- mobile deep link / exported component / webview
- desktop IPC / socket / helper

### Security boundary

特に次をmapする:

- authentication
- authorization
- tenant / owner isolation
- secret / credential boundary
- privilege transition
- trust between process/service
- browser origin / content boundary
- filesystem / path boundary
- code execution boundary
- release / signing authority
- data lifecycle / deletion / backup boundary
- resource / quota / cost boundary

### Source visibility

各controlを:

- source-visible
- locally verifiable
- deployment/provider fact required

へ分類する。

reconnaissance段階ではtarget-controlled codeを実行しない。

## 5. Coverage ledger

「agentが一通り見た」をcoverageとしない。

coverageは最低限次からstable unitを作る。

```text
subsystem × entry surface × trust boundary × attack class
```

project規模に応じてcoarsen/splitしてよい。

各unitは最低限:

- `coverage_id`
- subsystem
- entry surface
- lower-trust principal
- protected resource / boundary
- selected attack class
- starting source paths
- owner agent
- status
- checks / evidence
- candidate fingerprints
- uncovered dependency
- prior-run relation

を持つ。

status候補:

- `planned`
- `in_progress`
- `covered`
- `candidate`
- `blocked`
- `deferred`
- `out_of_scope`

`blocked` / `deferred` / `out_of_scope` を `covered` と数えない。

同一repositoryのprior auditが存在する場合:

- unchanged confirmed findingはcurrent source traceを再確認する
- changed sourceは再監査対象へ戻す
- prior `needs_validation` は未解決のままcoverageを抑制しない
- prior rejectionは同じfailed claimだけを抑制し、unit全体をcoveredにしない
- quick/scoped runをfull coverageとして継承しない

## 6. Phase 2 — Coverage-led hunting

hunterはcoverage unitを所有し、そのboundaryに関係するsourceを深く追う。

基本method:

1. lower-trust principal / accepted inputを確定
2. 守られるべきsecurity invariantを定義
3. invariantをenforceするcontrolを特定
4. parsing / normalization / identity / authorization / state transitionを追跡
5. derived copy / alternate path / batch / retry / migration / error pathを確認
6. security-sensitive sink/resultまでtrace
7. sibling pathのcontrol equivalenceを比較
8. minimum concrete resultで停止
9. root causeと最小source fix invariantを記録

重点的に見るsad path:

- absent / empty / zero / negative
- duplicate / replay
- stale / revoked
- mixed encoding / canonicalization disagreement
- over-limit / maximum
- reordered / concurrent
- partial failure / rollback
- migration old/new path
- dependency failure / fallback
- batch / import / export
- alternate endpoint / legacy path

hunterはpeer-owned coverageへ無秩序に広がらない。別boundaryを発見した場合はnew coverage unit候補として返す。

## 7. Attack classes

詳細な選定観点は [`ATTACK-CLASSES.md`](./ATTACK-CLASSES.md) をcanonical catalogとして使用する。projectに存在するsurfaceだけを選択する。

標準class:

- injection / unsafe sink
- authentication / session / account recovery
- authorization / object ownership / tenant isolation
- business logic / state machine / replay
- resource / file / path / archive handling
- SSRF / outbound request trust
- cryptography / secret handling
- parser / deserialization / protocol disagreement
- browser / DOM / origin / postMessage / storage
- native memory / unsafe / FFI / ABI / integer
- concurrency / TOCTOU
- dependency / generated input / plugin / extension
- CI / artifact / release / signing / update
- IAM / IaC / container / serverless / runtime config
- RPC / queue / broker / webhook
- resource exhaustion / quota / operator spend
- cache / search / export / backup / deletion / restore
- desktop / mobile / deep link / webview / local IPC
- AI / LLM context / prompt boundary / tool binding / MCP identity / output handling

generic scanner checklistとして機械的に全classを適用しない。reconnaissance evidenceから選ぶ。

## 8. Bounded local validation

static traceでcandidateが成立した後、必要なら最小local evidenceを取る。

許可される例:

- existing unit/integration test
- minimal function harness
- dummy tenant / dummy principal fixture
- malformed local parser fixture
- deterministic local race schedule
- isolated loopback onlyのlocal client/server
- rendered policy/config comparison

target-controlled build/test/process/browser/emulator/fuzzerは `sandbox-runtime` のenforced isolation下でのみ実行する。

最低条件:

- external networkなし
- explicit allowlistから作るsafe environment
- target/toolchainはread-onlyを基本とする
- writeはagent固有scratchだけ
- CPU / memory / process / disk / file size / wall clock bound
- credential / host secret / shared socketを渡さない
- dependency/toolをaudit中に勝手にfetch/installしない

必要controlをenforceできない場合、実行せず `needs_validation` にする。

minimum effectを確認したら停止する。exploit chain、persistence、stealth、availability damageへ拡張しない。

## 9. Candidate contract

hunter resultはprose-onlyにしない。

candidateは最低限:

- stable `fingerprint`
- title
- proposed verdict
- lower-trust principal
- intended security invariant
- root cause
- source trace: entrypoint -> propagation -> sink/result
- evidence
- required conditions
- observed local result if any
- missing decisive fact if any
- remediation invariant
- proposed regression case

を持つ。

同じsource-derived root causeは同じfingerprintへ統合する。

## 10. Phase 3 — Independent verification

hunter自身のself-confirmationでfindingを確定しない。

unique candidateごとに、発見へ参加していないfresh verifierを割り当てる。

verifierの目的は**candidateを確認することではなく反証すること**。

必須確認:

1. entrypointが本当にlower-trust surfaceか
2. trace中の全source locationがcurrent sourceと一致するか
3. stronger validation / authorization / containment controlがないか
4. preconditionが実際に成立するか
5. bounded local reproductionが再現可能か
6. resultがclaimed impactを支えるか
7. source外factを推測していないか
8. remediationがroot causeを最小範囲で閉じるか

verdict:

### confirmed

source traceと必要条件が成立し、meaningful boundary/resultがbounded evidenceで確認されている。

### needs_validation

specificなsource-grounded hypothesisはあるが、deployment/provider/runtime/identity等の決定的factがsource/local環境から確認できない。

必要:

- missing fact
- なぜ決定的か
- safe local validation plan
- owner-observed deployment validation plan

severityは付けない。

### rejected

source/control/local behaviorによってcandidateが反証された、meaningful impactがない、または前提が成立しない。

rejectedもaudit evidenceとして残し、同じ誤検出を繰り返さない。

## 11. Severity and priority

certaintyとseverityを混同しない。

severityは `confirmed` だけへ付ける。

評価:

- exploitability / required capability
- authentication / privilege
- user interaction
- blast radius
- confidentiality
- integrity
- availability
- tenant/account scope
- persistence
- prerequisite complexity

severityはobserved/demonstrated impactを超えない。

audit severityはdelivery priorityそのものではない。

confirmed findingは `security-maintenance` のproject-aware prioritizationへhandoffし、external exposure、release timing、fix availability、regression risk等を加えてP0/P1/P2/P3へ変換する。

## 12. Phase 4 — Structured output

repository/project conventionに合わせてmachine-readable audit artifactsを残す。標準contractは [`coverage-ledger.schema.json`](./coverage-ledger.schema.json) と [`findings.schema.json`](./findings.schema.json) を使用し、project固有extensionはcore verdict semanticsを弱めない。

推奨:

```text
security-audit/
  run-metadata.json
  architecture.md
  coverage-ledger.json
  findings.json
  REPORT.md
  NEEDS-VALIDATION.md
```

target repository内へ置く必要はない。audit artifactがtarget sourceやrelease artifactへ混入しないようにする。

`findings.json` は少なくとも:

- `confirmed`
- `needs_validation`
- `rejected`

をschemaで区別し、prose reportはstructured recordからderiveする。

run metadata:

- source ref / dirty state
- profile
- scope
- audit timestamp
- selected attack classes
- prior-run inputs
- execution restrictions
- incomplete reason if any

を追跡する。

## 13. Phase 5 — Final record verification

standard/deep auditではfinal report前に、confirmed recordのsource claimをfresh reviewerが再確認する。

material correctionでroot cause / condition / impact / severityが変わる場合は、修正recordを別fresh verifierへ通す。

report textとstructured findingを別々の事実源にしない。

## 14. Phase 6 — Delivery handoff

audit Skill自身はsource修正を行わない。

confirmed findingごとに:

1. root cause / affected boundaryを確定
2. duplicate findingをfingerprintで統合
3. project priorityを `security-maintenance` で判定
4. meaningful findingをGitHub Issueへ変換
5. target release / patch releaseを選択
6. remediation branch / PRを通常delivery workflowで実装
7. regression test + vulnerable-path verification
8. applicable integration / E2E / artifact verification
9. fix後にaffected audit coverageを再検証

`needs_validation` は無理にIssue化・severity付けしない。owner-observed validationが必要な場合はそのfact確認taskとして明示する。

security/privacy risk acceptanceが必要なら `engineering-decisions` に従いuserへescalateする。

## 15. Completion criteria

audit完了時に最低限報告:

- source ref / scope / profile
- mapped principals / trust boundaries
- selected attack classes
- coverage summary
- confirmed count
- needs-validation count
- rejected count
- deferred / blocked / out-of-scope units
- prior-run relation
- incomplete reason if any
- delivery handoff state

coverage gapが残る場合、「脆弱性なし」ではなく「このscopeではconfirmed findingなし」と表現する。

## 16. Anti-patterns

禁止:

- security checklist逸脱をそのままfinding化
- scanner warningをsource traceなしでfinding化
- CVSS/severityだけでcandidateを確定
- provider/deployment controlの存在/不在を推測
- authenticated self-impactをcross-tenant issueへ誇張
- parser crashからRCE等を推測
- hunterとverifierを同一agentで済ませる
- rejected candidateを捨てて同じ誤検出を再発
- uncovered areaをsilentに省略
- quick/scoped auditをfull auditとして報告
- audit中にtarget sourceを直接修正
- production/shared environmentでexploit validation

## 17. Upstream design reference

このSkillのcoverage-led audit、candidate/verifier separation、structured verdict modelはCloudflareの `security-audit-skill` を重要なdesign referenceとしている。

- https://github.com/cloudflare/security-audit-skill
- upstream license: MIT

project-initではupstream固有のagent runtimeやscratch ownership実装をそのままcanonicalにせず、既存の `parallel-orchestration` / `sandbox-runtime` / `github-delivery` semanticsへtranslateして使用する。
