#!/usr/bin/env bun
// Fabric MCP Server for Antigravity (agy).
// Integrates:
// 1. Warm sandboxed TypeScript kernel (`pi.*`, `mcp.*`, `skills.*`, `state.*`, `π`)
// 2. Real `pi-fovea` extension (`extensions.fovea_sketch/focus/dwell/impact`)
// 3. Real `pi-context-engineer` (`extensions.ctx_read/summarize/offload` + automatic 8.5 KB boundary offload)
// 4. Real `pi-fabric` deterministic algorithmic compaction (`compact.*` + `memory.expand`, PID-isolated)
// 5. `agy` subagents (`agents.run`, inheriting active agy model or configured default)

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clip, fit, textOf } from './budget.mjs'
import {
  cancelPendingCompaction,
  compileTranscriptCompaction,
  expandTranscriptMemory,
  findTranscriptForConversation,
  parseAgyTranscript,
  readCompactionStatus,
  rawContextTokens,
  updateCarryItems,
} from './compactor.mjs'
import { importFile, resolvePackageFile } from './resolve-deps.mjs'
import { createRunTracker } from './run-tracker.mjs'

// Keep stdout exclusively for MCP JSON-RPC frames even when extensions log
console.log = (...args) => console.error(...args)
process.env.FOVEA_TURN_SYNC = 'off'
process.env.FOVEA_GIT_UNTRACKED_CACHE = '0'

const HOME = homedir()
const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(SERVER_DIR)
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(HOME, '.bun', 'bin'),
  join(HOME, '.local', 'bin'),
  join(HOME, 'bin'),
]
const FULL_PATH = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':')].filter(Boolean).join(':')
process.env.PATH = FULL_PATH

const PATH_DIRS = FULL_PATH.split(':').filter(Boolean)
const findBin = (name, fallbacks = []) => {
  for (const candidate of [...fallbacks, ...PATH_DIRS.map(p => join(p, name)), `/usr/bin/${name}`, `/bin/${name}`]) {
    if (candidate && isAbsolute(candidate) && existsSync(candidate)) return candidate
  }
  return name
}

const BUN_BIN = findBin('bun', [process.execPath])
const RG_BIN = findBin('rg')
const HAS_RG = isAbsolute(RG_BIN) && existsSync(RG_BIN)
const GREP_BIN = findBin('grep', ['/usr/bin/grep', '/bin/grep'])
const isFabricLauncher = filePath => {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(256)
      const n = readSync(fd, buf, 0, 256, 0)
      const head = buf.subarray(0, n).toString('utf8')
      return head.startsWith('#!') && head.includes('agy-fabric-launcher')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

const findRealAgyBin = () => {
  const candidates = [
    process.env.AGY_BIN || '',
    join(HOME, '.local', 'bin', '.agy-orig', 'agy'),
    ...PATH_DIRS.flatMap(p => [join(p, '.agy-orig', 'agy'), join(p, 'agy')]),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ]
  for (const candidate of candidates) {
    if (candidate && isAbsolute(candidate) && existsSync(candidate) && !isFabricLauncher(candidate)) {
      return candidate
    }
  }
  return findBin('agy')
}

const AGY_BIN = findRealAgyBin()
const SHELL_BIN =
  ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'].find(p => existsSync(p)) || '/bin/sh'
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const HAS_SANDBOX = existsSync(SANDBOX_EXEC)
const SANDBOX_PROFILE =
  '(version 1)(allow default)(deny network*)(deny file-write*)' +
  '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))'

const CE_EXTRA_ROOTS = [join(HOME, 'pi-context-engineer')]
const CE_HOST_MODULE = resolvePackageFile('pi-context-engineer', join('claude-code', 'host.mjs'), CE_EXTRA_ROOTS)
const CE_EXT_ENTRY = resolvePackageFile('pi-context-engineer', join('src', 'index.ts'), CE_EXTRA_ROOTS)
const CE_STORE_MODULE = resolvePackageFile('pi-context-engineer', join('src', 'store.ts'), CE_EXTRA_ROOTS)
const CE_PREVIEW_MODULE = resolvePackageFile('pi-context-engineer', join('src', 'preview.ts'), CE_EXTRA_ROOTS)
const FOVEA_EXT_ENTRY = resolvePackageFile('pi-fovea', join('src', 'index.ts'))

const MARK = '\u001eFABRIC '
const TMP_ROOT = `/tmp/agy-fabric-${process.getuid ? process.getuid() : 501}`
const SESSIONS_DIR = join(TMP_ROOT, 'sessions')
const STATE_DIR = join(TMP_ROOT, 'state')
const SPILL_DIR = join(TMP_ROOT, 'spill')
const ACTIVE_CWD_FILE = join(TMP_ROOT, 'active-cwd.json')
const TELEMETRY_FILE = join(TMP_ROOT, 'telemetry.json')
mkdirSync(SESSIONS_DIR, { recursive: true })
mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(SPILL_DIR, { recursive: true })

// Antigravity's `call_mcp_tool` wrapper spills outputs > ~10 KB to `.system_generated/steps/<N>/output.txt`
// with no preview. Keeping Fabric's inline threshold at 8.5 KB (hard cap 9.5 KB) ensures Context Engineer
// always offloads to `.pi/context-store` with a rich structural outline + `extensions.ctx_read` handle first.
const DEFAULT_AGY_INLINE_MAX_BYTES = 8500
const HARD_AGY_MCP_INLINE_CAP_BYTES = 9500

const DEFAULT_SUBAGENT_MODEL = (process.env.FABRIC_SUBAGENT_MODEL || '').trim() || null
const MAX_SUBAGENT_DEPTH = 3

const record = v => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {})
const readJsonSafe = path => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

const PLUGIN_VERSION = readJsonSafe(join(PLUGIN_ROOT, 'plugin.json'))?.version || '1.0.0'

const isPidAlive = pid => {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code !== 'ESRCH'
  }
}

