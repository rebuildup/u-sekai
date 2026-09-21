# R-04: Comparison of isolated execution environments

> Draft research artifact for issue **R-04** (Comparison of isolated execution environment options for running Synthetic User agents independently).
> This is a **survey**, not an adoption decision. Nothing in this document is "decided" or "adopted".
> Investigation method, evidence, candidate sets, and open questions are recorded here so that subsequent Issues (R-03, R-06, R-08) can narrow the candidate set with prior-art visibility.

---

## 1. Question (verbatim from the draft)

> Compare isolated execution environment options (browser, desktop, VM, container, provider-managed sandbox) for running Synthetic User agents independently.

**Acceptance criteria** (from `docs/research-issues/README.md`):

1. Environment option comparison table exists in docs.
2. Recommended candidate set (not yet adopted) is documented.

**Hard non-scope** (from the draft): vendor lock-in; final adoption decision.

---

## 2. Investigation summary

### 2.1 What was covered

- **Provider-managed remote sandboxes** targeted at AI agent code / browser execution: E2B, Daytona, Modal, Fly.io Machines (with Sprites), and adjacent platforms (Browserbase, Steel, Hyperbrowser, Browserless, Anchor Browser).
- **Low-level isolation primitives** that these platforms (and u-sekai's own self-hosting option) are built on: Linux namespaces + cgroups (Docker / containerd / runc), gVisor, Firecracker microVMs, Kata Containers, and full-hardware VMs (QEMU / KVM / VirtualBox).
- **Browser-internal isolation patterns** within a single browser process: `BrowserContext` (Chromium incognito profile), per-context cookie/storage clearing, single-page iframe / origin sandboxing.
- **Per-session browser instantiation patterns** used by OSS automation stacks: Playwright, Puppeteer, Selenium Grid, `puppeteer-cluster` / `playwright-cluster`-style pools, and `SessionPool`-style orchestrators.
- **Desktop / full-OS isolation patterns** relevant to u-sekai's future-proofing for desktop targets: OSWorld's VM-based evaluation substrate (VirtualBox / KVM, snapshot-driven reproducibility), and QEMU/KVM direct usage.
- **Adjacent research / industry guidance** on isolation strength vs performance trade-offs for "running untrusted code from LLM agents": Fly.io's own write-up on Firecracker vs gVisor, Edera's Kata-vs-Firecracker-vs-gVisor comparison, Northflank's 2026 guide to sandboxing AI agents, and Zylos's analysis of microVMs / gVisor / WASM in the AI threat landscape.

### 2.2 What was skipped and why

- **Live cloud-tenant security models of hyperscalers (AWS Nitro Enclaves, Azure Confidential Compute, GCP Confidential VMs).** These are real isolation primitives but assume a customer-controlled workload on a hyperscaler. u-sekai's Synthetic User runs *its own* code that may act on third-party sites, which inverts the threat model (the workload is the aggressor, not the asset). Per-R-04 scope is "run Synthetic User agents independently", not "protect tenant assets from Synthetic Users".
- **WASM-based isolation (Wasmtime, Spin, Fermyon SpinKube, Fastly Compute@Edge, Cloudflare Workers).** Included only as a reference point in the isolation-strength discussion; not investigated as a primary candidate because the Web-agent substrate (Chromium / accessibility tree / DOM APIs) is not yet first-class in WASM runtimes, and u-sekai's initial Web target inherits the Web's existing execution semantics rather than redefining them.
- **Detailed per-vendor ToS / SLA / pricing negotiation**. R-04 only needs the **shape** of pricing (per-second vs per-session-hour vs per-month) and isolation guarantees; precise procurement-grade numbers are deferred until a candidate set narrows in a follow-up Issue.
- **Mobile device farms (BrowserStack, Sauce Labs, AWS Device Farm).** Noted as a *future* desktop/mobile extension candidate but not surveyed at depth because R-04 explicitly states "Future-proofing for desktop / mobile / CLI / API isolation" without committing to mobile in the initial Web target.

### 2.3 Methodology notes

- Primary sources: vendor docs (E2B, Daytona, Modal, Fly.io, Browserbase, Steel, Hyperbrowser), vendor engineering blogs (Fly.io's "Sandboxes for LLM agents", Modal's "Sandboxes are GA"), independent comparisons (Northflank, Edera, Zylos, Pondhouse Data, safeguard.sh, Substack), and the public OSWorld paper / repo.
- "Isolation" is graded by where the kernel boundary sits:
  1. Shared host kernel + namespace/cgroup only (Docker / runc / containerd without a sandbox runtime)
  2. Shared host kernel + syscall interception in userspace (gVisor)
  3. Dedicated guest kernel, hardware-virtualized, minimal device surface (Firecracker)
  4. Dedicated guest kernel + Kubernetes-native orchestration (Kata Containers)
  5. Full hardware VM with a full device surface (QEMU / KVM / VirtualBox; e.g. OSWorld)
- "Cold start" refers to the time from request to a usable environment, measured against a warm or cold pool depending on source; per-vendor numbers are reported with their stated measurement condition rather than normalized.
- All wording below is **candidate**. Nothing in Sections 5–7 records an adoption decision.

---

## 3. The u-sekai use case these options must serve

Before listing options, the use case is restated so the comparison is meaningful (it is not the generic "run LLM-generated code" question).

u-sekai's design intent (from `README.md` and the R-04 draft):

1. **Many Synthetic Users in parallel.** Personas / tasks / situations are sampled from a population (R-06), and each instance should run **independently** so that a failure or a side effect in one persona does not contaminate another.
2. **Reproducible across many personas.** The same persona / task should produce a comparable behavioral trace under controlled variation (R-07 calibration).
3. **Mixed execution surface.** Initial target is Web (Chromium-driven), but the design space must accommodate desktop / mobile / CLI / API in future revisions.
4. **Cost / safety / portability jointly matter.** u-sekai is a research infrastructure, not a SaaS product; cost shape determines what batch sizes are feasible, safety shape determines whether Synthetic Users can safely touch untrusted third-party sites, portability shape determines whether the infrastructure can be self-hosted.
5. **Telemetry surface.** Each independent session must emit observations (screenshots, DOM, network, action log, subjective report) for later analysis (R-05).

These five constraints, taken together, are what the comparison in Section 4 grades against.

---

## 4. Comparison of options

### 4.1 Isolation primitives (the substrate below any sandbox)

| Primitive | Kernel boundary | Isolation strength | Cold start (stated) | Memory overhead (stated) | Throughput / density | Best fit | Public evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Docker / runc / containerd (no sandbox runtime)** | Shared host kernel | Weakest — kernel escape = full host compromise | Milliseconds | Negligible per container | Very high | Trusted, vetted, in-house workloads | <https://www.docker.com/>, <https://github.com/opencontainers/runc> |
| **gVisor** | Shared host kernel + userspace syscall interception | Stronger than runc (reduced kernel attack surface) | Milliseconds | 10–30 % on I/O-heavy workloads | High | Multi-tenant SaaS, CI/CD, compute-heavy AI workloads | <https://gvisor.dev/>, <https://edera.dev/stories/kata-vs-firecracker-vs-gvisor-isolation-compared>, <https://fly.io/learn/firecracker-vs-gvisor/> |
| **Firecracker microVM** | Dedicated guest kernel, KVM-backed, ~30 emulated devices | Strong (hardware-level; must escape both guest kernel and hypervisor) | ~125 ms | <5 MiB per microVM | Up to 150 launches / second / host | Serverless functions, AI inference, untrusted code, multi-tenant | <https://firecracker-microvm.github.io/>, <https://fly.io/learn/firecracker-vs-gvisor/>, <https://northflank.com/blog/how-to-sandbox-ai-agents> |
| **Kata Containers** | Dedicated guest kernel via VMM (Firecracker / Cloud Hypervisor / QEMU) | Same VM-grade isolation as Firecracker | ~200 ms | Comparable to Firecracker | Slightly lower than raw Firecracker | Regulated industries, multi-tenant Kubernetes, zero-trust | <https://katacontainers.io/>, <https://edera.dev/stories/kata-vs-firecracker-vs-gvisor-isolation-compared> |
| **Full hardware VM (QEMU / KVM / VirtualBox)** | Full guest kernel + full device surface | Strongest per-VM; full OS control | Seconds (10s of seconds for first boot, near-instant for snapshot restore) | Hundreds of MB – GB | Low (one VM per host per task) | Desktop / cross-OS evaluation (e.g. OSWorld) | <https://www.qemu.org/>, <https://www.linux-kvm.org/>, <https://www.virtualbox.org/>, <https://osworld-eval.github.io/> |

Primary observation: the *strength* ordering is roughly **Docker < gVisor < Firecracker ≈ Kata < full VM**, and the *cost / density / cold start* ordering is the inverse. u-sekai's sweet spot is likely **Firecracker (or a platform built on it)** for the per-persona execution units, with **full VM** reserved for desktop-target / OSWorld-style future work where the *full OS surface* is itself the evaluation target.

### 4.2 Provider-managed remote sandboxes (code execution)

These platforms package the substrate in 4.1 behind an SDK that u-sekai could call directly without owning the underlying cluster.

| Platform | Substrate | SDK languages | Cold start (stated) | Pricing shape | Snapshot / state | File system | Compliance / status | Public evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **E2B** | Firecracker microVM | Python, JavaScript | Sub-second (vendor-reported) | Per-second, billed by usage | Full or filesystem-only snapshot; resume; fork up to 100 copies from a saved state | Isolated POSIX FS; mounted S3/GCS/R2; persistent volumes; Git | Apache-2.0 SDK; SOC 2 Type II; YC-backed | <https://e2b.dev/>, <https://docs.e2b.dev/>, <https://e2b.dev/pricing>, <https://e2b.dev/blog/e2b-vs-daytona> |
| **Daytona** | Customer-managed isolated compute | Python, TypeScript, Ruby, Go, Java | <90 ms (vendor-reported) | vCPU $0.0504 / hr, memory $0.0162 / GB / hr, storage $0.000108 / GB / hr; $200 free credits; GPU options from RTX 4090 to B200 | Stateful by design; environment snapshots for save / restore / resume; supports long-running / indefinite sessions | Full CRUD with granular permissions; native Git ops with secure credential handling | Self-hostable (OSS) or cloud-hosted | <https://www.daytona.io/>, <https://northflank.com/blog/daytona-vs-modal> |
| **Modal Sandboxes** | Modal's serverless containers (sandbox primitive) | Python | Seconds-class; Modal's claim is "serverless" (no specific public number verified in this investigation) | Per-second: CPU $0.00003942 / physical-core / s; memory $0.00000672 / GiB / s; billed by requested or actual, whichever is higher | Snapshot supported (Modal blog and docs reference it) | Mount support (per Modal docs) | GA since Jan 21, 2025 | <https://modal.com/blog/sandbox-launch>, <https://modal.com/docs/guide/sandboxes>, <https://modal.com/docs/guide/sandbox-resources>, <https://modal.com/blog/top-code-agent-sandbox-products>, <https://blaxel.ai/blog/blaxel-vs-modal> |
| **Fly.io Machines (with Sprites)** | Firecracker microVM | Languages supported by the container image | ~125 ms (Firecracker baseline); a stopped Machine "starts in well under a second"; Sprites layer resumes from pre-initialized runtimes | Fly's standard per-second machine billing (not re-quoted here) | Sprites add copy-on-write checkpoints to restore after agent breakage; resumes from saved state with entropy-pool caveats documented in the source | Per-microVM filesystem; Sprites provide FS that survives sleep | Fly.io's blog explicitly positions this as a sandbox pattern for LLM agents | <https://fly.io/blog/sandbox-patterns-for-llm-agents>, <https://fly.io/learn/firecracker-vs-gvisor/>, <https://fly.io/docs/machines/> |
| **Blaxel** | (Positioned as competitor to Modal in 2026) | Multi-language SDK | (Stated by vendor; not independently verified) | Per-second; positioned as cost-comparable to Modal | Yes | Yes | 2026 entrant | <https://blaxel.ai/blog/blaxel-vs-modal> |

Primary observations across the managed-sandbox row:

- **E2B** is the most SDK-friendly and has the strongest snapshot / fork story (fork up to 100 copies from a saved state) — directly relevant to the "many Synthetic Users in parallel" use case, where one persona could be branched into many slightly varied situations.
- **Daytona** is the most dev-environment-shaped (VS Code integration, Git-native, Language Server Protocol) and is the only one with GPU SKUs in the same control plane — relevant if u-sekai ever drives GPU-bound agents locally.
- **Modal** is the most mature serverless substrate but is **strongly Python-flavored** in its SDK; cross-language ergonomics are weaker than E2B or Daytona's.
- **Fly.io Machines** is the lowest-level option of the four; it gives u-sekai the *raw Firecracker substrate* plus an egress-allowlist network policy and Sprites checkpointing. Cost shape is competitive but the operational surface is wider.

None of these four is a single winner. Each trades off **friction to integrate** against **degree of substrate control**.

### 4.3 Browser-as-a-Service (hosted Chromium)

| Platform | Substrate | Open source | Self-host | Cost shape | Multi-context / parallel tabs | Anti-detection | Observability | Public evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Browserbase** | Cloud containers with headless Chrome instances | No | No | Subscription: free tier (1 hr / month), Developer $19 / mo, Premium $99 / mo; per-session at higher usage | Limited | Strongest (residential IPs, stealth proxies per vendor) | Live debugging viewer, session recording & replay, SOC 2 Type II | <https://www.browserbase.com/stagehand> |
| **Steel** | Self-hostable Docker container with Chromium + Node.js API | Yes (MIT) | Yes (free) + paid cloud | Self-hosted free; cloud ~$0.10 / session-hour | Yes | Strong (stealth mode, CAPTCHA solving, proxy rotation) | Basic logs | <https://github.com/steel-dev/steel> (Steel project site / docs referenced in third-party comparisons) |
| **Hyperbrowser** | Cloud-native Chromium | No | No | Pay-as-you-go (free credit tier, then compute-hours) | Native multi-context per agent | Strong | Full session traces, token-usage tracking, MCP server support | <https://hyperbrowser.ai/> (referenced in third-party comparison write-ups) |
| **Browserless** | Containerized Chromium with session APIs | Partial | Yes (self-host option) | Per-session / subscription (per vendor page) | Yes | Standard | Session logs | <https://www.browserless.io/> |
| **Anchor Browser** | Hosted browser instances | Partial | Yes | Per-session | Yes | Standard | Session logs | <https://anchorbrowser.io/> (referenced in third-party comparisons) |

Primary observations:

- All three first-tier platforms have added **Model Context Protocol (MCP) server support** for tool calling, which is relevant if u-sekai adopts MCP as an L3/L4 interface (see R-01 §4.4).
- **Token-cost compression** (compressing DOM before sending to LLM) is becoming a first-class feature in this category, originally pioneered by Hyperbrowser per the third-party comparison write-ups.
- **Anti-detection** (stealth mode, residential IP rotation, CAPTCHA solving) is relevant if u-sekai wants Synthetic Users to interact with *real, anti-bot-protected sites* — which is in tension with R-01's reproducibility concern (live-site drift). The candidate set should pick one stance (Section 5).
- The **open-source / self-host** axis is the most consequential difference for u-sekai: Browserbase and Hyperbrowser are paid SaaS only; Steel is OSS / self-host-first. This maps directly onto u-sekai's portability requirement.

### 4.4 Browser-internal isolation patterns (within a single browser)

| Pattern | Isolation boundary | Memory cost (per tenant) | Setup complexity | Best fit |
| --- | --- | --- | --- | --- |
| **`BrowserContext` (Chromium incognito) — Puppeteer `createIncognitoBrowserContext`, Playwright `newContext`** | One browser process, separate cookies / storage / cache per context | Tens of MB | Low | Many personas against *known* sites where cross-context leaks are tolerable |
| **Per-session full browser instance** | Separate process, separate caches, separate storage | ~100–300 MB per instance | Medium | Higher isolation; one browser per persona / per scenario |
| **Pool-managed browser** (`puppeteer-cluster`, `playwright-cluster`, `SessionPool`) | One of the above, but lifecycle managed externally | Same as base pattern | Medium | Parallelism at scale with health checks and lifecycle hooks |
| **Containerized browser (Selenium Grid Docker, Browserless, Anchor)** | One browser process per container; container-level isolation | Same as base + container overhead | Higher | Strict multi-tenant isolation; matches u-sekai's "many in parallel" requirement |

Primary observation: **BrowserContext alone is not strong enough** for u-sekai's "Synthetic User might click anything" threat model. The minimum credible isolation is **container-per-session** (Selenium Grid style) or **microVM-per-session** (Browserbase / Steel / Hyperbrowser / Fly.io style). Per-persona process isolation via a pool-managed browser is a defensible middle ground if the threat model is limited to "no cross-persona cookie leaks".

### 4.5 Desktop / full-OS isolation (future-proofing)

| Pattern | Substrate | Boot time (stated) | Snapshot / reset | Cross-OS | Public evidence |
| --- | --- | --- | --- | --- | --- |
| **OSWorld's evaluation environment** | VirtualBox or KVM, per the official repo; Ubuntu and Windows supported | Seconds for first boot; near-instant for snapshot restore | Snapshot-driven reproducibility (each task starts from a clean snapshot) | Yes — Ubuntu, Windows, macOS (per project page) | <https://osworld-eval.github.io/>, <https://github.com/osworld-eval/OSWorld>, <https://arxiv.org/abs/2404.07972> |
| **QEMU / KVM direct** | Full hardware VM | Seconds to tens of seconds | Yes (qemu-img snapshot / libvirt) | Yes (any guest OS) | <https://www.qemu.org/>, <https://www.linux-kvm.org/> |
| **VirtualBox** | Type-2 hypervisor | Seconds | Yes (VirtualBox snapshot) | Yes | <https://www.virtualbox.org/> |

Primary observation: for u-sekai's *future* desktop / OS evaluation use case, **OSWorld's VirtualBox / KVM substrate is the de facto reference** because it is the only public benchmark that already exercises this isolation pattern at scale and provides programmatic state checkers. u-sekai should treat it as a **candidate future extension**, not an initial Web-target dependency.

---

## 5. Gap analysis vs u-sekai requirements

| u-sekai requirement (from §3) | Best-fitting option class | What's missing in current prior art | Notes for R-03 / R-06 / R-08 |
| --- | --- | --- | --- |
| **R1. Many Synthetic Users in parallel** | Provider-managed Firecracker-based sandboxes (E2B, Fly.io, Browserbase, Steel, Hyperbrowser) — or a self-hosted Firecracker / Kata cluster | No platform exposes a **persona-indexed** API: every call returns a sandbox, but the synthetic-user identity has to be carried in the calling code. **Snapshot + fork** semantics (E2B's "fork up to 100 copies from a saved state") are the closest analog and should be evaluated against the persona-sampling design (R-06). | R-06 (user population generation) needs to design how persona branching interacts with sandbox fork semantics. |
| **R2. Reproducible across many personas** | Containerized browser per persona (Selenium Grid style) for *known sites*; self-hosted browser pool (Steel) or BrowserContext-per-persona for *live sites* (with reproducibility caveats from R-01 §5) | Live-site drift, anti-bot detection, and network variability make live-site reproducibility weak. **OSWorld / WebArena-style self-hosted replicas** (already noted in R-01) are the more reproducible substrate for the *evaluation* phase. | R-08 (MVP scope) must decide whether initial MVP runs against live sites or self-hosted replicas, because this choice constrains the isolation choice. |
| **R3. Mixed execution surface (Web today; desktop / mobile / CLI / API later)** | Layered choice: **Firecracker microVM** (E2B / Fly.io / Modal) for code & browser substrates; **full VM** (QEMU / KVM / VirtualBox, e.g. OSWorld substrate) for desktop-target future work | No single platform covers Web + desktop + mobile + CLI in a uniform API. WASM-based substrates (Wasmtime, Fermyon Spin, Cloudflare Workers) are a possible unifying future substrate but were not investigated in depth for this Issue. | R-08 should treat desktop / mobile as deferred unless R-03 concludes the Synthetic User persona model demands them in MVP. |
| **R4. Cost / safety / portability jointly matter** | **OSS / self-host** axis matters most for portability: Steel (browser) + Fly.io Machines or self-hosted Firecracker + Kata Containers on Kubernetes (code) give u-sekai the ability to run entirely on its own infrastructure; **SOC 2 / HIPAA compliance** matters most for safety in research-data handling. E2B and Browserbase are SOC 2 Type II. None of the surveyed OSS self-host stacks have published SOC 2 evidence. | Compliance posture (SOC 2 / GDPR / AI-Act) for u-sekai's *own* research data is not yet a design decision. It is recorded here as an open question. | R-08 (MVP) should pick a candidate based on which axis dominates for the MVP target. |
| **R5. Telemetry surface** | All surveyed platforms expose at least one of: session logs, traces, screenshots, DOM snapshots. **Hyperbrowser** is the most explicit about agent-observability dashboards (session traces + token usage tracking); **Modal** has traces; **E2B** has streaming output; **Browserbase** has live debugging + session replay. | None of them is designed to emit **persona-conditioned subjective reports** (R-05). The telemetry surface is *behavioral*, not *subjective*. u-sekai must build the subjective-report channel itself. | R-05 (subjective evaluation) must remain in scope for u-sekai to design, regardless of which isolation candidate is picked. |

### 5.1 Specific gaps the candidate set must address

1. **Persona-indexed API**: existing platforms expose sandbox-indexed APIs; u-sekai needs a persona-indexed layer above.
2. **Anti-bot vs reproducibility**: Browserbase / Hyperbrowser / Steel lean into anti-detection; OSWorld / WebArena lean into reproducibility. u-sekai must pick a stance.
3. **Live-site safety**: a Synthetic User that is free to click anything on a *live* third-party site is a real safety concern (ToS, account creation, payment flows, malicious content). Live sites should not be the initial target for an unsupervised exploratory agent — R-08 should default to self-hosted replicas for the MVP.
4. **Telemetry shape**: existing observability is behavioral (clicks, screenshots, traces). u-sekai's value also requires *subjective* (R-05) and *persona-conditioned* reporting (R-06), which must be designed independently.
5. **Cost shape at research scale**: per-second billing is good for batch workloads; per-month subscription is good for low-volume always-on. u-sekai's batch / bursty pattern (run N personas for session duration, then idle) favors per-second + snapshot.

---

## 6. Candidate sets (for downstream Issues to narrow)

> All wording below is **candidate**, not adopted. The role of R-04 is to put plausible candidates on the table so that R-03 / R-06 / R-08 can decide.

### 6.1 Substrate primitives (the layer u-sekai could self-host)

| Candidate | Pros | Cons |
| --- | --- | --- |
| Docker / runc / containerd | Ubiquitous; trivial to operate; smallest cold start | Shared kernel = weakest isolation; only safe for *known-trusted* code |
| gVisor | Stronger isolation than runc, no hardware-virtualization needed | 10–30 % I/O overhead; smaller ecosystem than Firecracker |
| Firecracker microVM | Hardware isolation; ~125 ms cold start; <5 MiB / VM; high density | Operational surface wider; less flexible than full VM |
| Kata Containers | Firecracker-grade isolation with K8s-native orchestration | ~200 ms cold start; still requires K8s operational expertise |
| Full VM (QEMU / KVM / VirtualBox) | Strongest per-VM isolation; full OS surface for desktop-target evaluation | Seconds-class boot; low density; high memory cost |

### 6.2 Provider-managed remote sandboxes (code execution)

| Candidate | Pros | Cons |
| --- | --- | --- |
| E2B | Firecracker; OSS SDK (Apache 2.0); snapshot + fork (up to 100 copies); SOC 2 Type II; YC-backed | Vendor dependency; per-second cost adds up at very large batch sizes |
| Daytona | Multi-language SDK (Python / TS / Ruby / Go / Java); <90 ms cold start; GPU options; OSS / self-host option | Smaller ecosystem than E2B / Modal |
| Modal | Serverless substrate; per-second pricing; GA since Jan 2025; mature engineering blog | Strongly Python-flavored; per-second pricing is competitive but requires careful budgeting |
| Fly.io Machines (with Sprites) | Firecracker substrate; egress-allowlist network policy; copy-on-write checkpoints; raw control | Operational surface wider; not a turnkey "agent sandbox" SDK — closer to primitives |
| Blaxel | 2026 entrant positioned against Modal | Newest entrant; ecosystem immaturity; pricing transparency limited |

### 6.3 Browser-as-a-Service

| Candidate | Pros | Cons |
| --- | --- | --- |
| Browserbase | Mature; SOC 2 Type II; live debugging + replay; strong anti-detection | Closed source; subscription pricing; **vendor-concentration risk** (paired tightly with the Stagehand L3 candidate from R-01) |
| Steel | Open source (MIT); self-hostable; SDK integrations with LangChain / LlamaIndex / CrewAI / AutoGen; cheapest per-session-hour of the three | Smaller ecosystem than Browserbase; basic observability |
| Hyperbrowser | Multi-context sessions; built-in structured extraction API; MCP server support; first-class observability for multi-agent | Closed source; pricing transparency limited |
| Browserless (self-host) | Mature; containerized; can be self-hosted | Older API surface; less AI-agent-specific than the three above |
| Anchor Browser | Self-host option; reasonable per-session pricing | Smaller ecosystem |

### 6.4 Browser-internal isolation patterns (within a self-hosted browser)

| Candidate | Pros | Cons |
| --- | --- | --- |
| Per-persona `BrowserContext` (Chromium incognito) | Lightweight; ms-scale creation; small memory footprint | Shared browser process; cross-context leaks possible; insufficient if Synthetic Users can issue arbitrary commands |
| Per-persona full browser instance + pool (`puppeteer-cluster`, `playwright-cluster`, `SessionPool`) | Strong per-persona isolation; mature pool libraries | ~100–300 MB / instance; operational surface (pool health checks, lifecycle) |
| Per-persona containerized browser (Selenium Grid Docker, Browserless, Anchor self-host) | Container-level isolation; reproducible per-persona image | Higher memory cost; K8s / Docker operational surface |

### 6.5 Cross-cutting combination candidates (illustrative, not adopted)

These are *combinations* of the above, sketched only to illustrate that the candidate space is layered; they are not recommendations.

| Combination | What it would give u-sekai | Open question |
| --- | --- | --- |
| **Steel (browser) + self-hosted Firecracker cluster (code) + OSWorld-style VM (desktop future)** | Fully self-hostable; no SaaS dependency; covers Web today and desktop later | Owns the operational surface end-to-end; needs K8s + Firecracker + KVM expertise |
| **E2B (code) + Browserbase (browser) + Modal (bursty GPU/CPU batch)** | Minimal ops burden; mature per-component; SOC 2 / compliance friendly | Three vendor relationships; per-second pricing at research scale; vendor-concentration risk |
| **Fly.io Machines + Steel (browser) on Fly.io** | Single cloud substrate (Firecracker) for both code and browser; egress-allowlist network policy | Tightest vendor coupling of the three; less AI-agent SDK surface than E2B / Browserbase |

### 6.6 What u-sekai should likely *not* adopt

- **Docker / runc alone** for any sandbox that touches untrusted third-party content. The shared-kernel boundary is the wrong shape for an exploratory agent that might click anything.
- **WASM-only sandboxes (Wasmtime / Spin / Fermyon / Cloudflare Workers)** as the *primary* Web substrate. Web's primary substrate is still DOM / Chromium; WASM is an adjacent runtime with its own tool ecosystem, and u-sekai's R-01 layer model places WASM as an L5 candidate (model API), not an L1 / L2 substrate.
- **Mobile device farms (BrowserStack, Sauce Labs, AWS Device Farm)** as initial MVP target — out of scope per R-04's Web-first framing.
- **Hyperscaler confidential compute (Nitro Enclaves, Confidential VMs)** as a *primary* substrate — inverts the threat model (confidential compute protects a workload from a malicious host; u-sekai's concern is protecting the host from the workload).

---

## 7. Open questions / unresolved consequential decisions

The following surfaced during the survey but require separate Issues or user escalation. They are recorded here so they are not lost.

1. **Live sites vs self-hosted replicas for the initial MVP.** R-01 §7 open question 2 framed this; R-04 makes the consequence concrete: Browserbase / Hyperbrowser / Steel lean into *real anti-bot anti-detection*, which only matters for *live* sites. If R-08 chooses live sites, the candidate set shifts toward anti-bot-strong BaaS; if it chooses replicas, the candidate set shifts toward self-hosted browser pool over a WebArena-style substrate. **This decision blocks the isolation choice for the MVP.**
2. **Persona-indexed API above the sandbox-indexed SDK.** No surveyed platform exposes a persona-indexed surface. Does u-sekai build this layer itself (thin wrapper), or wait for a vendor to add it? Affects the L4 / orchestration design (R-03).
3. **Snapshot vs fork semantics for persona variation.** E2B's "fork up to 100 copies from a saved state" is the closest analog to persona branching. But forking a saved state means children are identical at branch time; persona *variation* is then applied by what the persona layer injects on top of the sandbox. The exact contract between sandbox fork and persona branching is an open design decision (R-06).
4. **BrowserContext vs container-per-persona vs microVM-per-persona for the minimum isolation unit.** Tradeoff: BrowserContext is cheapest but weakest; container-per-persona is the mainstream middle; microVM-per-persona is strongest but costliest. The right answer depends on the *threat model* for the MVP (what Synthetic Users are allowed to click). R-08 must specify this.
5. **Anti-bot / anti-detection stance.** If u-sekai Synthetic Users should look like real users (anti-bot bypass), the candidate set is Browserbase / Hyperbrowser / Steel with stealth. If u-sekai Synthetic Users should be detectable as synthetic (transparency), the candidate set is open-source browser pools. The decision is in tension with R-07 (calibration against real users) — should synthetic users *behave* like real users including on detection surfaces, or should they be visibly synthetic?
6. **Self-host vs SaaS posture.** Self-host (Steel + Fly.io + self-hosted Firecracker + OSWorld substrate) gives full control and OSS alignment; SaaS (E2B + Browserbase / Hyperbrowser + Modal) gives operational lightness and compliance posture. R-08 must specify. If R-04's MVP self-hosts, u-sekai needs K8s / Firecracker / KVM operational expertise in its contributor base.
7. **Compliance posture for u-sekai's own research data.** If u-sekai runs on third-party SaaS sandboxes, what data classification (browser screenshots, persona logs, behavioral traces) can be sent to them? GDPR / AI Act / institutional IRB review apply. This is **not** a code decision but a research-operations decision.
8. **WASM as a unifying future substrate.** Not investigated in depth here. WASM-based sandboxes are rapidly maturing (Wasmtime 1.0+, Fermyon Spin, Cloudflare Workers); if u-sekai's R-08 deferred scope ever lands on cross-runtime portability, WASM deserves its own Issue.
9. **GPU-resident synthetic users.** Daytona's GPU SKUs (RTX 4090 through B200) suggest a future in which a Synthetic User runs an LLM locally inside its own sandbox rather than calling out to a model API. This affects both isolation (the LLM weights are part of the sandbox state) and cost (per-second GPU is dramatically more expensive than per-second CPU). Out of scope for MVP, in scope for a future Issue if R-06's persona model requires local models.

---

## 8. References

### Isolation primitives

- Docker — <https://www.docker.com/>
- runc — <https://github.com/opencontainers/runc>
- gVisor — <https://gvisor.dev/>
- Firecracker microVM — <https://firecracker-microvm.github.io/>
- Kata Containers — <https://katacontainers.io/>
- QEMU — <https://www.qemu.org/>
- KVM — <https://www.linux-kvm.org/>
- VirtualBox — <https://www.virtualbox.org/>
- Fly.io's Firecracker-vs-gVisor write-up — <https://fly.io/learn/firecracker-vs-gvisor/>
- Edera's Kata-vs-Firecracker-vs-gVisor isolation comparison — <https://edera.dev/stories/kata-vs-firecracker-vs-gvisor-isolation-compared>
- Northflank's "How to sandbox AI agents in 2026" — <https://northflank.com/blog/how-to-sandbox-ai-agents>
- Zylos's "MicroVMs, gVisor, WASM, and the new threat landscape" — <https://zylos.ai/research/2026-04-04-ai-agent-sandboxing-security-isolation/>
- safeguard.sh's runc-vs-gVisor-vs-Kata-vs-Firecracker comparison — <https://safeguard.sh/resources/blog/container-runtime-comparison-security>
- Manveer Chawla's "How to sandbox AI agents in 2026" — <https://manveerc.substack.com/p/ai-agent-sandboxing-guide>

### Provider-managed remote sandboxes

- E2B docs — <https://docs.e2b.dev/>, <https://docs.e2b.dev/quickstart>, <https://docs.e2b.dev/openapi-public.yaml>
- E2B pricing — <https://e2b.dev/pricing>
- E2B vs Daytona (vendor comparison) — <https://e2b.dev/blog/e2b-vs-daytona>
- E2B homepage — <https://e2b.dev/>
- Daytona homepage — <https://www.daytona.io/>
- Northflank's Daytona-vs-Modal comparison — <https://northflank.com/blog/daytona-vs-modal>
- Modal "Sandboxes are GA" announcement — <https://modal.com/blog/sandbox-launch>
- Modal Sandboxes docs — <https://modal.com/docs/guide/sandboxes>
- Modal sandbox resources & pricing — <https://modal.com/docs/guide/sandbox-resources>
- Modal "Run production Sandboxes at scale" — <https://modal.com/products/sandboxes>
- Modal "Top AI code sandbox products in 2025" — <https://modal.com/blog/top-code-agent-sandbox-products>
- Modal "Best GPU-enabled sandboxes for AI agents in 2026" — <https://modal.com/resources/best-gpu-enabled-sandboxes-ai-agents>
- Modal "Best serverless sandboxes for AI code execution in 2026" — <https://modal.com/resources/best-serverless-sandboxes-ai-code-execution>
- Blaxel-vs-Modal comparison (Jul 2026) — <https://blaxel.ai/blog/blaxel-vs-modal>
- Fly.io "Sandbox patterns for LLM agents" — <https://fly.io/blog/sandbox-patterns-for-llm-agents>
- Fly.io Machines docs — <https://fly.io/docs/machines/>
- Pondhouse Data "Sandboxed code execution for AI agents" — <https://www.pondhouse-data.com/blog/sandboxed-code-execution-for-ai-agents>

### Browser-as-a-Service

- Browserbase (paired with Stagehand, also referenced in R-01) — <https://www.browserbase.com/stagehand>
- Steel OSS repo — <https://github.com/steel-dev/steel>
- Hyperbrowser — <https://hyperbrowser.ai/>
- Browserless — <https://www.browserless.io/>
- Anchor Browser — <https://anchorbrowser.io/>
- Third-party Steel/Browserbase/Hyperbrowser comparison (commonly referenced in 2025 ecosystem write-ups) — referenced via Steel and Hyperbrowser product sites

### Browser-internal isolation

- Puppeteer `createIncognitoBrowserContext` docs — <https://pptr.dev/api/puppeteer.browser.createincognitobrowsercontext>
- Playwright `browser.newContext` — <https://playwright.dev/docs/api/class-browser#browser-new-context>
- `puppeteer-cluster` — <https://github.com/thomasdondorf/puppeteer-cluster>
- Selenium Docker — <https://github.com/SeleniumHQ/docker-selenium>
- SessionPool — <https://github.com/mediar-ai/sessionpool>

### Desktop / full-OS isolation

- OSWorld homepage — <https://osworld-eval.github.io/>
- OSWorld GitHub — <https://github.com/osworld-eval/OSWorld>
- OSWorld paper (arXiv) — <https://arxiv.org/abs/2404.07972>

### Adjacent (R-04 cross-reference)

- R-01 browser / computer-use agent survey — <https://github.com/u-sekai/u-sekai/blob/release-0-1-0/docs/research-issues/r-01-browser-agent-survey.md> (local copy at `docs/research-issues/r-01-browser-agent-survey.md`)

---

## 9. Status

This is a draft research artifact for R-04. No adoption / non-adoption decision is recorded here; per `CLAUDE.md` §3 and §5, those decisions belong to follow-up Issues (R-03, R-06, R-08) once they open and resolve. Open questions in Section 7 should be routed into those Issues or escalated to user per `engineering-decisions` precedence rules.
