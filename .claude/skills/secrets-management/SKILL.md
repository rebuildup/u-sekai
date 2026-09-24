---
name: secrets-management
description: application / serviceのenvironment secretをInfisical中心で設計・初期化・移行・検証する時に使用する。CLI-first、repository-controlled schema、Machine Identity、GitHub OIDC、agent least-privilege、secret-safe evidenceを扱う。
---

# Secrets Management

application / serviceのsecret管理を、人間・agent・CI/CDが同じauthority modelで扱えるようにする。

current default providerはInfisicalで、current default control planeはself-hosted `https://secrets.rebuildup.dev` だが、目的はprovider adoptionそのものではない。守るべき性質は、secret valueのcanonical authority、least privilege、plaintext persistence回避、schema discoverability、recoverability、agent-safe evidenceである。

原則:

> **Secret values live in the secret provider. Secret contracts live in the repository. Access is identity-scoped and injected only where needed.**

## 1. Responsibility boundary

このSkillが所有する:

- application / service env secretのSoT設計
- Infisical project / environment / path構成
- repository-controlled env schemaとの分離
- local CLI workflow
- Machine Identity / human identityの責務分離
- GitHub Actions OIDC integration
- agent / workerへのsecret capability付与
- plaintext `.env` / GitHub Secrets / SOPS等からのmigration
- secret-safe validation / evidence
- provider unavailable時のdeviation評価

このSkillが所有しない:

- application固有のcredential発行元でのrotation semantics
- cloud IAM全体のarchitecture
- vulnerability hunting全般
- production secret値そのもののレビュー
- security/privacy risk acceptance

接続先:

- unknown secret-handling vulnerability -> `security-audit`
- GitHub workflow / delivery -> `github-delivery`
- worker isolation / credential injection boundary -> `sandbox-runtime`
- runtime validation -> `quality-gate`
- provider selection deviation / security-cost decision -> `engineering-decisions`
- durable recovery -> `agent-recovery`

## 2. Canonical authority split

secret valueとenvironment contractを同じSoTへ押し込まない。

### Secret value

current application/service default:

```text
Infisical (current default: https://secrets.rebuildup.dev)
└─ project
   ├─ dev
   ├─ staging
   └─ prod
```

Infisical側がcanonical value authorityを持つ。

### Secret contract

repository側が次をcanonicalに持つ。

- key name
- required / optional
- type / shape
- non-secret default
- environment applicability
- owning component
- validation rule
- description that does not reveal the value

project stackに応じてtyped env schema、config schema、`.env.example`、generated metadata等を使用する。

`.env.example`を使う場合はreal secretを入れず、placeholder / empty value / non-secret defaultだけを置く。

fresh agentがInfisicalのsecret valueを読むことなく、必要keyとvalidation contractを理解できる状態を維持する。

## 3. When Infisical is the default

次を満たすapplication / serviceではInfisicalをdefaultとする。

- runtimeがenvironment secretを必要とする
- developer / CI / deployment等、複数principalからaccessする可能性がある
- secret valueをGit historyへ置く必要がない
- online secret providerへ到達できる

次はautomatic adoption対象にしない。

- NixOS / dotfiles / bootstrap等でencrypted secret-in-Gitがexplicit requirement
- offline-first runtime
- provider-native storeだけを使う明確なplatform requirement
- regulation / hosting / network constraintでInfisicalを利用できない

deviationはprovider名ではなく、同等以上のguaranteeで評価する。

## 4. Initialization / reconciliation

初期化時は作成前にcurrent stateを調査する。

確認:

1. env schema / validation source
2. `.env` / `.env.*` / secret-like config
3. `.gitignore`
4. GitHub Actions secrets / variablesへの依存
5. existing secret manager / SOPS / cloud secret store
6. runtime / deploy environment
7. CI jobs that actually require secret access
8. developer bootstrap path
9. repository visibility and agent/runtime trust boundaries

desired state:

```text
repository
├─ source
├─ env schema / non-secret metadata
├─ provider pointer/config
│  ├─ site/API endpoint
│  ├─ project ID
│  └─ environment/path mapping
└─ no canonical plaintext secret

Infisical
└─ canonical secret values

human / agent / CI
└─ scoped identity
   └─ runtime injection
```

idempotentに:

`initialize if missing -> repair if incomplete -> update if stale -> verify if already correct`

を適用する。

## 5. CLI-first human workflow

Web UIをnormal workflowの必須surfaceにしない。

current default instance:

```text
site: https://secrets.rebuildup.dev
api:  https://secrets.rebuildup.dev/api
```

標準bootstrap:

