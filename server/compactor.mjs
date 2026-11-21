// Deterministic algorithmic compaction for Antigravity (agy), powered by
// pi-fabric's real `compileFabricSummary` engine (0 LLM calls).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { importFile, resolvePackageFile } from './resolve-deps.mjs'

const PI_FABRIC_HOOK_PATH = resolvePackageFile('pi-fabric', join('dist', 'compaction', 'hook.js'))
if (!PI_FABRIC_HOOK_PATH) {
  throw new Error(
    'agy-fabric: pi-fabric is not installed. Run `bun install` in the agy-fabric plugin directory (or re-run install.sh).',
  )
}
const { compileFabricSummary, rawContextTokens } = await importFile(PI_FABRIC_HOOK_PATH)
export { rawContextTokens }

const HOME = homedir()
const BRAIN_ROOTS = [
  join(HOME, '.gemini', 'antigravity-cli', 'brain'),
  join(HOME, '.gemini', 'antigravity', 'brain'),
]

const MAX_CARRY_ITEMS = 16
const MAX_CARRY_BYTES = 2048

const record = v => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {})

const readJsonSafe = path => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

const writeJsonAtomic = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

export const compactionDir = cwd => join(resolve(cwd), '.pi', 'fabric', 'compaction')

// --- Carry-forward state ([Carry Forward]) ---------------------------------

export const readCarryItems = cwd => {
  const data = readJsonSafe(join(compactionDir(cwd), 'carry.json'))
  if (!data || !Array.isArray(data.items)) return []
  return data.items.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, MAX_CARRY_ITEMS)
}

export const updateCarryItems = (cwd, update = {}) => {
  if (!update || typeof update !== 'object' || Object.keys(update).length === 0) {
    return { items: readCarryItems(cwd) }
  }
  let list = update.clear ? [] : [...readCarryItems(cwd)]
  if (Array.isArray(update.items)) {
    list = update.items.map(s => String(s).trim()).filter(Boolean)
  }
  if (Array.isArray(update.remove)) {
    const rmSet = new Set(update.remove.map(s => String(s)))
    list = list.filter(item => !rmSet.has(item))
  }
  if (Array.isArray(update.add)) {
    for (const raw of update.add) {
      const s = String(raw).trim()
      if (s && !list.includes(s)) list.push(s)
    }
  }
  if (list.length > MAX_CARRY_ITEMS) {
    throw new Error(`compact.carry: exceeds max ${MAX_CARRY_ITEMS} items (got ${list.length})`)
  }
  for (const item of list) {
    if (item.length > MAX_CARRY_BYTES || Buffer.byteLength(item, 'utf8') > MAX_CARRY_BYTES) {
      throw new Error(`compact.carry: item exceeds ${MAX_CARRY_BYTES} bytes`)
    }
  }
  writeJsonAtomic(join(compactionDir(cwd), 'carry.json'), { version: 1, items: list })
  return { items: list }
}

// --- Transcript discovery & normalization ----------------------------------

const resolveExistingTranscript = candidatePath => {
  if (!candidatePath) return null
  const candidates = [
    candidatePath,
    candidatePath.replace('/.gemini/antigravity/brain/', '/.gemini/antigravity-cli/brain/'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      const fullSibling = p.replace(/\/transcript\.jsonl$/, '/transcript_full.jsonl')
      return existsSync(fullSibling) ? fullSibling : p
    }
  }
  return null
}

