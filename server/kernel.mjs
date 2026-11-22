// Fabric guest kernel for Antigravity (agy).
// Supports both:
// 1. Warm worker mode (`bun kernel.mjs --worker`): persistent sandboxed daemon speaking
//    framed JSONL RPC over stdin/stdout (zero cold-spawn or file-polling latency).
// 2. Single-shot mode (`bun kernel.mjs <runDir>`): backwards-compatible fs-IPC execution.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MARK = '\u001eFABRIC '
const isWorkerMode = process.argv[2] === '--worker'

const send = message => process.stdout.write(MARK + JSON.stringify(message) + '\n')
const sleep = ms => new Promise(done => setTimeout(done, ms))

const clip = (text, maxChars = 4000) => {
  const source = typeof text === 'string' ? text : (JSON.stringify(text, null, 2) ?? String(text))
  if (source.length <= maxChars) return source
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head - 40)
  return `${source.slice(0, head)}\n…[+${source.length - head - tail} chars]…\n${tail > 0 ? source.slice(-tail) : ''}`
}

const render = values =>
  values.map(v => (typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v)))).join(' ')

const stateKey = key => String(key).replace(/[^\w.-]/g, '_').slice(0, 80)

const describeError = (error, headerLines = 1) => {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    return `the program does not parse: ${error.errors
      .map(
        one =>
          `${one.message}${one.position?.line ? ` (program line ${Math.max(1, one.position.line - headerLines)}: ${String(one.position.lineText ?? '').trim()})` : ''}`,
      )
      .join('; ')}`
  }
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const frame = stack.split('\n').find(line => line.includes('program.ts'))
  const at = frame ? /program\.ts:(\d+)/.exec(frame) : null
  return at ? `${message} (program line ${Math.max(1, Number(at[1]) - headerLines)})` : message
}