```bash
export INFISICAL_API_URL=https://secrets.rebuildup.dev/api
infisical login --domain=https://secrets.rebuildup.dev
infisical init
```

ただしtracked project bindingが既に存在するrepositoryでは `infisical init` をfresh setupのたびに再実行しない。existing bindingを検証し、欠落・stale時だけreconcileする。

provider pointer/configにsecret valueを含めないことを確認し、current defaultで使用するsite/API URL、project ID、environment/path mapping等のsafe metadataをrepositoryからdiscoverableにする。

wrapper / task / CIはcurrent provider endpointを明示し、Infisical CLIのvendor default endpointへ暗黙fallbackさせない。current default profileでmanaged Cloudへ意図せず接続するのはconfiguration driftとして扱う。

通常実行:

```bash
INFISICAL_API_URL=https://secrets.rebuildup.dev/api \
  infisical run --env=dev --path=/backend -- <command>
```

projectにstable local command interfaceがある場合は、provider-specific invocationを薄く包んでよい。

例:

```text
env:run <command>
env:check
env:schema
```

wrapperはsecret valueをprint/exportせず、underlying provider failureを隠さない。

Web UIはinspection / emergency administration / onboarding / access review等に使用できるが、agentや通常developer taskの必須stepとして文書化しない。

### Control-plane automation

project / environment / path / Machine Identity / permission / OIDC trust等も、可能な範囲でheadlessにreconcileできるようにする。

優先順位:

1. Infisical CLIで安全に操作できるsurface
2. official API
3. Terraform / OpenTofu等のofficial provider
4. Web UIはbootstrap / inspection / emergency fallback

control-plane configurationをIaCへ置く場合、repositoryにはproject ID、identity ID、environment/path、role/policy等のnon-secret stateだけを置く。secret valueやlong-lived auth credentialをTerraform/OpenTofu stateへpersistさせない。provider capabilityがtime-sensitiveな場合はcurrent official documentationを確認する。

Web UIでしか行えなかった操作がある場合も、その事実と必要なresultをdurable documentationへ残し、画面操作そのものを唯一のrecoverability sourceにしない。

## 6. Plaintext materialization

runtime injectionを優先する。

平文`.env`やexport fileがtool compatibility上必要な場合だけmaterializeする。

必須条件:

- Git対象外
- pathが明示的にgitignored
- lifecycleがtask/runtimeにbounded
- file permissionを可能な範囲で絞る
- logs / Issue / PR / checkpointへvalueを出さない
- 不要になったcopyを残さない

plain `.env` をcanonical storeやonboarding distribution artifactとして扱わない。

## 7. Agent / worker access

agentへ「Infisicalを使える」ことと「全secretを読める」ことを同義にしない。

default:

- Coordinator / reviewer: secret accessなし
- implementation worker: secret accessなし
- local integrationで必要なworker: dev/testの必要pathだけread
- deployment worker: target environmentの必要pathだけread
- secret maintenance actor: explicit write scopeだけ

Machine Identity / temporary identityは最低限次でscopeする。

- project
- environment
- path
- action
- secret name/tag when practical
- lifetime / auth context when supported

Supervisorはhost userのbroad credentialをsandboxへ無条件inheritさせない。

secret accessが必要なら、そのworker capabilityとして明示的に付与する。

### Forbidden agent behavior

- `env` 等でenvironment全体をdumpする
- secret list取得を目的なく行う
- valueをchat / checkpoint / artifactへ転写する
- debugging目的でsecret valueをlogへ出す
- broader identityへ切り替えてpermission errorを回避する

permission不足はsecurity boundaryとして扱い、必要scopeを特定してから変更する。

## 8. GitHub Actions

GitHub ActionsからInfisicalへaccessする場合、current platformが対応していればOIDC + Machine Identityをdefaultとする。current default profileではidentity/control planeを `https://secrets.rebuildup.dev` 側へ統一する。

desired trust chain:

```text
GitHub Actions job
    ↓ short-lived OIDC token
Infisical Machine Identity
    ↓ scoped authorization
required environment/path secrets
```

標準:

- GitHubにlong-lived Infisical master credentialを保存しない
- workflowは必要なjobだけ `id-token: write`
- `contents: read` 等、他permissionも最小化
- OIDC issuer / subject / audience / repository / environment等をcurrent official contractに従ってrestrict
- generic lint/test jobへproduction secretを渡さない
- production accessはdeployment/release boundaryへ限定
- identity ID / project slug等のnon-secret identifierはsecretとして扱わない
- OIDCをworkflow source protectionの代替にしない
- secret-bearing workflowはtrusted branch / protected environment / applicable review boundaryからだけ実行する
- untrusted PR codeをsecret取得後に実行しない。特に `pull_request_target` 等、base-contextのcredentialとuntrusted head codeを混在させるtriggerは明示的にsecurity reviewする

