#!/usr/bin/env bun
/**
 * Deferred-wake test: a wake that fires while a user turn is live must be
 * mirrored into the held ledger and re-fired at the turn boundary, because
 * the harness drops channel notifications that land mid-turn (observed
 * 2026-09-22 and 2026-09-29 — the fired copy evaporates and the message is
 * never seen).
 *
 * Drives the adapter exactly as Claude Code would: stdio MCP handshake, then
 * a UserPromptSubmit through the hook socket to open a turn, the toy server's
 * scripted traffic lands "mid-turn", then a Stop — and the boundary re-fire
 * must carry everything.
 *
 * Red on main: mid-turn wakes go out unmarked with the held ledger folded
 * into the (doomed) notification, and no re-fire follows the Stop.
 */
import { spawn } from 'child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const SESSION_KEY = `defer-${process.pid}`
const TMP = mkdtempSync(join(tmpdir(), 'mcpl-defer-'))
const CONFIG_COPY = join(TMP, 'config.json')
copyFileSync(join(ROOT, 'test', 'config.json'), CONFIG_COPY)
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))

const child = spawn('bun', ['run', 'src/main.ts'], {
  cwd: ROOT,
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_KEY, MCPL_BRIDGE_CONFIG: CONFIG_COPY },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr1 = ''
child.stderr.on('data', (d: Buffer) => {
  stderr1 += d.toString()
  process.stderr.write(`  | ${d}`)
})

let seq = 0
const pendingReq = new Map<number, (v: unknown) => void>()
const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
const notifWaiters: Array<() => void> = []

let buf = ''
child.stdout.on('data', (d: Buffer) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if ('id' in msg && !('method' in msg)) {
      const cb = pendingReq.get(msg.id as number)
      if (cb) {
        pendingReq.delete(msg.id as number)
        cb('error' in msg ? { __error: msg.error } : msg.result)
      }
    } else if ('method' in msg && !('id' in msg)) {
      notifications.push({ method: msg.method as string, params: (msg.params ?? {}) as Record<string, unknown> })
      for (const w of notifWaiters.splice(0)) w()
    } else if ('method' in msg && 'id' in msg) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
    }
  }
})

function request(method: string, params: unknown): Promise<unknown> {
  const id = ++seq
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000)
    pendingReq.set(id, v => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

async function waitForChannel(pred: (p: Record<string, unknown>) => boolean, label: string, ms = 10_000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const hit = notifications.find(n => n.method === 'notifications/claude/channel' && pred(n.params))
    if (hit) return hit.params
    if (Date.now() > deadline) {
      ok(false, `${label} (timed out)`)
      return null
    }
    await new Promise<void>(r => {
      const t = setTimeout(r, 250)
      notifWaiters.push(() => {
        clearTimeout(t)
        r()
      })
    })
  }
}

const meta = (p: Record<string, unknown>) => (p.meta ?? {}) as Record<string, string>

const sockPath = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME!, '.claude'), 'mcpl-bridge', `sock-${SESSION_KEY}.sock`)
function sendHook(event: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const t = setTimeout(() => reject(new Error('hook socket timeout')), 10_000)
    void Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(JSON.stringify({ kind: 'hook', event }) + '\n')
        },
        data(_s, d) {
          chunks.push(Buffer.from(d))
        },
        close() {
          clearTimeout(t)
          resolve(Buffer.concat(chunks).toString())
        },
        error(_s, e) {
          clearTimeout(t)
          reject(e)
        },
      },
    }).catch(reject)
  })
}

async function sendHookWithRetry(event: Record<string, unknown>, tries = 20): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await sendHook(event)
    } catch (e) {
      if (i >= tries) throw e
      await new Promise(r => setTimeout(r, 250))
    }
  }
}

try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'defer', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // Open a user turn NOW. handleHook awaits the MCPL handshakes and then sets
  // currentInferenceId synchronously — before the toy's scripted traffic
  // (which starts on the same settle) reaches its first emission at +500 ms.
  await sendHookWithRetry({ hook_event_name: 'UserPromptSubmit', session_id: 'defer-session', prompt: 'long review turn begins' })

  // The toy's wake-class traffic now lands mid-turn.
  const m1 = await waitForChannel(p => String(p.content).includes('hello from the toy lobby'), 'mid-turn wake still emits a (marked) notification')
  if (m1) {
    ok(meta(m1).deferred === '1', 'mid-turn wake notification carries meta.deferred="1"')
    ok(!String(m1.content).includes('<held'), 'the held ledger is not spent into the doomed mid-turn copy')
  }
  const mention = await waitForChannel(p => String(p.content).includes('toy human mention'), 'second mid-turn wake (push/event mention) emits marked')
  if (mention) ok(meta(mention).deferred === '1', 'push-event wake mid-turn is marked deferred too')

  // Let the whole script land (incl. the policy-held bot replies).
  for (let i = 0; i < 40 && !stderr1.includes('incoming(bot2) result'); i++) await new Promise(r => setTimeout(r, 250))

  // No unmarked wake for the mention may exist: the unmarked path is the one
  // the harness drops.
  const unmarked = notifications.some(
    n => n.method === 'notifications/claude/channel' && String(n.params.content).includes('toy human mention') && meta(n.params).deferred !== '1' && meta(n.params).kind !== 'deferred-wake-refire',
  )
  ok(!unmarked, 'no unmarked mid-turn wake was fired')

  // Turn ends: the boundary must re-deliver everything through one refire.
  await sendHookWithRetry({ hook_event_name: 'Stop', session_id: 'defer-session' })
  const refire = await waitForChannel(p => meta(p).kind === 'deferred-wake-refire' && meta(p).server === 'toy', 'boundary re-fire arrives for toy', 8_000)
  if (refire) {
    const c = String(refire.content)
    ok(c.includes('<held server="toy"'), 're-fire carries the held block')
    ok(c.includes('toy human mention') && c.includes('hello from the toy lobby'), 're-fire contains the deferred wakes')
    ok(c.includes('bot echo'), 'policy-held deliveries ride the same re-fire')
    ok(c.includes('(wake fired mid-turn'), 'deferred entries are marked in the render')
  }

  // toy2 (default wake policy) deferred mid-turn as well and re-fires too.
  const refire2 = await waitForChannel(p => meta(p).kind === 'deferred-wake-refire' && meta(p).server === 'toy2', 'boundary re-fire arrives for toy2', 8_000)
  if (refire2) ok(String(refire2.content).includes('bot echo'), 'toy2 (policy "all") deferred and re-fired its mid-turn wake')
} catch (e) {
  ok(false, `test threw: ${e instanceof Error ? e.message : e}`)
} finally {
  child.kill()
}

process.exit(failures ? 1 : 0)
