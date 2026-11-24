#!/usr/bin/env bun
// Visual PTY compositor for agy-fabric (Antigravity + Fabric Code Mode).
// Runs `agy --agent fabric` inside a native Bun PTY, shadows its TUI via VtScreen,
// and cleanly replaces raw `fabric_fabric/fabric_exec` MCP rows with live, human-readable
// Fabric program summaries backed by PID-isolated run telemetry.
//
// Uses relative cursor movements from the live cursor row so it works identically in both
// inline terminal mode (at any starting row) and alternate-screen mode.
// Bypass with --plain or AGY_FABRIC_PLAIN=1 (or automatically when non-TTY / print mode).

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { VtScreen, truncateVisual, visualWidth } from './vt-screen.mjs'

const RST = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const WHITE = '\x1b[37m'
const AMBER = '\x1b[38;5;214m'
const MUTED = '\x1b[38;5;245m'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

const KIND_ORDER = ['read', 'edit', 'write', 'search', 'list', 'bash', 'fovea', 'ctx', 'agent', 'task', 'mcp', 'skill', 'compact', 'memory', 'tool']
const KIND_LABEL = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  search: 'Search',
  list: 'List',
  bash: 'Bash',
  fovea: 'Fovea',
  ctx: 'Ctx',
  agent: 'Agent',
  mcp: 'MCP',
  skill: 'Skill',
  task: 'Task',
  compact: 'Compact',
  memory: 'Recall',
  tool: 'Op',
}

const fmtDuration = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

const fmtCounts = (counts, maxParts = 4) => {
  if (!counts || typeof counts !== 'object') return ''
  const parts = []
  for (const k of KIND_ORDER) {
    const n = Number(counts[k] || 0)
    if (n > 0) parts.push(`${KIND_LABEL[k]} ×${n}`)
    if (parts.length >= maxParts) break
  }
  return parts.join(' · ')
}

const mergeCounts = runs => {
  const merged = {}
  for (const r of runs) {
    for (const [k, v] of Object.entries(r?.counts || {})) {
      merged[k] = (merged[k] || 0) + Number(v || 0)
    }
  }
  return merged
}

const clampAnsiLine = (segments, maxCols) => {
  let used = 0
  let out = ''
  for (const seg of segments) {
    if (!seg || !seg.text) continue
    const rem = maxCols - used
    if (rem <= 0) break
    const w = visualWidth(seg.text)
    if (w <= rem) {
      out += (seg.ansi || '') + seg.text
      used += w
    } else if (rem > 1) {
      out += (seg.ansi || '') + truncateVisual(seg.text, rem - 1) + '…'
      used = maxCols
      break
    } else {
      break
    }
  }
  return out + RST
}

const uid = process.getuid ? process.getuid() : 501
const TMP_ROOT = `/tmp/agy-fabric-${uid}`
const SESSIONS_DIR = join(TMP_ROOT, 'sessions')
const LATEST_RUNS_FILE = join(TMP_ROOT, 'runs-latest.json')

const readRunsSnapshot = (agyPid, sessionStartedAt) => {
  const pidFile = agyPid ? join(SESSIONS_DIR, `runs-${agyPid}.json`) : null
  for (const candidate of [pidFile, LATEST_RUNS_FILE]) {
    if (!candidate || !existsSync(candidate)) continue
    try {
      const data = JSON.parse(readFileSync(candidate, 'utf8'))
      if (candidate === LATEST_RUNS_FILE && agyPid && data.pid && data.pid !== agyPid) {
        if ((data.updatedAt || 0) < sessionStartedAt) continue
      }
      return data
    } catch {}
  }
  return null
}

// --- Row Pattern Matchers ---------------------------------------------------

const RE_GROUP_HEADER =
  /^(\s*)[●○◉]\s+(Calling|Called)\s+(\d+)\s+MCP\s+tools?\s+\(([^)]*fabric_exec[^)]*)\)(?:\s*\(ctrl\+o\s+to\s+(expand|collapse)\))?/

