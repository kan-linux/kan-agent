# Kan-Agent 概要设计

| 项目 | 内容 |
|---|---|
| 文档状态 | 草案（Draft） |
| 日期 | 2026-11-22 |
| 英文版本 | [HIGH_LEVEL_DESIGN.md](https://github.com/kan-linux/kan-agent/blob/master/docs/HIGH_LEVEL_DESIGN.md) |


## 1. 概述

Kan-Linux 的核心特征之一是**没有传统包管理器**，**Kan-Agent 是 Kan-Linux 的原生 agent 子系统**，它自主完成系统组件的**构建与部署**，取代传统 Linux 发行版中的包管理器（apt、dnf、pacman……）与应用商店；自主完成系统故障排除。

2026 年是一个转折点：本地 AI 已被广泛接受，消费级硬件与本地推理栈趋于成熟。Kan-Agent 砍掉中心化二进制分发中间环节，**直接从上游仓库拉取官方二进制或源码**，审计、补丁、编译、部署全部在本地完成——类似 Dell 直销模式的类比。


### 1.1 路线图

开发分三个阶段推进：**第一阶段**以 CLI 方式完成系统组件的构建与部署；**第二阶段**以 CLI 方式完成系统故障检修；**第三阶段**提供 GUI 界面的 Agent 交互。

| 里程碑 | 阶段 | 内容 | 状态 |
|---|---|---|---|
| **M0 选型与验证** | 一 | llama.cpp 在 Kan-Linux 构建（[kan#32](https://github.com/kan-linux/kan/discussions/32)）；端侧模型评估（[Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4)） | 进行中 |
| **M1 概要设计** | 一 | 完成概要设计（本文档） | ✅ 已完成 |
| **M2 骨架打通** | 一 | 定制 Pi（工具层+权限层）+ ggml-hexagon `llama-server` 对接；7 工具 Schema 注册（可先以空壳占位）；基座模型 + System Prompt 直接验证工具调用链路（微调前）；微调轨迹数据格式跑通 | |
| **M3 数据管线与微调** | 一 | 轨迹录制平台（沙盒真实执行 + 人工筛选）；150～800 条轨迹生产；QLoRA 微调；GGUF 导出；与基座模型对比评测（工具调用准确率、闭环成功率） | |
| **M4 全生命周期** | 一 | 沙盒、内容寻址存储、原子部署、快照（generation）回滚落地；构建异常自修复与安全审计场景闭环；`install-prebuilts.sh` 能力吸收进系统底座与官方组件目录 | |
| **M5 硬化与集成** | 一 | LiveISO 集成与体积优化；UX 打磨（llama.cpp 级易用）；构建系统覆盖扩展（Meson/Bazel/Autotools/Kbuild）；审计/权限策略完善；从镜像移除 `install-prebuilts.sh`，`kan-agent` 成为唯一入口 | |
| **M6 系统故障检修** | 二 | 系统排障巡检与修复闭环；排障场景轨迹生产与模型增强 | |
| **M7 GUI 交互** | 三 | GUI 界面的 Agent 交互（任务发起、进度/结果展示、确认授权） | |

### 1.2 术语

| 术语 | 定义 |
|---|---|
| **Kan-Agent** | Kan-Linux 的原生 agent 子系统，Agent-first 系统编排器 |
| **Pi** | 开源 agent 项目（[earendil-works/pi](https://github.com/earendil-works/pi)），一个极简、可扩展的 AI agent harness |
| **工具调用 DSL** | Kan-Agent 定义的一套结构化工具调用语言：7 个原子工具的 JSON Schema + Gemma4 原生控制符，是模型与工具层之间的契约 |
| **领域特定任务模型**（Domain-Specific Task Model, DST） | 基于前沿端侧模型（本设计中为 Gemma4-e4b）针对 Kan-Agent 的任务需求微调得到的领域专精模型，专精 Kan-Agent 工具调用 DSL 与系统工程任务（源码构建、补丁、审计、回滚、排障） |
| **ggml-hexagon** | kan-linux 维护的 llama.cpp fork（[`self-build-jz` 分支](https://github.com/kan-linux/ggml-hexagon/tree/self-build-jz)），Kan-Agent 的指定（featured）推理引擎 |
| **generation（代）** | 一次原子部署产生的系统组件状态版本，可整体回滚到任一历史"代" |

本文仅讨论 Kan-Agent 的系统组件构建与部署能力；系统故障排除不在本文讨论范围内。

## 2. 关键用例

Kan-Agent 处理**两类软件安装形态**：

| 形态 | 典型软件 | 特征 | 现状 |
|---|---|---|---|
| **官方二进制类** | Firefox、Node.js、Oracle JDK、Go、Rust、Vulkan SDK 等 | 上游提供官方预编译发布包（tarball/AppImage），无本地编译步骤 | 由 [kan 仓库 `vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh) 安装：仅官方分发 URL、/opt 隔离根、删除白名单、磁盘预检 |
| **源码构建类** | btop、htop 等 | 从源码托管站点拉取源码，本地沙盒编译后部署 | 无（Kan-Agent 新增的核心能力） |

两类形态共享同一套工具调用 DSL 与原子部署/回滚底座，流水线按形态裁剪。

| 编号 | 用例 | 概述 |
|---|---|---|
| UC1a | 安装软件（官方二进制类） | 用户："安装 Firefox/Node.js/Go" → agent 从官方分发源拉取发布包、校验来源与完整性、部署到 /opt 隔离根并落位配置 |
| UC1b | 安装软件（源码构建类） | 用户："安装 btop/htop/某驱动模块" → agent 拉源码、审计、沙盒编译、原子部署 |
| UC2 | 更新组件 | 上游有新版本 → 按形态执行更新流水线（新发布包/新源码），验证、原子切换，失败即回滚 |
| UC3 | 构建失败自修复 | 编译报错 → 分析 stderr、定位头文件/链接/标志问题、`source_patch` 后重编 |
| UC4 | 部署失败回滚 | 新组件引发动态库冲突/服务异常 → 健康检查失败 → 自动原子回滚 |
| UC5 | 安全审计拦截 | 安装脚本含 `curl \| sh`、越权写 `/etc`、危险 `rm -rf` → 强制拦截并请求用户授权 |
| UC6 | 系统排障巡检 | 用户："系统某功能坏了" → `sys_inspect` 只读巡检、定位、修复或给出建议 |

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│  交互层：kan-agent CLI（llama.cpp 般易用；交互 / print / JSON 模式）  │
└──────────────────────────────┬─────────────────────────────────────┘
┌──────────────────────────────▼─────────────────────────────────────┐
│  Agent Runtime（定制 Pi）                                          │
│  agent loop · 会话管理 · 工具调用解析 · 权限/确认策略               │
└───────────────┬───────────────────────────────────┬────────────────┘
┌───────────────▼─────────────────┐ ┌───────────────▼────────────────┐
│  推理引擎层                      │ │  工具编排层                      │
│  ggml-hexagon (llama.cpp fork)  │ │  7 个原子工具 + 工具调用 DSL      │
│  CPU 后端（基线）/ Vulkan 后端   │ │  （enum 约束 · Schema 校验）     │
│  llama-server / libllama        │ └───────────────┬────────────────┘
│           │                      │ ┌───────────────▼────────────────┐
│  领域特定任务模型                 │ │  系统底座                        │
│  Gemma4-e4b 微调版 (GGUF Q4_0)  │ │  沙盒构建 · 内容寻址存储          │
└──────────────────────────────────┘ │  快照/generation · 审计日志      │
                                     │  权限策略                        │
                                     └───────────────┬────────────────┘
                                     ┌───────────────▼────────────────┐
                                     │  Kan-Linux（无传统包管理器）      │
                                     └────────────────────────────────┘
```

数据流（以安装为例）：用户请求 → Agent Runtime 生成计划 → 工具编排层按 DSL 依次调用工具 → 系统底座在沙盒/存储上执行 → 结果（含 stderr）回填上下文 → 模型决策下一步 → 部署成功或回滚。

## 4. 核心组件

### 4.1 交互层：kan-agent CLI

- 设计标杆是 llama.cpp 的用户体验：一条命令开箱即用，无需复杂配置；
- 形态：交互模式（TUI）、单次执行（print/JSON 模式，便于脚本化）、子命令式入口（如 `kan-agent install <pkg>`、`kan-agent fix`、`kan-agent rollback`、`kan-agent inspect`）；
- 所有高危动作在 CLI 层显式呈现并要求确认。

### 4.2 Agent Runtime：定制 Pi

**选型**：[earendil-works/pi](https://github.com/earendil-works/pi) —— 极简、可扩展的 agent harness，自带统一 LLM API、agent loop、tool calling、TUI、RPC 与 SDK。

**定制范围（本期限定为工具层 + 权限层集成）**：

1. **工具层集成**：将 Kan-Agent 的 7 个系统工具 Schema 注册进 Pi 的 tool-calling 通道，工具结果（stderr、审计告警等）回填对话上下文；
2. **权限层集成**：Pi 本身不含权限系统（官方建议外部容器化解决）。Kan-Agent 在**工具执行边界**实现权限控制——高危工具（部署、回滚、补丁、构建）执行前强制用户确认或策略授权，审计结果驱动拦截；
3. **推理对接**：通过 OpenAI 兼容 API 对接本地 llama-server（ggml-hexagon）。

不改动 Pi 的 agent loop / 会话核心；裁剪打包与深度改造不在第一阶段范围。

**生态参考**：[simplexai-labs/linger](https://github.com/simplexai-labs/linger) 的 "bring your own runtime"（支持 Pi 作为运行时）与 model–harness 协同设计理念可作为长期参考。

### 4.3 推理引擎层：ggml-hexagon

**选型**：[kan-linux/ggml-hexagon](https://github.com/kan-linux/ggml-hexagon) 的 **`self-build-jz` 分支**（默认分支），直接采用其代码作为 Kan-Agent 的推理引擎。

**第一阶段性能基线为 x86_64 纯 CPU 后端**（[Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4) 实测环境）；Vulkan 后端为可选增强。

### 4.4 模型层：领域特定任务模型

- **基座**：Gemma4-e4b（Q4_0 GGUF）——端侧模型评估综合最优；
- **形态**：微调后的领域特定任务模型，部署为 GGUF Q4_0；
- **能力定位**：把系统工程经验固化为模型的"肌肉记忆"与安全边界——不是教它 Linux 知识，而是让它在 Kan-Agent 的工具调用 DSL 与工作流上高度可靠。

### 4.5 工具编排层：7 个原子工具

设计原则：**安全下沉到工具底层而非全靠模型自律**；用 enum 约束降低 4B 模型参数幻觉；强制审计与可追溯；自带自我修复闭环。

| 工具 | 职责 | 权限级别 |
|---|---|---|
| `repo_fetch` | 从 Git 仓库/压缩包 URL 拉取上游源码或官方发布包至隔离工作区 | 只读网络 + 写工作区 |
| `install_audit` | 执行前做安全审计：源码/构建脚本的静态行为审计；官方二进制类为来源白名单与完整性校验 | 只读 |
| `source_patch` | 在工作区应用补丁/修改构建或源码文件（修编译错误、消安全隐患） | 写工作区 |
| `sandbox_build` | 在无特权隔离沙盒（Namespace/chroot）内配置并编译源码 | 沙盒内执行 |
| `atomic_deploy` | 将构建产物原子化部署到系统存储并更新软链接，生成状态快照 | 高危，需确认 |
| `system_rollback` | 部署验证/健康检查失败时，将组件或系统状态原子回滚 | 高危，需确认 |
| `sys_inspect` | 对系统环境、动态库依赖、工具链、内核日志、工作区做只读巡检；查询官方组件目录（可安装组件/版本） | 只读 |

两类安装形态共享上述工具集，流水线按 `source_type: binary | source` 枚举裁剪：

- **官方二进制类**：`repo_fetch`（官方发布包，URL 由官方组件目录解析）→ `install_audit`（来源白名单 + 完整性 + 安装脚本行为校验）→ `atomic_deploy`（/opt 隔离根 + 配置落位）→ 验证/回滚。**不经过** `sandbox_build` / `source_patch`；
- **源码构建类**：完整流水线 `repo_fetch → install_audit → sandbox_build → atomic_deploy`。

高频字段（`source_type`、`build_system`、`scan_scope`、`action` 等）严格使用 enum，配合 llama.cpp 的 `--jinja` 采样保证参数合法并压缩生成 token 数。

### 4.6 系统底座

- **沙盒构建**：Namespace/bwrap 级隔离，构建期无网络（可按策略放开）、仅可写 workspace 与 DESTDIR，杜绝污染根目录；
- **内容寻址存储**：构建产物写入只读 store（类 Nix/OSTree 模型），通过软链接原子切换对外生效；
- **官方组件目录（component catalog）**：类比 apt/dnf/rpm 的本地软件数据库，但以"组件描述数据"形态存在：组件名 → 官方分发 URL 模式 → 默认/可用版本 → 安装根（如 `/opt/<tool>`）→ 配置落位步骤（`ld.so.conf`、`profile.d`、软链接等）。`repo_fetch` / `install_audit` 据此解析 URL 并校验官方来源白名单（**防模型编造下载地址**）；`sys_inspect` 只读暴露可安装组件/版本清单；权限层据此裁决 URL 合法性。源码类组件可渐进收录（上游仓库地址、构建系统类型）；
- **快照与 generation**：每次 `atomic_deploy` 产生一个"代"，`system_rollback` 即切换回历史代；
- **审计日志**：`install_audit` 结论与所有高危操作全量落盘，可追溯；
- **权限策略**：工具级别的 allowlist/确认规则，由 Agent Runtime 的权限层统一裁决。

## 5. 关键工作流

### 5.1 源码构建安装（如 btop、htop）

```
用户请求 → 计划 → repo_fetch → install_audit ──告警──▶ 拦截 + 用户授权
                                     │通过
                                     ▼
              sandbox_build ──失败──▶ sys_inspect → source_patch → 重试（闭环）
                                     │成功
                                     ▼
              atomic_deploy（生成快照/新 generation）→ verify/健康检查
                                     │失败
                                     ▼
                              system_rollback（回到上一代）
```

### 5.2 官方二进制安装（如 Firefox、Node.js、JDK、Go、Rust、Vulkan SDK）

```
用户请求 → 计划 → repo_fetch（仅官方分发 URL）→ install_audit（来源白名单 + 完整性
                                     + 安装脚本行为校验）
                                     │通过
                                     ▼
              atomic_deploy（安装至 /opt 隔离根 + 配置/软链接落位，生成快照）→ verify
                                     │失败
                                     ▼
                              system_rollback（回到上一代）
```

信任锚点是**官方来源白名单**（沿用 [`install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh) 的"仅官方分发 URL、禁第三方镜像"约定）；URL 解析与白名单校验的数据来自官方组件目录（§4.6）；`/opt` 隔离安装根、删除白名单（safe_rm_rf）、磁盘空间预检等既有安全约定由系统底座继承。此链路无编译步骤，故不经 `sandbox_build` / `source_patch`。过渡期（M2～M3）该链路可由工具内部调用 `install-prebuilts.sh` 实现；M4 起由底座原语 + 官方组件目录原生实现，脚本随后退役。

### 5.3 更新组件

同 5.1/5.2，起点为新版本（新发布包或新源码）；部署前自动记录当前 generation，健康检查失败即自动回滚。

### 5.4 排障修复

`sys_inspect`（只读巡检：ldd、工具链、内核日志）→ 模型定位 → `source_patch`/重建部署 → 验证；全程只读工具先行，高危工具需确认。

### 5.5 回滚

`system_rollback` 直接切换到指定历史 generation；回滚动作本身也是一次原子操作并记录审计。

## 6. 模型策略

### 6.1 端侧模型评估（[Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4)）

测试环境：Kan-Linux x86_64，16 线程 CPU（llama 使用 6 线程），AVX/AVX2/FMA/BMI2/AVX512/AVX512_VBMI/AVX512_VNNI；**纯 CPU，无 GPU**；llama.cpp 1.0.0-dev（build 13310，commit 68fac4aef），GNU 16.2.0；ctx 8192，Q4_0 量化为主。

| 模型 | 量化 | Prompt 处理 (t/s) | 生成 (t/s) | 质量观察 |
|---|---|---|---|---|
| Gemma4-e2b | Q4_0 | 341.24 | 20.04 | 质量好，输出流畅 |
| **Gemma4-e4b** | Q4_0 | 113.24 | 11.06 | **质量最好，综合吞吐最优，最终推荐** |
| Qwen3-2b | Q4_0 | 193.15 | 23.17 | 思维链陷入死循环（反复纠结提示词歧义） |
| Qwen3-4b | Q4_0 | 77.99 | 11.11 | 思维链死循环，输出被中断，无最终答案 |
| Spark-X2.5-1.7B | — | 130.43 | 9.79 | 流畅但事实性错误（导演、主角均张冠李戴） |
| Spark-X2.6-4B | Q8_0 | 71.11 | 7.23 | 行文连贯但严重幻觉（混入其他影片情节） |

**结论**（[Discussion #4](https://github.com/kan-linux/kan-agent/discussions/4)）：Gemma4-e2b/e4b 显著优于 Qwen3-2b/4b；Spark-X2.6-4B 优于 Qwen3 系但逊于 Gemma4-e4b。追加验证（`--reasoning-budget 128 --temp 0.2 --top-p 0.9`，FHS/安全模型问答）显示 Gemma4-e4b 结构化输出质量优秀。

**选型决定**：Gemma4-e4b 为领域特定任务模型基座。Gemma4-e2b 可作为低配/降级备选。

### 6.2 领域特定任务模型微调方案

**定位**：Gemma4-e4b 已具备扎实的 Linux 命令、代码理解与工具调用基础；微调目标不是教 Linux 知识，而是把嵌入式/系统工程经验固化为"肌肉记忆"和安全边界。

**数据量（质量远大于数量，1 条"编译失败→分析 stderr→打补丁→重编成功"的完整轨迹 > 20 条单轮问答）**：

| 阶段 | 数据量 | 目的 |
|---|---|---|
| 首期验证 | 150～300 条 | 跑通工具 Schema 格式、构建链路与回滚动作 |
| 生产级可用 | 500～800 条 | 覆盖异常排障与安全审计 |
| 进阶强化（可选） | 1000+ 条 | 冷门构建系统（Meson/Bazel/Autotools/Kbuild）、复杂依赖树 |

**四类核心场景（约 60% 常规构建 + 40% 异常与安全）**：

| 场景 | 占比 | 训练重点 |
|---|---|---|
| 源码拉取与跨构建系统编译 | 35% | 识别 CMake/Makefile/Meson/Cargo 等构建文件；先探测环境（架构、编译器、动态库）再编译；`--prefix` 隔离到沙盒/版本目录 |
| 编译报错诊断与自动打补丁 | 30% | 头文件缺失、GCC 16 严格语法报错、链接符号未定义、交叉编译标志错误；精准定位 stderr 报错行，调用 `source_patch` 修复后重试，而非盲目重跑 |
| 安全审计与细粒度权限 | 20% | 识别脚本中外联下载、改 `/etc/passwd`、越权写系统路径、危险 `rm -rf`；发现越权主动拦截并请求授权 |
| 原子部署与安全回滚 | 15% | "部署前快照 → 部署后健康检查 → 失败自动回滚"的固定行为闭环（如 ldd 冲突、服务启动失败） |

此外应包含官方二进制类安装/更新轨迹（拉取 → 来源/完整性校验 → 部署 → 回滚），占比按实际需求调整。

**数据生产路径（真实环境录制 + 辅助生成 + 人工筛选）**：

1. 在容器/测试虚拟机中搭建 Agent Runtime + **与生产完全一致的 7 原子工具集**（见 §4.5）——训练与推理必须同一套工具（train/inference skew 是微调失效的经典根源）；
2. 真实执行 100～200 个软件包的安装与排障任务并录制轨迹（可借助辅助手段生成轨迹初稿）；
3. 人工筛选 + 修正（尤其保留"经历报错并自我修复"的轨迹），导出为 Gemma4 原生多轮工具调用 JSONL。

**微调技术栈（单卡消费级 GPU）**：

- 工具：[Unsloth](https://github.com/unslothai/unsloth) 或 [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)（原生支持 Gemma4 架构与 Chat Template）；
- 方法：QLoRA（4-bit 加载基座）或 LoRA（BF16，显存 ≥24GB）；
- 超参：`lora_rank` 16/32，`lora_alpha` 32/64，`lr` 1e-4～2e-4（余弦退火）；1～2 epochs 并混入少量通用指令数据防止能力回退，按任务指标早停而非 loss 曲线；
- 关键细节：`train_on_responses_only`（仅对模型输出计损失）；严格使用 Gemma4 原生控制符 `<|turn>` / `<|tool_call>`；
- 训练评测门：held-out 意图的工具调用准确率与 Schema 合法率不达标则不放行导出。

**导出与部署**：LoRA merge 回 BF16 → `convert_hf_to_gguf.py` 转 F16 GGUF → `llama-quantize` 量化 Q4_0（与 AVX-512 REPACK 优化环境无缝衔接）→ 在 Q4_0 产物上复测工具调用准确率与格式可靠性（量化可能损伤格式，不以 BF16 结果为准）→ 由 ggml-hexagon 加载。

## 7. 安全模型

**核心思想：即使模型偶发幻觉，也无法破坏宿主机根文件系统。**

1. **不暴露通用能力**：不给模型万能 `bash`/`rm`/`sudo`；危险操作封装进 `sandbox_build` / `atomic_deploy` / `system_rollback`；
2. **沙盒隔离**：Namespace/bwrap 限制无网络、仅读写 workspace 与 DESTDIR；
3. **强制审计**：`install_audit` 独立成工具；流水线习惯为 `repo_fetch → install_audit → sandbox_build → atomic_deploy`；审计高危告警立即暂停并请求用户确认；
4. **工具边界权限**：高危工具执行前由权限层裁决（策略 allowlist 或交互确认）；
5. **原子性兜底**：store 只读 + 软链接原子切换 + generation 快照，任何失败可回滚；
6. **可追溯**：审计日志全量记录工具调用、参数、结论与用户授权。

## 8. 非功能性需求

| 类别 | 需求 | 基线/验收 |
|---|---|---|
| 性能 | 纯 CPU x86_64 交互可用 | Gemma4-e4b Q4_0 实测生成 ≥10 t/s（11.06 t/s）；prompt 处理 ≥100 t/s |
| 体积 | LiveISO 友好 | C/C++ 推理引擎；量化模型 |
| 易用性 | 像 llama.cpp 一样简单 | 一条命令安装/构建；默认配置开箱即用；错误信息可读 |
| 可靠性 | 原子与可回滚 | 任何部署失败可回滚到已知良好 generation；回滚本身原子化 |
| 离线性 | 断网可用 | 推理全本地 |

## 9. 与 Kan-Linux 的集成

- Kan-Agent 作为 LiveISO 内的原生子系统发布：CLI + Agent Runtime + ggml-hexagon + 领域特定任务模型；
- Kan-Linux 不含 apt/dnf/pacman，Kan-Agent 是组件生命周期的唯一编排入口；
- 模型与源码缓存的分发/更新机制待定。
- 官方二进制类安装的现有机制为 kan 仓库 [`vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh)：Firefox、MiMoCode、Oracle JDK、Go、Rust、Node.js 为镜像内组件，LibreOffice、Vulkan SDK 为可选组件；仅官方分发 URL（go.dev、nodejs.org、download.oracle.com、sdk.lunarg.com 等），安装至 /opt 隔离根，删除白名单（safe_rm_rf）、约 10GB 磁盘预检、下载临时落盘后改名。**其定位是过渡性 workaround，能力归属 Kan-Agent 自身**。`install-prebuilts.sh` 的能力由 Kan-Agent 的原子工具底座与官方组件目录承载，`kan-agent` 是软件安装的唯一入口；脚本在过渡期内可作为官方二进制流水线的临时实现，吸收完成后从镜像移除。

设计要点：

- 部署/回滚/generation 快照是唯一路径：脚本的 `replace_dir`（先删后装）由 `atomic_deploy` 的原子切换 + `system_rollback` 取代；
- 组件的 URL、版本、安装根与配置落位信息由官方组件目录（§4.6）承载，`install_audit` 据此做官方源白名单校验；
- 脚本的安全约定（safe_rm_rf 删除白名单、磁盘空间预检、下载临时落盘后改名）升格为系统底座原语，两类安装流水线共用。

吸收映射：

| 脚本能力 | 去向 |
|---|---|
| 组件名 → 官方 URL → 版本 → 安装根 → 配置落位（如 Firefox 策略配置、JAVA_HOME、Rust 目录布局修正等） | 官方组件目录（§4.6，数据） |
| fetch（临时落盘 + 改名 + 重试）、safe_rm_rf、磁盘预检 | 系统底座原语（`repo_fetch`/部署层实现） |
| `install_*` / `setup_*_config` 配置落位 | `atomic_deploy` 的部署 profile |
| `replace_dir`（先删后装） | 废弃，由快照 + 原子切换 + `system_rollback` 取代 |

迁移节奏：M2～M3 允许工具内部调用脚本作为过渡实现（快速跑通 UC1a）；M4 随全生命周期底座落地完成吸收；M5 从镜像移除脚本，保留 `kan-agent` 单一入口。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 4B 模型工具调用/推理可靠性不足 | 闭环失败率高 | enum 约束 + Schema 校验兜底；官方组件目录约束下载 URL（防编造）；微调固化流程；失败自动回滚；人机协同确认 |
| Pi 为 TypeScript/Node 栈 vs LiveISO 体积 | 镜像超预算 | 采用 Pi 独立二进制打包；控制运行时体积；（备选）将核心 loop C/C++ 化 |
| 上游源码快速演化破坏构建 | 构建失败率上升 | 沙盒失败即回滚；补丁库沉淀；周末随 ggml-hexagon 同步节奏巡检 |
| 沙盒/权限被绕过 | 安全事故 | 纵深防御（工具层+内核隔离+审计）；最小权限；定期威胁建模 |
| 微调数据质量/数量不足 | 模型行为不稳定 | 质量>数量原则；录制 + 人工筛选（含辅助生成初稿）；分阶段验收（150→300→800） |
| 引擎分支与上游漂移 | 维护成本 | 周末同步策略；CI 回归（含 Kan-Linux 构建脚本） |
| 模型幻觉输出虚假"完成" | 用户信任受损 | 工具返回真实结果作为唯一事实来源；verify 步骤强制执行 |

## 11. 参考

- kan-agent：[Discussion #3：Fine-tune a DST model for Kan-Agent based on top edge LLMs](https://github.com/kan-linux/kan-agent/discussions/3)、[Discussion #4：Edge model evaluation on Kan-Linux for Kan-Agent](https://github.com/kan-linux/kan-agent/discussions/4)
- 推理引擎：[kan-linux/ggml-hexagon](https://github.com/kan-linux/ggml-hexagon)
- Agent 框架：[earendil-works/pi](https://github.com/earendil-works/pi)
- 生态参考：[simplexai-labs/linger](https://github.com/simplexai-labs/linger)（model–harness 协同设计）、[niko1221/strata](https://github.com/niko1221/strata)
- Kan-Linux：[How to build llama.cpp in Kan-Linux（kan#32）](https://github.com/kan-linux/kan/discussions/32)
- 软件安装现状：[kan 仓库 `vendor/install-prebuilts.sh`](https://github.com/kan-linux/kan/blob/master/vendor/install-prebuilts.sh)（官方二进制类安装脚本）