const pruneStaleTmpFiles = () => {
  const now = Date.now()
  const pidTtlMs = 3600 * 1000
  const fileTtlMs = 48 * 3600 * 1000
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      const full = join(SESSIONS_DIR, name)
      let mt = 0
      try {
        mt = statSync(full).mtimeMs
      } catch {
        continue
      }
      const pidMatch = /^(?:pid|runs|tel-pid|autonew)-(\d+)\.json$/.exec(name)
      if (pidMatch) {
        if (now - mt > pidTtlMs && !isPidAlive(Number(pidMatch[1]))) {
          try {
            unlinkSync(full)
          } catch {}
        }
      } else if (now - mt > fileTtlMs) {
        try {
          unlinkSync(full)
        } catch {}
      }
    }
  } catch {}
  try {
    for (const name of readdirSync(SPILL_DIR)) {
      const full = join(SPILL_DIR, name)
      try {
        if (now - statSync(full).mtimeMs > fileTtlMs) unlinkSync(full)
      } catch {}
    }
  } catch {}
  try {
    for (const name of readdirSync(TMP_ROOT)) {
      if (!name.startsWith('bg-') && !name.startsWith('run-')) continue
      const full = join(TMP_ROOT, name)
      const ttl = name.startsWith('run-') ? pidTtlMs : fileTtlMs
      try {
        if (now - statSync(full).mtimeMs > ttl) rmSync(full, { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}
pruneStaleTmpFiles()

const workspaceStateDir = cwd => {
  const full = resolve(cwd || HOME)
  const base = full.split('/').filter(Boolean).pop() || 'root'
  const safeBase = base.replace(/[^\w.-]/g, '_').slice(0, 32)
  const hash =
    typeof Bun !== 'undefined' && typeof Bun.hash === 'function'
      ? Bun.hash(full).toString(36)
      : Buffer.from(full).toString('base64url').slice(-16)
  const dir = join(STATE_DIR, `${safeBase}-${hash}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const loadFabricConfig = cwd => {
  let merged = {}
  for (const p of [
    join(HOME, '.pi', 'agent', 'fabric.json'),
    join(HOME, '.pi', 'fabric.json'),
    cwd ? join(cwd, '.pi', 'fabric.json') : null,
  ]) {
    if (!p) continue
    const data = readJsonSafe(p)
    if (data) {
      merged = {
        ...merged,
        ...record(data),
        executor: { ...record(merged.executor), ...record(data.executor) },
        agents: { ...record(merged.agents), ...record(data.agents) },
        compaction: { ...record(merged.compaction), ...record(data.compaction) },
      }
    }
  }
  const exec = record(merged.executor)
  const agents = record(merged.agents)
  const comp = record(merged.compaction)
  return {
    timeoutMs: typeof exec.timeoutMs === 'number' && exec.timeoutMs > 0 ? Math.min(exec.timeoutMs, 600000) : 600000,
    maxOutputChars: typeof exec.maxOutputChars === 'number' && exec.maxOutputChars > 0 ? exec.maxOutputChars : 50000,
    inlineMaxBytes:
      typeof exec.inlineMaxBytes === 'number' && exec.inlineMaxBytes >= 1024
        ? Math.min(exec.inlineMaxBytes, HARD_AGY_MCP_INLINE_CAP_BYTES)
        : DEFAULT_AGY_INLINE_MAX_BYTES,
    budgetChars: DEFAULT_AGY_INLINE_MAX_BYTES,
    maxConcurrentAgents:
      typeof agents.maxConcurrent === 'number' && agents.maxConcurrent > 0 ? Math.min(agents.maxConcurrent, 16) : 8,
    defaultSubagentModel:
      (typeof agents.defaultModel === 'string' && agents.defaultModel.trim()) || DEFAULT_SUBAGENT_MODEL,
    modelAliases: record(agents.modelAliases),
    targetContextRatio:
      typeof comp.targetContextRatio === 'number' && comp.targetContextRatio >= 0.25 && comp.targetContextRatio <= 0.85
        ? comp.targetContextRatio
        : 0.65,
    outputReserveTokens: typeof comp.outputReserveTokens === 'number' && comp.outputReserveTokens >= 0 ? comp.outputReserveTokens : 16000,
    pressureBands: {
      warn: Number(comp.pressureBands?.warn) > 0 ? Number(comp.pressureBands.warn) : 0.6,
      urgent: Number(comp.pressureBands?.urgent) > 0 ? Number(comp.pressureBands.urgent) : 0.8,
    },
  }
}

// --- Session & Workspace CWD tracking (PID-isolated across terminals) -------

const resolveOwnerAgyPid = () => {
  const override = Number(process.env.FABRIC_OWNER_PID)
  if (Number.isFinite(override) && override > 1) return override
  let cur = process.ppid
  for (let hop = 0; hop < 4 && cur > 1; hop++) {
    try {
      const out = spawnSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { encoding: 'utf8', timeout: 500 })
      const line = String(out.stdout || '').trim()
      if (!line) break
      const m = /^(\d+)\s+(.+)$/.exec(line)
      if (!m) break
      const parentPid = Number(m[1])
      const comm = m[2].trim()
      if (/(?:^|\/)agy(?:[-.]orig|[-.]real|-bin)?$/.test(comm)) return cur
      cur = parentPid
    } catch {
      break
    }
  }
  return process.ppid
}

const OWNER_AGY_PID = resolveOwnerAgyPid()
const runTracker = createRunTracker({ tmpRoot: TMP_ROOT, sessionsDir: SESSIONS_DIR, getOwnerPid: () => OWNER_AGY_PID })
let mcpRoots = []

const readActiveSessionMeta = () => {
  if (OWNER_AGY_PID > 1) {
    const byPid = readJsonSafe(join(SESSIONS_DIR, `pid-${OWNER_AGY_PID}.json`))
    if (byPid && typeof byPid === 'object') return byPid

    const telByPid = readJsonSafe(join(SESSIONS_DIR, `tel-pid-${OWNER_AGY_PID}.json`))
    if (telByPid && typeof telByPid === 'object') {
      const convId = telByPid.session_id ?? null
      const byConv = convId ? readJsonSafe(join(SESSIONS_DIR, `conv-${convId}.json`)) : null
      if (byConv && typeof byConv === 'object') return byConv
      return {
        cwd: telByPid.cwd ?? null,
        conversationId: convId,
        transcriptPath: telByPid.transcript_path ?? null,
        turnIndex: 0,
        agyPid: OWNER_AGY_PID,
      }
    }
  }
  const globalMeta = readJsonSafe(ACTIVE_CWD_FILE) ?? {}
  if (globalMeta.agyPid && OWNER_AGY_PID > 1 && globalMeta.agyPid !== OWNER_AGY_PID) {
    // Another terminal wrote active-cwd.json; do not adopt its conversationId.
    return { cwd: globalMeta.cwd ?? null, conversationId: null, transcriptPath: null, turnIndex: 0 }
  }
  return globalMeta
}

const readSessionTelemetry = convId => {
  if (convId) {
    const bySid = readJsonSafe(join(SESSIONS_DIR, `tel-${convId}.json`))
    if (bySid) return bySid
  }
  if (OWNER_AGY_PID > 1) {
    const byPid = readJsonSafe(join(SESSIONS_DIR, `tel-pid-${OWNER_AGY_PID}.json`))
    if (byPid && (!convId || byPid.session_id === convId)) return byPid
  }
  const globalTel = readJsonSafe(TELEMETRY_FILE)
  if (globalTel && (!convId || globalTel.session_id === convId)) return globalTel
  return null
}

const resolveSessionCwd = explicitCwd => {
  if (typeof explicitCwd === 'string' && explicitCwd.trim() !== '') {
    const p = explicitCwd.startsWith('~/') ? join(HOME, explicitCwd.slice(2)) : explicitCwd === '~' ? HOME : explicitCwd
    if (existsSync(p)) return resolve(p)
  }
  const tracked = readActiveSessionMeta()
  if (typeof tracked.cwd === 'string' && existsSync(tracked.cwd)) {
    return resolve(tracked.cwd)
  }
  if (mcpRoots.length > 0 && existsSync(mcpRoots[0])) {
    return resolve(mcpRoots[0])
  }
  const procCwd = process.cwd()
  if (procCwd && !procCwd.startsWith(PLUGIN_ROOT) && procCwd !== '/') {
    return procCwd
  }
  return HOME
}

const absPath = (cwd, p) => {
  const text = String(p ?? '.')
  if (text === '~') return HOME
  if (text.startsWith('~/')) return join(HOME, text.slice(2))
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text)
}

const shownPath = (cwd, p) => {
  const full = absPath(cwd, p)
  if (full === cwd) return '.'
  if (full.startsWith(`${cwd}/`)) return full.slice(cwd.length + 1)
  return full === HOME || full.startsWith(`${HOME}/`) ? `~${full.slice(HOME.length)}` : full
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'dir', 'directory', 'folder']
const firstKey = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined) return obj[k]
  return undefined
}
const shapeArgs = (primaryKey, args) => {
  const [head, tail] = args
  if (head !== null && typeof head === 'object' && !Array.isArray(head)) return { ...head }
  const options = tail !== null && typeof tail === 'object' && !Array.isArray(tail) ? { ...tail } : {}
  return head === undefined ? options : { ...options, [primaryKey]: head }
}

// --- In-process Pi Extension Hosts (`pi-context-engineer` & `pi-fovea`) ----

let createHostFn = null
let ceExtFactory = null
let ContextStoreCls = null
let buildPreviewFn = null
let fabricSectionNamesFn = null
let foveaExtFactory = null

const ensureHostLoaders = async () => {
  if (!createHostFn && CE_HOST_MODULE) {
    createHostFn = (await importFile(CE_HOST_MODULE))?.createHost ?? null
  }
  if (!ceExtFactory && CE_EXT_ENTRY) {
    ceExtFactory = (await importFile(CE_EXT_ENTRY))?.default ?? null
  }
  if (!ContextStoreCls && CE_STORE_MODULE) {
    ContextStoreCls = (await importFile(CE_STORE_MODULE))?.ContextStore ?? null
  }
  if (!buildPreviewFn && CE_PREVIEW_MODULE) {
    const prevMod = await importFile(CE_PREVIEW_MODULE)
    buildPreviewFn = prevMod?.buildPreview ?? null
    fabricSectionNamesFn = prevMod?.fabricSectionNames ?? null
  }
  if (!foveaExtFactory && FOVEA_EXT_ENTRY) {
    foveaExtFactory = (await importFile(FOVEA_EXT_ENTRY))?.default ?? null
  }
}

const ceHostsByCwd = new Map()
const foveaHostsByCwd = new Map()

const getCeHost = async (cwd, sessionId) => {
  await ensureHostLoaders()
  if (!createHostFn || !ceExtFactory) return null
  const key = `${resolve(cwd)}::${sessionId || 'default'}`
  if (ceHostsByCwd.has(key)) return ceHostsByCwd.get(key)
  const host = createHostFn({ cwd: resolve(cwd), sessionId: sessionId || `agy-${Date.now()}` })
  await host.load(ceExtFactory)
  ceHostsByCwd.set(key, { host, lastTurn: -1 })
  return ceHostsByCwd.get(key)
}

const getFoveaHost = async (cwd, sessionId) => {
  await ensureHostLoaders()
  if (!createHostFn || !foveaExtFactory) return null
  const key = `${resolve(cwd)}::${sessionId || 'default'}`
  if (foveaHostsByCwd.has(key)) return foveaHostsByCwd.get(key)
  const host = createHostFn({ cwd: resolve(cwd), sessionId: sessionId || `agy-${Date.now()}` })
  await host.load(foveaExtFactory)
  foveaHostsByCwd.set(key, host)
  return host
}

// Store a payload in `.pi/context-store` using pi-context-engineer's ContextStore + structural preview.
const offloadToContextStore = async (cwd, rawKey, source, payloadText, previewBytes = 2048) => {
  await ensureHostLoaders()
  if (!ContextStoreCls) return null
  const safeKey = String(rawKey || 'result').replace(/[^a-z0-9-_]/gi, '-').slice(0, 48) || 'result'
  const store = new ContextStoreCls(resolve(cwd), '.pi/context-store')
  const handle = store.write(safeKey, String(source || 'fabric_exec'), payloadText)
  const preview = buildPreviewFn ? buildPreviewFn(payloadText, previewBytes) : { text: clip(payloadText, previewBytes), readFrom: 0 }
  const sections = fabricSectionNamesFn ? fabricSectionNamesFn(payloadText) : null

  let readArgs = `offset: ${preview.readFrom ?? 0}, length: 4096`
  if (sections?.length) {
    readArgs = `section: ${JSON.stringify(sections[0])}`
  } else if (handle.contentType === 'json') {
    let jsonPath = '$'
    try {
      const val = JSON.parse(payloadText)
      jsonPath = Array.isArray(val)
        ? val.length ? '$[0]' : '$'
        : val && typeof val === 'object' && Object.keys(val).length
          ? `$[${JSON.stringify(Object.keys(val)[0])}]`
          : '$'
    } catch {}
    readArgs = `jsonPath: ${JSON.stringify(jsonPath)}`
  }

  const text =
    `[offloaded to handle "${handle.id}" — ${handle.bytes} bytes (~${handle.estimatedTokens} tokens); full result stored; read instead of re-running.]\n` +
    `Read: (await extensions.ctx_read({ id: ${JSON.stringify(handle.id)}, ${readArgs} })).text\n` +
    `Preview (up to ${previewBytes} bytes):\n${preview.text}`

  return { text, handle }
}

const FOVEA_TOOLS = new Set(['fovea_sketch', 'fovea_focus', 'fovea_dwell', 'fovea_impact'])
const CE_TOOLS = new Set(['ctx_read', 'ctx_summarize', 'ctx_offload'])

const callPiExtensionTool = async (cwd, sessionId, name, args) => {
  if (FOVEA_TOOLS.has(name)) {
    const fHost = await getFoveaHost(cwd, sessionId)
    if (!fHost) throw new Error(`extensions.${name}: pi-fovea is not installed. Run \`bun install\` in the agy-fabric plugin directory.`)
    const out = await fHost.ops.tool({ name, params: args ?? {}, isNested: true })
    return {
      text: out.text,
      content: [{ type: 'text', text: out.text }],
      details: out.details ?? {},
      isError: false,
    }
  }
  if (name === 'ctx_offload') {
    const params = record(args)
    const rawData = params.data ?? params.text ?? params.content ?? ''
    const payloadText = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2)
    const stored = await offloadToContextStore(cwd, params.key ?? 'ctx-offload', params.source ?? 'ctx_offload', payloadText)
    if (!stored) throw new Error(`extensions.ctx_offload: ContextStore is unavailable at ${CE_STORE_MODULE}`)
    return {
      text: stored.text,
      content: [{ type: 'text', text: stored.text }],
      details: { result: stored.handle, handle: stored.handle },
      isError: false,
    }
  }
  if (CE_TOOLS.has(name)) {
    const ceEntry = await getCeHost(cwd, sessionId)
    if (!ceEntry) throw new Error(`extensions.${name}: pi-context-engineer is not installed. Run \`bun install\` in the agy-fabric plugin directory.`)
    const out = await ceEntry.host.ops.tool({ name, params: args ?? {}, isNested: true })
    return {
      text: out.text,
      content: [{ type: 'text', text: out.text }],
      details: out.details ?? {},
      isError: false,
    }
  }
  return undefined
}

// --- Compaction (`compact.*` & `memory.expand`) ----------------------------

const computePressure = (cwd, cfg, sessionMeta) => {
  const convId = sessionMeta.conversationId ?? null
  const telemetry = readSessionTelemetry(convId)
  const effectiveConvId = convId ?? telemetry?.session_id ?? null
  let tokens = null
  let contextWindow = 1048576

  if (telemetry) {
    contextWindow = Number(telemetry.context_window_size) || 1048576
    const cur = record(telemetry.current_usage)
    const livePrompt =
      (Number(cur.input_tokens) || 0) +
      (Number(cur.cache_creation_input_tokens) || 0) +
      (Number(cur.cache_read_input_tokens) || 0) +
      (Number(cur.output_tokens) || 0)
    if (livePrompt > 0) {
      tokens = livePrompt
    } else if (Number(telemetry.used_percentage) > 0) {
      tokens = Math.round((Number(telemetry.used_percentage) / 100) * contextWindow)
    } else if (Number(telemetry.total_input_tokens) > 0) {
      tokens = Number(telemetry.total_input_tokens)
    }
  }

  if (tokens === null && (effectiveConvId || sessionMeta.transcriptPath)) {
    const tPath = findTranscriptForConversation(effectiveConvId, sessionMeta.transcriptPath ?? null)
    if (tPath) {
      const { entries } = parseAgyTranscript(tPath)
      if (entries.length > 0) tokens = rawContextTokens(entries)
    }
  }

  if (tokens === null) {
    return {
      tokens: null,
      contextWindow,
      fraction: null,
      headroomTokens: null,
      band: 'unknown',
      outputReserveTokens: cfg.outputReserveTokens,
      targetContextRatio: cfg.targetContextRatio,
      conversationId: effectiveConvId,
      owner: 'fabric',
    }
  }

  const fraction = Number((tokens / contextWindow).toFixed(4))
  const headroomTokens = Math.max(0, contextWindow - tokens)
  let band = 'ok'
  if (
    fraction >= cfg.pressureBands.urgent ||
    (cfg.outputReserveTokens > 0 && headroomTokens < cfg.outputReserveTokens)
  ) {
    band = 'urgent'
  } else if (fraction >= cfg.pressureBands.warn) {
    band = 'warn'
  }

  return {
    tokens,
    contextWindow,
    fraction,
    headroomTokens,
    band,
    outputReserveTokens: cfg.outputReserveTokens,
    targetContextRatio: cfg.targetContextRatio,
    conversationId: effectiveConvId,
    owner: 'fabric',
  }
}

const handleCompactOp = async (cwd, cfg, sessionMeta, { action, options = {} }) => {
  if (action === 'pressure') {
    return computePressure(cwd, cfg, sessionMeta)
  }
  if (action === 'status') {
    return readCompactionStatus(cwd)
  }
  if (action === 'carry') {
    return updateCarryItems(cwd, options)
  }
  if (action === 'cancel') {
    return cancelPendingCompaction(cwd)
  }
  if (action === 'request') {
    const pkt = compileTranscriptCompaction({
      cwd,
      transcriptPath: sessionMeta.transcriptPath ?? null,
      conversationId: sessionMeta.conversationId ?? null,
      instructions: options.instructions ? String(options.instructions) : '',
      preserve: Array.isArray(options.preserve) ? options.preserve : [],
      reason: options.reason ? String(options.reason) : 'programmatic compact.request',
      seed: options.seed ? String(options.seed) : null,
      requestedBy: options.requestedBy ? String(options.requestedBy) : 'model',
      targetContextRatio: cfg.targetContextRatio,
    })
    return {
      staged: true,
      compactor: pkt.compactor,
      sourceTranscriptPath: pkt.sourceTranscriptPath,
      firstKeptEntryId: pkt.firstKeptEntryId,
      counts: pkt.counts,
      omittedCounts: pkt.omittedCounts,
      summaryBytes: pkt.summaryBytes,
      estimatedTokensAfter: pkt.estimatedTokensAfter,
      commitHint:
        'Deterministic compaction staged (0 LLM tokens). Run `/new` in agy or `agy-compact` in terminal to start the fresh compacted window with automatic SessionStart injection.',
    }
  }
  throw new Error(`compact.${action}: unknown action`)
}

// --- Process execution helper ----------------------------------------------

const runSubprocess = (cmd, argv, { cwd, env, timeoutMs = 120000, maxBytes = 4 * 1024 * 1024 } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...process.env, ...env, PATH: FULL_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const outChunks = []
    const errChunks = []
    let outLen = 0
    let errLen = 0
    let timedOut = false

    const killGroup = sig => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {}
      }
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), 1500).unref()
          }, timeoutMs)
        : null

    child.stdout.on('data', chunk => {
      if (outLen < maxBytes) {
        outChunks.push(chunk)
        outLen += chunk.length
      }
    })
    child.stderr.on('data', chunk => {
      if (errLen < maxBytes) {
        errChunks.push(chunk)
        errLen += chunk.length
      }
    })
    child.on('error', err => {
      if (timer) clearTimeout(timer)
      rejectPromise(err)
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        exitCode: code ?? (signal ? 128 : 1),
        signal,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })
    })
  })

