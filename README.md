## Overview

Kan-Agent: The native agent subsystem of Kan-Linux, powered by local AI community.

It autonomously builds, deploys, audits, rolls back and troubleshooting system components, replacing traditional package managers and app stores in traditional Linux distributions.

2026 marks a turning point: local AI is widely accepted, consumer hardware and local inference stacks are mature. Kan-Agent cuts out the centralized binary distribution middleman, pulling source code directly from upstream repositories. Auditing, patching, building and deployment all happen locally, an analogy similar to Dell’s direct‑sale model.


## Description

A core feature of **Kan-Linux is the absence of traditional package managers (apt, dnf, pacman, ...)**. Kan-Agent is an agent-first system orchestrator.
No conventional package manager required. Local inference, reproducible builds, fine-grained permission control, safe rollback.


## Docs

| Document | Link |
|---|---|
| Kan-Agent High Level Design (Chinese) | [HIGH_LEVEL_DESIGN.zh-CN.md](docs/HIGH_LEVEL_DESIGN.zh-CN.md) |
| Kan-Agent High Level Design (English) | [HIGH_LEVEL_DESIGN.md](docs/HIGH_LEVEL_DESIGN.md) |
| Kan-Agent Tool Schema | [TOOL_SCHEMA.json](docs/TOOL_SCHEMA.json) |


## Build from source

Kan-Agent runs on a managed llama-server runtime built from the sibling
[ggml-hexagon](https://github.com/kan-linux/ggml-hexagon) project. Clone both repositories —
side by side or the engine inside this tree, either layout works:

```sh
npm install -g bun      # the only extra build tool (or: curl -fsSL https://bun.sh/install | bash)
git clone https://github.com/kan-linux/kan-agent
git clone https://github.com/kan-linux/ggml-hexagon
cd ggml-hexagon && ./scripts/build-run-ggmlvulkan-x86-linux.sh build && cd ../kan-agent
./build.sh build
```

`./build.sh build` builds kan-agent and assembles the self-contained release tree in `out/kan-agent`
(runnable in place or installable with `sudo ./build.sh deploy` to `/opt/kan-agent`). Place exactly
one `.gguf` model in its `llm/` directory, then:

```sh
sudo /opt/kan-agent/kan-agent "帮我安装go"
```

`./build.sh help` lists every verb. `KAN_GGMLHEXAGON_PATH` / `KAN_GGMLHEXAGON_BIN` point the build
at an engine checkout in any other location.


## Acknowledgements
- Thanks to [llama.cpp](https://github.com/ggml-org/llama.cpp)
- Thanks to [Pi](https://github.com/earendil-works/pi)
- Thanks to the entire local AI community
- Special thanks to the AI assistant for extensive technical discussions, architectural advice, and writing assistance throughout the development of Kan-Agent



## Branches

- master
  https://github.com/kan-linux/kan-agent/tree/master, track [upstream pi project](https://github.com/earendil-works/pi).

- kan-agent
  https://github.com/kan-linux/kan-agent/tree/kan-agent, the default branch

- backup
  [https://github.com/kan-linux/kan-agent/tree/backup](https://github.com/kan-linux/kan-agent/tree/backup), backup branch


## Trademarks
This project may include trademarks or logos belonging to third parties. Use of any third-party trademarks is governed by their respective policies.