const RE_SINGLE_HEADER =
  /^(\s*)[●○◉]\s+(Calling|Called)\s+(?:MCP\s+tool\s+)?[\w./:-]*fabric_exec\b/

const RE_SPINNER = /^(\s*)([⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+Calling\s+MCP\s+tool\.{0,3}\s*$/

const RE_EXPANDED_CALL = /^(\s*(?:│\s*)?)([●○◉✓✗])\s+[\w./:-]*fabric_exec\((.*)$/

const RE_EXPANDED_CONT = /^(\s*│\s+)(?!([●○◉✓✗▾▸]\s|\s*⎿))(.*)$/

const RE_EXPANDED_CONT_BARE =
  /^(\s*)(?!([●○◉✓✗▾▸>─└⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|⎿))(.+)$/

const RE_EXPANDED_END = /\}\)(?:\s*\(ctrl\+o\s+to\s+(?:expand|collapse)\))?\s*$/

const RE_EXPANDED_RESULT =
  /^(\s*(?:│\s+)?⎿\s+)(.*?)(\s*\(ctrl\+o\s+to\s+(?:expand|collapse)\))?\s*$/

const extractFallbackFromJson = rawArgs => {
  const nameM = /"name"\s*:\s*"([^"]{1,48})/.exec(rawArgs)
  const descM = /"description"\s*:\s*"([^"]{1,96})/.exec(rawArgs)
  const codeM = /"code"\s*:\s*"([^"]*)/.exec(rawArgs)
  const codeSnippet = codeM ? codeM[1] : ''
  let inferred = ''
  if (!nameM && codeSnippet) {
    const opM = /\b(?:pi|extensions|agents|compact|memory|mcp|skills)\.[a-zA-Z0-9_]+/.exec(codeSnippet)
    if (opM) inferred = opM[0]
  }
  return {
    name: nameM ? nameM[1] : inferred || 'fabric_exec',
    description: descM ? descM[1] : '',
    codeSnippet,
  }
}

const matchExpandedRun = (rawArgs, allRuns, usedIds) => {
  const parsed = extractFallbackFromJson(rawArgs)
  const needle = parsed.codeSnippet.slice(0, 32)
  if (needle.length >= 6) {
    for (let i = allRuns.length - 1; i >= 0; i--) {
      const r = allRuns[i]
      if (!r || usedIds.has(r.id)) continue
      if (
        r.codePrefix &&
        (r.codePrefix.startsWith(needle) ||
          needle.startsWith(r.codePrefix.slice(0, Math.min(20, r.codePrefix.length))))
      ) {
        usedIds.add(r.id)
        return { run: r, parsed }
      }
    }
  }
  if (parsed.name && parsed.name !== 'fabric_exec') {
    for (let i = allRuns.length - 1; i >= 0; i--) {
      const r = allRuns[i]
      if (!r || usedIds.has(r.id)) continue
      if (r.name === parsed.name) {
        usedIds.add(r.id)
        return { run: r, parsed }
      }
    }
  }
  return { run: null, parsed }
}

const formatActiveDetail = active => {
  if (!active) return ''
  const elapsed = fmtDuration(Date.now() - (active.startedAt || Date.now()))
  const runningCall = [...(active.calls || [])].reverse().find(c => c.status === 'running')
  const lastCall = (active.calls || [])[active.calls.length - 1]
  const focus = runningCall || lastCall
  if (focus) {
    const opText = focus.label ? `${focus.verb} ${focus.label}` : focus.verb
    const opElapsed = focus.status === 'running' ? fmtDuration(Date.now() - (focus.startedAt || Date.now())) : ''
    const suffix = opElapsed ? ` (${opElapsed})` : elapsed ? ` (${elapsed})` : ''
    return `${opText}${suffix}`
  }
  return elapsed ? `running… (${elapsed})` : 'running…'
}

