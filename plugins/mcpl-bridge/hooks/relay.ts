#!/usr/bin/env bun
/**
 * Hook relay: forwards Claude Code hook events to the mcpl-bridge adapter
 * over a unix socket, and prints the adapter's hook response.
 *
 * Socket discovery: the adapter (spawned by Claude Code as an MCP stdio
 * server) binds ~/.claude/mcpl-bridge/sock-<claude-pid>.sock, where
 * <claude-pid> is the adapter's parent pid — the `claude` process itself.
 * This hook script runs as a descendant of the same `claude` process, so we
 * walk our own ancestor chain until we find a pid with a socket file.
 *
 * Fail-open: if no adapter socket is found or the adapter errors, exit 0
 * with no output — the session proceeds untouched. The bridge must never
 * take a session down.
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const SOCK_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'mcpl-bridge')

function ancestors(maxDepth = 8): number[] {
  const out: number[] = []
  let pid = process.pid
  for (let i = 0; i < maxDepth; i++) {
    let ppid: number
    try {
      const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)])
      ppid = parseInt(r.stdout.toString().trim(), 10)
    } catch {
      break
    }
    if (!ppid || ppid <= 1 || Number.isNaN(ppid)) break
    out.push(ppid)
    pid = ppid
  }
  return out
}

function findSocket(): string | null {
  // Primary key: session id, exported by CC to both hook commands and MCP
  // servers (the adapter binds sock-<session-id>.sock).
  const keys = [process.env.CLAUDE_CODE_SESSION_ID, (event as { session_id?: string })?.session_id].filter(Boolean) as string[]
  for (const k of keys) {
    const p = join(SOCK_DIR, `sock-${k}.sock`)
    if (existsSync(p)) return p
  }
  // Fallback for older CC without CLAUDE_CODE_SESSION_ID: adapter binds
  // sock-<its ppid>; walk our ancestors hoping to share that pid.
  for (const pid of ancestors()) {
    const p = join(SOCK_DIR, `sock-${pid}.sock`)
    if (existsSync(p)) return p
  }
  return null
}

/** The adapter binds its socket ~1s after spawn; the first UserPromptSubmit
 *  of a session can fire before that. Poll briefly before failing open. */
async function findSocketWithRetry(ms = 3000): Promise<string | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const p = findSocket()
    if (p) return p
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 250))
  }
}

function debug(line: string) {
  try {
    const { appendFileSync, mkdirSync } = require('fs') as typeof import('fs')
    mkdirSync(SOCK_DIR, { recursive: true })
    appendFileSync(join(SOCK_DIR, 'debug.log'), `${new Date().toISOString()} [relay ${process.pid}] ${line}\n`)
  } catch {}
}

const input = await Bun.stdin.text()
let event: unknown
try {
  event = JSON.parse(input)
} catch {
  process.exit(0)
}
// Log only the event name — hook payloads carry prompt text, never log it.
debug(`invoked: ${(event as { hook_event_name?: string })?.hook_event_name ?? 'unknown'}`)

const isPrompt = (event as { hook_event_name?: string })?.hook_event_name === 'UserPromptSubmit'
const sock = isPrompt ? await findSocketWithRetry() : findSocket()
debug(`socket: ${sock ?? 'NOT FOUND'}`)
if (!sock) process.exit(0)

try {
  const reply = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => reject(new Error('timeout')), 12_000)
    Bun.connect({
      unix: sock,
      socket: {
        open(s) {
          s.write(JSON.stringify({ kind: 'hook', event }) + '\n')
        },
        data(_s, data) {
          chunks.push(Buffer.from(data))
        },
        close() {
          clearTimeout(timer)
          resolve(Buffer.concat(chunks).toString('utf8'))
        },
        error(_s, err) {
          clearTimeout(timer)
          reject(err)
        },
      },
    }).catch(reject)
  })
  const trimmed = reply.trim()
  if (trimmed) {
    // Adapter returns a complete hook-output JSON object (or nothing).
    JSON.parse(trimmed) // validate before emitting
    process.stdout.write(trimmed)
  }
  process.exit(0)
} catch {
  process.exit(0)
}