// --- Host pi.* implementations ---------------------------------------------

let bgCounter = 0

const execPi = async (cwd, maxTimeoutMs, method, rawArgs) => {
  const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs]

  if (method === 'read') {
    const opts = shapeArgs('path', args)
    const p = firstKey(opts, PATH_KEYS)
    if (p === undefined) throw new Error('pi.read: needs a path')
    const full = absPath(cwd, p)
    if (!existsSync(full)) throw new Error(`pi.read: file not found: ${shownPath(cwd, full)}`)
    const st = statSync(full)
    if (st.isDirectory()) throw new Error(`pi.read: ${shownPath(cwd, full)} is a directory; use pi.ls`)
    const text = readFileSync(full, 'utf8')
    if (opts.offset === undefined && opts.limit === undefined) return text
    const start = Math.max(0, (Number(opts.offset) || 1) - 1)
    const count = Number(opts.limit)
    return text
      .split('\n')
      .slice(start, count > 0 ? start + count : undefined)
      .join('\n')
  }

  if (method === 'write') {
    const opts = typeof args[0] === 'string' ? { path: args[0], content: args[1] } : shapeArgs('path', args)
    const p = firstKey(opts, PATH_KEYS)
    const content = firstKey(opts, ['content', 'text', 'contents', 'data'])
    if (p === undefined || typeof content !== 'string') {
      throw new Error('pi.write: needs a path and a content string')
    }
    const full = absPath(cwd, p)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    return { ok: true, output: `Wrote ${bytes} bytes to ${shownPath(cwd, full)}`, details: { path: full, bytes } }
  }

  if (method === 'edit') {
    const opts =
      typeof args[0] === 'string'
        ? { path: args[0], oldText: args[1], newText: args[2], ...(typeof args[3] === 'object' ? args[3] : {}) }
        : { ...record(args[0]) }
    const p = firstKey(opts, PATH_KEYS)
    if (p === undefined) throw new Error('pi.edit: needs a path')
    const full = absPath(cwd, p)
    if (!existsSync(full)) throw new Error(`pi.edit: file not found: ${shownPath(cwd, full)}`)
    let current = readFileSync(full, 'utf8')
    const parseOne = entry => ({
      old: firstKey(record(entry), ['oldText', 'old_string', 'old', 'from', 'oldString']),
      new: firstKey(record(entry), ['newText', 'new_string', 'new', 'to', 'replacement', 'newString']),
      all: Boolean(record(entry).all ?? record(entry).replace_all ?? opts.all ?? false),
    })
    const edits = Array.isArray(opts.edits) ? opts.edits.map(parseOne) : [parseOne(opts)]
    for (const [idx, ed] of edits.entries()) {
      if (typeof ed.old !== 'string' || typeof ed.new !== 'string') {
        throw new Error(`pi.edit: edit ${idx + 1} of ${edits.length} needs oldText and newText strings`)
      }
      if (ed.old === '') {
        throw new Error(`pi.edit: edit ${idx + 1} of ${edits.length} has empty oldText`)
      }
      const firstIdx = current.indexOf(ed.old)
      if (firstIdx < 0) {
        throw new Error(`pi.edit: edit ${idx + 1} of ${edits.length} (0 written): oldText not found in ${shownPath(cwd, full)}`)
      }
      if (!ed.all && current.indexOf(ed.old, firstIdx + ed.old.length) !== -1) {
        throw new Error(
          `pi.edit: edit ${idx + 1} of ${edits.length} (0 written): oldText matches multiple locations in ${shownPath(cwd, full)}; include more surrounding context or pass all: true`,
        )
      }
      current = ed.all ? current.split(ed.old).join(ed.new) : current.replace(ed.old, () => ed.new)
    }
    writeFileSync(full, current, 'utf8')
    return {
      ok: true,
      output: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${shownPath(cwd, full)}`,
      details: { path: full, applied: edits.length },
    }
  }

  if (method === 'ls') {
    const opts = shapeArgs('path', args)
    const limit = Math.max(1, Number(opts.limit) || 500)
    const where = firstKey(opts, PATH_KEYS)
    const full = absPath(cwd, where)
    if (!existsSync(full)) throw new Error(`pi.ls: path not found: ${shownPath(cwd, full)}`)
    const st = statSync(full)
    if (!st.isDirectory()) return shownPath(cwd, full)
    const entries = readdirSync(full, { withFileTypes: true })
      .map(d => {
        if (d.isDirectory()) return `${d.name}/`
        if (d.isSymbolicLink()) {
          try {
            if (statSync(join(full, d.name)).isDirectory()) return `${d.name}/`
          } catch {}
        }
        return d.name
      })
      .sort()
      .slice(0, limit)
    return entries.join('\n')
  }

  if (method === 'grep') {
    const opts =
      typeof args[0] === 'string'
        ? {
            pattern: args[0],
            ...(typeof args[1] === 'string' ? { path: args[1] } : record(args[1])),
            ...(typeof args[2] === 'number' ? { limit: args[2] } : {}),
          }
        : { ...record(args[0]) }
    const pattern = firstKey(opts, ['pattern', 'query', 'regex', 'search', 'q', 'expression', 'text'])
    if (typeof pattern !== 'string') throw new Error('pi.grep: needs a pattern')
    const where = firstKey(opts, PATH_KEYS)
    const limit = Math.max(1, Number(opts.limit) || 100)
    if (HAS_RG) {
      const rgArgs = ['-n', '--no-heading', '--color=never']
      if (opts.ignoreCase) rgArgs.push('-i')
      if (opts.literal) rgArgs.push('-F')
      if (opts.context) rgArgs.push('-C', String(Math.max(0, Number(opts.context) || 0)))
      if (opts.glob) rgArgs.push('-g', String(opts.glob))
      rgArgs.push('-e', pattern)
      if (where !== undefined) rgArgs.push('--', shownPath(cwd, where) === '.' ? '.' : absPath(cwd, where))
      const ran = await runSubprocess(RG_BIN, rgArgs, { cwd, timeoutMs: 60000 })
      if (ran.timedOut) throw new Error('pi.grep: timed out after 60s')
      if (ran.exitCode === 1 && ran.stderr.trim() === '') return ''
      if (ran.exitCode > 1) throw new Error(`pi.grep: ${ran.stderr.trim() || `rg exited with ${ran.exitCode}`}`)
      const lines = ran.stdout.split('\n')
      if (lines.at(-1) === '') lines.pop()
      return lines
        .slice(0, limit)
        .map(line => (line.startsWith(`${cwd}/`) ? line.slice(cwd.length + 1) : line))
        .join('\n')
    }
    const grepArgs = [
      '-R',
      '-n',
      '-I',
      '--color=never',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '--exclude-dir=.pi',
    ]
    if (opts.ignoreCase) grepArgs.push('-i')
    if (opts.literal) grepArgs.push('-F')
    else grepArgs.push('-E')
    if (opts.context) grepArgs.push('-C', String(Math.max(0, Number(opts.context) || 0)))
    if (opts.glob) grepArgs.push(`--include=${String(opts.glob)}`)
    const target = where !== undefined ? (shownPath(cwd, where) === '.' ? '.' : absPath(cwd, where)) : '.'
    grepArgs.push('-e', pattern, target)
    const ran = await runSubprocess(GREP_BIN, grepArgs, { cwd, timeoutMs: 60000 })
    if (ran.timedOut) throw new Error('pi.grep: timed out after 60s')
    if (ran.exitCode === 1 && ran.stderr.trim() === '') return ''
    if (ran.exitCode > 1) throw new Error(`pi.grep: ${ran.stderr.trim() || `grep exited with ${ran.exitCode}`}`)
    const lines = ran.stdout.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
      .slice(0, limit)
      .map(line => (line.startsWith(`${cwd}/`) ? line.slice(cwd.length + 1) : line.replace(/^\.\//, '')))
      .join('\n')
  }

  if (method === 'find') {
    const opts =
      typeof args[0] === 'string'
        ? {
            pattern: args[0],
            ...(typeof args[1] === 'string' ? { path: args[1] } : record(args[1])),
            ...(typeof args[2] === 'number' ? { limit: args[2] } : {}),
          }
        : { ...record(args[0]) }
    const pattern = firstKey(opts, ['pattern', 'name', 'filename', 'glob', 'include'])
    if (typeof pattern !== 'string') throw new Error('pi.find: needs a glob pattern')
    const limit = Math.max(1, Number(opts.limit) || 200)
    const root = absPath(cwd, firstKey(opts, PATH_KEYS))
    if (!existsSync(root)) throw new Error(`pi.find: directory not found: ${shownPath(cwd, root)}`)
    if (HAS_RG) {
      const ran = await runSubprocess(RG_BIN, ['--files', '--hidden', '-g', '!.git', '-g', pattern], {
        cwd: root,
        timeoutMs: 60000,
      })
      if (ran.timedOut) throw new Error('pi.find: timed out after 60s')
      if (ran.exitCode === 1 && ran.stderr.trim() === '') return ''
      if (ran.exitCode > 1) throw new Error(`pi.find: ${ran.stderr.trim() || `rg exited with ${ran.exitCode}`}`)
      return ran.stdout
        .split('\n')
        .filter(Boolean)
        .sort()
        .slice(0, limit)
        .join('\n')
    }
    const cleanPat = pattern.replace(/^\.\//, '')
    const globExpr = cleanPat.includes('/') ? cleanPat : `**/${cleanPat}`
    const includeNodeModules = cleanPat.includes('node_modules')
    const matches = []
    for (const rel of new Bun.Glob(globExpr).scanSync({ cwd: root, dot: true, onlyFiles: true })) {
      if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) continue
      if (!includeNodeModules && (rel.startsWith('node_modules/') || rel.includes('/node_modules/'))) continue
      matches.push(rel)
    }
    return matches.sort().slice(0, limit).join('\n')
  }

  if (method === 'bash') {
    const opts = shapeArgs('command', args)
    const command = firstKey(opts, ['command', 'cmd', 'script', 'shell', 'commandLine', 'cmdline'])
    if (typeof command !== 'string') throw new Error('pi.bash: needs a command string')
    const cmdCwd = opts.cwd ? absPath(cwd, opts.cwd) : cwd
    const background = Boolean(opts.background ?? opts.run_in_background)
    if (background) {
      const logPath = join(TMP_ROOT, `bg-${Date.now().toString(36)}-${++bgCounter}.log`)
      const outFd = openSync(logPath, 'a')
      const child = spawn(SHELL_BIN, ['-c', command], {
        cwd: cmdCwd,
        env: { ...process.env, PATH: FULL_PATH },
        detached: true,
        stdio: ['ignore', outFd, outFd],
      })
      child.unref()
      closeSync(outFd)
      return {
        ok: true,
        output: `Background process started (pid ${child.pid}, log: ${logPath})`,
        details: { pid: child.pid, logPath },
      }
    }
    const seconds = Number(opts.timeout)
    const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, maxTimeoutMs) : Math.min(120000, maxTimeoutMs)
    const ran = await runSubprocess(SHELL_BIN, ['-c', command], { cwd: cmdCwd, timeoutMs })
    const combined = [ran.stdout, ran.stderr].filter(Boolean).join(ran.stdout && !ran.stdout.endsWith('\n') && ran.stderr ? '\n' : '')
    if (ran.timedOut) {
      const timeoutSec = Math.round(timeoutMs / 1000)
      const errMsg = `pi.bash: timed out after ${timeoutSec}s${combined ? `\n${clip(combined, 3000)}` : ''}`
      if (opts.settle) {
        return {
          ok: false,
          timedOut: true,
          exitCode: null,
          output: combined,
          error: errMsg,
          details: { timedOut: true, timeoutSeconds: timeoutSec },
        }
      }
      throw new Error(errMsg)
    }
    if (ran.exitCode === 0) {
      return { ok: true, output: combined, details: { exitCode: 0 } }
    }
    if (opts.settle) {
      return {
        ok: false,
        timedOut: false,
        exitCode: ran.exitCode,
        output: combined,
        error: combined || `Exit code ${ran.exitCode}`,
        details: null,
      }
    }
    throw new Error(`pi.bash: Exit code ${ran.exitCode}${combined ? `\n${clip(combined, 4000)}` : ''}`)
  }

  throw new Error(`pi.${method}: unknown method`)
}

// --- Skills discovery & loading --------------------------------------------

const parseFrontmatter = md => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const block = m[1]
  const nameMatch = /^name:\s*(.+)$/m.exec(block)
  let desc = ''
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const dm = /^description:\s*(.*)$/.exec(lines[i])
    if (!dm) continue
    const inline = dm[1].trim()
    if (inline && inline !== '>' && inline !== '|-' && inline !== '>-' && inline !== '|') {
      desc = inline.replace(/^['"]|['"]$/g, '')
    } else {
      const collected = []
      for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j++) {
        collected.push(lines[j].trim())
      }
      desc = collected.join(' ')
    }
    break
  }
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : undefined,
    description: desc,
  }
}

const skillSearchRoots = cwd => {
  const pluginRoot = join(HOME, '.gemini', 'config', 'plugins')
  const pluginSkillDirs = existsSync(pluginRoot)
    ? readdirSync(pluginRoot)
        .filter(n => n !== 'fabric')
        .map(n => join(pluginRoot, n, 'skills'))
        .filter(p => existsSync(p))
    : []
  const upstreamTs = resolvePackageFile('pi-fabric', join('skillsets', 'typescript'))
  const foveaSkills = resolvePackageFile('pi-fovea', 'skills')
  const ceSkills = resolvePackageFile('pi-context-engineer', 'skills', CE_EXTRA_ROOTS)
  return [
    { path: join(cwd, '.agents', 'skills'), source: 'workspace' },
    { path: join(cwd, '.agent', 'skills'), source: 'workspace' },
    { path: join(HOME, '.agents', 'skills'), source: 'user' },
    { path: join(HOME, '.gemini', 'config', 'skills'), source: 'global' },
    ...pluginSkillDirs.map(path => ({ path, source: 'plugin' })),
    { path: join(HOME, '.pi', 'agent', 'skills'), source: 'pi' },
    ...(ceSkills && existsSync(ceSkills) ? [{ path: ceSkills, source: 'pi-context-engineer' }] : []),
    ...(foveaSkills && existsSync(foveaSkills) ? [{ path: foveaSkills, source: 'pi-fovea' }] : []),
    ...(upstreamTs && existsSync(upstreamTs) ? [{ path: upstreamTs, source: 'pi-fabric' }] : []),
  ]
}

const discoverSkills = cwd => {
  const seen = new Set()
  const out = []
  for (const { path: root, source } of skillSearchRoots(cwd)) {
    if (!existsSync(root)) continue
    let dirs = []
    try {
      dirs = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of dirs) {
      const skillDir = join(root, entry)
      const mdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(mdPath)) continue
      try {
        const md = readFileSync(mdPath, 'utf8')
        const fm = parseFrontmatter(md)
        const name = fm.name || entry
        if (seen.has(name)) continue
        seen.add(name)
        out.push({ name, description: fm.description || `Skill ${name}`, dir: skillDir, source })
      } catch {}
    }
  }
  return out
}

const loadSkillText = (cwd, rawName) => {
  const bare = String(rawName).replace(/^\//, '')
  const leaf = bare.includes(':') ? bare.slice(bare.lastIndexOf(':') + 1) : bare
  const found = discoverSkills(cwd).find(s => s.name === bare || s.name === leaf || s.dir.endsWith(`/${leaf}`))
  if (!found) {
    const available = discoverSkills(cwd).map(s => s.name)
    throw new Error(`skills.load: unknown skill "${bare}". Available: ${available.join(', ') || 'none'}`)
  }
  const md = readFileSync(join(found.dir, 'SKILL.md'), 'utf8')
  return `<skill name="${found.name}" dir="${found.dir}">\n${md}\n</skill>`
}

// --- Subagents via `agy -p` ------------------------------------------------

let activeSubagents = 0
const subagentQueue = []

const withSubagentSlot = async (maxConcurrent, fn) => {
  if (activeSubagents >= maxConcurrent) {
    await new Promise(r => subagentQueue.push(r))
  }
  activeSubagents += 1
  try {
    return await fn()
  } finally {
    activeSubagents -= 1
    const next = subagentQueue.shift()
    if (next) next()
  }
}

const runAgySubagent = async (cwd, fabricCfg, req) => {
  const currentDepth = Number(process.env.FABRIC_SUBAGENT_DEPTH || 0)
  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(`agents.run: max recursion depth (${MAX_SUBAGENT_DEPTH}) reached`)
  }
  const promptText = String(req.prompt ?? req.task ?? '').trim()
  if (!promptText) throw new Error('agents.run: needs a prompt string')

  const rawModel = req.model ? String(req.model).trim() : fabricCfg.defaultSubagentModel || ''
  const aliases = fabricCfg.modelAliases || {}
  const model = rawModel ? String(aliases[rawModel.toLowerCase()] ?? rawModel).trim() : ''
  const effort = req.effort ? String(req.effort).trim().toLowerCase() : ''
  const agentOpt = req.agent !== undefined ? req.agent : req.type === 'default' ? 'default' : 'fabric'
  const isReadOnly = req.readOnly === true || req.type === 'research' || req.subagent_type === 'research'
  const finalPrompt = isReadOnly
    ? `[Read-only research subagent: inspect files, search, and return a clear concise synthesis. Do NOT modify or write files.]\n\n${promptText}`
    : promptText

  const cliSettings = readJsonSafe(join(HOME, '.gemini', 'antigravity-cli', 'settings.json')) ?? {}
  const skipPerms = cliSettings.toolPermission === 'always-proceed'

  const argv = []
  if (model && model.toLowerCase() !== 'default' && model.toLowerCase() !== 'auto') {
    argv.push(`--model=${model}`)
  }
  if (agentOpt && agentOpt !== 'default') {
    argv.push(`--agent=${String(agentOpt)}`)
  }
  if (effort) {
    argv.push(`--effort=${effort}`)
  }
  if (skipPerms) {
    argv.push('--dangerously-skip-permissions')
  } else {
    argv.push('--mode=auto')
  }
  argv.push(`--prompt=${finalPrompt}`)

  const subCwd = req.cwd ? absPath(cwd, req.cwd) : cwd
  const timeoutMs =
    typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? Math.min(req.timeoutMs, 600000) : Math.min(300000, fabricCfg.timeoutMs)

  const cleanEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTIGRAVITY_') || k.startsWith('ORCA_')) continue
    cleanEnv[k] = v
  }
  cleanEnv.FABRIC_SUBAGENT_DEPTH = String(currentDepth + 1)

  return withSubagentSlot(fabricCfg.maxConcurrentAgents, async () => {
    const ran = await runSubprocess(AGY_BIN, argv, { cwd: subCwd, env: cleanEnv, timeoutMs })
    if (ran.timedOut) {
      if (req.settle) return { ok: false, output: ran.stdout, error: `agents.run timed out after ${Math.round(timeoutMs / 1000)}s` }
      throw new Error(`agents.run: timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    if (ran.exitCode !== 0 && !ran.stdout.trim()) {
      if (req.settle) return { ok: false, output: '', error: ran.stderr.trim() || `agy exited with ${ran.exitCode}` }
      throw new Error(`agents.run: ${ran.stderr.trim() || `agy exited with ${ran.exitCode}`}`)
    }
    const text = ran.stdout.trim()
    return req.settle ? { ok: true, output: text, details: { model: model || 'default' } } : text
  })
}