const buildProgramEnv = ({ host, runMeta, logs, memState }) => {
  const pi = {
    read: (...args) => host('pi', { method: 'read', args }),
    bash: (...args) => host('pi', { method: 'bash', args }),
    grep: (...args) => host('pi', { method: 'grep', args }),
    find: (...args) => host('pi', { method: 'find', args }),
    ls: (...args) => host('pi', { method: 'ls', args }),
    edit: (...args) => host('pi', { method: 'edit', args }),
    write: (...args) => host('pi', { method: 'write', args }),
  }

  const SHIM_MAP = {
    Read: a => pi.read({ path: a?.file_path ?? a?.Path ?? a?.path, offset: a?.offset ?? a?.StartLine, limit: a?.limit }),
    read_file: a =>
      pi.read({
        path: a?.Path ?? a?.path,
        offset: a?.StartLine,
        limit: a?.EndLine && a?.StartLine ? a.EndLine - a.StartLine + 1 : undefined,
      }),
    Bash: a => pi.bash({ command: a?.command ?? a?.CommandLine, timeout: a?.timeout ? a.timeout / 1000 : undefined, cwd: a?.cwd }),
    run_command: a => pi.bash({ command: a?.CommandLine ?? a?.command, cwd: a?.cwd }),
    Edit: a =>
      pi.edit({
        path: a?.file_path ?? a?.Path ?? a?.path,
        oldText: a?.old_string ?? a?.Target,
        newText: a?.new_string ?? a?.Replacement,
        all: a?.replace_all,
      }),
    edit_file: a => pi.edit({ path: a?.Path ?? a?.path, oldText: a?.Target, newText: a?.Replacement, all: true }),
    Write: a => pi.write(a?.file_path ?? a?.Path ?? a?.path, a?.content ?? a?.Content),
    write_file: a => pi.write(a?.Path ?? a?.path, a?.Content ?? a?.content),
    Grep: a => pi.grep({ pattern: a?.pattern ?? a?.Query, path: a?.path ?? a?.SearchPath, glob: a?.glob, ignoreCase: a?.['-i'] ?? a?.CaseInsensitive }),
    Glob: a => pi.find({ pattern: a?.pattern ?? a?.Pattern, path: a?.path ?? a?.SearchDirectory }),
  }

  const makeHostProxy = label =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          typeof name === 'string'
            ? async (toolInput = {}, options = {}) => {
                if (name in SHIM_MAP) {
                  try {
                    const res = await SHIM_MAP[name](toolInput)
                    const text = typeof res === 'string' ? res : JSON.stringify(res)
                    return options?.settle ? { ok: true, text, result: res } : { text, result: res }
                  } catch (err) {
                    if (options?.settle) return { ok: false, text: err.message, result: null }
                    throw err
                  }
                }
                throw new Error(
                  `${label}.${name} is not available inside fabric_exec; use pi.*, extensions.fovea_*, extensions.ctx_*, compact.*, memory.*, mcp.<server>.<tool>(args), skills.load(name), or agents.run({prompt}).`,
                )
              }
            : undefined,
      },
    )

  const cc = makeHostProxy('cc')
  const agy = makeHostProxy('agy')

  const mcp = new Proxy(
    {},
    {
      get: (_, server) =>
        typeof server === 'string'
          ? new Proxy(
              {},
              {
                get: (__, toolName) =>
                  typeof toolName === 'string'
                    ? (args = {}, options = {}) =>
                        host('mcp', { server, tool: toolName, args, settle: Boolean(options?.settle) })
                    : undefined,
              },
            )
          : undefined,
    },
  )

  const extensions = new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === 'string' ? (args = {}) => host('extension', { name, args }) : undefined,
    },
  )

  const fovea = {
    sketch: (args = {}) => host('extension', { name: 'fovea_sketch', args }),
    focus: (args = {}) =>
      host('extension', { name: 'fovea_focus', args: typeof args === 'string' ? { query: args } : args }),
    dwell: (args = {}) => host('extension', { name: 'fovea_dwell', args }),
    impact: (args = {}) => host('extension', { name: 'fovea_impact', args }),
  }

  const ce = {
    read: (args = {}) => host('extension', { name: 'ctx_read', args }),
    summarize: (args = {}) => host('extension', { name: 'ctx_summarize', args }),
    offload: (args = {}) => host('extension', { name: 'ctx_offload', args }),
    status: (args = '') => host('ce_cmd', { args: typeof args === 'string' ? `status ${args}`.trim() : 'status' }),
    settings: () => host('ce_cmd', { args: 'settings' }),
    trace: () => host('ce_cmd', { args: 'trace' }),
    clear: () => host('ce_cmd', { args: 'clear' }),
  }

  const compact = {
    request: (options = {}) =>
      host('compact', { action: 'request', options: typeof options === 'string' ? { instructions: options } : options }),
    status: () => host('compact', { action: 'status' }),
    pressure: () => host('compact', { action: 'pressure' }),
    carry: (options = {}) => host('compact', { action: 'carry', options }),
    cancel: () => host('compact', { action: 'cancel' }),
  }

  const memory = {
    expand: (options = {}) =>
      host('memory', {
        action: 'expand',
        options: typeof options === 'number' || typeof options === 'string' ? { entryId: options } : options,
      }),
  }
  memory.recall = memory.expand

  const skills = {
    async list() {
      return runMeta.skills ?? []
    },
    async load(name, args) {
      return host('skill', { name: String(name), args })
    },
  }

  const agents = {
    async run(options = {}) {
      const req = typeof options === 'string' ? { prompt: options } : { ...options }
      return host('agent', req)
    },
    async list() {
      return runMeta.agents ?? []
    },
  }
  agents.spawn = agents.run

  const state = {
    async set(key, value) {
      const sk = stateKey(key)
      if (memState) memState.set(sk, value)
      return host('state', { action: 'set', key, value })
    },
    async get(key) {
      const sk = stateKey(key)
      if (memState && memState.has(sk)) return memState.get(sk)
      if (runMeta.stateDir) {
        const path = join(runMeta.stateDir, `${sk}.json`)
        if (existsSync(path)) {
          const val = JSON.parse(readFileSync(path, 'utf8'))
          if (memState) memState.set(sk, val)
          return val
        }
      }
      return undefined
    },
    async delete(key) {
      const sk = stateKey(key)
      if (memState) memState.delete(sk)
      return host('state', { action: 'delete', key })
    },
    async keys() {
      const diskKeys =
        runMeta.stateDir && existsSync(runMeta.stateDir)
          ? readdirSync(runMeta.stateDir)
              .filter(n => n.endsWith('.json'))
              .map(n => n.replace(/\.json$/, ''))
          : []
      if (!memState) return diskKeys
      return [...new Set([...memState.keys(), ...diskKeys])]
    },
  }

  const tools = {
    async list(options = {}) {
      return host('tools', { action: 'list', options })
    },
    async search(options = {}) {
      const query = typeof options === 'string' ? { query: options } : options
      return host('tools', { action: 'search', options: query })
    },
    async describe(options = {}) {
      const req = typeof options === 'string' ? { ref: options } : options
      return host('tools', { action: 'describe', options: req })
    },
    async call(options = {}) {
      const ref = String(options?.ref ?? '')
      const args = options?.args ?? {}
      if (ref.startsWith('pi.')) {
        const fn = pi[ref.slice(3)]
        if (typeof fn !== 'function') throw new Error(`tools.call: unknown core tool ${ref}`)
        return fn(args)
      }
      if (ref.startsWith('extensions.')) {
        return host('extension', { name: ref.slice('extensions.'.length), args })
      }
      if (ref.startsWith('compact.')) {
        const fn = compact[ref.slice('compact.'.length)]
        if (typeof fn !== 'function') throw new Error(`tools.call: unknown compact op ${ref}`)
        return fn(args)
      }
      if (ref === 'memory.expand' || ref === 'memory.recall') {
        return memory.expand(args)
      }
      if (ref.startsWith('skills.')) {
        return skills.load(ref.slice(7), args?.args)
      }
      if (ref === 'agents.run' || ref === 'agents.spawn') {
        return agents.run(args)
      }
      if (ref.startsWith('mcp.')) {
        const [, server, ...rest] = ref.split('.')
        return host('mcp', { server, tool: rest.join('.'), args, settle: Boolean(options?.settle) })
      }
      throw new Error(`tools.call: unknown ref "${ref}"; try tools.search({query})`)
    },
  }

  const print = (...values) => {
    logs.push(render(values))
  }
  const fabricConsole = { log: print, info: print, warn: print, error: print, debug: print }

  const payloads = runMeta.payloads ?? {}
  const π = new Proxy(payloads, {
    get(target, key) {
      if (typeof key !== 'string' || key in target) return target[key]
      throw new Error(`π.${key} is not in this call's payloads (${Object.keys(target).join(', ') || 'none supplied'})`)
    },
  })

  return {
    pi,
    agy,
    cc,
    mcp,
    extensions,
    fovea,
    ce,
    compact,
    memory,
    tools,
    skills,
    agents,
    state,
    clip,
    print,
    console: fabricConsole,
    π,
    payloads,
  }
}