export const findTranscriptForConversation = (conversationId, fallbackPath = null) => {
  const direct = resolveExistingTranscript(fallbackPath)
  if (direct) return direct

  let convId = conversationId
  if (!convId && typeof fallbackPath === 'string') {
    const m = /\/brain\/([0-9a-f-]{36})\//i.exec(fallbackPath)
    if (m) convId = m[1]
  }

  if (convId) {
    for (const root of BRAIN_ROOTS) {
      const full = join(root, convId, '.system_generated', 'logs', 'transcript_full.jsonl')
      if (existsSync(full)) return full
      const compact = join(root, convId, '.system_generated', 'logs', 'transcript.jsonl')
      if (existsSync(compact)) return compact
    }
  }
  // Fallback: newest transcript_full.jsonl in brain
  let bestPath = null
  let bestMtime = 0
  for (const root of BRAIN_ROOTS) {
    if (!existsSync(root)) continue
    for (const id of readdirSync(root)) {
      const full = join(root, id, '.system_generated', 'logs', 'transcript_full.jsonl')
      if (!existsSync(full)) continue
      try {
        const mt = statSync(full).mtimeMs
        if (mt > bestMtime) {
          bestMtime = mt
          bestPath = full
        }
      } catch {}
    }
  }
  return bestPath
}

export const mapAgyTool = (rawName, rawArgs) => {
  const args = record(rawArgs)
  if (rawName === 'call_mcp_tool') {
    const toolName = String(args.ToolName ?? args.toolName ?? '')
    const innerArgs = record(args.Arguments ?? args.arguments)
    if (toolName === 'fabric_exec') {
      return { name: 'fabric_exec', args: innerArgs }
    }
    const serverName = String(args.ServerName ?? args.serverName ?? 'mcp')
    return { name: `mcp_${serverName}_${toolName || 'tool'}`, args: innerArgs }
  }
  if (/^(?:mcp_)?(?:fabric_)*fabric_exec$/.test(String(rawName || ''))) {
    return { name: 'fabric_exec', args }
  }
  if (rawName === 'read_file') return { name: 'read', args: { path: args.Path } }
  if (rawName === 'write_file') return { name: 'write', args: { path: args.Path, content: args.Content } }
  if (rawName === 'edit_file') return { name: 'edit', args: { path: args.Path, oldText: args.Target, newText: args.Replacement } }
  if (rawName === 'run_command') return { name: 'bash', args: { command: args.CommandLine } }
  return { name: rawName || 'tool', args }
}

export const cleanUserContent = raw => {
  const text = String(raw ?? '')
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text)
  return (m ? m[1] : text).trim()
}

export const parseCompactSlashCommand = raw => {
  const cleaned = cleanUserContent(raw)
  const m = /^\/compact(?:\s+([\s\S]*))?$/i.exec(cleaned)
  if (!m) return null
  return { instructions: (m[1] ?? '').trim() }
}

const stripAgyStepHeaders = raw =>
  String(raw ?? '').replace(/^(?:Created At: [^\n]*\nCompleted At: [^\n]*\n)+/, '')

const stepBodyText = step => {
  if (!step || typeof step !== 'object') return ''
  if (step.type === 'USER_INPUT') return cleanUserContent(step.content)
  return stripAgyStepHeaders(step.content ?? step.error ?? '')
}

export const parseAgyTranscript = transcriptPath => {
  if (!transcriptPath || !existsSync(transcriptPath)) return { steps: [], entries: [] }
  const rawLines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  const steps = []
  const entries = []
  let pendingCalls = []

  for (const line of rawLines) {
    let step
    try {
      step = JSON.parse(line)
    } catch {
      continue
    }
    steps.push(step)
    const ts = step.created_at || new Date().toISOString()
    const id = `step-${step.step_index}`

    if (step.type === 'CHECKPOINT') {
      pendingCalls = []
      continue
    }

    if (step.type === 'USER_INPUT') {
      const text = cleanUserContent(step.content)
      if (text && !parseCompactSlashCommand(text)) {
        entries.push({
          type: 'message',
          id,
          timestamp: ts,
          message: { role: 'user', content: [{ type: 'text', text }] },
        })
      }
      pendingCalls = []
      continue
    }

    if (step.type === 'PLANNER_RESPONSE') {
      const parts = []
      if (step.thinking) parts.push({ type: 'thinking', thinking: String(step.thinking) })
      if (step.content && step.content !== 'null') {
        parts.push({ type: 'text', text: String(step.content) })
      }
      const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : []
      pendingCalls = []
      tcs.forEach((tc, k) => {
        const cid = tc.id || `call-${step.step_index}-${k}`
        const mapped = mapAgyTool(String(tc.name || 'tool'), tc.args ?? tc.arguments)
        parts.push({ type: 'toolCall', id: cid, name: mapped.name, arguments: mapped.args })
        pendingCalls.push({ id: cid, name: mapped.name })
      })
      if (parts.length > 0) {
        entries.push({
          type: 'message',
          id,
          timestamp: ts,
          message: { role: 'assistant', content: parts },
        })
      }
      continue
    }

    if (pendingCalls.length > 0) {
      const pc = pendingCalls.shift()
      const text = stepBodyText(step)
      entries.push({
        type: 'message',
        id,
        timestamp: ts,
        message: {
          role: 'toolResult',
          toolCallId: pc.id,
          toolName: pc.name,
          isError: step.status === 'ERROR' || text.startsWith('fabric_exec error:'),
          content: [{ type: 'text', text }],
        },
      })
    }
  }
  return { steps, entries }
}