// --- External MCP client bridge (mcp.<server>.<tool>) ----------------------

const discoverMcpConfigs = () => {
  const servers = {}
  const pluginRoot = join(HOME, '.gemini', 'config', 'plugins')
  const configJson = readJsonSafe(join(HOME, '.gemini', 'config', 'config.json'))
  const pluginStates = record(configJson?.plugins)

  if (existsSync(pluginRoot)) {
    for (const dirName of readdirSync(pluginRoot)) {
      if (dirName === 'fabric') continue
      const pJson = readJsonSafe(join(pluginRoot, dirName, 'plugin.json'))
      const explicitState = pluginStates[dirName]?.enabled
      const enabled = explicitState !== undefined ? explicitState : pJson?.disabled !== true
      if (!enabled) continue
      const mcpCfg = readJsonSafe(join(pluginRoot, dirName, 'mcp_config.json'))
      if (mcpCfg?.mcpServers) Object.assign(servers, record(mcpCfg.mcpServers))
    }
  }
  for (const cfgPath of [
    join(HOME, '.gemini', 'config', 'mcp_config.json'),
    join(HOME, '.pi', 'fabric', 'mcp.json'),
  ]) {
    const mcpCfg = readJsonSafe(cfgPath)
    if (mcpCfg?.mcpServers) {
      for (const [name, spec] of Object.entries(record(mcpCfg.mcpServers))) {
        if (name !== 'fabric' && spec && !spec.disabled) servers[name] = spec
      }
    }
  }
  return servers
}

