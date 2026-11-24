<div align="center">

<img src="assets/logo.svg" alt="agy-fabric logo" width="80" />

# agy-fabric

**Full Code Mode for Google Antigravity (`agy`)**

[![Version](https://img.shields.io/badge/version-1.0.0-38BDF8?labelColor=0F172A&style=flat-square)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?labelColor=0F172A&style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1-F9F1E1?labelColor=0F172A&style=flat-square&logo=bun&logoColor=FBF0DF)](https://bun.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-64748B?labelColor=0F172A&style=flat-square)](#quick-start)
[![Compaction](https://img.shields.io/badge/compaction-0--LLM-7C3AED?labelColor=0F172A&style=flat-square)](#features)
[![CI](https://img.shields.io/github/actions/workflow/status/p-yan-6908/agy-fabric/ci.yml?branch=main&label=CI&style=flat-square&labelColor=0F172A)](https://github.com/p-yan-6908/agy-fabric/actions)

One warm, sandboxed TypeScript kernel for everything — file I/O, shell, code-graph navigation,<br>
context offloading, deterministic 0-LLM compaction, MCP, skills, and parallel `agy` subagents.

[Quick Start](#quick-start) · [Benchmarks](#benchmarks) · [Changelog](CHANGELOG.md) · [fabric-swe results](https://p-yan-6908.github.io/fabric-swe/)

</div>

---

## Why `agy-fabric`?

Stock agent loops spend a model round-trip on every `read_file`, `grep`, `edit`, and `run_command` — and dump every byte of every result into the context window. `agy-fabric` wraps `agy` to run Antigravity with a minimal system prompt and a **single** tool, `fabric_exec`: a persistent, sandboxed TypeScript kernel that composes file I/O, shell commands, code-graph navigation, context offloading, compaction, MCP servers, skills, and subagents inside one program. Intermediate data stays in the kernel; only the returned value reaches the model.

Powered by [Pi Fabric](https://www.npmjs.com/package/pi-fabric), [Pi Fovea](https://www.npmjs.com/package/pi-fovea), and [Pi Context Engineer](https://github.com/p-yan-6908/pi-context-engineer).

## Features

- **Warm Sandboxed TypeScript Kernel (`fabric_exec`)**
  - Top-level `await` + `return` TypeScript execution in a persistent warm worker process (no cold-start penalty between calls; sandboxed via macOS `sandbox-exec` when available).
  - Composes `pi.read`, `pi.write`, `pi.edit`, `pi.grep`, `pi.find`, `pi.ls`, `pi.bash`, `mcp.<server>.<tool>`, `skills.list/load`, `state.get/set`, and `π` string payloads.
  - Intermediate data stays inside the kernel; only the returned value and `print()` output enter model context.
  - **Auto-Yield & Unified `tasks.*` Registry:** Programs still running at `yieldMs` (default `95s`; `0` disables) automatically yield `{ yielded: true, taskId }` before KV-cache TTL expiry while the worker continues uninterrupted in the background — inspect, collect, or cancel via `tasks.wait`, `tasks.get`, `tasks.list`, and `tasks.stop` (also tracks `pi.bash(cmd, { background: true })` tasks).
- **Pi Fovea Code-Graph Navigation (`extensions.fovea_*`)**
  - Heat-ranked repository overviews (`fovea_sketch`), symbol/path/route focus (`fovea_focus`), neighborhood deepening (`fovea_dwell`), and blast-radius impact analysis (`fovea_impact`).
- **Pi Context Engineer Offloading (`extensions.ctx_*`)**
  - Automatically offloads `fabric_exec` results `> 8.5 KB` to `.pi/context-store` with a compact handle + structural outline (sized below Antigravity's ~10 KB MCP file-spill threshold) and compacts oversized errors `> 4 KB`.
  - Inspect offloaded payloads inside `fabric_exec` via `extensions.ctx_read`, `extensions.ctx_summarize`, and `extensions.ctx_offload` without re-running commands.
- **Deterministic 0-LLM Compaction & Lossless Recall (`compact.*`, `memory.expand`, `agy-compact`)**
  - Uses `pi-fabric`'s deterministic algorithmic compactor (`0` LLM calls) to summarize transcripts into a compact handoff and inject them automatically on `SessionStart`.
  - Intercepts `/compact [instructions]` via `PreInvocation` hook, auto-stages compaction when context occupancy crosses 65%, and supports persistent `[Carry Forward]` items and lossless transcript recall via `memory.expand`.
  - Concurrent terminal sessions are isolated per `agy` PID.
- **Parallel `agy` Subagents (`agents.run`)**
  - Spawn nested `agy` subagents directly from TypeScript (fan out with `Promise.all`), inheriting your active `agy` model by default or configurable via `FABRIC_SUBAGENT_MODEL` / `fabric.json`.
- **Clean TUI Visuals (`server/tui-proxy.mjs` + `server/run-tracker.mjs`)**
  - Replaces raw `Called N MCP tools (fabric_fabric/fabric_exec ×N)` rows, generic `Calling MCP tool...` spinners, and wrapped JSON dumps in `ctrl+o` with live Fabric program names, descriptions, op breakdowns, and durations:
    - Collapsed: `● Fabric · 12 runs  ✓ Read ×14 · Edit ×4 · Bash ×3 · 8.2s  (ctrl+o)`
    - Expanded (`ctrl+o`): `│ ✓ read_pkg · Read ×1 · 11ms` + indented description & op summary
  - Automatically bypassed in non-TTY / `-p` print mode, or opt out anytime with `agy --plain` / `AGY_FABRIC_PLAIN=1`.
  - Runs agy in its full-screen (alternate screen) rendering mode by default, so the TUI stays intact when the tab is backgrounded or the terminal reflows. Use `agy --inline` / `AGY_FABRIC_INLINE=1` (or save a `Rendering Mode` in `/config`) to keep native inline scrollback.
- **Optional Live Telemetry Statusline (`scripts/statusline.sh`)**
  - Displays model, context %, cumulative session tokens, cache hit % (last turn + session avg), and quota — and feeds live token telemetry into `compact.pressure()`.

---

## Prerequisites

- [Antigravity CLI (`agy`)](https://antigravity.google) installed and authenticated
- [Bun](https://bun.sh) (`>= 1.1`)
- Recommended: `rg` (ripgrep) for fast `pi.grep`/`pi.find`, and `jq` if using the optional statusline

---

## Quick Start

One-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/p-yan-6908/agy-fabric/main/install.sh | bash
```

Then start a Fabric Code Mode session:

```bash
agy
```

<details>
<summary><b>Install from a local clone</b></summary>

```bash
git clone https://github.com/p-yan-6908/agy-fabric.git
cd agy-fabric
./install.sh
```

To also install the live context telemetry statusline:

```bash
./install.sh --with-statusline
```

</details>

What `install.sh` does:
1. Installs the Antigravity plugin to `~/.gemini/config/plugins/fabric` (with resolved `bun` and script paths in `mcp_config.json` and `hooks.json`).
2. Runs `bun install --production` inside the plugin directory to install `pi-fabric`, `pi-fovea`, and `pi-context-engineer`.
3. Installs `agy` and `agy-compact` into `~/.local/bin` (override with `--bin-dir`), preserving any existing stock `agy` binary at `~/.local/bin/.agy-orig/agy` (restored by `./uninstall.sh`).
4. Runs `agy plugin validate ~/.gemini/config/plugins/fabric --strict`.

To uninstall:

```bash
./uninstall.sh
```

---

## Usage

```bash
# Start an interactive Fabric Code Mode session (with clean TUI visuals)
agy

# Start without the visual PTY compositor (raw agy output)
agy --plain

# Keep agy's native inline (scrollback) rendering instead of full screen
agy --inline

# Launch stock Antigravity CLI without Fabric Code Mode
agy --no-fabric

# One-shot prompt mode
agy -p="Sketch this repository with Fovea and summarize its entrypoints"

# Deterministic 0-LLM compaction into a fresh session window
agy-compact
agy-compact "Keep auth token refresh invariant"
agy-compact --stage-only     # stage for next /new without launching agy
agy-compact --status         # inspect carry-forward items and staged/committed state
agy-compact --carry "item"   # add a persistent [Carry Forward] item
agy-compact --cancel         # cancel a pending staged compaction
```

> **Tip:** Inside an active `agy` session, running `/compact [optional focus]` is intercepted by the `PreInvocation` hook to run `pi-fabric`'s deterministic 0-LLM compactor and stage the summary for `/new`.

---

## Inside `fabric_exec`

All capabilities are exposed as globals inside each `fabric_exec` TypeScript program:

| Namespace | Key APIs |
| --- | --- |
| **Core (`pi`)** | `pi.read`, `pi.write`, `pi.edit`, `pi.grep`, `pi.find`, `pi.ls`, `pi.bash` |
| **Fovea (`extensions`)** | `extensions.fovea_sketch`, `extensions.fovea_focus`, `extensions.fovea_dwell`, `extensions.fovea_impact` |
| **Context Engineer (`extensions`)** | `extensions.ctx_read`, `extensions.ctx_summarize`, `extensions.ctx_offload` |
| **Compaction & Recall** | `compact.pressure`, `compact.carry`, `compact.request`, `compact.status`, `compact.cancel`, `memory.expand` |
| **Tasks & Auto-Yield (`tasks` / `bg`)** | `tasks.wait`, `tasks.get`, `tasks.list`, `tasks.stop` |
| **MCP, Skills & Subagents** | `mcp.<server>.<tool>(args)`, `tools.list/search/describe`, `skills.list/load`, `agents.run`, `state.get/set`, `π.<key>` |

---

## Configuration

Settings are merged in order from:
1. `~/.pi/agent/fabric.json`
2. `~/.pi/fabric.json`
3. `<workspace>/.pi/fabric.json`

Example `~/.pi/fabric.json`:

```json
{
  "executor": {
    "timeoutMs": 600000,
    "yieldMs": 95000,
    "inlineMaxBytes": 8500
  },
  "agents": {
    "maxConcurrent": 8,
    "defaultModel": "auto",
    "modelAliases": {
      "fast": "your-fast-model-id"
    }
  },
  "compaction": {
    "targetContextRatio": 0.65,
    "outputReserveTokens": 16000,
    "pressureBands": {
      "warn": 0.6,
      "urgent": 0.8
    }
  }
}
```

### Environment Variables

- `FABRIC_SUBAGENT_MODEL`: Default `--model` flag passed to `agy` subagents spawned via `agents.run` (when unset, subagents inherit `agy`'s active default model).
- `AGY_BIN`: Override path to the underlying stock `agy` binary used by the `agy` launcher, `agy-compact`, and `agents.run`.
- `AGY_FABRIC_PLAIN`: Set to `1` to bypass the PTY visual compositor by default (same as `--plain`).
- `AGY_FABRIC_INLINE`: Set to `1` to keep inline scrollback rendering instead of full-screen mode (same as `--inline`).
- `AGY_FABRIC_PLUGIN_DIR`: Override installed plugin directory (default: `~/.gemini/config/plugins/fabric`).
- `AGY_FABRIC_BIN_DIR`: Override target bin directory for `agy` and `agy-compact` (default: `~/.local/bin`).

---

## Optional Statusline Setup

If you installed `scripts/statusline.sh` (`./install.sh --with-statusline`), enable it in `~/.gemini/antigravity-cli/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.gemini/antigravity-cli/statusline.sh",
    "enabled": true
  }
}
```

This both renders the live statusline and writes per-session context telemetry to `/tmp/agy-fabric-<uid>/sessions/` so `compact.pressure()` and auto-staging have live token counts.

---

## Benchmarks

Measured by [fabric-swe](https://p-yan-6908.github.io/fabric-swe/): `pi` + `pi-fabric` (full code mode) + `pi-fovea` vs. vanilla `pi` (built-in tools only) — same model, prompts, sandbox, time budget, and grader on real-repository coding tasks. The same `fabric_exec` kernel powers this plugin.

| Model | Arm | Resolved | Mean tool calls | Mean wall | Mean cost |
| --- | --- | :-: | :-: | :-: | :-: |
| GPT-6.1 Sol | fabric-fovea | **10/10** | **23.3** | **12.9 min** | **$0.56** |
| | vanilla | 9/10 | 67.8 | 13.7 min | $0.59 |
| GPT-6.1 Terra | fabric-fovea | 8/10 | **42.6** | **11.6 min** | **$0.99** |
| | vanilla | **9/10** | 106.4 | 13.9 min | $1.11 |
| GPT-6 Luna | fabric-fovea | 7/10 | **42.9** | 26.2 min | $0.08 |
| | vanilla | **8/10** | 98.8 | **22.9 min** | $0.08 |

Code mode cuts tool calls by **57–66%** at comparable resolve rates (within noise at *n* = 10). Full per-task data, methodology, and run files: [p-yan-6908/fabric-swe](https://github.com/p-yan-6908/fabric-swe).

---

## Repository Structure

```text
.
├── plugin.json           # Antigravity plugin manifest
├── agents/fabric.md      # Minimal full-codemode agent prompt
├── hooks.json            # SessionStart / PreInvocation / PreToolUse / Stop hooks
├── mcp_config.json       # Fabric MCP server config
├── assets/logo.svg       # Plugin icon
├── server/
│   ├── mcp-server.mjs    # Fabric MCP server + extension hosts + subagent runner
│   ├── kernel.mjs        # Warm sandboxed guest TypeScript kernel
│   ├── compactor.mjs     # Deterministic 0-LLM transcript compactor
│   ├── hook-cwd.mjs      # Lifecycle hook handler (PID-isolated session tracking)
│   ├── run-tracker.mjs   # PID-isolated live run/op telemetry snapshots
│   ├── tui-proxy.mjs     # Zero-flicker PTY visual compositor for agy
│   ├── vt-screen.mjs     # Lightweight VT100 shadow screen tracker
│   ├── budget.mjs        # Output clipping helpers
│   └── resolve-deps.mjs  # Portable package resolver for pi-* dependencies
├── bin/
│   ├── agy               # `agy --agent fabric` launcher
│   └── agy-compact       # CLI for deterministic compaction & carry-forward items
├── scripts/
│   └── statusline.sh     # Optional live token telemetry statusline
├── install.sh            # One-command installer
└── uninstall.sh          # Clean uninstaller
```

---

## Credits

Built on top of:
- [`pi-fabric`](https://www.npmjs.com/package/pi-fabric) — programmable tool runtime & deterministic algorithmic compaction
- [`pi-fovea`](https://www.npmjs.com/package/pi-fovea) — foveated heat-diffusion code graph
- [`pi-context-engineer`](https://github.com/p-yan-6908/pi-context-engineer) — boundary offloading & structural previews

## License

MIT — see [LICENSE](LICENSE).