const renderRawTail = (entries, firstKeptEntryId, maxTailChars = 48000) => {
  if (!firstKeptEntryId) return ''
  const idx = entries.findIndex(e => e.id === firstKeptEntryId)
  if (idx < 0) return ''
  const kept = entries.slice(idx)
  const blocks = []
  for (const entry of kept) {
    if (entry.type !== 'message' || !entry.message) continue
    const { role, content } = entry.message
    if (role === 'user') {
      const t = (content || []).map(p => p.text || '').join('\n').trim()
      if (t) blocks.push(`User [${entry.id}]:\n${t}`)
    } else if (role === 'assistant') {
      const texts = (content || [])
        .filter(p => p.type === 'text' && p.text)
        .map(p => p.text.trim())
        .filter(Boolean)
      const calls = (content || [])
        .filter(p => p.type === 'toolCall')
        .map(c => {
          const disp = c.arguments?.display
          const label = disp?.name ? `${c.name} (${disp.name})` : c.name
          return `  -> toolCall ${c.id}: ${label}`
        })
      const body = [...texts, ...calls].join('\n')
      if (body) blocks.push(`Assistant [${entry.id}]:\n${body}`)
    } else if (role === 'toolResult') {
      const raw = (content || []).map(p => p.text || '').join('\n').trim()
      const clipped =
        raw.length > 3000
          ? `${raw.slice(0, 2100)}\n…[+${raw.length - 2700} chars; recall via memory.expand({entryId: "${entry.id}"})]…\n${raw.slice(-600)}`
          : raw
      blocks.push(`ToolResult [${entry.id} · ${entry.message.toolName}${entry.message.isError ? ' · ERROR' : ''}]:\n${clipped}`)
    }
  }
  const joined = blocks.join('\n\n')
  return joined.length <= maxTailChars ? joined : joined.slice(joined.length - maxTailChars)
}

// --- Compile & Stage Deterministic Compaction ------------------------------

