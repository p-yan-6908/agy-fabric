#!/usr/bin/env bun
// Lifecycle hook for Fabric plugin:
// - SessionStart: commits staged deterministic compaction (`pending.json` -> `last-committed.json`)
//   via `injectSteps` (0 LLM calls).
// - PreInvocation: intercepts `/compact [instructions]` in both `agy` and `agyf`, running `pi-fabric`'s
//   deterministic 0-LLM compactor, staging `pending.json`, signaling the PTY wrapper to trigger `/new`
//   automatically, and returning `terminationBehavior: "terminate"` so `agy`'s LLM compactor never runs.
// - PreToolUse: refreshes session `cwd` + returns `{"decision":"allow"}`.
// - Stop: auto-stages deterministic compaction once context occupancy reaches 65%+.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  compactionDir,
  compileTranscriptCompaction,
  findTranscriptForConversation,
  parseCompactSlashCommand,
} from './compactor.mjs'

const uid = process.getuid ? process.getuid() : 501
const tmpDir = `/tmp/agy-fabric-${uid}`
const sessionsDir = `${tmpDir}/sessions`
const activeFile = `${tmpDir}/active-cwd.json`
const telemetryFile = `${tmpDir}/telemetry.json`

const readJsonSafe = p => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  } catch {
    return null
  }
}

