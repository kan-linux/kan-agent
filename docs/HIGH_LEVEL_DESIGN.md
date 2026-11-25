# Kan-Agent High Level Design

| Item | Content |
|---|---|
| Status | Draft |
| Date | 2026-11-22 |
| Chinese version | [HIGH_LEVEL_DESIGN.zh-CN.md](https://github.com/kan-linux/kan-agent/blob/kan-agent/docs/HIGH_LEVEL_DESIGN.zh-CN.md) |


## 1. Overview

A core feature of Kan-Linux is the **absence of traditional package managers**. **Kan-Agent is the native agent subsystem of Kan-Linux**: it autonomously performs **build and deployment** of system components, replacing the package managers (apt, dnf, pacman, ...) and app stores of traditional Linux distributions; it also autonomously performs system fault resolution.

2026 marks a turning point: local AI is widely accepted, and consumer hardware and local inference stacks are mature. Kan-Agent cuts out the centralized binary distribution middleman, **pulling official binaries or source code directly from upstream repositories**; auditing, patching, compilation and deployment all happen locally — an analogy similar to Dell's direct-sale model.


### 1.1 Roadmap

Development proceeds in three stages: **Stage 1** completes build and deployment of system components via CLI; **Stage 2** completes system fault repair via CLI; **Stage 3** provides GUI-based agent interaction.

| Milestone | Stage | Content | Status |
|---|---|---|---|
| **M0 Selection & validation** | 1 | llama.cpp build on Kan-Linux ([kan#32](https://github.com/kan-linux/kan/discussions/32)); edge model evaluation ([Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4)) | In progress |
| **M1 High-level design** | 1 | High-level design completed (this document) | ✅ Done |
| **M2 Skeleton** | 1 | Customized Pi (tool layer + permission layer) + ggml-hexagon `llama-server` binding; register the 7 tool Schemas (stubs acceptable); validate the tool-call chain directly with the base model + System Prompt (before fine-tuning); get the fine-tuning trajectory data format working | |
| **M3 Data pipeline & fine-tuning** | 1 | Trajectory recording platform (real execution in sandbox + human screening); produce 150–800 trajectories; QLoRA fine-tuning; GGUF export; comparative evaluation against the base model (tool-call accuracy, closed-loop success rate) | |
| **M4 Full lifecycle** | 1 | Sandbox, content-addressed store, atomic deploy, snapshot (generation) rollback landing; closed loops for build-exception self-repair and security-audit scenarios; absorb `install-prebuilts.sh` capabilities into the system substrate and the official component catalog | |
| **M5 Hardening & integration** | 1 | LiveISO integration and footprint optimization; UX polish (llama.cpp-grade ease of use); broader build-system coverage (Meson/Bazel/Autotools/Kbuild); audit/permission policy completion; remove `install-prebuilts.sh` from the image so `kan-agent` is the sole entry point | |
| **M6 System fault repair** | 2 | Closed loop for system troubleshooting and repair; troubleshooting-scenario trajectory production and model enhancement | |
| **M7 GUI interaction** | 3 | GUI-based agent interaction (task initiation, progress/result display, confirmation & authorization) | |

### 1.2 Terminology

| Term | Definition |
|---|---|
| **Kan-Agent** | The native agent subsystem of Kan-Linux; an agent-first system orchestrator |
| **Pi** | An open-source agent project ([earendil-works/pi](https://github.com/earendil-works/pi)), a minimal, extensible AI agent harness |
| **Tool-calling DSL** | A structured tool-call language defined by Kan-Agent: JSON Schemas of the 7 atomic tools plus Gemma4 native control tokens; the contract between the model and the tool layer |
| **Domain-Specific Task Model (DST)** | A domain-specialized model fine-tuned from a frontier edge model (Gemma4-e4b in this design) for Kan-Agent's task requirements, mastering the Kan-Agent tool-calling DSL and systems-engineering tasks (source builds, patching, auditing, rollback, troubleshooting) |
| **ggml-hexagon** | A llama.cpp fork maintained by kan-linux (the [`self-build-jz` branch](https://github.com/kan-linux/ggml-hexagon/tree/self-build-jz)), the featured inference engine of Kan-Agent |
| **generation** | The system-component state version produced by one atomic deploy; the system can roll back as a whole to any historical generation |

This document covers only Kan-Agent's build-and-deploy capability for system components; system fault resolution is out of scope.

## 2. Key Use Cases

Kan-Agent handles **two classes of software installation**:

| Class | Typical software | Characteristics | Current status |
|---|---|---|---|
| **Official binary** | Firefox, Node.js, Oracle JDK, Go, Rust, Vulkan SDK, etc. | Upstream provides official prebuilt release packages (tarball/AppImage); no local compilation step | Installed by [`vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh) in the kan repo: official distribution URLs only, /opt isolated roots, deletion allowlist, disk preflight |
| **Source build** | btop, htop, etc. | Source fetched from hosting sites, compiled locally in a sandbox, then deployed | None (Kan-Agent's new core capability) |

Both classes share the same tool-calling DSL and the atomic deploy/rollback substrate; pipelines are trimmed per class.

| ID | Use case | Summary |
|---|---|---|
| UC1a | Install software (official binary) | User: "install Firefox/Node.js/Go" → agent fetches the release package from official distribution sources, verifies origin and integrity, deploys to /opt isolated roots and places configuration |
| UC1b | Install software (source build) | User: "install btop/htop/some driver module" → agent fetches source, audits, compiles in sandbox, deploys atomically |
| UC2 | Update component | New upstream version → run the update pipeline per class (new release package / new source), verify, atomic switch, roll back on failure |
| UC3 | Build-failure self-repair | Compile error → analyze stderr, locate header/linker/flag issues, patch via `source_patch`, rebuild |
| UC4 | Rollback on deploy failure | New component causes shared-library conflicts / service failures → health check fails → automatic atomic rollback |
| UC5 | Security-audit interception | Install script contains `curl \| sh`, unauthorized writes to `/etc`, dangerous `rm -rf` → force interception and request user authorization |
| UC6 | System troubleshooting sweep | User: "something is broken" → `sys_inspect` read-only sweep, locate, fix or advise |

## 3. Overall Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Interaction layer: kan-agent CLI (llama.cpp-grade ease of use;    │
│            interactive / print / JSON modes)                       │
└──────────────────────────────┬─────────────────────────────────────┘
┌──────────────────────────────▼─────────────────────────────────────┐
│  Agent Runtime (customized Pi)                                     │
│  agent loop · session management · tool-call parsing ·             │
│  permission/confirmation policy                                    │
└───────────────┬───────────────────────────────────┬────────────────┘
┌───────────────▼─────────────────┐ ┌───────────────▼────────────────┐
│  Inference engine layer          │ │  Tool orchestration layer      │
│  ggml-hexagon (llama.cpp fork)  │ │  7 atomic tools + tool DSL     │
│  CPU backend (baseline) /        │ │  (enum constraints ·           │
│  Vulkan backend                  │ │   schema validation)           │
│  llama-server / libllama        │ └───────────────┬────────────────┘
│           │                      │ ┌───────────────▼────────────────┐
│  Domain-Specific Task Model      │ │  System substrate              │
│  fine-tuned Gemma4-e4b           │ │  sandboxed builds ·            │
│  (GGUF Q4_0)                    │ │  content-addressed store ·     │
└──────────────────────────────────┘ │  snapshots/generation ·        │
                                     │  audit log · permission policy │
                                     └───────────────┬────────────────┘
                                     ┌───────────────▼────────────────┐
                                     │  Kan-Linux (no classic pkg     │
                                     │  manager)                      │
                                     └────────────────────────────────┘
```

Data flow (install example): user request → Agent Runtime produces a plan → tool orchestration layer invokes tools per the DSL → system substrate executes on sandbox/store → results (incl. stderr) feed back into context → model decides the next step → deploy succeeds or rolls back.

## 4. Core Components

### 4.1 Interaction Layer: kan-agent CLI

- The usability benchmark is the llama.cpp experience: one command works out of the box, no complex configuration;
- Forms: interactive mode (TUI), single-shot execution (print/JSON mode, scriptable), subcommand entries (e.g. `kan-agent install <pkg>`, `kan-agent fix`, `kan-agent rollback`, `kan-agent inspect`);
- All dangerous actions are surfaced explicitly at the CLI layer and require confirmation.

### 4.2 Agent Runtime: Customized Pi

**Choice**: [earendil-works/pi](https://github.com/earendil-works/pi) — a minimal, extensible agent harness with a unified LLM API, agent loop, tool calling, TUI, RPC and SDK.

**Customization scope (this phase: tool-layer + permission-layer integration only)**:

1. **Tool layer integration**: register Kan-Agent's 7 system tool Schemas into Pi's tool-calling channel; tool results (stderr, audit alerts, ...) are fed back into conversation context;
2. **Permission layer integration**: Pi has no built-in permission system (upstream recommends external containerization). Kan-Agent enforces permissions **at the tool-execution boundary** — dangerous tools (deploy, rollback, patch, build) require user confirmation or policy authorization before execution; audit findings drive interception;
3. **Inference binding**: talk to the local llama-server (ggml-hexagon) via the OpenAI-compatible API.

Loop guardrail: tool-failure retries are capped (e.g. 3) to avoid dead-looping on unsolvable errors.

Pi's agent loop / session core is left untouched; slimming/packaging and deep rework are out of scope for the first stage.

**Ecosystem reference**: [simplexai-labs/linger](https://github.com/simplexai-labs/linger) ("bring your own runtime", which supports Pi as a runtime) and its model–harness co-design philosophy are useful long-term references.

### 4.3 Inference Engine Layer: ggml-hexagon

**Choice**: the **`self-build-jz` branch** (the default branch) of [kan-linux/ggml-hexagon](https://github.com/kan-linux/ggml-hexagon), adopted directly as Kan-Agent's inference engine.

**The first-stage performance baseline is the x86_64 pure-CPU backend** ([Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4) test environment); the Vulkan backend is an optional enhancement.

**Runtime baseline**: llama-server is spawned on demand as a resident process and releases model memory after an idle timeout; startup parameters are fixed to `--jinja`, a low default temperature, `--reasoning-budget 128`, and KV-cache prefix reuse (`--cache-reuse`), so the System Prompt and tool Schemas are prefilled only once.

### 4.4 Model Layer: Domain-Specific Task Model

- **Base**: Gemma4-e4b (Q4_0 GGUF) — best overall in the edge model evaluation;
- **Form**: the fine-tuned domain-specific task model, deployed as GGUF Q4_0;
- **Capability positioning**: solidify systems-engineering experience into the model's "muscle memory" and safety boundaries — not teaching it Linux knowledge, but making it highly reliable on Kan-Agent's tool-calling DSL and workflows.

### 4.5 Tool Orchestration Layer: 7 Atomic Tools

Design principles: **push safety down into the tool layer rather than relying on model self-discipline**; use enum constraints to curb parameter hallucination in a 4B model; forced auditing and traceability; built-in self-repair loop; budgeted tool outputs — structured trimmed results (error tail + surrounding lines) are returned while full logs are persisted for `sys_inspect`.

| Tool | Responsibility | Privilege |
|---|---|---|
| `repo_fetch` | Fetch upstream source or official release packages from git repo / tarball URLs into an isolated workspace | read network + write workspace |
| `install_audit` | Pre-execution security audit: static behavior audit of source/build scripts; for official binaries, origin allowlist and integrity verification | read-only |
| `source_patch` | Apply patches / edit build or source files in the workspace (fix compile errors, remove hazards) | write workspace |
| `sandbox_build` | Configure and compile source in an unprivileged isolated sandbox (namespace/chroot) | sandboxed exec |
| `atomic_deploy` | Atomically deploy build artifacts to the system store and flip symlinks; create a state snapshot | dangerous, confirm |
| `system_rollback` | Atomically roll the component or system state back when deploy verification / health checks fail | dangerous, confirm |
| `sys_inspect` | Read-only sweep of system env, shared-library deps, toolchain, kernel logs, workspace; query the official component catalog (installable components/versions) | read-only |

Both install classes share the tool set above; pipelines are trimmed per the `source_type: binary | source` enum:

- **Official binary**: `repo_fetch` (official release package, URL resolved via the official component catalog) → `install_audit` (origin allowlist + integrity + install-script behavior check) → `atomic_deploy` (/opt isolated roots + config placement) → verify/rollback. Does **not** go through `sandbox_build` / `source_patch`;
- **Source build**: the full pipeline `repo_fetch → install_audit → sandbox_build → atomic_deploy`.

High-frequency fields (`source_type`, `build_system`, `scan_scope`, `action`, ...) strictly use enums; combined with llama.cpp `--jinja` sampling this keeps parameters valid and cuts generated token count.

The complete parameter contract of the 7 tools (parameter names, types, enums, required fields) is frozen in [`docs/TOOL_SCHEMA.json`](https://github.com/kan-linux/kan-agent/blob/master/docs/TOOL_SCHEMA.json), shared by Pi integration and fine-tuning data construction.

### 4.6 System Substrate

- **Sandboxed builds**: namespace/bwrap-level isolation; no network during builds (policy-releasable); writable only workspace and DESTDIR — never polluting the root filesystem;
- **Content-addressed store**: build artifacts are written to a read-only store (Nix/OSTree-like), made effective via atomic symlink flips;
- **Official component catalog**: analogous to the local software database of apt/dnf/rpm, but as "component description data": component name → official distribution URL pattern → default/available versions → install root (e.g. `/opt/<tool>`) → config placement steps (`ld.so.conf`, `profile.d`, symlinks, etc.) → dependency declarations (`dependencies`). `repo_fetch` / `install_audit` use it to resolve URLs and enforce the official-source allowlist (**preventing the model from fabricating download addresses**); `sys_inspect` exposes the installable component/version list read-only; the permission layer adjudicates URL legitimacy with it. Source-class components can be added progressively (upstream repo addresses, build-system types);
- **Snapshots and generations**: every `atomic_deploy` produces a generation; `system_rollback` switches back to a historical generation; a generation also hosts declarative config snapshots (`ld.so.conf.d`, `profile.d`, systemd units, app policy files); rollback automatically runs `ldconfig` and systemd reload; user data/documents are out of rollback scope;
- **Audit log**: `install_audit` verdicts and all dangerous operations are fully persisted and traceable;
- **Permission policy**: tool-level allowlist/confirmation rules, adjudicated centrally by the Agent Runtime's permission layer.

## 5. Key Workflows

### 5.1 Source-Build Install (e.g. btop, htop)

```
user request → plan → repo_fetch → install_audit ──alert──▶ intercept + user authorization
                                     │pass
                                     ▼
              sandbox_build ──fail──▶ sys_inspect → source_patch → retry (closed loop)
                                     │success
                                     ▼
              atomic_deploy (snapshot / new generation) → verify / health check
                                     │fail
                                     ▼
                              system_rollback (back to previous generation)
```

Dependency handling: topologically sort dependency declarations from the component catalog and build in order before compiling; when configure/CMake reports a missing dependency, bounded recursive resolution is allowed (depth ≤2, missing dependencies resolved only from the component catalog), with every recursive action fully audited.

### 5.2 Official-Binary Install (e.g. Firefox, Node.js, JDK, Go, Rust, Vulkan SDK)

```
user request → plan → repo_fetch (official distribution URLs only) → install_audit
                                     (origin allowlist + integrity + install-script check)
                                     │pass
                                     ▼
              atomic_deploy (install to /opt isolated roots + config/symlink placement,
                             create snapshot) → verify
                                     │fail
                                     ▼
                              system_rollback (back to previous generation)
```

The trust anchor is the **official-source allowlist** (inheriting the "official distribution URLs only, no third-party mirrors" convention of [`install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh)); URL resolution and allowlist-check data come from the official component catalog (§4.6); existing safety conventions — the /opt isolated install root, deletion allowlist (safe_rm_rf), disk-space preflight — are inherited by the system substrate. This chain has no compile step, so it goes through neither `sandbox_build` nor `source_patch`. During the transition (M2–M3) the chain may be implemented by tools calling `install-prebuilts.sh` internally; from M4 on it is natively implemented by substrate primitives + the official component catalog, and the script is retired afterwards.

### 5.3 Update Component

Same as 5.1/5.2, starting from a new version (new release package or new source); the current generation is recorded automatically before deploy, and a failed health check auto-rolls back.

### 5.4 Troubleshoot & Repair

`sys_inspect` (read-only sweep: ldd, toolchain, kernel logs) → model locates → `source_patch` / rebuild & deploy → verify; read-only tools go first throughout; dangerous tools require confirmation.

### 5.5 Rollback

`system_rollback` switches directly to a named historical generation; the rollback itself is an atomic operation and is audited.

## 6. Model Strategy

### 6.1 Edge Model Evaluation ([Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4))

Test environment: Kan-Linux x86_64, 16-thread CPU (llama uses 6 threads), AVX/AVX2/FMA/BMI2/AVX512/AVX512_VBMI/AVX512_VNNI; **pure CPU, no GPU**; llama.cpp 1.0.0-dev (build 13310, commit 68fac4aef), GNU 16.2.0; ctx 8192, mostly Q4_0 quantization.

| Model | Quant | Prompt eval (t/s) | Generation (t/s) | Quality observations |
|---|---|---|---|---|
| Gemma4-e2b | Q4_0 | 341.24 | 20.04 | Good quality, fluent output |
| **Gemma4-e4b** | Q4_0 | 113.24 | 11.06 | **Best quality, best overall throughput; final recommendation** |
| Qwen3-2b | Q4_0 | 193.15 | 23.17 | Thinking loop (obsessively re-litigating prompt ambiguity) |
| Qwen3-4b | Q4_0 | 77.99 | 11.11 | Thinking loop; output interrupted; no final answer |
| Spark-X2.5-1.7B | — | 130.43 | 9.79 | Fluent but factually wrong (director and protagonist both mistaken) |
| Spark-X2.6-4B | Q8_0 | 71.11 | 7.23 | Coherent prose but heavy hallucination (plot of other films mixed in) |

**Conclusion** ([Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4)): Gemma4-e2b/e4b significantly outperform Qwen3-2b/4b; Spark-X2.6-4B beats the Qwen3 pair but trails Gemma4-e4b. An additional validation (`--reasoning-budget 128 --temp 0.2 --top-p 0.9`, FHS/security-model Q&A) showed excellent structured output from Gemma4-e4b.

**Selection decision**: Gemma4-e4b is the base of the domain-specific task model. Gemma4-e2b can serve as a low-end/downgrade fallback.

### 6.2 Fine-Tuning Plan for the Domain-Specific Task Model

**Positioning**: Gemma4-e4b already has solid Linux command, code understanding and tool-calling foundations; the fine-tuning goal is not to teach Linux knowledge, but to solidify embedded/systems engineering experience into "muscle memory" and safety boundaries.

**Data volume (quality over quantity: one complete trajectory "compile fails → analyze stderr → patch → rebuild succeeds" outweighs 20 single-turn Q&A pairs)**:

| Phase | Volume | Purpose |
|---|---|---|
| Initial validation | 150–300 items | Get the tool Schema format, build chain and rollback actions working |
| Production-grade | 500–800 items | Cover exception troubleshooting and security auditing |
| Advanced (optional) | 1000+ items | Niche build systems (Meson/Bazel/Autotools/Kbuild), complex dependency trees |

**Four core scenario classes (~60% routine builds + 40% exceptions & security)**:

| Scenario | Share | Training focus |
|---|---|---|
| Source fetch & cross-build-system compilation | 35% | Recognize CMake/Makefile/Meson/Cargo build files; probe the environment (arch, compiler, shared libs) before building; isolate `--prefix` into sandbox/versioned dirs |
| Compile-error diagnosis & auto-patching | 30% | Missing headers, strict GCC 16 syntax errors, undefined linker symbols, cross-compile flag errors; pinpoint the failing stderr line, fix via `source_patch`, retry — never blindly rerun the same failed command |
| Security audit & fine-grained permissions | 20% | Spot outbound downloads in scripts, edits to `/etc/passwd`, unauthorized system-path writes, dangerous `rm -rf`; intercept and request authorization proactively |
| Atomic deploy & safe rollback | 15% | The fixed behavioral loop "snapshot before deploy → health check after → auto-rollback on failure" (e.g. ldd conflicts, service startup failures) |

Official-binary install/update trajectories (fetch → source/integrity verification → deploy → rollback) should also be included, with the share adjusted as needed.

**Data production path (real-environment recording + assisted generation + human screening)**:

1. Stand up Agent Runtime + **the 7-tool set identical to production** (see §4.5) in a container/test VM — training and inference must use the same tools (train/inference skew is a classic root cause of fine-tuning failure);
2. Really execute install & troubleshooting tasks for 100–200 software packages and record trajectories (assisted generation of trajectory drafts is allowed);
3. Screen + correct by hand (especially keep trajectories that hit an error and self-repaired), exporting Gemma4-native multi-turn tool-call JSONL.

**Fine-tuning stack (single consumer GPU)**:

- Tools: [Unsloth](https://github.com/unslothai/unsloth) or [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) (native Gemma4 architecture & chat template support);
- Method: QLoRA (4-bit base loading) or LoRA (BF16, VRAM ≥24GB);
- Hyper-parameters: `lora_rank` 16/32, `lora_alpha` 32/64, `lr` 1e-4–2e-4 (cosine decay); 1–2 epochs with a small amount of general instruction data mixed in to prevent capability regression; early-stop on task metrics rather than the loss curve;
- Key details: `train_on_responses_only` (loss only on model output); strictly use Gemma4 native control tokens `<|turn>` / `<|tool_call>`;
- Training eval gate: export is not released unless tool-call accuracy and schema-validity rate on held-out intents pass.

**Export & deployment**: merge LoRA back to BF16 → `convert_hf_to_gguf.py` to F16 GGUF → `llama-quantize` to Q4_0 (seamless with the AVX-512 REPACK-optimized environment) → re-test tool-call accuracy and format reliability on the Q4_0 artifact (quantization can harm format reliability; BF16 results are not authoritative) → loaded by ggml-hexagon.

## 7. Security Model

**Core idea: even if the model hallucinates, it cannot damage the host root filesystem.**

1. **No general-purpose capabilities exposed**: no omnipotent `bash`/`rm`/`sudo` for the model; dangerous operations are wrapped into `sandbox_build` / `atomic_deploy` / `system_rollback`;
2. **Sandbox isolation**: namespace/bwrap limits — no network, writable only workspace and DESTDIR;
3. **Forced auditing**: `install_audit` is a standalone tool; the pipeline habit is `repo_fetch → install_audit → sandbox_build → atomic_deploy`; a high-risk audit alert pauses execution immediately and requests user confirmation;
4. **Permissions at the tool boundary**: dangerous tools are adjudicated by the permission layer (policy allowlist or interactive confirmation) before execution;
5. **Atomicity as the safety net**: read-only store + atomic symlink flips + generation snapshots — any failure can roll back;
6. **Traceability**: the audit log records every tool call, its parameters, verdict and user authorization.

## 8. Non-Functional Requirements

| Category | Requirement | Baseline / acceptance |
|---|---|---|
| Performance | Interactive on pure CPU x86_64 | Gemma4-e4b Q4_0 measured generation ≥10 t/s (11.06 t/s); prompt eval ≥100 t/s |
| Footprint | LiveISO-friendly | C/C++ inference engine; quantized model |
| Usability | As simple as llama.cpp | One-command install/build; sane defaults; readable errors |
| Reliability | Atomic & rollback-able | Any deploy failure can roll back to a known-good generation; rollback itself is atomic |
| Offline | Works without network | Fully local inference |

## 9. Integration with Kan-Linux

- Kan-Agent ships as a native subsystem of the LiveISO: CLI + Agent Runtime + ggml-hexagon + domain-specific task model;
- Kan-Linux contains no apt/dnf/pacman; Kan-Agent is the sole orchestration entry point for component lifecycle;
- The distribution/update mechanism for models and source caches is TBD.
- The current mechanism for official-binary installs is [`vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh) in the kan repo: Firefox, MiMoCode, Oracle JDK, Go, Rust, Node.js are in-image components; LibreOffice and Vulkan SDK are optional components; official distribution URLs only (go.dev, nodejs.org, download.oracle.com, sdk.lunarg.com, etc.); installs to /opt isolated roots; deletion allowlist (safe_rm_rf), ~10GB disk preflight, download-to-temp-then-rename. **Its positioning is a transitional workaround; the capability belongs to Kan-Agent itself**. The capabilities of `install-prebuilts.sh` are carried by Kan-Agent's atomic tool substrate and the official component catalog; `kan-agent` is the sole entry point for software installation; during the transition the script may serve as the temporary implementation of the official-binary pipeline, and is removed from the image after absorption is complete.

Design points:

- Deploy/rollback/generation snapshots are the only path: the script's `replace_dir` (delete-then-install) is replaced by `atomic_deploy`'s atomic switch + `system_rollback`;
- Component URL, version, install-root and config-placement information is carried by the official component catalog (§4.6), which `install_audit` uses for official-source allowlist checks;
- The script's safety conventions (safe_rm_rf deletion allowlist, disk-space preflight, download-to-temp-then-rename) are promoted to system-substrate primitives shared by both install pipelines.

Absorption mapping:

| Script capability | Destination |
|---|---|
| Component name → official URL → version → install root → config placement (e.g. Firefox policy config, JAVA_HOME, Rust directory-layout fixes, etc.) | Official component catalog (§4.6, data) |
| fetch (temp file + rename + retry), safe_rm_rf, disk preflight | System-substrate primitives (implemented by `repo_fetch`/deploy layer) |
| `install_*` / `setup_*_config` config placement | `atomic_deploy` deployment profiles |
| `replace_dir` (delete-then-install) | Deprecated; replaced by snapshot + atomic switch + `system_rollback` |

Migration schedule: M2–M3 allow tools to call the script internally as a transitional implementation (quickly get UC1a working); M4 completes absorption with the full-lifecycle substrate landing; M5 removes the script from the image, keeping `kan-agent` as the sole entry point.

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 4B model unreliable at tool calls / reasoning | High closed-loop failure rate | Enum constraints + schema validation as backstop; official component catalog constrains download URLs (anti-fabrication); fine-tuning solidifies flows; auto-rollback on failure; human-in-the-loop confirmation |
| Pi is TypeScript/Node vs LiveISO footprint | Image exceeds budget | Ship Pi as standalone binaries; control runtime size; (fallback) port the core loop to C/C++ |
| Fast upstream churn breaks builds | Rising build failure rate | Rollback on sandbox failure; maintain a patch library; weekly inspection aligned with the ggml-hexagon sync cadence |
| Sandbox/permission bypass | Security incident | Defense in depth (tool layer + kernel isolation + audit); least privilege; periodic threat modeling |
| Insufficient fine-tuning data quality/quantity | Unstable model behavior | Quality over quantity; recording + human screening (incl. assisted drafts); staged acceptance (150→300→800) |
| Engine fork drifts from upstream | Maintenance cost | Weekend sync policy; CI regressions (including Kan-Linux build scripts) |
| Model hallucinates fake "success" | Loss of user trust | Tool results are the only source of truth; the verify step is mandatory |

## 11. References

- kan-agent: [Discussion #3: Fine-tune a DST model for Kan-Agent based on top edge LLMs](https://github.com/kan-linux/kan-agent/discussions/3), [Discussion #4: Edge model evaluation on Kan-Linux for Kan-Agent](https://github.com/kan-linux/kan-agent/discussions/4)
- Inference engine: [kan-linux/ggml-hexagon](https://github.com/kan-linux/ggml-hexagon)
- Agent framework: [earendil-works/pi](https://github.com/earendil-works/pi)
- Ecosystem references: [simplexai-labs/linger](https://github.com/simplexai-labs/linger) (model–harness co-design), [niko1221/strata](https://github.com/niko1221/strata)
- Kan-Linux: [How to build llama.cpp in Kan-Linux (kan#32)](https://github.com/kan-linux/kan/discussions/32)
- Current software-installation mechanism: [`vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh) in the kan repo (official-binary install script)