const mcpClients = new Map()

const connectStdioMcp = async (serverName, spec) => {
  const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    cwd: spec.cwd || HOME,
    env: { ...process.env, ...record(spec.env), PATH: FULL_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextReqId = 1
  const pending = new Map()
  let buf = ''

  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
          else res(msg.result)
        }
      } catch {}
    }
  })
  const close = () => {
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill('SIGTERM')
    } catch {}
  }

  child.on('error', err => {
    mcpClients.delete(serverName)
    for (const { reject: rej } of pending.values()) rej(err)
    pending.clear()
  })

  child.on('close', () => {
    mcpClients.delete(serverName)
    for (const { reject: rej } of pending.values()) rej(new Error(`MCP server "${serverName}" closed`))
    pending.clear()
  })

  const rpc = (method, params = {}, timeoutMs = 30000) =>
    new Promise((res, rej) => {
      const id = nextReqId++
      const t = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`MCP ${serverName}.${method} timed out`))
      }, timeoutMs)
      pending.set(id, {
        resolve: v => {
          clearTimeout(t)
          res(v)
        },
        reject: e => {
          clearTimeout(t)
          rej(e)
        },
      })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        clearTimeout(t)
        pending.delete(id)
        rej(err)
      }
    })

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agy-fabric', version: PLUGIN_VERSION },
    })
  } catch (err) {
    close()
    throw err
  }
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  } catch {}
  const listed = await rpc('tools/list', {}).catch(() => ({ tools: [] }))
  return { rpc, tools: Array.isArray(listed?.tools) ? listed.tools : [], close }
}