export const compileTranscriptCompaction = ({
  cwd,
  transcriptPath,
  conversationId = null,
  instructions = '',
  preserve = [],
  reason = 'manual',
  seed = null,
  requestedBy = 'model',
  contextWindow = 1048576,
  targetContextRatio = 0.65,
  keepRecentTokens = 12000,
  stagePending = true,
  commitConversationId = null,
}) => {
  const resolvedTranscript = findTranscriptForConversation(conversationId, transcriptPath)
  if (!resolvedTranscript) {
    throw new Error('compact: no active Antigravity transcript found to compact')
  }
  const { entries } = parseAgyTranscript(resolvedTranscript)
  if (entries.length === 0) {
    throw new Error('compact: transcript has no message entries yet')
  }

  const carryItems = [
    ...readCarryItems(cwd),
    ...(Array.isArray(preserve) ? preserve.map(s => String(s).trim()).filter(Boolean) : []),
  ].slice(0, MAX_CARRY_ITEMS)

  const rawTok = rawContextTokens(entries)
  const effectiveBefore = Math.max(rawTok, keepRecentTokens + 16000)

  let compiled = compileFabricSummary(
    entries,
    effectiveBefore,
    [],
    instructions || undefined,
    {
      contextWindow,
      targetContextRatio,
      reserveTokens: 16000,
      keepRecentTokens,
      calibrateUsage: false,
    },
    carryItems,
  )

  if ('cancel' in compiled && !compiled.instructionError) {
    compiled = compileFabricSummary(
      entries,
      Math.max(rawTok, 1),
      [],
      instructions || undefined,
      undefined,
      carryItems,
    )
  }

  if ('cancel' in compiled) {
    throw new Error(`compact: ${compiled.reason}`)
  }

  const { summary, firstKeptEntryId, details } = compiled.compaction
  const tailText = renderRawTail(entries, firstKeptEntryId, keepRecentTokens * 4)

  const fullInjection = [
    '# Fabric Deterministic Session Continuation',
    `Source transcript: \`${resolvedTranscript}\` (use \`await memory.expand({ stepIndex })\` or \`await memory.expand({ query })\` in \`fabric_exec\`, or read the transcript file directly, for exact lossless recall of any omitted entry).`,
    reason ? `Compaction reason: ${reason}` : '',
    '',
    summary,
    tailText ? `\n[Recent raw continuity tail from ${firstKeptEntryId}]\n\n${tailText}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const packet = {
    version: 2,
    compactor: 'pi-fabric-deterministic',
    createdAt: new Date().toISOString(),
    requestedBy,
    reason,
    instructions: instructions || null,
    preserve: Array.isArray(preserve) ? preserve : [],
    seed: seed ? String(seed) : null,
    sourceConversationId: conversationId,
    sourceTranscriptPath: resolvedTranscript,
    tokensBeforeEstimate: rawTok,
    estimatedTokensAfter: Math.ceil(Buffer.byteLength(fullInjection, 'utf8') / 4),
    firstKeptEntryId,
    counts: details.counts,
    omittedCounts: details.omittedCounts,
    summaryBytes: Buffer.byteLength(summary, 'utf8'),
    injectionBytes: Buffer.byteLength(fullInjection, 'utf8'),
    injectionText: fullInjection,
  }

  if (cwd) {
    const dir = compactionDir(cwd)
    mkdirSync(dir, { recursive: true })
    if (stagePending) {
      writeJsonAtomic(join(dir, 'pending.json'), packet)
    }
    if (commitConversationId) {
      const committed = {
        ...packet,
        committedAt: new Date().toISOString(),
        committedToConversationId: commitConversationId,
      }
      writeJsonAtomic(join(dir, 'last-committed.json'), committed)
      const pendingPath = join(dir, 'pending.json')
      if (!stagePending && existsSync(pendingPath)) {
        try {
          renameSync(pendingPath, join(dir, 'consumed-pending.json'))
        } catch {}
      }
    }
    writeFileSync(join(dir, 'latest-summary.md'), fullInjection, 'utf8')
  }
  return packet
}

export const readCompactionStatus = cwd => {
  const dir = compactionDir(cwd)
  const pending = readJsonSafe(join(dir, 'pending.json'))
  const last = readJsonSafe(join(dir, 'last-committed.json'))
  const stripBody = pkt => {
    if (!pkt) return null
    const { injectionText: _ignored, ...rest } = pkt
    return rest
  }
  return {
    owner: 'fabric',
    carry: readCarryItems(cwd),
    pending: stripBody(pending),
    last: stripBody(last),
  }
}

export const cancelPendingCompaction = cwd => {
  const p = join(compactionDir(cwd), 'pending.json')
  if (existsSync(p)) {
    unlinkSync(p)
    return { cancelled: true }
  }
  return { cancelled: false }
}

// --- Lossless source recall (`memory.expand`) ------------------------------

export const expandTranscriptMemory = (cwd, options = {}, sessionMeta = {}) => {
  const dir = compactionDir(cwd)
  const last = readJsonSafe(join(dir, 'last-committed.json'))
  const pending = readJsonSafe(join(dir, 'pending.json'))

  const explicitPath = resolveExistingTranscript(options.transcriptPath)
  const explicitConvPath = options.conversationId
    ? findTranscriptForConversation(String(options.conversationId), null)
    : null

  const activeConvId = sessionMeta?.conversationId ?? null
  const activeTranscript =
    activeConvId || sessionMeta?.transcriptPath
      ? findTranscriptForConversation(activeConvId, sessionMeta?.transcriptPath ?? null)
      : null

  const lastPath = resolveExistingTranscript(last?.sourceTranscriptPath)
  const pendingPath = resolveExistingTranscript(pending?.sourceTranscriptPath)
  const spawnedFromLast = Boolean(activeConvId && last?.committedToConversationId === activeConvId && lastPath)

  let targetPath = null
  if (explicitPath) {
    targetPath = explicitPath
  } else if (explicitConvPath) {
    targetPath = explicitConvPath
  } else if (options.source === 'compacted' || options.prior === true) {
    targetPath = lastPath || pendingPath || activeTranscript
  } else if (options.source === 'current') {
    targetPath = activeTranscript
  } else if (spawnedFromLast) {
    targetPath = lastPath
  } else {
    targetPath = activeTranscript || lastPath || pendingPath || findTranscriptForConversation(null, null)
  }

  if (!targetPath || !existsSync(targetPath)) {
    throw new Error('memory.expand: no source transcript available to recall from')
  }

  const lines = readFileSync(targetPath, 'utf8').split('\n').filter(Boolean)
  const steps = lines
    .map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 25))

  // By stepIndex, entryId ("step-42" or 42), or fromStep/toStep range
  const rawId = options.entryId ?? options.stepIndex ?? options.step
  const hasRange = options.fromStep !== undefined || options.toStep !== undefined
  if ((rawId !== undefined && rawId !== null) || hasRange) {
    const idxNum =
      rawId !== undefined && rawId !== null
        ? typeof rawId === 'number'
          ? rawId
          : Number(String(rawId).replace(/^step-/, ''))
        : undefined
    const from = options.fromStep !== undefined ? Number(options.fromStep) : idxNum ?? 0
    const to = options.toStep !== undefined ? Number(options.toStep) : idxNum ?? Number.MAX_SAFE_INTEGER
    const matched = steps.filter(s => s.step_index >= from && s.step_index <= to).slice(0, limit)
    return {
      sourceTranscriptPath: targetPath,
      matches: matched.map(s => ({
        entryId: `step-${s.step_index}`,
        type: s.type,
        status: s.status,
        createdAt: s.created_at,
        toolCalls: s.tool_calls ?? [],
        content: stepBodyText(s),
      })),
    }
  }

  // By keyword query across exact raw steps
  const q = String(options.query ?? '').trim().toLowerCase()
  if (q) {
    const matched = steps
      .filter(s => {
        const hay = `${stepBodyText(s)} ${JSON.stringify(s.tool_calls ?? '')}`.toLowerCase()
        return hay.includes(q)
      })
      .slice(-limit)
    return {
      sourceTranscriptPath: targetPath,
      totalMatchedSteps: matched.length,
      matches: matched.map(s => ({
        entryId: `step-${s.step_index}`,
        type: s.type,
        status: s.status,
        createdAt: s.created_at,
        toolCalls: s.tool_calls ?? [],
        content: stepBodyText(s).slice(0, 16000),
      })),
    }
  }

  return {
    sourceTranscriptPath: targetPath,
    totalSteps: steps.length,
    range: steps.length > 0 ? { first: `step-${steps[0].step_index}`, last: `step-${steps.at(-1).step_index}` } : null,
  }
}
