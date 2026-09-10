#!/usr/bin/env bun
/**
 * Smoke test: spawns the adapter exactly as Claude Code would (stdio MCP),
 * drives the MCP handshake, and asserts every bridged surface:
 *   tools proxying, channel push (channels/incoming + push/event + tag closure),
 *   hook socket (beforeInference → additionalContext, ungranted injection dropped),
 *   channels/publish via mcpl_send, inference/request via mcpl_answer,
 *   wake policy (held from-bot reply folded into the next wake / user turn),
 *   push/event origin → meta, channels/open + close via config and tools.
 */
import { spawn } from 'child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// Isolated session key so a real CC session's adapter (same env) can't collide.
const SESSION_KEY = `smoke-${process.pid}`
// A private copy of the config so the reload section can rewrite it.
const TMP = mkdtempSync(join(tmpdir(), 'mcpl-smoke-'))
const CONFIG_COPY = join(TMP, 'config.json')
copyFileSync(join(ROOT, 'test', 'config.json'), CONFIG_COPY)
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
const CHILD_ENV = {
  ...process.env,
  CLAUDE_CODE_SESSION_ID: SESSION_KEY,
  MCPL_BRIDGE_CONFIG: CONFIG_COPY,
  TOY_INFERENCE: '1',
}

const child = spawn('bun', ['run', 'src/main.ts'], {
  cwd: ROOT,
  env: CHILD_ENV,
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
      // server→client request (unexpected here) — answer empty
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

try {
  // ── MCP handshake ──
  const init = (await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  })) as { capabilities?: { experimental?: Record<string, unknown> } }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  ok(!!init.capabilities?.experimental?.['claude/channel'], 'declares claude/channel capability')

  // Give the bridge time to connect + handshake the toy server
  await new Promise(r => setTimeout(r, 2000))

  // ── Tools ──
  const tools = (await request('tools/list', {})) as { tools: Array<{ name: string }> }
  const names = tools.tools.map(t => t.name)
  ok(names.includes('toy__ping'), `proxied tool toy__ping listed (got: ${names.join(', ')})`)
  ok(names.includes('mcpl_status') && names.includes('mcpl_send') && names.includes('mcpl_answer'), 'bridge tools listed')

  const ping = (await request('tools/call', { name: 'toy__ping', arguments: { echo: 'x' } })) as { content: Array<{ text: string }> }
  ok(ping?.content?.[0]?.text === 'pong x', `toy__ping → "${ping?.content?.[0]?.text}"`)

  const status = (await request('tools/call', { name: 'mcpl_status', arguments: {} })) as { content: Array<{ text: string }> }
  const statusText = status?.content?.[0]?.text ?? ''
  ok(statusText.includes('toy: ready'), `mcpl_status shows ready: "${statusText.split('\n')[0]}"`)
  ok(/toy: .*channels=1\b/.test(statusText), 'mcpl_status counts registered channels instead of listing ids')
  ok(statusText.includes('channels.lifecycle'), 'channels.lifecycle is in the effective grant')
  ok(/toy: .*open=\[Toy Lobby\]/.test(statusText), 'openChannels config opened toy:lobby after channels/register (shown by label)')
  const chans = (await request('tools/call', { name: 'mcpl_channels', arguments: { server: 'toy' } })) as { content: Array<{ text: string }> }
  const chansText = chans?.content?.[0]?.text ?? ''
  ok(/^\* Toy Lobby — toy:lobby$/m.test(chansText), `mcpl_channels lists label — id with open marker: "${chansText.split('\n')[1]}"`)
  const chansFiltered = (await request('tools/call', { name: 'mcpl_channels', arguments: { filter: 'nope' } })) as { content: Array<{ text: string }> }
  ok(/toy: 0 of 1 channel/.test(chansFiltered?.content?.[0]?.text ?? ''), 'mcpl_channels filter narrows')
  ok(stderr1.includes('toy: open: toy:lobby'), 'toy server received channels/open')

  // ── Channel pushes ──
  const hello = await waitForChannel(p => meta(p).kind === 'channel-message', 'channels/incoming delivered as channel push')
  if (hello) {
    ok(String(hello.content).includes('hello from the toy lobby'), 'incoming message content intact')
    ok(meta(hello).channel === 'Toy Lobby', `incoming message carries the registered label (channel="${meta(hello).channel}")`)
    ok((meta(hello).tags ?? '').includes('chat:addressed'), `tag closure applied (tags="${meta(hello).tags}")`)
  }
  const push = await waitForChannel(p => meta(p).kind === 'push-event', 'push/event delivered as channel push')
  if (push) ok(String(push.content).includes('toy push event fired'), 'push event content intact')

  // ── Wake policy: toy is wake="chat", toy2 is the default ("all") ──
  await waitForChannel(p => meta(p).server === 'toy2' && String(p.content).includes('bot echo'), 'default policy (toy2) wakes on a from-bot reply')
  const mention = await waitForChannel(p => meta(p).server === 'toy' && String(p.content).includes('toy human mention'), 'from-human mention woke toy under wake="chat"')
  const leaked = notifications.find(
    n => n.method === 'notifications/claude/channel' && meta(n.params).server === 'toy' && String(n.params.content).includes('bot echo') && !String(n.params.content).includes('<held'),
  )
  ok(!leaked, 'wake="chat" held the from-bot reply instead of waking on it')
  if (mention) {
    const c = String(mention.content)
    ok(c.includes('<held server="toy" count="1"') && c.includes('bot echo') && c.indexOf('</held>') < c.indexOf('toy human mention'), 'held reply folded in ahead of the waking message')
    ok(meta(mention).held === '1', 'meta.held carries the folded count')
    ok(meta(mention).channel_id === 'toy:lobby' && meta(mention).message_id === 'toy-m3' && meta(mention).author === 'toyhuman', `push/event origin passed through as meta (channel_id=${meta(mention).channel_id} message_id=${meta(mention).message_id} author=${meta(mention).author})`)
    ok(meta(mention).native_channel_id === 'raw-lobby', 'native channel id kept beside the MCPL id')
  }

  // ── channels/open + close via tools ──
  const closed = (await request('tools/call', { name: 'mcpl_close', arguments: { server: 'toy', channel_id: 'toy:lobby' } })) as { content: Array<{ text: string }> }
  ok(closed?.content?.[0]?.text === 'closed Toy Lobby (toy:lobby)', `mcpl_close by id → "${closed?.content?.[0]?.text}"`)
  ok(stderr1.includes('toy: close: toy:lobby'), 'toy server received channels/close')
  // Label addressing: the label as printed, case-insensitively, with a leading # tolerated.
  const reopened = (await request('tools/call', { name: 'mcpl_open', arguments: { server: 'toy', channel_id: '#toy lobby' } })) as { content: Array<{ text: string }> }
  ok(reopened?.content?.[0]?.text === 'opened Toy Lobby (toy:lobby)', `mcpl_open by label → "${reopened?.content?.[0]?.text}"`)
  const status2 = (await request('tools/call', { name: 'mcpl_status', arguments: {} })) as { content: Array<{ text: string }> }
  ok(/toy: .*open=\[Toy Lobby\]/.test(status2?.content?.[0]?.text ?? ''), 'mcpl_status reflects the reopened channel')
  const unknown = (await request('tools/call', { name: 'mcpl_send', arguments: { server: 'toy', channel_id: 'toy lobbies', text: 'x' } })) as { isError?: boolean; content: Array<{ text: string }> }
  ok(unknown?.isError === true && /unknown channel "toy lobbies"/.test(unknown?.content?.[0]?.text ?? ''), `no fuzzy matching: "${unknown?.content?.[0]?.text}"`)

  // ── inference/request → mcpl_answer roundtrip ──
  const inf = await waitForChannel(p => meta(p).kind === 'inference-request' && meta(p).server === 'toy', 'inference/request delivered as channel push')
  if (inf) {
    const reqId = meta(inf).request_id
    const ans = (await request('tools/call', { name: 'mcpl_answer', arguments: { server: 'toy', request_id: reqId, content: 'marble' } })) as {
      content: Array<{ text: string }>
    }
    ok(ans?.content?.[0]?.text === 'answered', `mcpl_answer resolved pending request ${reqId}`)
  }

  // ── channels/publish via mcpl_send ──
  const sent = (await request('tools/call', { name: 'mcpl_send', arguments: { server: 'toy', channel_id: 'toy:lobby', text: 'hi toy' } })) as {
    content: Array<{ text: string }>
  }
  ok((sent?.content?.[0]?.text ?? '').startsWith('delivered'), `mcpl_send → "${sent?.content?.[0]?.text}"`)

  // ── Hook socket: UserPromptSubmit → beforeInference fan-out ──
  // The toy's second bot reply must be held before the hook fires for the flush assertion below.
  for (let i = 0; i < 40 && !stderr1.includes('incoming(bot2) result'); i++) await new Promise(r => setTimeout(r, 250))
  const sockPath = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME!, '.claude'), 'mcpl-bridge', `sock-${SESSION_KEY}.sock`)
  const hookReply = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const t = setTimeout(() => reject(new Error('hook socket timeout')), 8000)
    void Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(
            JSON.stringify({
              kind: 'hook',
              event: { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-session', prompt: 'what is up' },
            }) + '\n',
          )
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
  const hookJson = hookReply ? (JSON.parse(hookReply) as { hookSpecificOutput?: { additionalContext?: string } }) : {}
  const ctx = hookJson.hookSpecificOutput?.additionalContext ?? ''
  ok(ctx.includes('TOY-CONTEXT'), 'beforeInference injection reached additionalContext')
  ok(!ctx.includes('TOY-UNGRANTED'), 'ungranted afterUser injection was dropped')
  ok(ctx.includes('position="beforeUser"'), 'injection position preserved')
  ok(ctx.includes('<held server="toy" count="1"') && ctx.includes('bot echo 2'), 'held delivery flushed into UserPromptSubmit additionalContext')

  // ── Default grant: toy2 has no "grant" field ──
  ok(names.includes('toy2__ping'), 'default-grant server toy2 proxied its tool')
  ok(ctx.includes('server="toy2"'), 'default-grant server contributed beforeInference context')

  // ── Config reload: mcpl_reload tool + file watcher ──
  {
    const cfg = JSON.parse(readFileSync(CONFIG_COPY, 'utf8')) as { servers: Record<string, unknown> }
    const toy2 = cfg.servers.toy2
    delete cfg.servers.toy2
    cfg.servers.toy3 = { ...(toy2 as object), toolPrefix: 'three' }
    writeFileSync(CONFIG_COPY, JSON.stringify(cfg))
    // The watcher will also fire; the tool call must coalesce with it, not double-reconcile.
    const r = (await request('tools/call', { name: 'mcpl_reload', arguments: {} })) as { content: Array<{ text: string }> }
    const summary = r?.content?.[0]?.text ?? ''
    ok(/added \[toy3\]/.test(summary) && /removed \[toy2\]/.test(summary) && /changed \[—\]/.test(summary), `mcpl_reload reported the diff: ${summary.slice(0, 120)}`)
    await new Promise(r => setTimeout(r, 1500))
    const after = (await request('tools/list', {})) as { tools: Array<{ name: string }> }
    ok(after.tools.some(t => t.name === 'three__ping'), 'reload: added server proxied its tool')
    ok(!after.tools.some(t => t.name === 'toy2__ping'), 'reload: removed server\'s tools are gone')
    ok(after.tools.some(t => t.name === 'toy__ping'), 'reload: unchanged server untouched')
    const p3 = (await request('tools/call', { name: 'three__ping', arguments: { echo: 'reloaded' } })) as { content: Array<{ text: string }> }
    ok(p3?.content?.[0]?.text === 'pong reloaded', `reload: added server callable (got "${p3?.content?.[0]?.text}")`)
    // File watcher alone: put toy2 back, drop toy3, call nothing.
    delete cfg.servers.toy3
    cfg.servers.toy2 = toy2
    writeFileSync(CONFIG_COPY, JSON.stringify(cfg))
    await new Promise(r => setTimeout(r, 2500))
    const watched = (await request('tools/list', {})) as { tools: Array<{ name: string }> }
    ok(watched.tools.some(t => t.name === 'toy2__ping') && !watched.tools.some(t => t.name === 'three__ping'), 'config file watcher reloaded without a tool call')
    // A broken file is rejected whole; the fleet keeps running.
    writeFileSync(CONFIG_COPY, '{ this is not json')
    const bad = (await request('tools/call', { name: 'mcpl_reload', arguments: {} })) as { content: Array<{ text: string }> }
    ok(/rejected/.test(bad?.content?.[0]?.text ?? ''), 'reload: invalid config rejected, running config kept')
    const still = (await request('tools/list', {})) as { tools: Array<{ name: string }> }
    ok(still.tools.some(t => t.name === 'toy__ping') && still.tools.some(t => t.name === 'toy2__ping'), 'reload: fleet intact after rejected config')
    writeFileSync(CONFIG_COPY, JSON.stringify(cfg))
    await new Promise(r => setTimeout(r, 1000))
  }

  // ── Second instance (CC double-spawn) becomes a forwarding replica ──
  const child2 = spawn('bun', ['run', 'src/main.ts'], { cwd: ROOT, env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr2 = ''
  child2.stderr.on('data', (d: Buffer) => {
    stderr2 += d.toString()
    process.stderr.write(`  2| ${d}`)
  })
  let buf2 = ''
  let seq2 = 0
  const pending2 = new Map<number, (v: unknown) => void>()
  child2.stdout.on('data', (d: Buffer) => {
    buf2 += d.toString()
    let nl2
    while ((nl2 = buf2.indexOf('\n')) !== -1) {
      const line = buf2.slice(0, nl2)
      buf2 = buf2.slice(nl2 + 1)
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line)
        if ('id' in m && !('method' in m)) pending2.get(m.id as number)?.(m.result)
      } catch {}
    }
  })
  const request2 = (method: string, params: unknown): Promise<unknown> => {
    const id = ++seq2
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} (replica) timed out`)), 20_000)
      pending2.set(id, v => {
        clearTimeout(t)
        resolve(v)
      })
    })
  }
  try {
    await request2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke2', version: '0' } })
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await new Promise(r => setTimeout(r, 1000))
    ok(stderr2.includes('replica'), 'second instance detected primary and became replica')
    const tools2 = (await request2('tools/list', {})) as { tools: Array<{ name: string }> }
    ok(tools2.tools.some(t => t.name === 'toy__ping'), 'replica forwards tools/list to primary')
    const ping2 = (await request2('tools/call', { name: 'toy__ping', arguments: { echo: 'via-replica' } })) as { content: Array<{ text: string }> }
    ok(ping2?.content?.[0]?.text === 'pong via-replica', `replica forwards tools/call (got "${ping2?.content?.[0]?.text}")`)
    ok(!stderr2.includes('toy MCPL server up'), 'replica dialed no MCPL servers of its own')
  } finally {
    child2.kill()
  }
} catch (e) {
  ok(false, `unhandled: ${e instanceof Error ? e.message : e}`)
} finally {
  child.kill()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