const connectHttpMcp = async (serverName, spec) => {
  const endpoint = spec.url || spec.serverUrl
  let sessionId = null
  let nextReqId = 1

  const rpc = async (method, params = {}, timeoutMs = 30000) => {
    const id = nextReqId++
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...record(spec.headers),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const sid = resp.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const ct = resp.headers.get('content-type') || ''
    const raw = await resp.text()
    let msg
    if (ct.includes('text/event-stream')) {
      const dataLine = raw
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
        .find(Boolean)
      msg = dataLine ? JSON.parse(dataLine) : {}
    } else {
      msg = JSON.parse(raw)
    }
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error))
    return msg.result
  }
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agy-fabric', version: PLUGIN_VERSION },
  }).catch(() => undefined)
  const listed = await rpc('tools/list', {}).catch(() => ({ tools: [] }))
  return { rpc, tools: Array.isArray(listed?.tools) ? listed.tools : [], close: () => {} }
}

const getMcpClient = async serverName => {
  if (mcpClients.has(serverName)) return mcpClients.get(serverName)
  const servers = discoverMcpConfigs()
  const spec = servers[serverName]
  if (!spec) {
    const known = Object.keys(servers)
    throw new Error(`mcp.${serverName}: server not configured. Configured servers: ${known.join(', ') || 'none'}`)
  }
  const client = spec.command ? await connectStdioMcp(serverName, spec) : await connectHttpMcp(serverName, spec)
  mcpClients.set(serverName, client)
  return client
}

const callExternalMcp = async ({ server, tool, args, settle }) => {
  try {
    const client = await getMcpClient(server)
    const res = await client.rpc('tools/call', { name: tool, arguments: args ?? {} }, 120000)
    const blocks = Array.isArray(res?.content) ? res.content : []
    const text = blocks.map(b => (typeof b?.text === 'string' ? b.text : JSON.stringify(b))).join('\n')
    if (res?.isError) {
      if (settle) return { ok: false, text, result: res }
      throw new Error(`mcp.${server}.${tool}: ${text || 'tool returned error'}`)
    }
    return settle ? { ok: true, text, result: res } : { text, result: res }
  } catch (err) {
    if (settle) return { ok: false, text: err.message, result: null }
    throw err
  }
}

// --- Catalog & tools.* inspection ------------------------------------------

const BUILTIN_CATALOG = [
  { ref: 'pi.read', kind: 'core', description: 'Read UTF-8 file text: (path, {offset?, limit?}) -> string' },
  { ref: 'pi.bash', kind: 'core', description: 'Run shell command: (command, {timeout? seconds, cwd?, settle?, background?}) -> {ok, output, details}' },
  { ref: 'pi.grep', kind: 'core', description: 'Search contents via ripgrep: (pattern, path?, limit?) or {pattern, path?, glob?, ignoreCase?, literal?, context?, limit?} -> string' },
  { ref: 'pi.find', kind: 'core', description: 'Find files matching glob: (pattern, path?, limit?) -> string' },
  { ref: 'pi.ls', kind: 'core', description: 'List directory entries: (path?, {limit?}) -> string' },
  { ref: 'pi.edit', kind: 'core', description: 'Exact replacements: {path, edits:[{oldText, newText, all?}]} or (path, oldText, newText) -> {ok, output, details}' },
  { ref: 'pi.write', kind: 'core', description: 'Create or overwrite file: (path, content) -> {ok, output, details}' },
  { ref: 'extensions.fovea_sketch', kind: 'extension', description: 'Pi Fovea heat-ranked repository overview: ({maxTokens?, root?}) -> {text, details}' },
  { ref: 'extensions.fovea_focus', kind: 'extension', description: 'Pi Fovea graph focus on symbol/path/route: ({query, fresh?, maxTokens?, root?}) -> {text, details}' },
  { ref: 'extensions.fovea_dwell', kind: 'extension', description: 'Pi Fovea deepen active focus neighborhood: ({maxTokens?, root?}) -> {text, details}' },
  { ref: 'extensions.fovea_impact', kind: 'extension', description: 'Pi Fovea caller/dependent blast-radius analysis: ({files?, base?, maxTokens?, root?}) -> {text, details}' },
  { ref: 'extensions.ctx_read', kind: 'extension', description: 'Context Engineer read handle by byte range (offset/length), query, section, or jsonPath: ({id, ...}) -> {text, details}' },
  { ref: 'extensions.ctx_summarize', kind: 'extension', description: 'Context Engineer deterministic structural or code summary: ({id?, text?, mode?, maxTokens?}) -> {text, details}' },
  { ref: 'extensions.ctx_offload', kind: 'extension', description: 'Context Engineer store large payload into .pi/context-store and return handle: ({key, source?, data}) -> {text, details}' },
  { ref: 'compact.pressure', kind: 'compact', description: 'Read context window pressure and band (ok | warn | urgent)' },
  { ref: 'compact.carry', kind: 'compact', description: 'Read or update persistent [Carry Forward] focus items across compactions: ({add?, remove?, clear?, items?})' },
  { ref: 'compact.request', kind: 'compact', description: 'Compile and stage deterministic LLM-free Fabric compaction from transcript_full.jsonl: ({reason?, instructions?, preserve?, seed?})' },
  { ref: 'compact.status', kind: 'compact', description: 'Inspect pending and last committed deterministic compactions' },
  { ref: 'memory.expand', kind: 'memory', description: 'Lossless exact recall from current or compacted transcript_full.jsonl: ({entryId?, stepIndex?, fromStep?, toStep?, query?, limit?, source?})' },
  { ref: 'agents.run', kind: 'agent', description: 'Run an agy subagent (inherits active agy model or configured default): ({prompt, model?, effort?, agent?, readOnly?, cwd?, timeoutMs?}) -> string' },
]

const buildCatalog = async (cwd, includeMcpTools = false) => {
  const skills = discoverSkills(cwd).map(s => ({
    ref: `skills.${s.name}`,
    kind: 'skill',
    description: s.description,
  }))
  const mcpEntries = []
  const servers = discoverMcpConfigs()
  for (const serverName of Object.keys(servers)) {
    if (includeMcpTools) {
      try {
        const client = await getMcpClient(serverName)
        for (const t of client.tools) {
          mcpEntries.push({
            ref: `mcp.${serverName}.${t.name}`,
            kind: 'mcp',
            description: String(t.description || ''),
            inputSchema: t.inputSchema,
          })
        }
        continue
      } catch {}
    }
    mcpEntries.push({
      ref: `mcp.${serverName}.*`,
      kind: 'mcp',
      description: `Configured MCP server "${serverName}"`,
    })
  }
  return [...BUILTIN_CATALOG, ...mcpEntries, ...skills]
}

const handleToolsOp = async (cwd, sessionId, { action, options = {} }) => {
  const needMcp = !options?.kind || options.kind === 'mcp' || action === 'describe' || action === 'search'
  const cat = await buildCatalog(cwd, needMcp)
  if (action === 'list') {
    return cat
      .filter(e => !options.kind || e.kind === options.kind)
      .map(({ ref, kind }) => ({ ref, kind }))
  }
  if (action === 'search') {
    const q = String(options.query ?? '').toLowerCase()
    const terms = q.split(/[^a-z0-9_]+/).filter(Boolean)
    const limit = Math.max(1, Number(options.limit) || 12)
    return cat
      .map(entry => {
        const hay = `${entry.ref} ${entry.description}`.toLowerCase()
        const score = terms.reduce((s, t) => s + (entry.ref.toLowerCase().includes(t) ? 3 : hay.includes(t) ? 1 : 0), 0)
        return { entry, score }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => ({ ref: entry.ref, kind: entry.kind, description: entry.description.slice(0, 300) }))
  }
  if (action === 'describe') {
    const ref = String(options.ref ?? '')
    if (ref.startsWith('extensions.')) {
      const extName = ref.slice('extensions.'.length)
      if (FOVEA_TOOLS.has(extName)) {
        const fHost = await getFoveaHost(cwd, sessionId)
        const hello = fHost ? await fHost.ops.hello() : null
        const t = hello?.tools?.find(x => x.name === extName)
        if (t) return { ref, kind: 'extension', description: t.description, inputSchema: t.parameters }
      }
      if (extName === 'ctx_offload') {
        const entry = BUILTIN_CATALOG.find(x => x.ref === ref)
        return {
          ref,
          kind: 'extension',
          description: entry?.description ?? 'Store large payload into .pi/context-store',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              source: { type: 'string' },
              data: { type: 'string' },
            },
            required: ['data'],
          },
        }
      }
      if (CE_TOOLS.has(extName)) {
        const ceEntry = await getCeHost(cwd, sessionId)
        const hello = ceEntry ? await ceEntry.host.ops.hello() : null
        const t = hello?.tools?.find(x => x.name === extName)
        if (t) return { ref, kind: 'extension', description: t.description, inputSchema: t.parameters }
      }
    }
    const entry = cat.find(e => e.ref === ref)
    if (!entry) throw new Error(`tools.describe: unknown ref "${ref}"`)
    return {
      ref: entry.ref,
      kind: entry.kind,
      description: entry.description,
      ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
    }
  }
  throw new Error(`tools.${action}: unknown action`)
}

// --- Warm Sandboxed Bun Worker Pool ----------------------------------------

let idleWorker = null

