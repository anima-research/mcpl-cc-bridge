/**
 * MCPL RFC-014 r2 host side against the real go-mcpl (surfaces-mcpl's native
 * r2 server): the RFC §13 behaviours a host can show, over stdio and ws, two
 * agents playing each other, and the whole adapter — constant tool list,
 * pushes rendered into channel notifications, the compaction reminder.
 *
 * Opt-in: MCPL_GO_SERVER=<surfaces-mcpl>/dist/src/servers/go/main.js, with
 * node >= 22 from MCPL_GO_NODE or PATH. Data goes to temp dirs ($MCPL_TEST_TMP
 * or the OS tmpdir); every process started here is killed by pid.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callMetaTool } from '../src/meta-tools'
import { McplServerHandle, type IncomingDelivery } from '../src/mcpl-host'
import { keyOf } from '../src/presence'
import { WakeGate } from '../src/wake'

const GO = process.env.MCPL_GO_SERVER
const NODE = process.env.MCPL_GO_NODE ?? 'node'
const ROOT = join(import.meta.dir, '..')
const go = test.skipIf(!GO)
if (!GO) console.error('go-hints: skipped (set MCPL_GO_SERVER to surfaces-mcpl dist/src/servers/go/main.js)')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitFor = async (cond: () => boolean, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n')

let base = ''
const procs: ChildProcess[] = []
const handles: McplServerHandle[] = []
let wsPort = 0

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function startWsGo(): Promise<number> {
  const port = await freePort()
  const home = join(base, `go-ws-${port}`)
  mkdirSync(home, { recursive: true })
  const p = spawn(NODE, [GO!, '--ws', String(port)], { env: { ...process.env, GO_MCPL_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] })
  procs.push(p)
  let err = ''
  p.stderr?.on('data', d => (err += d))
  await waitFor(() => err.includes('listening'), 10_000, 'go-mcpl --ws to listen')
  return port
}

type Box = { h: McplServerHandle; delivered: IncomingDelivery[]; toolsChanged: () => number; map: Map<string, McplServerHandle> }
async function connect(transport: Record<string, unknown>): Promise<Box> {
  const delivered: IncomingDelivery[] = []
  let n = 0
  const h = new McplServerHandle('go', { transport: transport as never, grant: ['tools', 'pushEvents'], reconnectIntervalMs: 200 }, {
    deliver: d => delivered.push(d),
    toolsChanged: () => n++,
    log: () => {},
  })
  handles.push(h)
  h.start()
  await h.firstAttempt
  expect(h.status).toBe('ready')
  return { h, delivered, toolsChanged: () => n, map: new Map([['go', h]]) }
}
const stdioGo = (home: string) => ({ command: NODE, args: [GO!, '--stdio'], env: { GO_MCPL_HOME: home } })

beforeAll(async () => {
  if (!GO) return
  base = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-go-hints-'))
  wsPort = await startWsGo()
}, 20_000)

afterAll(async () => {
  for (const h of handles) await h.close()
  for (const p of procs) if (p.pid && p.exitCode === null) process.kill(p.pid, 'SIGTERM')
  await sleep(200)
  if (base) rmSync(base, { recursive: true, force: true })
})

go('stdio: surface mode lists nothing; open/act/look/close; instances carried on calls; a visibility change rendered; the tool list never changes', async () => {
  const { h, map, toolsChanged } = await connect(stdioGo(join(base, 'stdio-1')))
  expect(h.presence.surface?.title).toBe('Go')
  expect(h.listedTools()).toEqual([])
  const n = toolsChanged()

  const o = textOf(await callMetaTool('open', { server: 'go', instance: 'first', options: { level: 'easy' } }, map))
  expect(o).toStartWith('[go/game:first] Go 9×9 — you are Black, vs bot (easy)\n    A B C D E F G H J')
  expect(o).toContain('Your move.\ntools now — act {server:"go", instance:"first", tool, args}:\n  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".')
  expect(o).toEndWith('close {server:"go", toolset:"game", instance:"first"} closes it.')

  // one instance open: act fills it in (RFC §5.5 _meta["mcpl/instance"])
  const a1 = await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'E5' } }, map)
  expect(a1.isError).toBeUndefined()
  expect(textOf(a1)).toMatch(/^You played E5\.\nWhite \(bot\) plays [A-J]\d\./)

  // two instances (vector 5): the server names the second
  const o2 = textOf(await callMetaTool('open', { server: 'go', options: { level: 'easy' } }, map))
  expect(o2).toStartWith('[go/game:game-1] Go 9×9')
  const ambiguous = await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'D4' } }, map)
  expect(ambiguous.isError).toBe(true)
  expect(textOf(ambiguous)).toBe('several game instances are open (first, game-1) — say which with instance')
  const a2 = await callMetaTool('act', { server: 'go', tool: 'play', instance: 'game-1', args: { point: 'D4' } }, map)
  expect(textOf(a2)).toStartWith('You played D4.')
  // look at one instance: its tools, described in full (a re-publish)
  expect(textOf(await callMetaTool('look', { server: 'go', instance: 'first' }, map))).toBe(
    '[go/game:first] Go 9×9 — you are Black, vs bot (easy) tools now — act {server:"go", instance:"first", tool, args}:\n' +
      '  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".\n' +
      '  pass() — Pass.\n  resign() — Resign the game.\n  undo() — Take back your last move and the bot\'s reply.\n' +
      'close {server:"go", toolset:"game", instance:"first"} closes it.',
  )

  // resigning changes what is visible: rendered after the server's own text, in the result
  const r = textOf(await callMetaTool('act', { server: 'go', tool: 'resign', instance: 'first' }, map))
  expect(r).toStartWith('You resigned. White wins (W+R).\n')
  expect(r).toEndWith('[go/game:first] tools now — act {server:"go", instance:"first", tool, args}:\n  rematch() — Play again with the same settings and colors swapped.\n  sgf() — The game record in SGF.\nnow unavailable: play, pass, resign, undo')

  const catalog = textOf(await callMetaTool('look', {}, map))
  expect(catalog).toContain('go — Go: Go on 9×9, 13×13 or 19×19, against a Monte Carlo bot or another agent. (everything through open/act/look/close)')
  expect(catalog).toContain('  [go/game:first] Go 9×9 — you are Black, vs bot (easy) tools now — act {server:"go", instance:"first", tool, args}:')
  expect(catalog).toContain('can open — open {server:"go", toolset, instance?, options?}:\n  game — Go: A game of Go against the bot or another agent (several can be open at once; name each with instance); options {size?: 9|13|19 =9, color?: "black"|"white"|"random" =')
  expect(catalog).toContain('tools — act {server:"go", tool, args}:\n  games()')
  const def = textOf(await callMetaTool('look', { server: 'go', tool: 'play' }, map))
  expect(def).toStartWith('play(point: string)\nPlace a stone')
  expect(def).toContain('"pattern"')
  expect(def).toEndWith('available now in go/game:game-1 — act {server:"go", tool:"play", args}')

  const c = textOf(await callMetaTool('close', { server: 'go', instance: 'first' }, map))
  expect(c).toBe('[go/game:first] closed. Now unavailable: rematch, sgf.')
  expect(h.presence.openRecords().map(o => o.instance)).toEqual(['game-1'])
  expect(toolsChanged()).toBe(n) // the tool list never moved
}, 30_000)

go('stdio: a respawned server lost its instances — the host says so instead of re-opening a fresh game under the old name', async () => {
  const { h, map, delivered } = await connect(stdioGo(join(base, 'stdio-2')))
  await callMetaTool('open', { server: 'go', instance: 'lost', options: { level: 'easy' } }, map)
  await h.restart() // kill + respawn: a new process, no games
  await waitFor(() => delivered.length > 0, 5000, 'the reconnect notice')
  expect(delivered[0]!.meta.tags).toBe('surface:tools')
  expect(delivered[0]!.text).toBe('[go/game:lost] is gone — go did not keep it across the reconnect. open {server:"go", toolset:"game"} starts a new one.')
  expect(delivered).toHaveLength(1)
  expect(h.presence.openRecords()).toEqual([])
}, 20_000)

go('ws: after a reconnect, toolsets/list is adopted — the kept game is not opened a second time (vector 9)', async () => {
  const { h, map, delivered } = await connect({ url: `ws://127.0.0.1:${wsPort}/mcpl?name=solo` })
  await callMetaTool('open', { server: 'go', instance: 'kept', options: { level: 'easy' } }, map)
  await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'C3' } }, map)
  await h.restart()
  expect(h.status).toBe('ready')
  expect(h.presence.openRecords().map(o => o.instance)).toEqual(['kept'])
  expect([...h.presence.view().get(keyOf('game', 'kept'))!.tools.keys()]).toEqual(['play', 'pass', 'resign', 'undo'])
  expect(delivered).toEqual([]) // nothing changed for the model
  const next = textOf(await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'G7' } }, map))
  expect(next).toStartWith('You played G7.') // the same game, move 3
}, 20_000)

go('ws, agent vs agent: a move arrives as a push and the visibility change is rendered into it', async () => {
  const ada = await connect({ url: `ws://127.0.0.1:${wsPort}/mcpl?name=ada` })
  const bo = await connect({ url: `ws://127.0.0.1:${wsPort}/mcpl?name=bo` })
  const opened = textOf(await callMetaTool('open', { server: 'go', instance: 'g', options: { opponent: 'agent' } }, ada.map))
  const code = opened.match(/join:"(go-[0-9a-f]+)"/)![1]
  expect(opened).toContain('tools now — act {server:"go", instance:"g", tool, args}:\n  cancel() — Withdraw the game before anyone joins.')
  const joined = textOf(await callMetaTool('open', { server: 'go', instance: 'g', options: { join: code } }, bo.map))
  expect(joined).toContain('[go/game:g] Go 9×9 — you are White, vs ada')
  expect(joined).toContain('tools now — act {server:"go", instance:"g", tool, args}:\n  resign() — Resign the game.')

  await waitFor(() => ada.delivered.length === 1, 5000, "ada's join event")
  const join = ada.delivered[0]!
  expect(join.meta).toMatchObject({ toolset: 'game', instance: 'g' })
  expect(join.meta.tags).toContain('surface:turn')
  expect(new WakeGate(undefined).decide(join)).toBe('wake')
  expect(join.text).toStartWith('bo joined as White. Your move.\n    A B C D E F G H J')
  // (the title the open announced still stands: the server sends no toolsets entry when an opponent joins)
  expect(join.text).toEndWith(
    'Your move.\n[go/game:g] tools now — act {server:"go", instance:"g", tool, args}:\n' +
      '  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".\n' +
      '  pass() — Pass.\n  resign() — Resign the game.\nnow unavailable: cancel',
  )

  const mine = textOf(await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'D4' } }, ada.map))
  expect(mine).toStartWith('You played D4.\n')
  expect(mine).toEndWith('[go/game:g] tools now — act {server:"go", instance:"g", tool, args}:\n  resign()\nnow unavailable: play, pass')

  await waitFor(() => bo.delivered.length === 1, 5000, "bo's move event")
  const move = bo.delivered[0]!
  expect(move.meta.tags).toContain('surface:turn')
  expect(move.text).toStartWith('Black played D4. Your move.\n')
  expect(move.text).toEndWith('[go/game:g] tools now — act {server:"go", instance:"g", tool, args}:\n  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".\n  pass() — Pass.\n  resign()')

  // bo leaves: ada gets the forfeit as surface:done with rematch/sgf
  await callMetaTool('close', { server: 'go', instance: 'g' }, bo.map)
  await waitFor(() => ada.delivered.length === 2, 5000, "ada's game-over event")
  expect(ada.delivered[1]!.meta.tags).toContain('surface:done')
  expect(ada.delivered[1]!.text).toContain('rematch() — Play again with the same settings and colors swapped.')
}, 30_000)

// ── the whole adapter ──

go('adapter: the tool list is constant (no list_changed) through a game; a push from the other player arrives rendered; compaction brings a reminder', async () => {
  const cc = join(base, 'cc')
  mkdirSync(cc, { recursive: true })
  const cfgPath = join(base, 'bridge.json')
  writeFileSync(cfgPath, JSON.stringify({ servers: { go: { transport: { url: `ws://127.0.0.1:${wsPort}/mcpl?name=cc` }, grant: ['tools', 'pushEvents'] } } }))
  const session = `go-hints-${process.pid}`
  const child = spawn('bun', ['run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MCPL_BRIDGE_CONFIG: cfgPath, CLAUDE_CONFIG_DIR: cc, CLAUDE_CODE_SESSION_ID: session, MCPL_BRIDGE_WATCH: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  procs.push(child)
  const msgs: Array<Record<string, unknown>> = []
  let buf = ''
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) msgs.push(JSON.parse(line))
    }
  })
  let seq = 0
  const call = async (method: string, params: unknown) => {
    const id = ++seq
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await waitFor(() => msgs.some(m => m.id === id), 15_000, `${method} answer\n${stderr.slice(-1500)}`)
    return msgs.find(m => m.id === id)!.result as Record<string, unknown>
  }
  const tool = async (name: string, args: Record<string, unknown>) => (await call('tools/call', { name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean }
  const listChanged = () => msgs.filter(m => m.method === 'notifications/tools/list_changed').length
  const channel = () => msgs.filter(m => m.method === 'notifications/claude/channel').map(m => m.params as { content: string; meta: Record<string, string> })

  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'go-hints', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const names = ((await call('tools/list', {})).tools as Array<{ name: string; _meta?: Record<string, unknown> }>)
  expect(names.map(t => t.name).filter(n => !n.startsWith('mcpl_'))).toEqual(['open', 'act', 'look', 'close'])
  expect(names.find(t => t.name === 'look')?._meta?.['mcpl/class']).toEqual(['control'])
  await sleep(400)
  const baseline = listChanged()

  const opened = textOf(await tool('open', { server: 'go', instance: 'm', options: { opponent: 'agent' } }))
  const code = opened.match(/join:"(go-[0-9a-f]+)"/)![1]
  const bo = await connect({ url: `ws://127.0.0.1:${wsPort}/mcpl?name=bo2` })
  await callMetaTool('open', { server: 'go', instance: 'm', options: { join: code } }, bo.map)
  await waitFor(() => channel().length >= 1, 5000, 'the join notification')
  expect(channel()[0]!.meta).toMatchObject({ server: 'go', kind: 'push-event', toolset: 'game', instance: 'm' })
  expect(channel()[0]!.content).toContain('bo2 joined as White. Your move.')
  expect(channel()[0]!.content).toContain('Your move.\n[go/game:m] tools now — act {server:"go", instance:"m", tool, args}:\n  play(point: string) — Place a stone')

  const mine = textOf(await tool('act', { server: 'go', tool: 'play', args: { point: 'E5' } }))
  expect(mine).toContain('now unavailable: play, pass')
  await waitFor(() => bo.delivered.length >= 1, 5000, "bo2's move event")
  await callMetaTool('act', { server: 'go', tool: 'play', args: { point: 'C3' } }, bo.map)
  await waitFor(() => channel().length >= 2, 5000, 'the reply notification')
  const reply = channel()[1]!
  expect(reply.meta.tags).toContain('surface:turn')
  expect(reply.content).toStartWith('White played C3. Your move.\n')
  expect(reply.content).toEndWith('[go/game:m] tools now — act {server:"go", instance:"m", tool, args}:\n  play(point: string)\n  pass()\n  resign()')

  // compaction: Claude Code runs SessionStart hooks with source "compact"; the reply's additionalContext is the reminder
  const sock = join(cc, 'mcpl-bridge', `sock-${session}.sock`)
  const hook = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    Bun.connect({
      unix: sock,
      socket: {
        open: s => void s.write(JSON.stringify({ kind: 'hook', event: { hook_event_name: 'SessionStart', source: 'compact', session_id: session } }) + '\n'),
        data: (_s, d) => void chunks.push(Buffer.from(d)),
        close: () => resolve(Buffer.concat(chunks).toString('utf8')),
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })
  const out = JSON.parse(hook) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(out.hookSpecificOutput.additionalContext).toBe(
    [
      '<mcpl-tools reason="compact">',
      'Open MCPL toolsets — call their tools with act (they are not in your tool list); look shows this again any time:',
      '[go/game:m] Go 9×9 — you are Black, vs bo2 tools now — act {server:"go", instance:"m", tool, args}:',
      '  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".',
      '  pass() — Pass.',
      '  resign() — Resign the game.',
      '  close {server:"go", toolset:"game", instance:"m"} closes it.',
      '</mcpl-tools>',
    ].join('\n'),
  )

  await tool('close', { server: 'go', instance: 'm' })
  expect(listChanged()).toBe(baseline) // vector: the tool list stayed constant through open, act, pushes and close
  const again = ((await call('tools/list', {})).tools as Array<{ name: string }>).map(t => t.name)
  expect(again).toEqual(names.map(t => t.name))
  child.stdin.end()
  await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)])
}, 45_000)