const computeOverlays = (screen, snapshot) => {
  const cols = Math.max(20, screen.cols - 1)
  const recent = Array.isArray(snapshot?.recent) ? snapshot.recent : []
  const active = snapshot?.active || null
  const allRuns = active ? [...recent, active] : recent

  const rowTexts = Array.from({ length: screen.rows }, (_, r) => screen.getRowText(r))
  const groupRows = []
  for (let r = 0; r < screen.rows; r++) {
    const m = RE_GROUP_HEADER.exec(rowTexts[r])
    if (m) {
      groupRows.push({
        row: r,
        indent: m[1] || '',
        verb: m[2],
        count: Number(m[3]) || 1,
        toggle: m[5] || '',
      })
    }
  }

  const groupRunSlices = new Map()
  let cursor = recent.length
  for (let i = groupRows.length - 1; i >= 0; i--) {
    const g = groupRows[i]
    const isCalling = g.verb === 'Calling'
    const completedInGroup = isCalling ? Math.max(0, g.count - (active ? 1 : 0)) : g.count
    const take = Math.min(cursor, completedInGroup)
    const slice = recent.slice(cursor - take, cursor)
    cursor -= take
    groupRunSlices.set(g.row, { slice, isCalling, active: isCalling && i === groupRows.length - 1 ? active : null })
  }

  const overlays = new Map()
  const usedRunIds = new Set()
  let lastExpandedRun = null
  let lastExpandedEndRow = -10

  for (let r = 0; r < screen.rows; r++) {
    const line = rowTexts[r]
    if (!line) continue

    // 1. Group header
    const gm = RE_GROUP_HEADER.exec(line)
    if (gm) {
      const indent = gm[1] || ''
      const verb = gm[2]
      const count = Number(gm[3]) || 1
      const toggle = gm[5] || ''
      const expanded = toggle === 'collapse'
      const info = groupRunSlices.get(r) || { slice: [], isCalling: verb === 'Calling', active: null }
      const runsForStats = info.active ? [...info.slice, info.active] : info.slice
      const totalMs = runsForStats.reduce(
        (acc, x) => acc + (x.durationMs || (x === info.active ? Date.now() - x.startedAt : 0)),
        0,
      )
      const errors = info.slice.filter(x => x && x.ok === false).length
      const countsSummary = fmtCounts(mergeCounts(runsForStats), count === 1 ? 3 : 4)
      const dur = fmtDuration(totalMs)

      const segs = []
      if (indent) segs.push({ text: indent })
      if (expanded) {
        segs.push({ ansi: MUTED, text: '▾ ' })
      } else {
        const dotColor = info.isCalling ? YELLOW : errors > 0 ? RED : GREEN
        segs.push({ ansi: dotColor, text: '● ' })
      }
      segs.push({ ansi: BOLD + WHITE, text: 'Fabric' })

      if (info.isCalling) {
        const activeName = info.active?.name || (count > 1 ? `${count} runs` : 'running')
        segs.push({ ansi: MUTED, text: ' · ' })
        segs.push({
          ansi: CYAN,
          text: count > 1 && info.active?.name ? `${count} runs · ${info.active.name}` : activeName,
        })
        segs.push({ ansi: RST + '  ' + YELLOW, text: '● ' })
        const detail = formatActiveDetail(info.active) || countsSummary || 'running…'
        segs.push({ ansi: WHITE, text: detail })
        if (countsSummary && info.active?.calls?.length > 1) {
          segs.push({ ansi: MUTED, text: ` · ${countsSummary}` })
        }
      } else {
        const single = count === 1 ? info.slice[0] : null
        const title = single?.name || `${count} ${count === 1 ? 'run' : 'runs'}`
        segs.push({ ansi: MUTED, text: ' · ' })
        segs.push({ ansi: CYAN, text: title })
        segs.push({ ansi: RST, text: '  ' })
        if (errors > 0) {
          segs.push({ ansi: RED, text: `✗ ${errors} err` })
          if (countsSummary) segs.push({ ansi: MUTED, text: ` · ${countsSummary}` })
        } else {
          segs.push({ ansi: GREEN, text: '✓' })
          if (single && single.calls?.length === 1) {
            const c0 = single.calls[0]
            const oneOp = c0.label ? ` ${c0.verb} ${c0.label}` : ` ${c0.verb}`
            segs.push({ ansi: WHITE, text: oneOp })
          } else if (countsSummary) {
            segs.push({ ansi: WHITE, text: ` ${countsSummary}` })
          } else {
            segs.push({ ansi: MUTED, text: ' done' })
          }
        }
        if (dur) segs.push({ ansi: MUTED, text: ` · ${dur}` })
      }
      if (toggle) {
        segs.push({ ansi: DIM + MUTED, text: '  (ctrl+o)' })
      }
      overlays.set(r, clampAnsiLine(segs, cols))
      continue
    }

    // 2. Single header fallback
    const sm = RE_SINGLE_HEADER.exec(line)
    if (sm) {
      const indent = sm[1] || ''
      const isCalling = sm[2] === 'Calling'
      const run = isCalling ? active : recent[recent.length - 1]
      const segs = [
        ...(indent ? [{ text: indent }] : []),
        { ansi: isCalling ? YELLOW : run?.ok === false ? RED : GREEN, text: '● ' },
        { ansi: BOLD + WHITE, text: 'Fabric' },
        { ansi: MUTED, text: ' · ' },
        { ansi: CYAN, text: run?.name || 'program' },
        { ansi: RST, text: '  ' },
        isCalling
          ? { ansi: YELLOW, text: `● ${formatActiveDetail(active) || 'running…'}` }
          : {
              ansi: run?.ok === false ? RED : GREEN,
              text: run?.ok === false ? '✗ failed' : `✓ ${fmtCounts(run?.counts, 3) || 'done'}`,
            },
      ]
      overlays.set(r, clampAnsiLine(segs, cols))
      continue
    }

    // 3. Bottom active spinner
    const sp = RE_SPINNER.exec(line)
    if (sp) {
      const indent = sp[1] || ''
      const frame = sp[2]
      const segs = [
        ...(indent ? [{ text: indent }] : []),
        { ansi: CYAN, text: frame },
        { ansi: RST, text: '  ' },
        { ansi: AMBER, text: 'Fabric' },
      ]
      if (active) {
        segs.push({ ansi: MUTED, text: ' · ' })
        segs.push({ ansi: WHITE, text: active.name })
        const detail = formatActiveDetail(active)
        if (detail) {
          segs.push({ ansi: MUTED, text: ' — ' })
          segs.push({ ansi: DIM + WHITE, text: detail })
        }
      } else {
        segs.push({ ansi: MUTED, text: ' · running program…' })
      }
      overlays.set(r, clampAnsiLine(segs, cols))
      continue
    }

    // 4. Expanded individual call row (+ wrapped JSON continuation rows!)
    const em = RE_EXPANDED_CALL.exec(line)
    if (em) {
      const gutter = em[1]
      const hasPipe = gutter.includes('│')
      const bullet = em[2]
      let joinedArgs = em[3] || ''
      const contRows = []
      let look = r + 1
      while (!RE_EXPANDED_END.test(joinedArgs) && look < screen.rows && contRows.length < 5) {
        const nextLine = rowTexts[look]
        if (!nextLine || !nextLine.trim()) break
        const cm = (hasPipe ? RE_EXPANDED_CONT : RE_EXPANDED_CONT_BARE).exec(nextLine)
        if (!cm) break
        const frag = cm[3] || ''
        contRows.push({ row: look, gutter: cm[1], text: frag })
        joinedArgs += frag
        look++
        if (RE_EXPANDED_END.test(frag)) break
      }

      const { run, parsed } = matchExpandedRun(joinedArgs, allRuns, usedRunIds)
      lastExpandedRun = run
      lastExpandedEndRow = contRows.length > 0 ? contRows[contRows.length - 1].row : r

      const isRunning = Boolean(run && active && run.id === active.id)
      const isFailed = run ? run.ok === false : bullet === '✗'
      const mark = isRunning ? '●' : isFailed ? '✗' : '✓'
      const markColor = isRunning ? YELLOW : isFailed ? RED : GREEN
      const title = run?.name || parsed.name
      const desc = run?.description || parsed.description
      const ops = run ? fmtCounts(run.counts, 3) : ''
      const dur = run ? fmtDuration(isRunning ? Date.now() - run.startedAt : run.durationMs) : ''

      // Main row: │ ✓ list_root  · List ×1 · 0.1s  (plus inline desc if there are no wrapped rows)
      const segs = [
        { ansi: MUTED, text: gutter },
        { ansi: markColor, text: `${mark} ` },
        { ansi: BOLD + CYAN, text: title },
      ]
      if (contRows.length === 0 && desc && desc.toLowerCase() !== title.toLowerCase()) {
        segs.push({ ansi: RST + WHITE, text: `  ${desc}` })
      }
      if (isRunning) {
        const live = formatActiveDetail(run)
        if (live) segs.push({ ansi: MUTED, text: ` · ${live}` })
      } else {
        if (ops) segs.push({ ansi: MUTED, text: ` · ${ops}` })
        if (isFailed) segs.push({ ansi: RED, text: ' · failed' })
        if (dur) segs.push({ ansi: MUTED, text: ` · ${dur}` })
      }
      if (/\(ctrl\+o\s+to\s+collapse\)/.test(joinedArgs)) {
        segs.push({ ansi: DIM + MUTED, text: '  (ctrl+o)' })
      }
      overlays.set(r, clampAnsiLine(segs, cols))

      // Cleanly repurpose wrapped continuation rows (description on first, subtle gutter on any extras)
      for (let i = 0; i < contRows.length; i++) {
        const cr = contRows[i]
        if (i === 0 && desc) {
          overlays.set(
            cr.row,
            clampAnsiLine(
              [
                { ansi: MUTED, text: gutter + '  ' },
                { ansi: DIM + WHITE, text: desc },
              ],
              cols,
            ),
          )
        } else if (i === 0 && run?.calls?.length) {
          const callTrail = run.calls
            .slice(0, 4)
            .map(c => (c.label ? `${c.verb} ${c.label}` : c.verb))
            .join(' · ')
          overlays.set(
            cr.row,
            clampAnsiLine(
              [
                { ansi: MUTED, text: gutter + '  ' },
                { ansi: DIM + WHITE, text: callTrail },
              ],
              cols,
            ),
          )
        } else {
          overlays.set(cr.row, clampAnsiLine([{ ansi: MUTED, text: gutter.trimEnd() }], cols))
        }
      }

      r = lastExpandedEndRow
      continue
    }

    // 5. Expanded result line directly under an expanded fabric_exec call
    if (lastExpandedRun && r > lastExpandedEndRow && r <= lastExpandedEndRow + 2) {
      const rm = RE_EXPANDED_RESULT.exec(line)
      if (rm) {
        const gutter = rm[1]
        const rawBody = (rm[2] || '').trim()
        const hasToggle = Boolean(rm[3])
        if (rawBody === '{' || rawBody === '[' || rawBody.startsWith('{"') || rawBody.startsWith('[offloaded')) {
          const callSummary = (lastExpandedRun.calls || [])
            .slice(0, 4)
            .map(c => (c.label ? `${c.verb} ${c.label}` : c.verb))
            .join(' · ')
          const body = lastExpandedRun.error
            ? `error: ${lastExpandedRun.error}`
            : callSummary || lastExpandedRun.preview || rawBody
          const segs = [
            { ansi: MUTED, text: gutter },
            { ansi: lastExpandedRun.error ? RED : DIM + WHITE, text: body },
            ...(hasToggle ? [{ ansi: DIM + MUTED, text: '  (ctrl+o)' }] : []),
          ]
          overlays.set(r, clampAnsiLine(segs, cols))
        }
        lastExpandedRun = null
      }
    }
  }

  return overlays
}