const spawnWarmWorker = initialCwd => {
  const kernelArgs = [
    ...(HAS_SANDBOX ? [SANDBOX_EXEC, '-p', SANDBOX_PROFILE] : []),
    '/usr/bin/env',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
    BUN_BIN,
    join(SERVER_DIR, 'kernel.mjs'),
    '--worker',
  ]
  const child = spawn(kernelArgs[0], kernelArgs.slice(1), {
    cwd: initialCwd && existsSync(initialCwd) ? initialCwd : HOME,
    env: { ...process.env, PATH: FULL_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let readyResolve
  const readyPromise = new Promise(r => {
    readyResolve = r
  })

  const worker = {
    child,
    alive: true,
    ready: readyPromise,
    stderr: '',
    activeRun: null,
    destroy(sig = 'SIGTERM') {
      if (!worker.alive) return
      worker.alive = false
      if (idleWorker === worker) idleWorker = null
      try {
        child.stdin.end()
      } catch {}
      try {
        child.kill(sig)
      } catch {}
    },
    send(msg) {
      if (!worker.alive) throw new Error('the kernel worker is closed')
      child.stdin.write(MARK + JSON.stringify(msg) + '\n')
    },
  }

  let outBuf = ''
  child.stdout.on('data', chunk => {
    outBuf += chunk.toString('utf8')
    let cut
    while ((cut = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, cut).replace(/\r$/, '')
      outBuf = outBuf.slice(cut + 1)
      if (!line.startsWith(MARK)) {
        if (line.trim() !== '' && worker.activeRun) worker.activeRun.onStray(line)
        continue
      }
      try {
        const msg = JSON.parse(line.slice(MARK.length))
        if (msg.t === 'ready') {
          readyResolve(true)
        } else if (worker.activeRun) {
          worker.activeRun.onMessage(msg)
        }
      } catch {}
    }
  })

  child.stderr.on('data', chunk => {
    worker.stderr = (worker.stderr + chunk.toString('utf8')).slice(-4000)
  })

  child.on('error', err => {
    worker.alive = false
    readyResolve(false)
    if (idleWorker === worker) idleWorker = null
    if (worker.activeRun) worker.activeRun.onExit(`the kernel could not run: ${err.message}`)
  })

  child.on('close', (code, sig) => {
    worker.alive = false
    readyResolve(false)
    if (idleWorker === worker) idleWorker = null
    if (worker.activeRun) {
      worker.activeRun.onExit(`the kernel exited with ${sig ?? `code ${code ?? 1}`}`)
    }
  })

  return worker
}

const ensurePrewarmedWorker = cwd => {
  if (!idleWorker || !idleWorker.alive) {
    idleWorker = spawnWarmWorker(cwd)
  }
}

const acquireWorker = async cwd => {
  let w = null
  if (idleWorker && idleWorker.alive) {
    w = idleWorker
    idleWorker = null
  } else {
    w = spawnWarmWorker(cwd)
  }
  const ok = await w.ready
  if (!ok || !w.alive) {
    w.destroy()
    w = spawnWarmWorker(cwd)
    await w.ready
  }
  return w
}

const releaseWorker = (worker, cwd) => {
  if (!worker || !worker.alive) {
    ensurePrewarmedWorker(cwd)
    return
  }
  worker.stderr = ''
  worker.activeRun = null
  if (!idleWorker || !idleWorker.alive) {
    idleWorker = worker
  } else {
    worker.destroy()
  }
}

// --- Program execution (`fabric_exec`) -------------------------------------

let runCounter = 0

const parsePayloads = value => {
  let source = value
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      source = {}
    }
  }
  return Object.fromEntries(
    Object.entries(record(source)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  )
}

const PROGRAM_HEADER_LINES = 3
const wrapProgramSource = code =>
  `export default async function (__fabric_env) {\n` +
  `const { pi, agy, cc, mcp, extensions, fovea, ce, compact, memory, tools, skills, agents, state, clip, print, console, π, payloads } = __fabric_env;\n` +
  `{\n${code}\n}\n` +
  `}\n`

const executeFabricProgram = async rawInput => {
  const input = record(rawInput)
  const code = String(input.code ?? '')
  if (!code.trim()) {
    return { text: 'fabric_exec error: `code` must be a non-empty TypeScript function body.', isError: true }
  }

  const sessionMeta = readActiveSessionMeta()
  const sessionId = sessionMeta.conversationId || 'agy-session'
  const cwd = resolveSessionCwd(input.cwd)
  const stateDir = workspaceStateDir(cwd)
  const cfg = loadFabricConfig(cwd)
  const reqTimeout = Number(input.timeoutMs ?? input.timeout_ms)
  const timeoutMs = Number.isFinite(reqTimeout) && reqTimeout > 0 ? Math.min(reqTimeout, 600000) : cfg.timeoutMs
  const reqTokens = Number(input.maxOutputTokens ?? input.max_output_tokens)
  const isBudgetSet = Number.isFinite(reqTokens) && reqTokens > 0
  const budgetChars = isBudgetSet
    ? Math.min(reqTokens * 4, HARD_AGY_MCP_INLINE_CAP_BYTES)
    : cfg.inlineMaxBytes
  const resultFormat = String(input.resultFormat ?? 'json')

  // Sync turn boundary with Context Engineer if turnIndex advanced
  const ceEntry = await getCeHost(cwd, sessionId).catch(() => null)
  if (ceEntry && typeof sessionMeta.turnIndex === 'number' && sessionMeta.turnIndex !== ceEntry.lastTurn) {
    ceEntry.lastTurn = sessionMeta.turnIndex
    await ceEntry.host.ops.turn({ index: sessionMeta.turnIndex }).catch(() => undefined)
  }

  const id = `${Date.now().toString(36)}-${++runCounter}`
  const dir = join(TMP_ROOT, `run-${id}`)
  mkdirSync(dir, { recursive: true })
  const programPath = join(dir, 'program.ts')
  writeFileSync(programPath, wrapProgramSource(code), 'utf8')

  const skillsList = discoverSkills(cwd).map(({ name, description, source }) => ({ name, description, source }))
  const worker = await acquireWorker(cwd)

  const runHandle = runTracker.startRun({ id, cwd, code, display: record(input.display) })
  const served = []
  const pending = new Set()
  const stray = []
  let done = undefined
  let stopped = undefined
  let exitReason = 'the kernel exited without a result'

  const dispatchHostCall = async (op, args) => {
    if (op === 'pi') return execPi(cwd, timeoutMs, args.method, args.args)
    if (op === 'skill') return loadSkillText(cwd, args.name)
    if (op === 'agent') return runAgySubagent(cwd, cfg, record(args))
    if (op === 'mcp') return callExternalMcp(record(args))
    if (op === 'tools') return handleToolsOp(cwd, sessionId, record(args))
    if (op === 'compact') return handleCompactOp(cwd, cfg, sessionMeta, record(args))
    if (op === 'memory') return expandTranscriptMemory(cwd, record(args?.options), sessionMeta)
    if (op === 'ce_cmd') {
      if (!ceEntry) throw new Error('pi-context-engineer is unavailable')
      return ceEntry.host.ops.command({ name: 'ce', args: String(args?.args ?? 'status') })
    }
    if (op === 'extension') {
      const extOut = await callPiExtensionTool(cwd, sessionId, String(args.name), args.args)
      if (extOut !== undefined) return extOut
      const servers = Object.keys(discoverMcpConfigs())
      for (const s of servers) {
        const client = await getMcpClient(s).catch(() => null)
        if (client?.tools?.some(t => t.name === args.name)) {
          return callExternalMcp({ server: s, tool: args.name, args: args.args, settle: false })
        }
      }
      throw new Error(`extensions.${args.name}: unknown extension tool`)
    }
    if (op === 'state') {
      const safe = String(args.key).replace(/[^\w.-]/g, '_').slice(0, 80)
      const p = join(stateDir, `${safe}.json`)
      if (args.action === 'set') {
        writeFileSync(p, JSON.stringify(args.value ?? null), 'utf8')
        return null
      }
      if (args.action === 'delete') {
        if (existsSync(p)) unlinkSync(p)
        return null
      }
      return null
    }
    throw new Error(`Unknown host op: ${op}`)
  }

  const serve = async call => {
    const ref =
      call.op === 'pi'
        ? `pi.${call.args?.method}`
        : call.op === 'extension'
          ? `extensions.${call.args?.name}`
          : call.op === 'mcp'
            ? `mcp.${call.args?.server}.${call.args?.tool}`
            : call.op === 'compact'
              ? `compact.${call.args?.action}`
              : call.op
    const callEntry = runTracker.startCall(runHandle, call.op, call.args, cwd)
    let answer
    try {
      const value = await dispatchHostCall(call.op, call.args)
      answer = { ok: true, value: value === undefined ? null : value }
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    runTracker.finishCall(runHandle, callEntry, answer.ok)
    if (call.op !== 'state') served.push({ ref, isOk: answer.ok })
    try {
      if (worker.alive) worker.send({ t: 'res', id: call.id, answer })
    } catch {}
  }

  await new Promise(resolveRun => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolveRun()
    }

    const timer = setTimeout(() => {
      stopped ??= `timed out after ${timeoutMs} ms`
      worker.destroy('SIGTERM')
      finish()
    }, timeoutMs)

    worker.activeRun = {
      onStray: line => stray.push(line),
      onMessage: msg => {
        if (msg.t === 'done' && msg.runId === id) {
          done = msg
          clearTimeout(timer)
          finish()
          return
        }
        if (msg.t === 'call') {
          const job = serve(msg).catch(() => undefined)
          pending.add(job)
          job.finally(() => pending.delete(job))
        }
      },
      onExit: reason => {
        exitReason = reason
        clearTimeout(timer)
        finish()
      },
    }

    try {
      worker.send({
        t: 'run',
        runId: id,
        programPath,
        cwd,
        payloads: parsePayloads(input.payloads ?? input.strings),
        skills: skillsList,
        agents: [{ name: 'fabric', ...(cfg.defaultSubagentModel ? { defaultModel: cfg.defaultSubagentModel } : {}) }],
        stateDir,
        headerLines: PROGRAM_HEADER_LINES,
      })
    } catch (err) {
      exitReason = `the kernel could not run: ${err instanceof Error ? err.message : String(err)}`
      clearTimeout(timer)
      worker.destroy()
      finish()
    }
  })

  const workerStderr = worker.stderr
  if (stopped === undefined && done !== undefined && worker.alive) {
    releaseWorker(worker, cwd)
  } else {
    worker.destroy()
    ensurePrewarmedWorker(cwd)
  }

  await Promise.allSettled([...pending])
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}

  const logs = [...(done?.logs ?? []), ...stray]
  const allLogs = logs.join('\n')
  const allPrinted = logs.length > 0 ? `\n--- print ---\n${allLogs}` : ''
  const indent = resultFormat === 'text' ? 0 : 2
  const isOk = stopped === undefined && done?.ok === true

  let failure = ''
  let before = ''
  if (!isOk) {
    failure = stopped ?? done?.error ?? `${exitReason}${workerStderr.trim() ? `\n${workerStderr.trim()}` : ''}`
    before =
      served.length === 0
        ? 'No host call had run.'
        : `Host calls already made (${served.length}, effects stand): ${served.map(s => `${s.ref}${s.isOk ? '' : ' (failed)'}`).join(', ')}.`
  }

  const wholeValue = isOk && done?.hasValue ? textOf(done.value, indent) : ''
  const whole = isOk
    ? `${wholeValue}${wholeValue === '' ? allPrinted.trimStart() : allPrinted}` || '(the program returned nothing)'
    : `fabric_exec error: ${failure}\n${before}${allPrinted}`

  runTracker.finishRun(runHandle, { ok: isOk, error: isOk ? null : failure, preview: isOk ? wholeValue.slice(0, 120) : '' })
  const wholeBytes = Buffer.byteLength(whole, 'utf8')

  // 1. Hand whole result to pi-context-engineer (handles >=16 KB offloads, >=4 KB error compaction, turn budgets)
  if (ceEntry) {
    const ceInput = {
      code,
      ...(isBudgetSet ? { maxOutputTokens: Math.floor(budgetChars / 4) } : {}),
    }
    const controlled = await ceEntry.host.ops
      .result({
        toolCallId: `fabric-${id}`,
        input: ceInput,
        isError: !isOk,
        text: whole,
      })
      .catch(() => null)
    if (controlled && typeof controlled.text === 'string' && controlled.text.trim() !== '') {
      return { text: controlled.text, isError: !isOk }
    }
    // 2. Eliminate Antigravity's 10-16 KB `steps/<N>/output.txt` dead zone:
    //    if CE kept a medium result inline (>8.5 KB), store it in `.pi/context-store` with a preview + handle.
    if (isOk && wholeBytes > budgetChars) {
      const hint = String(input.display?.name || code).slice(0, 36)
      const offloaded = await offloadToContextStore(cwd, `fabric-exec-${hint}`, 'fabric_exec', whole).catch(() => null)
      if (offloaded) {
        return { text: offloaded.text, isError: false }
      }
    }
    if (wholeBytes <= budgetChars || (!isOk && wholeBytes <= HARD_AGY_MCP_INLINE_CAP_BYTES)) {
      return { text: whole, isError: !isOk }
    }
  } else if (isOk && wholeBytes > budgetChars) {
    const hint = String(input.display?.name || code).slice(0, 36)
    const offloaded = await offloadToContextStore(cwd, `fabric-exec-${hint}`, 'fabric_exec', whole).catch(() => null)
    if (offloaded) {
      return { text: offloaded.text, isError: false }
    }
  }

  // 3. Fallback structural fitting if ContextStore is unavailable
  const shownLogs = clip(allLogs, Math.max(1000, Math.floor(budgetChars / 4)))
  const printed = logs.length > 0 ? `\n--- print ---\n${shownLogs}` : ''
  if (!isOk) {
    return { text: clip(`fabric_exec error: ${failure}\n${before}${printed}`, HARD_AGY_MCP_INLINE_CAP_BYTES), isError: true }
  }
  const spillPath = join(SPILL_DIR, `${id}.txt`)
  let isSpilled = false
  const fitted = done?.hasValue
    ? fit(done.value, Math.max(1000, budgetChars - printed.length), indent)
    : { text: '', full: '', isClipped: false }
  if (fitted.isClipped || shownLogs !== allLogs) {
    isSpilled = true
    writeFileSync(spillPath, whole, 'utf8')
  }
  let text = `${fitted.text}${fitted.text === '' ? printed.trimStart() : printed}` || '(the program returned nothing)'
  if (Buffer.byteLength(text, 'utf8') > HARD_AGY_MCP_INLINE_CAP_BYTES) {
    if (!isSpilled) writeFileSync(spillPath, whole, 'utf8')
    isSpilled = true
    text = clip(text, budgetChars)
  }
  if (isSpilled) {
    text += `\n[fabric: clipped to ~${Math.round(budgetChars / 4)} tokens; full output saved at ${spillPath}]`
  }
  return { text, isError: false }
}

