#!/usr/bin/env bun
/**
 * Smoke test: spawns the adapter exactly as Claude Code would (stdio MCP),
 * drives the MCP handshake, and asserts every bridged surface:
 *   tools proxying, channel push (channels/incoming + push/event + tag closure),
 *   hook socket (beforeInference → additionalContext, ungranted injection dropped),
 *   channels/publish via mcpl_send, inference/request via mcpl_answer,
 *   wake policy (held from-bot reply folded into the next wake / user turn),
 *   push/event origin → meta, channels/open + close via config and tools,
 *   server lifecycle (config "disabled", mcpl_enable / mcpl_disable, hot reload).
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
// The toy servers' "build": read once at spawn, so only a respawn sees a new one.
const BUILD_FILE = join(TMP, 'build')
writeFileSync(BUILD_FILE, 'v1')
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))
const CHILD_ENV = {
  ...process.env,
  CLAUDE_CODE_SESSION_ID: SESSION_KEY,
  MCPL_BRIDGE_CONFIG: CONFIG_COPY,
  TOY_INFERENCE: '1',
  TOY_BUILD_FILE: BUILD_FILE,
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

  // ── open-on-addressed: toy2 has no openChannels, so its lobby starts closed;
  //    the from-human mention push (chat:addressed) must open it. ──
  for (let i = 0; i < 40 && !stderr1.includes('toy2: opened Toy Lobby (addressed there)'); i++) await new Promise(r => setTimeout(r, 250))
  ok(stderr1.includes('toy2: opened Toy Lobby (addressed there)'), 'addressed push from a closed channel opened it (openOnAddressed default)')
  const statusAuto = (await request('tools/call', { name: 'mcpl_status', arguments: {} })) as { content: Array<{ text: string }> }
  ok(/toy2: .*open=\[Toy Lobby\]/.test(statusAuto?.content?.[0]?.text ?? ''), 'mcpl_status shows the auto-opened channel on toy2')
  const nativePush = await waitForChannel(p => meta(p).server === 'toy2' && String(p.content).includes('toy native-id mention'), 'native-id-only push delivered on toy2')
  if (nativePush) ok(meta(nativePush).channel_id === 'toy:lobby' && meta(nativePush).native_channel_id === 'raw-lobby', `native id mapped to the registered channel (channel_id=${meta(nativePush).channel_id} native=${meta(nativePush).native_channel_id})`)
  ok((stderr1.match(/toy2: opened Toy Lobby \(addressed there\)/g) ?? []).length === 1, 'the second addressed push did not open the channel again')

  // ── openChannelsOnly: toygate holds nothing open, so everything from its lobby is refused ──
  for (let i = 0; i < 40 && !stderr1.includes('toygate: dropped push from closed channel Toy Lobby (openChannelsOnly)'); i++) await new Promise(r => setTimeout(r, 250))
  ok(stderr1.includes('toygate: dropped push from closed channel Toy Lobby (openChannelsOnly)'), 'openChannelsOnly refused the addressed push from a closed channel')
  ok(stderr1.includes('toygate: dropped incoming from closed channel Toy Lobby (openChannelsOnly)'), 'openChannelsOnly refused channels/incoming from a closed channel')
  ok(!stderr1.includes('toygate: opened'), 'openChannelsOnly never auto-opens')
  ok(!notifications.some(n => n.method === 'notifications/claude/channel' && meta(n.params).server === 'toygate' && String(n.params.content).includes('toy native-id mention')), 'native-id-only push from the gated channel was refused too')
  ok(!notifications.some(n => n.method === 'notifications/claude/channel' && meta(n.params).server === 'toygate' && /toy human mention|hello from the toy lobby|bot echo/.test(String(n.params.content))), 'nothing from the gated channel reached the session')
  const statusGate = (await request('tools/call', { name: 'mcpl_status', arguments: {} })) as { content: Array<{ text: string }> }
  ok(/toygate: .*open=\[—\]/.test(statusGate?.content?.[0]?.text ?? ''), 'toygate still holds nothing open')

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

  // ── Server lifecycle: config "disabled", mcpl_enable / mcpl_disable, hot reload ──
  {
    type R = { isError?: boolean; content?: Array<{ text: string }> }
    const call = async (name: string, a: Record<string, unknown> = {}) => (await request('tools/call', { name, arguments: a })) as R
    const out = (r: R) => r?.content?.[0]?.text ?? ''
    const listed = async () => ((await request('tools/list', {})) as { tools: Array<{ name: string }> }).tools.map(t => t.name)
    const statusLine = async (id: string) => out(await call('mcpl_status')).split('\n').find(l => l.startsWith(`${id}: `)) ?? ''
    const pidOf = (line: string) => Number(/\bpid=(\d+)/.exec(line)?.[1] ?? 0)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const waitFor = async (pred: () => Promise<boolean>, ms = 5000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await pred()) return true
      return false
    }

    // The watcher step above may not have landed (FSEvents can lag badly): start from the file as written.
    await call('mcpl_reload')
    await new Promise(r => setTimeout(r, 1500))

    // Configured with "disabled": true — listed, not started.
    ok(!(await listed()).some(n => n.startsWith('toyoff__')), 'config-disabled server proxies no tools')
    const offLine = await statusLine('toyoff')
    ok(/^toyoff: disabled \(config/.test(offLine), `mcpl_status lists the config-disabled server ("${offLine}")`)
    const offCall = await call('toyoff__ping')
    ok(offCall.isError === true && /server toyoff is disabled/.test(out(offCall)), `a call into a disabled server says so: "${out(offCall)}"`)

    // mcpl_enable: a session-scoped start.
    const en = await call('mcpl_enable', { server: 'toyoff' })
    ok(!en.isError && /^toyoff: enabled — ready, \d+ tools?/.test(out(en)) && /this session only/.test(out(en)), `mcpl_enable started it: "${out(en)}"`)
    ok((await listed()).includes('toyoff__ping'), "enabled server's tools listed")
    ok(out(await call('toyoff__ping', { echo: 'on' })) === 'pong on', 'enabled server callable')
    ok(/enabled this session \(config: disabled\)/.test(await statusLine('toyoff')), 'mcpl_status marks the session override')
    ok(/already enabled/.test(out(await call('mcpl_enable', { server: 'toyoff' }))), 'enabling an enabled server is a no-op')

    // mcpl_disable: process stopped, tools withdrawn; on a config-disabled server the override just goes.
    const toy2Pid = pidOf(await statusLine('toy2'))
    const dis = await call('mcpl_disable', { server: 'toy2, toyoff' })
    ok(/^toy2: disabled — \d+ tools? withdrawn.*this session only/m.test(out(dis)), `mcpl_disable toy2: "${out(dis).split('\n')[0]}"`)
    ok(/^toyoff: disabled — /m.test(out(dis)) && !/toyoff: .*this session only/.test(out(dis)), 'disabling a config-disabled server drops the override (back to the config)')
    ok(!(await listed()).some(n => n.startsWith('toy2__') || n.startsWith('toyoff__')), "disabled servers' tools withdrawn")
    ok(toy2Pid > 0 && !alive(toy2Pid), `disabled stdio server's process is gone (pid ${toy2Pid})`)
    ok(/^toy2: disabled \(this session/.test(await statusLine('toy2')), 'mcpl_status says disabled by this session')
    await call('mcpl_reload')
    ok(/^toy2: disabled \(this session/.test(await statusLine('toy2')), 'a config reload does not undo a session override')
    const en2 = await call('mcpl_enable', { server: 'toy2' })
    ok(/^toy2: enabled — ready/.test(out(en2)) && !/this session only/.test(out(en2)), `re-enabled toy2, override cleared: "${out(en2)}"`)
    ok((await listed()).includes('toy2__ping'), "re-enabled server's tools are back")

    // Hot reload: the respawn runs the new build; a channel opened this session survives it.
    ok(out(await call('toygate__build')).startsWith('build v1'), 'toygate runs build v1')
    await call('mcpl_open', { server: 'toygate', channel_id: 'Toy Lobby' })
    writeFileSync(BUILD_FILE, 'v2')
    ok(out(await call('toygate__build')).startsWith('build v1'), 'a running server keeps its build until respawned')
    const gatePid = pidOf(await statusLine('toygate'))
    const hot = await call('mcpl_reload', { server: 'toygate' })
    ok(!hot.isError && /^toygate: reloaded — ready, \d+ tools?, pid \d+ \(pid \d+ → \d+\)$/m.test(out(hot)), `mcpl_reload server=toygate: "${out(hot).split('\n').slice(1).join(' | ')}"`)
    ok(gatePid > 0 && !alive(gatePid), `old toygate process reaped before the respawn (pid ${gatePid})`)
    ok(out(await call('toygate__build')).startsWith('build v2'), 'hot-reloaded server runs the new build')
    ok(await waitFor(async () => /toygate: .*open=\[Toy Lobby\]/.test(await statusLine('toygate'))), 'channel opened this session is re-opened after the hot reload')
    const all = await call('mcpl_reload', { server: '*' })
    const reloadedIds = out(all).split('\n').slice(1).map(l => l.split(':')[0])
    ok(!all.isError && reloadedIds.includes('toy') && reloadedIds.includes('toy2') && reloadedIds.includes('toygate') && !reloadedIds.includes('toyoff'), `server="*" reloads every enabled server, no disabled one (${reloadedIds.join(', ')})`)
    ok(/toyoff: disabled — not reloaded/.test(out(await call('mcpl_reload', { server: 'toyoff' }))), 'hot reload of a disabled server points at mcpl_enable')
    const bogus = await call('mcpl_reload', { server: 'nosuch' })
    ok(bogus.isError === true && /unknown server: nosuch \(configured: /.test(out(bogus)), `unknown server id rejected: "${out(bogus).split('\n').pop()}"`)

    // A server that dies on startup: the failure and its stderr come back in the result.
    const crash = await call('mcpl_enable', { server: 'toycrash' })
    ok(crash.isError === true && /toycrash: enabled — disconnected/.test(out(crash)) && /cannot find module/.test(out(crash)) && /\[exited code 3\]/.test(out(crash)), `crash on startup reported with its stderr: "${out(crash).replace(/\n\s*/g, ' | ')}"`)
    const nocmd = await call('mcpl_enable', { server: 'toynocmd' })
    ok(nocmd.isError === true && /toynocmd: enabled — disconnected/.test(out(nocmd)), `unspawnable command reported, not fatal: "${out(nocmd).replace(/\n\s*/g, ' | ')}"`)
    ok(/^toy: ready/m.test(out(await call('mcpl_status'))), 'bridge still serving after the failed spawns')
    await call('mcpl_disable', { server: 'toycrash,toynocmd' })

    // Flipping "disabled" in the config switches a server on or off in place.
    const cfgL = JSON.parse(readFileSync(CONFIG_COPY, 'utf8')) as { servers: Record<string, Record<string, unknown>> }
    delete cfgL.servers.toyoff.disabled
    writeFileSync(CONFIG_COPY, JSON.stringify(cfgL))
    // Named in the same call: the reload's own start is awaited and reported, not restarted on top.
    const flipOn = out(await call('mcpl_reload', { server: 'toyoff' }))
    ok(/ enabled \[toyoff\]/.test(flipOn) && /changed \[—\]/.test(flipOn), `"disabled" removed → enabled in place: "${flipOn.split('\n')[0].slice(flipOn.indexOf('added'))}"`)
    ok(/^toyoff: reconnected by the config change — ready/m.test(flipOn), `hot reload named with the flip waits on the reload's own start: "${flipOn.split('\n')[1]}"`)
    ok(await waitFor(async () => (await listed()).includes('toyoff__ping')), 'config-enabled server proxied its tools')
    cfgL.servers.toyoff.disabled = true
    writeFileSync(CONFIG_COPY, JSON.stringify(cfgL))
    const flipOff = out(await call('mcpl_reload'))
    ok(/ disabled \[toyoff\]/.test(flipOff), `"disabled": true → stopped in place: "${flipOff.slice(flipOff.indexOf('added'))}"`)
    ok(!(await listed()).includes('toyoff__ping'), 'config-disabled server withdrew its tools')
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