const writeJsonAtomic = (p, obj) => {
  mkdirSync(sessionsDir, { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  renameSync(tmp, p)
}

const readLastTranscriptStep = transcriptPath => {
  if (!transcriptPath || !existsSync(transcriptPath)) return null
  try {
    const content = readFileSync(transcriptPath, 'utf8').trim()
    if (!content) return null
    const nl = content.lastIndexOf('\n')
    const lastLine = nl >= 0 ? content.slice(nl + 1) : content
    return JSON.parse(lastLine)
  } catch {
    return null
  }
}

// Resolve the owning `agy` CLI process PID so concurrent terminals stay isolated.
const resolveAgyPid = () => {
  const envPid = Number(process.env.ORCA_HOOK_AGENT_PID)
  let cur = Number.isFinite(envPid) && envPid > 1 ? envPid : process.ppid
  for (let hop = 0; hop < 4 && cur > 1; hop++) {
    try {
      const out = spawnSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { encoding: 'utf8', timeout: 500 })
      const line = String(out.stdout || '').trim()
      if (!line) break
      const m = /^(\d+)\s+(.+)$/.exec(line)
      if (!m) break
      const parentPid = Number(m[1])
      const comm = m[2].trim()
      if (/(?:^|\/)agy$/.test(comm)) return cur
      cur = parentPid
    } catch {
      break
    }
  }
  return process.ppid
}

let eventName = ''
let responseObj = {}

try {
  const raw = await new Response(Bun.stdin.stream()).text()
  const payload = raw ? JSON.parse(raw) : {}
  eventName = String(payload.hookEventName ?? payload.hook_event_name ?? '')
  const cwd = payload.cwd || (Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : null)
  const convId = payload.conversationId ?? payload.conversation_id ?? payload.session_id ?? null
  const transcriptPath = payload.transcriptPath ?? payload.transcript_path ?? null
  const agyPid = resolveAgyPid()

  let resolvedCwd = cwd ? resolve(cwd) : null
  let resolvedConvId = convId
  let resolvedTranscript = transcriptPath

  if (cwd || convId) {
    mkdirSync(sessionsDir, { recursive: true })
    const pidFile = `${sessionsDir}/pid-${agyPid}.json`
    const prevPid = readJsonSafe(pidFile) ?? {}
    const prevConv = convId ? (readJsonSafe(`${sessionsDir}/conv-${convId}.json`) ?? {}) : {}
    const prev = prevPid.conversationId === convId ? prevPid : { ...prevPid, ...prevConv }

    resolvedCwd = resolvedCwd ?? (prev.cwd ? resolve(prev.cwd) : null)
    resolvedConvId = resolvedConvId ?? prevPid.conversationId ?? null
    resolvedTranscript = resolvedTranscript ?? prev.transcriptPath ?? null

    const nextTurn =
      eventName === 'PreInvocation'
        ? Number(payload.invocationNum ?? payload.invocation_num ?? (prevPid.conversationId === resolvedConvId ? (prevPid.turnIndex ?? 0) + 1 : 0))
        : (prev.turnIndex ?? 0)

    if (resolvedCwd) {
      const recordObj = {
        cwd: resolvedCwd,
        conversationId: resolvedConvId,
        transcriptPath: resolvedTranscript,
        turnIndex: nextTurn,
        agyPid,
        updatedAt: Date.now(),
      }
      if (agyPid > 1) writeJsonAtomic(pidFile, recordObj)
      if (resolvedConvId) writeJsonAtomic(`${sessionsDir}/conv-${resolvedConvId}.json`, recordObj)
      writeJsonAtomic(activeFile, recordObj)
    }
  }

  if (eventName === 'SessionStart' && resolvedCwd) {
    const cDir = compactionDir(resolvedCwd)
    const pendingPath = join(cDir, 'pending.json')
    const pkt = readJsonSafe(pendingPath)
    if (pkt && typeof pkt.injectionText === 'string' && pkt.injectionText.trim() !== '') {
      const committed = {
        ...pkt,
        committedAt: new Date().toISOString(),
        committedToConversationId: resolvedConvId,
      }
      const committedPath = join(cDir, 'last-committed.json')
      writeFileSync(committedPath, JSON.stringify(committed, null, 2), 'utf8')
      try {
        renameSync(pendingPath, join(cDir, 'consumed-pending.json'))
      } catch {}

      responseObj = {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: pkt.injectionText,
            },
          },
          ...(pkt.seed ? [{ userMessage: String(pkt.seed) }] : []),
        ],
      }
    }
  } else if (eventName === 'PreInvocation') {
    const invNum = Number(payload.invocationNum ?? payload.invocation_num ?? 0)
    if (invNum === 0) {
      let compactCmd = parseCompactSlashCommand(payload.lastUserInput ?? payload.last_user_input ?? '')
      if (!compactCmd) {
        const tx = findTranscriptForConversation(resolvedConvId, resolvedTranscript)
        const lastStep = readLastTranscriptStep(tx)
        if (lastStep && lastStep.type === 'USER_INPUT') {
          compactCmd = parseCompactSlashCommand(lastStep.content)
        }
      }
      if (compactCmd) {
        try {
          const targetCwd = resolvedCwd || process.cwd()
          const pkt = compileTranscriptCompaction({
            cwd: targetCwd,
            transcriptPath: resolvedTranscript,
            conversationId: resolvedConvId,
            instructions: compactCmd.instructions,
            reason: compactCmd.instructions ? `/compact ${compactCmd.instructions}` : '/compact',
            requestedBy: '/compact',
            stagePending: true,
          })
          const summaryMsg = `[fabric] Algorithmic compaction staged (0 LLM tokens): summarized ${pkt.counts?.cumulativeSourceEntries ?? pkt.counts?.branchEntries ?? 0} entries (${pkt.omittedCounts?.thinking ?? 0} thinking blocks stripped) into ~${pkt.estimatedTokensAfter ?? 0} tokens. Run /new to continue in the compacted window.`
          responseObj = {
            injectSteps: [
              {
                errorMessage: {
                  userMessage: summaryMsg,
                },
              },
            ],
            terminationBehavior: 'terminate',
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          responseObj = {
            injectSteps: [
              {
                errorMessage: {
                  userMessage: msg.includes('no message entries') ? 'Nothing to compact.' : msg,
                },
              },
            ],
            terminationBehavior: 'terminate',
          }
        }
      }
    }
  } else if (eventName === 'PreToolUse') {
    responseObj = { decision: 'allow' }
  } else if (eventName === 'Stop') {
    responseObj = { decision: '' }
    if (resolvedCwd && resolvedConvId) {
      const sessionTel = readJsonSafe(`${sessionsDir}/tel-${resolvedConvId}.json`)
      const globalTel = readJsonSafe(telemetryFile)
      const telemetry =
        sessionTel ?? (globalTel && globalTel.session_id === resolvedConvId ? globalTel : null)
      const usedPct = telemetry ? Number(telemetry.used_percentage || 0) : 0
      if (usedPct >= 65) {
        try {
          compileTranscriptCompaction({
            cwd: resolvedCwd,
            transcriptPath: resolvedTranscript,
            conversationId: resolvedConvId,
            reason: `auto-staged at ${usedPct.toFixed(1)}% context occupancy`,
            requestedBy: 'auto-threshold',
          })
        } catch {}
      }
    }
  }
} catch {
  if (eventName === 'PreToolUse') responseObj = { decision: 'allow' }
  else if (eventName === 'Stop') responseObj = { decision: '' }
}

process.stdout.write(JSON.stringify(responseObj) + '\n')