// --- Relative Cursor Patch Builder ------------------------------------------

const moveVert = (fromRow, toRow) => {
  const d = toRow - fromRow
  if (d < 0) return `\x1b[${-d}A`
  if (d > 0) return `\x1b[${d}B`
  return ''
}

const buildOverlayPatch = (screen, nextOverlays, forceAll) => {
  const hasPrev = screen.hasOverlaidRows()
  if (!forceAll && nextOverlays.size === 0 && !hasPrev) return ''

  // Collect all rows we need to touch, sorted top-to-bottom.
  // screen.rowOverlaid moves in lockstep with scrolls/inserts/deletes/clears,
  // so stale overlays shifted by DECSTBM/SU/SD/IL/DL are always cleanly restored.
  const targetRows = new Set()
  for (let r = 0; r < screen.rows; r++) {
    if (screen.rowOverlaid[r] && !nextOverlays.has(r)) targetRows.add(r)
  }
  for (const r of nextOverlays.keys()) {
    targetRows.add(r)
  }
  if (targetRows.size === 0) return ''

  const sorted = [...targetRows].sort((a, b) => a - b)
  const useAbs = screen.inAltScreen
  const curCol = Math.max(0, Math.min(screen.cols - 1, screen.col))
  let curR = screen.row
  let out = '\x1b[?25l'

  for (const r of sorted) {
    const isOverlay = nextOverlays.has(r)
    const content = isOverlay ? nextOverlays.get(r) : screen.renderRowAnsi(r)
    if (useAbs) {
      out += `\x1b[${r + 1};1H\x1b[2K${content}`
    } else {
      out += moveVert(curR, r)
      curR = r
      out += `\r\x1b[2K${content}`
    }
    screen.rowOverlaid[r] = isOverlay
  }

  // Restore exact cursor row, col, SGR, and visibility
  if (useAbs) {
    out += `\x1b[${screen.row + 1};${curCol + 1}H`
  } else {
    out += moveVert(curR, screen.row)
    out += '\r'
    if (curCol > 0) out += `\x1b[${curCol}C`
  }
  out += '\x1b[0m' + screen.curSgr
  out += screen.cursorVisible ? '\x1b[?25h' : '\x1b[?25l'
  return out
}