OIDC非対応runtimeではUniversal Auth等をfallbackとして使用できるが、static credentialは最小scope、rotation可能、long-lived master keyではないものにする。

GitHub Actions / Infisical OIDCのclaim形式やofficial action syntaxはtime-sensitiveである。実装時にcurrent official documentationを確認し、古いexampleをblind copyしない。

## 9. Environment / path model

環境はproject実態へ合わせる。

標準候補:

```text
dev
staging
prod
```

pathはdeployment/component boundaryを表現する。

例:

```text
/shared
/web
/backend
/worker
/deploy
```

すべてのprojectへ固定pathを強制しない。

同じsecretを無秩序に複製するより、ownershipとconsumer boundaryを明確にする。

prod credentialをdevへcopyして動作確認することを標準化しない。

## 10. Schema and drift verification

secret valueを取得せずに可能な検証を優先する。

最低限:

- required keyがschemaに定義されている
- provider上に必要keyが存在する
- unknown/stale keyを検出できる
- environment/path mappingがconsumerと一致する
- required secretがgeneric CIへ露出していない
- application startup時のenv validationがある場合は実行する

evidenceにはvalueではなく次を使用する。

- key name
- presence / absence
- schema validation result
- environment/path
- identity scope
- exit code
- redacted/hash fingerprint when truly necessary

hashもsmall-domain secretの推測材料になり得るため、必要性がない場合は記録しない。

## 11. Secret mutation

secretの作成・変更・削除はconsequential external mutationとして扱う。

変更前:

- target project / environment / path / key identityを確認
- consumerとrollback pathを確認
- write authorityを確認

変更後:

- valueを表示せずpresence / version / consumer behaviorを検証
- dependent runtimeをcurrent valueで再検証
- duplicate old storeが不要なら削除
- rotationが必要ならcredential issuer側も含めて完了を確認

secret valueのPR reviewは行わない。review可能なartifactはschema、scope、consumer change、identity policy、validation evidenceである。

## 12. Migration

### Plaintext .env -> Infisical

1. schema/keyをrepository側で確定
2. valuesをInfisicalへ安全にimport
3. runtimeを`infisical run`等へ切り替え
4. current runtimeを検証
5. plaintext fileをcanonical workflowから除去
6. historical exposureが疑われるvalueはrotate

### GitHub Actions Secrets -> Infisical

1. workflowごとのactual secret dependencyをinventory
2. Machine Identity scopeを設計
3. OIDC利用可能ならOIDCへ切り替え
4. deployment jobでsecret取得を検証
5. 不要になったGitHub Actions secretを削除

### SOPS -> Infisical

application envを移す場合:

1. encrypted file内のkey schemaをinventory
2. valueをInfisicalへ移行
3. local/CI consumerを切り替え
4. current runtimeを検証
5. SOPS file / decryption key dependencyを除去

Nix/dotfiles/bootstrap等 encrypted-in-Git が目的ならSOPSを無理に移行しない。

## 13. Recovery / provider outage

self-hosted Infisical outageを理由にsecret valueをGitやchatへ退避しない。またavailability問題を理由にmanaged Infisical Cloudへ無断fallbackしてsecond canonical secret storeを作らない。

project stakesに応じて:

- bounded local token/session cache
- provider-native HA/self-hosting
- deployment platform側のruntime secret cache
- documented emergency path

を設計できる。

emergency copyを作る場合もtemporary authorityとして扱い、復旧後にreconcile/deleteする。

## 14. Completion criteria

secrets managementを完了扱いするには最低限:

- secret valueのcanonical authorityが一意
- repositoryからrequired env contractをdiscoverできる
- normal developer flowがCLIで完結
- current default profileではself-host site/API endpointがnon-secret metadataとして明示され、managed Cloudへ暗黙fallbackしない
- project ID / environment/path mapping等のprovider pointerがrepositoryからdiscoverable
- Web UIがnormal taskのmandatory dependencyではない
- canonical plaintext `.env` が存在しない
- agent/worker accessが必要最小scope
- generic CIにproduction secretがない
- GitHub OIDCが利用可能ならstatic CI credentialより優先
- secret valueがGit / logs / Issue / PR / checkpointへ残っていない
- migration時はconsumer切替後にold duplicate storeをreconcile済み
- deviation時はInfisical採用有無ではなく必要guaranteeを満たしている