if (!isWorkerMode) {
  // --- Legacy single-shot mode (`bun kernel.mjs <runDir>`) -------------------
  const dir = process.argv[2]
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'))
  const logs = []
  let nextId = 0

  const host = async (op, args) => {
    const id = ++nextId
    send({ t: 'call', id, op, args })
    const ok = join(dir, 'res', `${id}.ok`)
    for (let wait = 1; !existsSync(ok); wait = Math.min(wait * 2, 25)) await sleep(wait)
    const answer = JSON.parse(readFileSync(join(dir, 'res', `${id}.json`), 'utf8'))
    if (!answer.ok) {
      throw new Error(answer.error || `${op} failed`)
    }
    return answer.value
  }

  const env = buildProgramEnv({ host, runMeta: input, logs, memState: null })
  const headerLines = Number(input.headerLines) || 1
  try {
    const program = await import(pathToFileURL(join(dir, 'program.ts')).href)
    const value = await program.default(env)
    send({ t: 'done', ok: true, value: value === undefined ? null : value, hasValue: value !== undefined, logs })
  } catch (error) {
    send({ t: 'done', ok: false, error: describeError(error, headerLines), logs })
  }
  process.exit(0)
} else {
  // --- Persistent Warm Worker Mode (`bun kernel.mjs --worker`) ---------------
  const pendingCalls = new Map()
  const memStateByDir = new Map()
  let nextId = 0

  const host = (op, args) =>
    new Promise((resolveCall, rejectCall) => {
      const id = ++nextId
      pendingCalls.set(id, { resolveCall, rejectCall, op })
      send({ t: 'call', id, op, args })
    })

  const runProgram = async msg => {
    const logs = []
    const headerLines = Number(msg.headerLines) || 3
    if (msg.cwd) {
      try {
        process.chdir(msg.cwd)
      } catch {}
    }
    const stateNs = String(msg.stateDir || msg.cwd || 'default')
    if (!memStateByDir.has(stateNs)) memStateByDir.set(stateNs, new Map())
    const memState = memStateByDir.get(stateNs)
    const env = buildProgramEnv({ host, runMeta: msg, logs, memState })
    try {
      const program = await import(pathToFileURL(msg.programPath).href)
      const value = await program.default(env)
      send({
        t: 'done',
        runId: msg.runId,
        ok: true,
        value: value === undefined ? null : value,
        hasValue: value !== undefined,
        logs,
      })
    } catch (error) {
      send({
        t: 'done',
        runId: msg.runId,
        ok: false,
        error: describeError(error, headerLines),
        logs,
      })
    }
  }

  let stdinBuf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    stdinBuf += chunk
    let cut
    while ((cut = stdinBuf.indexOf('\n')) >= 0) {
      const rawLine = stdinBuf.slice(0, cut).replace(/\r$/, '')
      stdinBuf = stdinBuf.slice(cut + 1)
      const payloadText = rawLine.startsWith(MARK) ? rawLine.slice(MARK.length) : rawLine
      if (!payloadText.trim()) continue
      let msg
      try {
        msg = JSON.parse(payloadText)
      } catch {
        continue
      }
      if (msg.t === 'res') {
        const entry = pendingCalls.get(msg.id)
        if (!entry) continue
        pendingCalls.delete(msg.id)
        if (msg.answer?.ok) entry.resolveCall(msg.answer.value)
        else entry.rejectCall(new Error(msg.answer?.error || `${entry.op} failed`))
      } else if (msg.t === 'run') {
        void runProgram(msg)
      } else if (msg.t === 'ping') {
        send({ t: 'pong' })
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
  send({ t: 'ready' })
}