// --- Main PTY Proxy Loop ----------------------------------------------------

const agyBin = process.argv[2]
const agyArgs = process.argv.slice(3)
if (!agyBin) {
  console.error('tui-proxy: missing agy binary path')
  process.exit(1)
}

const sessionStartedAt = Date.now()
const initCols = process.stdout.columns || 120
const initRows = process.stdout.rows || 40
const screen = new VtScreen(initCols, initRows)
const decoder = new StringDecoder('utf8')
let pendingChunks = []
let flushTimer = null
let agyPid = null
let autoNewTimer = null

const checkAutoNewSignal = () => {
  if (!agyPid || autoNewTimer) return
  const sigFile = join(SESSIONS_DIR, `autonew-${agyPid}.json`)
  if (!existsSync(sigFile)) return
  let sig = null
  try {
    sig = JSON.parse(readFileSync(sigFile, 'utf8'))
    unlinkSync(sigFile)
  } catch {
    try {
      unlinkSync(sigFile)
    } catch {}
    return
  }
  if ((sig?.requestedAt || 0) < sessionStartedAt) return
  autoNewTimer = setTimeout(() => {
    try {
      proc.terminal.write('/new')
      setTimeout(() => {
        try {
          proc.terminal.write('\r')
        } catch {}
        autoNewTimer = null
      }, 80)
    } catch {
      autoNewTimer = null
    }
  }, 220)
}

