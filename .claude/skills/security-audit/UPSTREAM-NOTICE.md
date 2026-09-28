# Upstream design reference

`skills/security-audit` は、Cloudflare の `security-audit-skill` を重要なdesign referenceとして設計しています。

- Upstream: https://github.com/cloudflare/security-audit-skill
- Copyright: 2025-2026 Cloudflare, Inc.
- Upstream license: MIT

project-init版はupstreamをvendor copyとして固定するのではなく、coverage-led reconnaissance / hunting、candidateとverifierのseparation、structured verdict、source-visible factとdeployment-only factの分離というworkflow semanticsを、project-init既存のSupervisor / sandbox / delivery / quality contractへtranslateしています。

upstream由来の実装・文章を将来substantialに取り込む場合は、MIT Licenseのcopyright / permission noticeを該当copyへ保持してください。