// --- MCP Tool Schema -------------------------------------------------------

const FABRIC_TOOL_SPEC = {
  name: 'fabric_exec',
  description:
    'Execute one sandboxed TypeScript program (`await` + `return` at top level) composing: `pi.*` (read, write, edit, grep, find, ls, bash), `extensions.fovea_*` (fovea_sketch, fovea_focus, fovea_dwell, fovea_impact), `extensions.ctx_*` (Context Engineer ctx_read, ctx_summarize, ctx_offload), `compact.*` & `memory.expand` (deterministic LLM-free compaction & lossless transcript recall), `mcp.<server>.<tool>(args)`, `skills.list/load`, `state.get/set`, and `agents.run` (`agy` subagents). Outputs >8.5 KB automatically offload to `.pi/context-store` with a handle + structural outline.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'Async TypeScript function body. Globals: `pi`, `extensions` (`fovea_*`, `ctx_*`), `fovea`, `ce`, `compact`, `memory`, `mcp`, `tools`, `skills`, `agents`, `state`, `clip`, `print`, `π`. Return one compact JSON-serializable value or string.',
      },
      display: {
        type: 'object',
        description: 'Short title and intent description of this program (also preserved by deterministic compaction).',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
      },
      payloads: {
        type: 'object',
        description: 'Named string literals exposed as `π.<key>` inside `code` (for large file bodies or quote-heavy text).',
        additionalProperties: { type: 'string' },
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override (defaults automatically to the active workspace directory).',
      },
      resultFormat: {
        type: 'string',
        enum: ['json', 'text'],
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional program deadline in ms (up to 600000).',
      },
      maxOutputTokens: {
        type: 'number',
        description:
          'Optional inline token budget for this call (up to ~2375 tokens / 9.5 KB inline before Context Engineer handle offload).',
      },
    },
    required: ['code'],
  },
}

// --- JSON-RPC 2.0 Stdio Server Loop ----------------------------------------

let serverReqId = 1000
const serverPending = new Map()

const sendJson = obj => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const requestClient = (method, params = {}) =>
  new Promise(res => {
    const id = ++serverReqId
    const t = setTimeout(() => {
      serverPending.delete(id)
      res(null)
    }, 3000)
    serverPending.set(id, result => {
      clearTimeout(t)
      res(result)
    })
    sendJson({ jsonrpc: '2.0', id, method, params })
  })

const refreshRoots = async () => {
  const res = await requestClient('roots/list', {})
  if (Array.isArray(res?.roots)) {
    mcpRoots = res.roots
      .map(r => r?.uri)
      .filter(u => typeof u === 'string' && u.startsWith('file://'))
      .map(u => {
        try {
          return fileURLToPath(u)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
}

let clientSupportsRoots = false

const shutdownAll = async () => {
  if (idleWorker) idleWorker.destroy()
  for (const client of mcpClients.values()) {
    try {
      client.close?.()
    } catch {}
  }
  mcpClients.clear()
  const jobs = []
  for (const { host } of ceHostsByCwd.values()) jobs.push(host.ops.shutdown().catch(() => undefined))
  for (const host of foveaHostsByCwd.values()) jobs.push(host.ops.shutdown().catch(() => undefined))
  await Promise.allSettled(jobs)
}

process.once('SIGTERM', () => void shutdownAll().finally(() => process.exit(0)))
process.once('SIGINT', () => void shutdownAll().finally(() => process.exit(130)))

const handleRpcMessage = async msg => {
  if (!msg || typeof msg !== 'object') return

  if (msg.id !== undefined && msg.method === undefined && serverPending.has(msg.id)) {
    const done = serverPending.get(msg.id)
    serverPending.delete(msg.id)
    done(msg.result ?? null)
    return
  }

  if (msg.id === undefined) {
    if (msg.method === 'notifications/initialized' && clientSupportsRoots) {
      void refreshRoots()
    } else if (msg.method === 'notifications/roots/list_changed') {
      void refreshRoots()
    }
    return
  }

  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      clientSupportsRoots = Boolean(params?.capabilities?.roots)
      ensurePrewarmedWorker(resolveSessionCwd())
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fabric', version: PLUGIN_VERSION },
        },
      })
      return
    }
    if (method === 'ping') {
      sendJson({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'tools/list') {
      sendJson({ jsonrpc: '2.0', id, result: { tools: [FABRIC_TOOL_SPEC] } })
      return
    }
    if (method === 'tools/call') {
      if (params?.name !== 'fabric_exec') {
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }],
            isError: true,
          },
        })
        return
      }
      const out = await executeFabricProgram(params?.arguments ?? {})
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: out.text }],
          isError: out.isError,
        },
      })
      return
    }
    if (method === 'resources/list') {
      sendJson({ jsonrpc: '2.0', id, result: { resources: [] } })
      return
    }
    if (method === 'prompts/list') {
      sendJson({ jsonrpc: '2.0', id, result: { prompts: [] } })
      return
    }
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    })
  } catch (err) {
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    })
  }
}

let stdinBuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  stdinBuf += chunk
  let idx
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).replace(/\r$/, '')
    stdinBuf = stdinBuf.slice(idx + 1)
    if (!line.trim()) continue
    try {
      void handleRpcMessage(JSON.parse(line))
    } catch {}
  }
})