const flushOutput = (finalFlush = false) => {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingChunks.length === 0) return
  const raw = pendingChunks.join('')
  pendingChunks = []
  screen.feed(raw)

  // Never flush a truncated ANSI escape sequence to stdout, or a subsequent
  // SYNC_START/patch could split the sequence and print raw CSI text on screen.
  let outRaw = raw
  if (!finalFlush && screen.pending && raw.endsWith(screen.pending)) {
    const rem = screen.pending
    screen.pending = ''
    outRaw = raw.slice(0, raw.length - rem.length)
    pendingChunks.unshift(rem)
  }
  if (!outRaw) return

  const snapshot = readRunsSnapshot(agyPid, sessionStartedAt)
  const nextOverlays = computeOverlays(screen, snapshot)
  const patch = buildOverlayPatch(screen, nextOverlays, false)
  if (patch) {
    // Strip inner synchronized-update toggles so raw + patch render in one atomic frame
    const cleanRaw = outRaw.replace(/\x1b\[\?2026[hl]/g, '')
    process.stdout.write(SYNC_START + cleanRaw + patch + SYNC_END)
  } else {
    process.stdout.write(outRaw)
  }
  checkAutoNewSignal()
}

// Configure outer TTY to true raw mode (including -opost) BEFORE spawning agy.
// Node/Bun's setRawMode(true) leaves OPOST/ONLCR enabled, which turns agy's raw
// LF (\n) cursor-down moves into CRLF (\r\n) and corrupts relative positioning.
const ttyIsInteractive = Boolean(process.stdin.isTTY)
const wasRaw = Boolean(process.stdin.isRaw)
let savedStty = ''
let ttyRestored = false

