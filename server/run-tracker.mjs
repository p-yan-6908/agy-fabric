// Live run telemetry tracker for agy-fabric.
// Writes atomic PID-isolated JSON snapshots so the agyf TUI visual compositor and
// statusline can render real-time Fabric program names, sub-calls, counts, and durations.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const MAX_RECENT_RUNS = 200
const MAX_CALLS_PER_RUN = 24

const trimOneLine = (s, max = 44) => {
  const clean = String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const shortPath = (p, cwd) => {
  if (!p) return ''
  const s = String(p)
  try {
    if (cwd && s.startsWith(cwd)) {
      const rel = relative(cwd, s)
      if (rel && !rel.startsWith('..')) return rel
    }
  } catch {}
  return s.length > 32 ? basename(s) : s
}

export const describeHostCall = (op, args, cwd) => {
  const a = args && typeof args === 'object' ? args : {}
  if (op === 'pi') {
    const method = String(a.method || '')
    const callArgs = Array.isArray(a.args) ? a.args : []
    const first = callArgs[0]
    if (method === 'read') {
      const p = typeof first === 'string' ? first : first?.path
      return { kind: 'read', verb: 'Read', label: shortPath(p, cwd) || 'file' }
    }
    if (method === 'edit') {
      const p = typeof first === 'string' ? first : first?.path
      return { kind: 'edit', verb: 'Edit', label: shortPath(p, cwd) || 'file' }
    }
    if (method === 'write') {
      const p = typeof first === 'string' ? first : first?.path
      return { kind: 'write', verb: 'Write', label: shortPath(p, cwd) || 'file' }
    }
    if (method === 'grep') {
      const pat = typeof first === 'string' ? first : first?.pattern
      return { kind: 'search', verb: 'Grep', label: trimOneLine(pat || '', 28) }
    }
    if (method === 'find') {
      const pat = typeof first === 'string' ? first : first?.pattern
      return { kind: 'search', verb: 'Find', label: trimOneLine(pat || '*', 28) }
    }
    if (method === 'ls') {
      const p = typeof first === 'string' ? first : first?.path
      return { kind: 'list', verb: 'List', label: shortPath(p || '.', cwd) || '.' }
    }
    if (method === 'bash') {
      const cmd = typeof first === 'string' ? first : first?.command
      return { kind: 'bash', verb: 'Bash', label: trimOneLine(cmd || '', 34) }
    }
    return { kind: 'tool', verb: method || 'Pi', label: '' }
  }
  if (op === 'extension') {
    const name = String(a.name || '')
    const extArgs = a.args && typeof a.args === 'object' ? a.args : {}
    if (name.startsWith('fovea_')) {
      const sub = name.slice('fovea_'.length)
      const q = extArgs.query || (Array.isArray(extArgs.files) ? extArgs.files.join(', ') : '')
      return { kind: 'fovea', verb: 'Fovea', label: trimOneLine(q ? `${sub} ${q}` : sub, 30) }
    }
    if (name.startsWith('ctx_')) {
      const sub = name.slice('ctx_'.length)
      const target = extArgs.id || extArgs.key || ''
      return { kind: 'ctx', verb: 'Ctx', label: trimOneLine(target ? `${sub} ${target}` : sub, 28) }
    }
    return { kind: 'tool', verb: name || 'Ext', label: '' }
  }
  if (op === 'agent') {
    return { kind: 'agent', verb: 'Agent', label: trimOneLine(a.prompt || a.task || '', 30) }
  }
  if (op === 'compact') {
    return { kind: 'compact', verb: 'Compact', label: String(a.action || '') }
  }
  if (op === 'memory') {
    const o = a.options && typeof a.options === 'object' ? a.options : {}
    return { kind: 'memory', verb: 'Recall', label: trimOneLine(o.query || o.entryId || '', 28) }
  }
  if (op === 'skill') {
    return { kind: 'skill', verb: 'Skill', label: trimOneLine(a.name || '', 28) }
  }
  if (op === 'mcp') {
    return { kind: 'mcp', verb: 'MCP', label: trimOneLine(`${a.server || ''}.${a.tool || ''}`, 30) }
  }
  if (op === 'tools') {
    return { kind: 'tool', verb: 'Tools', label: String(a.action || '') }
  }
  return { kind: 'tool', verb: String(op || 'Op'), label: '' }
}

const inferProgramName = (code, display) => {
  const rawName = typeof display?.name === 'string' ? display.name.trim() : ''
  if (rawName) return trimOneLine(rawName, 40)
  const rawDesc = typeof display?.description === 'string' ? display.description.trim() : ''
  if (rawDesc) return trimOneLine(rawDesc, 40)
  const m = /\b(?:pi|extensions|agents|compact|memory|mcp|skills)\.([a-zA-Z0-9_]+)/.exec(String(code || ''))
  return m ? m[0] : 'fabric_exec'
}

const writeJsonAtomic = (filePath, data) => {
  try {
    const tmp = `${filePath}.${process.pid}.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, filePath)
  } catch {}
}

export const createRunTracker = ({ tmpRoot, sessionsDir, getOwnerPid }) => {
  const latestFile = join(tmpRoot, 'runs-latest.json')
  const stateByPid = new Map()

  const getState = pid => {
    const key = String(pid || 'default')
    let st = stateByPid.get(key)
    if (!st) {
      const file = join(sessionsDir, `runs-${key}.json`)
      let existing = null
      try {
        if (existsSync(file)) existing = JSON.parse(readFileSync(file, 'utf8'))
      } catch {}
      st = {
        pid: pid || null,
        file,
        cwd: existing?.cwd || null,
        active: null,
        recent: Array.isArray(existing?.recent) ? existing.recent.slice(-MAX_RECENT_RUNS) : [],
        totals: existing?.totals || { runs: 0, ops: 0, errors: 0, counts: {} },
      }
      stateByPid.set(key, st)
    }
    return st
  }

  const flush = st => {
    mkdirSync(sessionsDir, { recursive: true })
    const payload = {
      pid: st.pid,
      cwd: st.cwd,
      updatedAt: Date.now(),
      active: st.active,
      recent: st.recent,
      totals: st.totals,
    }
    writeJsonAtomic(st.file, payload)
    writeJsonAtomic(latestFile, payload)
  }

  const startRun = ({ id, cwd, code, display }) => {
    const pid = getOwnerPid()
    const st = getState(pid)
    st.cwd = cwd || st.cwd
    const jsonEscapedCode = JSON.stringify(String(code ?? '')).slice(1, 56)
    const run = {
      id,
      name: inferProgramName(code, display),
      description: typeof display?.description === 'string' ? trimOneLine(display.description, 80) : '',
      codePrefix: jsonEscapedCode,
      startedAt: Date.now(),
      durationMs: 0,
      ok: true,
      error: null,
      counts: {},
      totalOps: 0,
      calls: [],
    }
    st.active = run
    flush(st)
    return { st, run }
  }

  const startCall = (handle, op, args, cwd) => {
    if (!handle || op === 'state') return null
    const info = describeHostCall(op, args, cwd)
    const entry = {
      kind: info.kind,
      verb: info.verb,
      label: info.label,
      status: 'running',
      startedAt: Date.now(),
      ms: 0,
    }
    handle.run.totalOps += 1
    handle.run.counts[info.kind] = (handle.run.counts[info.kind] || 0) + 1
    handle.run.calls.push(entry)
    if (handle.run.calls.length > MAX_CALLS_PER_RUN) {
      handle.run.calls.splice(0, handle.run.calls.length - MAX_CALLS_PER_RUN)
    }
    flush(handle.st)
    return entry
  }

  const finishCall = (handle, entry, ok) => {
    if (!handle || !entry) return
    entry.status = ok ? 'done' : 'failed'
    entry.ms = Math.max(0, Date.now() - entry.startedAt)
    flush(handle.st)
  }

  const finishRun = (handle, { ok, error, preview } = {}) => {
    if (!handle) return
    const { st, run } = handle
    run.durationMs = Math.max(1, Date.now() - run.startedAt)
    run.ok = Boolean(ok)
    run.error = error ? trimOneLine(error, 72) : null
    run.preview = preview ? trimOneLine(preview, 90) : ''
    for (const c of run.calls) {
      if (c.status === 'running') {
        c.status = ok ? 'done' : 'failed'
        c.ms = Math.max(0, Date.now() - c.startedAt)
      }
    }
    if (st.active?.id === run.id) st.active = null
    st.recent.push(run)
    if (st.recent.length > MAX_RECENT_RUNS) {
      st.recent.splice(0, st.recent.length - MAX_RECENT_RUNS)
    }
    st.totals.runs = (st.totals.runs || 0) + 1
    st.totals.ops = (st.totals.ops || 0) + run.totalOps
    if (!run.ok) st.totals.errors = (st.totals.errors || 0) + 1
    for (const [k, v] of Object.entries(run.counts)) {
      st.totals.counts[k] = (st.totals.counts[k] || 0) + v
    }
    flush(st)
  }

  return { startRun, startCall, finishCall, finishRun }
}
