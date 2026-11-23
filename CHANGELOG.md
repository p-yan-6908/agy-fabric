# Changelog

All notable changes to `agy-fabric` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- `scripts/statusline.sh` now reports cumulative session total tokens
  (`tok`, with `↑` input including cache reads and `↓` output) and cumulative
  session cache hit rate (`cache %`) aggregated across all turns in the
  session's `transcript.jsonl` (cached per session by file signature), instead
  of per-turn context size and last-turn cache rate. `ctx %` continues to
  report current context window fill.
- `agyf` now starts agy in its full-screen (alternate screen) rendering mode
  (`altScreenMode: "always"`) when the TUI compositor is active, fixing
  duplicated/garbled rows after backgrounding the terminal tab or reflowing.
  Opt out with `agyf --inline` / `AGYF_INLINE=1`, your own `--settings`, or an
  explicit `Rendering Mode` saved via `/config`.

### Fixed

- Fixed TUI compositor desync in full-screen (`altScreenMode`) where raw
  `Called N MCP tools (fabric_fabric/fabric_exec)` rows leaked through or
  overlays shifted onto wrong lines after scrolling or closing modals like
  `/model`:
  - Implemented `DECSTBM` (`CSI r`), `SU` (`CSI S`), `SD` (`CSI T`),
    scroll-region-scoped `IL`/`DL`/`LF`/`RI`, alternate-screen save/restore,
    and structured truecolor SGR tracking in `server/vt-screen.mjs`.
  - Tracked overlaid rows inside `VtScreen` so overlays move/clear in lockstep
    with scrolls, and switched `server/tui-proxy.mjs` to absolute `CUP`
    addressing when in alternate-screen mode.
- `agyf` no longer trips `set -u` on macOS bash 3.2 when launched with no
  arguments (empty passthrough array).

## [1.0.0] - 2026-11-21

### Added

- Fabric Code Mode plugin for Google Antigravity (`agy`): a single warm, sandboxed
  TypeScript kernel (`fabric_exec`) composing `pi.*` file/shell ops, MCP servers,
  skills, state, and parallel `agy` subagents.
- Pi Fovea code-graph navigation (`extensions.fovea_*`): `fovea_sketch`,
  `fovea_focus`, `fovea_dwell`, `fovea_impact`.
- Pi Context Engineer offloading (`extensions.ctx_*`): automatic offload of
  `fabric_exec` results `> 8.5 KB` to `.pi/context-store` with handles +
  structural outlines; oversized error compaction `> 4 KB`.
- Deterministic 0-LLM compaction: `/compact` interception via `PreInvocation`,
  auto-staging at 65% context occupancy, `[Carry Forward]` items, lossless
  `memory.expand` recall, and per-`agy`-PID session isolation.
- `agyf` launcher with zero-flicker PTY visual compositor (`tui-proxy.mjs`):
  collapsed/expanded Fabric run rows with op breakdowns and durations.
- `agy-compact` CLI: staged compaction, carry-forward management, status, cancel.
- Optional live telemetry statusline (`scripts/statusline.sh`, opt-in via
  `install.sh --with-statusline`): model, context %, session tokens, cache hit %,
  quota, and live Fabric run/op badge.
- `install.sh` / `uninstall.sh`: one-command install into
  `~/.gemini/config/plugins/fabric`, `bun install --production` of pi-*
  dependencies, `~/.local/bin` launchers, and `agy plugin validate --strict`.
- Remote bootstrap: `curl -fsSL .../install.sh | bash` clones to a temp dir and
  installs from there.

### Fixed

- TUI corruption: disabled `OPOST` on the outer PTY and guarded split ANSI
  flushes in `tui-proxy.mjs`.
- Removed emojis from UI/statusline; fixed weekly quota key selection.