if (ttyIsInteractive) {
  try {
    const r = Bun.spawnSync(['stty', '-g'], { stdin: 'inherit', stdout: 'pipe', stderr: 'ignore' })
    if (r.exitCode === 0) savedStty = r.stdout.toString().trim()
  } catch {}
}

const applyRawTty = () => {
  if (!ttyIsInteractive) return
  ttyRestored = false
  try {
    process.stdin.setRawMode(true)
  } catch {}
  try {
    Bun.spawnSync(['stty', '-opost'], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

const restoreTty = () => {
  if (!ttyIsInteractive || ttyRestored) return
  ttyRestored = true
  try {
    process.stdin.setRawMode(wasRaw)
  } catch {}
  if (savedStty) {
    try {
      Bun.spawnSync(['stty', savedStty], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' })
    } catch {}
  } else {
    try {
      Bun.spawnSync(['stty', 'opost', 'echo', 'icanon'], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' })
    } catch {}
  }
}

applyRawTty()
process.on('exit', restoreTty)

const proc = Bun.spawn([agyBin, ...agyArgs], {
  cwd: process.cwd(),
  env: { ...process.env },
  terminal: {
    cols: initCols,
    rows: initRows,
    data(_term, data) {
      const s = typeof data === 'string' ? data : decoder.write(Buffer.from(data))
      if (!s) return
      pendingChunks.push(s)
      if (
        s.includes('\x1b[?25h') ||
        s.includes('\x1b[?2026l') ||
        s.includes('$p') ||
        s.includes('?\x07') ||
        s.includes('\x1b[?u') ||
        s.includes('\x1b[6n')
      ) {
        flushOutput()
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushOutput, 12)
      }
    },
  },
})

agyPid = proc.pid

// Live refresh ticker while a Fabric program is actively executing (and auto-/new watcher)
const liveTicker = setInterval(() => {
  checkAutoNewSignal()
  if (!screen.hasOverlaidRows() || pendingChunks.length > 0) return
  const snapshot = readRunsSnapshot(agyPid, sessionStartedAt)
  if (!snapshot?.active) return
  const nextOverlays = computeOverlays(screen, snapshot)
  const patch = buildOverlayPatch(screen, nextOverlays, true)
  if (patch) process.stdout.write(SYNC_START + patch + SYNC_END)
}, 180)
liveTicker.unref?.()

// Forward raw stdin to PTY
process.stdin.resume()
const onStdinData = chunk => {
  try {
    proc.terminal.write(chunk)
  } catch {}
}
process.stdin.on('data', onStdinData)

// Forward terminal resizes
const onResize = () => {
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 40
  screen.resize(cols, rows)
  screen.clearOverlaidFlags()
  try {
    proc.terminal.resize(cols, rows)
  } catch {}
}
process.stdout.on('resize', onResize)

const onSignal = sig => {
  try {
    proc.kill(sig)
  } catch {}
}
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGHUP', () => onSignal('SIGHUP'))
process.on('SIGCONT', () => {
  applyRawTty()
  onResize()
})

const exitCode = await proc.exited
clearInterval(liveTicker)
const tail = decoder.end()
if (tail) pendingChunks.push(tail)
flushOutput(true)
process.stdin.off('data', onStdinData)
process.stdout.off('resize', onResize)
restoreTty()
process.stdin.pause()
process.exit(exitCode ?? 0)
