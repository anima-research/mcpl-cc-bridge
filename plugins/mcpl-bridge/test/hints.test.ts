/**
 * MCPL RFC-014 r2 host side, without go-mcpl: the presence state and its one
 * apply path, rendering, the wake defaults, and a real McplServerHandle
 * against a scripted peer for what go-mcpl cannot be made to do (a stale rev,
 * a suggestion, an undeclared toolset, a server without hints).
 */
import { afterEach, expect, test } from 'bun:test'
import type { ServerConfig } from '../src/config'
import { callMetaTool } from '../src/meta-tools'
import { McplServerHandle, type IncomingDelivery } from '../src/mcpl-host'
import { ToolPresence, keyOf } from '../src/presence'
import { firstSentence, renderToolLines, signature } from '../src/tool-render'
import { WakeGate } from '../src/wake'
import { McplPeer } from './mcpl-peer'

const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties: props, required })
const dyn = (name: string, description: string, toolset?: string, inputSchema = obj(), visible?: boolean) => ({
  name,
  description,
  inputSchema,
  _meta: { 'mcpl/presence': 'dynamic', ...(toolset ? { 'mcpl/toolset': toolset } : {}), ...(visible !== undefined ? { 'mcpl/visible': visible } : {}) },
})

// ── rendering ──

test('signatures: enums as "a"|"b", ranges as int 1..7, optional and defaults marked; first sentence only', () => {
  expect(signature({ name: 'play', inputSchema: obj({ point: { type: 'string' } }, ['point']) })).toBe('play(point: string)')
  expect(signature({ name: 'pick', inputSchema: obj({ suit: { enum: ['a', 'b'] }, n: { type: 'integer', minimum: 1, maximum: 7 } }, ['suit']) })).toBe('pick(suit: "a"|"b", n?: int 1..7)')
  expect(signature({ name: 'mark', inputSchema: obj({ points: { type: 'array', items: { type: 'string' }, maxItems: 40 }, size: { enum: [9, 13], default: 9 } }) })).toBe('mark(points?: string[≤40], size?: 9|13 =9)')
  expect(firstSentence('Place a stone: column letter then row, e.g. "D4". Passing is separate.')).toBe('Place a stone: column letter then row, e.g. "D4".')
  const shown = new Set<string>()
  const t = dyn('pass', 'Pass. Two passes end play.')
  expect(renderToolLines([t], shown)).toEqual(['  pass() — Pass.'])
  expect(renderToolLines([t], shown)).toEqual(['  pass()']) // said once
  expect(renderToolLines([{ ...t, description: 'Pass your turn.' }], shown)).toEqual(['  pass() — Pass your turn.']) // a changed definition is said again
})

// ── presence: the one apply path ──

function goLike(): ToolPresence {
  const p = new ToolPresence('go')
  p.beginConnection({ toolHints: true, toolsets: { game: { title: 'Go', summary: 'A game', default: 'closed', instances: true } }, surface: { title: 'Go', summary: 'Games' } }, true)
  p.setTools([
    { name: 'games', description: 'Waiting games.', inputSchema: obj(), _meta: { 'mcpl/presence': 'static' } },
    dyn('play', 'Place a stone.', 'game', obj({ point: { type: 'string' } }, ['point']), false),
    dyn('pass', 'Pass.', 'game', obj(), false),
    dyn('rematch', 'Play again.', 'game', obj(), false),
  ])
  return p
}

test('hint changes apply in rev order; a stale rev is ignored; visibility is per instance; open/closed from toolsets entries', () => {
  const p = goLike()
  expect(p.presents).toBe(true)
  expect(p.presenceOf('games')).toBe('static')
  expect(p.presenceOf('play')).toBe('dynamic')
  const before = p.view()
  expect(p.apply({ rev: 2, toolsets: [{ toolset: 'game', instance: 'a', state: 'open', title: 'Go vs bot' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'pass', instance: 'a', visible: true }] })).toMatchObject({ applied: true })
  const cs = p.diff(before, p.view())
  expect(cs.changes).toHaveLength(1)
  expect(cs.changes[0]).toMatchObject({ key: keyOf('game', 'a'), opened: true, title: 'Go vs bot' })
  expect(cs.changes[0]!.appeared.map(t => t.name)).toEqual(['play', 'pass'])
  // rev 1 after 2: out of order, never applied — stale (what it said may be missing)
  expect(p.apply({ rev: 1, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, stale: true, duplicate: false })
  // rev 2 again: already applied — a duplicate, each rev applies once (RFC §6.1)
  expect(p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, stale: false, duplicate: true })
  expect([...p.view().get(keyOf('game', 'a'))!.tools.keys()]).toEqual(['play', 'pass'])
  // a second instance is separate
  p.apply({ rev: 3, toolsets: [{ toolset: 'game', instance: 'b', state: 'open' }], tools: [{ name: 'rematch', instance: 'b', visible: true }] })
  expect([...p.view().get(keyOf('game', 'b'))!.tools.keys()]).toEqual(['rematch'])
  expect([...p.view().get(keyOf('game', 'a'))!.tools.keys()]).toEqual(['play', 'pass'])
  // the server closes one
  const b2 = p.view()
  p.apply({ rev: 4, toolsets: [{ toolset: 'game', instance: 'a', state: 'closed' }] })
  const closed = p.diff(b2, p.view())
  expect(closed.changes[0]).toMatchObject({ closed: true, gone: ['play', 'pass'] })
  expect(p.render(closed)).toBe('[go/game:a] closed. Now unavailable: play, pass.')
  // malformed changes are not applied
  expect(p.apply({ tools: [] })).toMatchObject({ applied: false, stale: false, duplicate: false })
  // a retitle: "open" again, with a new title, for one already open
  const b3 = p.view()
  p.apply({ rev: 5, toolsets: [{ toolset: 'game', instance: 'b', state: 'open', title: 'Go vs bo' }] })
  expect(p.render(p.diff(b3, p.view()))).toBe('[go/game:b] Go vs bo')
  // tools/list's mcpl/rev covers what came before it: earlier revs are duplicates, not losses
  p.noteListRev(9)
  expect(p.apply({ rev: 8 })).toMatchObject({ duplicate: true, stale: false })
  expect(p.apply({ rev: 10 }).applied).toBe(true)
  // a new connection starts revs over
  p.beginConnection({ toolHints: true, toolsets: { game: { instances: true } } }, true)
  expect(p.apply({ rev: 1 }).applied).toBe(true)
})

test('rendering a change: tools now (first sentence once), now unavailable, suggestions never acted on', () => {
  const p = goLike()
  let before = p.view()
  p.apply({ rev: 1, toolsets: [{ toolset: 'game', instance: 'a', state: 'open', title: 'Go 9×9' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'pass', instance: 'a', visible: true }] })
  expect(p.render(p.diff(before, p.view()))).toBe(
    ['[go/game:a] Go 9×9 tools now — act {server:"go", instance:"a", tool, args}:', '  play(point: string) — Place a stone.', '  pass() — Pass.', 'close {server:"go", toolset:"game", instance:"a"} closes it.'].join('\n'),
  )
  before = p.view()
  p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', visible: false }, { name: 'pass', instance: 'a', visible: false }, { name: 'rematch', instance: 'a', visible: true }], suggest: [{ toolset: 'game', action: 'open', reason: 'bo challenges you' }] })
  const cs = p.diff(before, p.view())
  cs.suggest.push({ toolset: 'game', action: 'open', reason: 'bo challenges you' })
  expect(p.render(cs)).toBe(
    [
      '[go/game:a] tools now — act {server:"go", instance:"a", tool, args}:',
      '  rematch() — Play again.',
      'now unavailable: play, pass',
      'go suggests opening game: bo challenges you — open {server:"go", toolset:"game"} if you want to (nothing was done).',
    ].join('\n'),
  )
  // play comes back: signature only now, it was described before
  before = p.view()
  p.apply({ rev: 3, tools: [{ name: 'play', instance: 'a', visible: true }] })
  expect(p.render(p.diff(before, p.view()))).toContain('\n  play(point: string)\n')
  // after compaction everything is described again
  p.forgetShown()
  expect(p.reminder()).toContain('play(point: string) — Place a stone.')
})

test('a definition change reaches the view without a tools/list (RFC §13 vector 7)', () => {
  const p = goLike()
  p.apply({ rev: 1, toolsets: [{ toolset: 'game', instance: 'a', state: 'open' }], tools: [{ name: 'play', instance: 'a', visible: true }] })
  const before = p.view()
  p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', definition: { name: 'play', description: 'Place a stone.', inputSchema: obj({ point: { enum: ['D4', 'E5'] } }, ['point']) } }] })
  const cs = p.diff(before, p.view())
  expect(cs.changes[0]!.redefined.map(t => t.name)).toEqual(['play'])
  expect(p.render(cs)).toContain('play(point: "D4"|"E5")')
})

test('undeclared toolset: the host opens it, and a tool shows only while open AND server-visible (RFC §5.4, §13 vector 10)', () => {
  const p = new ToolPresence('eido')
  p.beginConnection({ toolHints: true }, true)
  p.setTools([
    { name: 'look', description: 'Look.', inputSchema: obj() },
    dyn('place', 'Place a block.', 'builder', obj(), true),
    dyn('paint', 'Paint.', 'builder', obj(), false),
  ])
  expect(p.undeclaredGroups).toEqual(['builder'])
  expect(p.view().size).toBe(0) // closed by the host: nothing, whatever the server says
  p.openGroup('builder')
  expect([...p.view().get(keyOf('builder'))!.tools.keys()]).toEqual(['place'])
  p.apply({ rev: 1, tools: [{ name: 'paint', visible: true }] })
  expect([...p.view().get(keyOf('builder'))!.tools.keys()]).toEqual(['place', 'paint'])
  // the server's toolsets entries cannot open or close an undeclared group
  p.apply({ rev: 2, toolsets: [{ toolset: 'builder', state: 'closed' }] })
  expect(p.isOpen('builder')).toBe(true)
  p.closeGroup('builder')
  expect(p.view().size).toBe(0)
})

test('static ↔ dynamic moves wait for a boundary', () => {
  const p = goLike()
  p.apply({ rev: 1, tools: [{ name: 'games', presence: 'dynamic' }] })
  expect(p.presenceOf('games')).toBe('static') // until the host applies it
  expect(p.applyMoves()).toEqual([{ name: 'games', to: 'dynamic' }])
  expect(p.presenceOf('games')).toBe('dynamic')
})

test('toolsets/list is the truth: adopted whatever its rev; what the host had but the server lost is closed; ended toolsets are told', () => {
  const p = goLike()
  p.apply({ rev: 7, toolsets: [{ toolset: 'game', instance: 'a', state: 'open' }, { toolset: 'game', instance: 'b', state: 'open' }, { toolset: 'game', instance: 'c', state: 'open' }], tools: [{ name: 'play', instance: 'a', visible: true }] })
  const r = p.adopt({
    open: [{ toolset: 'game', instance: 'a', title: 'kept' }],
    ended: [{ toolset: 'game', instance: 'c', reason: 'idle for 30 minutes' }, { toolset: 'game', instance: 'z', reason: 'opponent left' }],
    _meta: { 'mcpl/hints': { rev: 3, tools: [{ name: 'pass', instance: 'a', visible: true }] } },
  })
  expect(r.lost.map(o => o.instance)).toEqual(['b', 'c'])
  expect([...p.view().get(keyOf('game', 'a'))!.tools.keys()]).toEqual(['pass'])
  expect(p.isOpen('game', 'b')).toBe(false)
  expect(p.rev).toBe(7)
  expect(p.adoptionNotes(r.lost, r.ended)).toEqual([
    '[go/game:c] ended while you were away: idle for 30 minutes.',
    '[go/game:z] ended while you were away: opponent left.',
    '[go/game:b] is closed: go no longer has it open. open {server:"go", toolset:"game"} starts a new one.',
  ])
})

// ── wake defaults ──

const delivery = (tags: string, keepWhole = false): IncomingDelivery => ({ server: 'go', kind: 'push-event', text: '[go/game:a] tools now — act {…}:\n  play(point: string)', meta: { tags }, keepWhole })

test('wake: surface:tools and surface:update are held by default under every policy; turn, alert, done, invite wake', () => {
  for (const cfg of [undefined, 'all', 'chat'] as const) {
    const g = new WakeGate(cfg)
    expect(g.decide(delivery('surface:tools'))).toBe('hold')
    expect(g.decide(delivery('surface:update'))).toBe('hold')
    for (const t of ['surface:turn', 'surface:alert', 'surface:done', 'surface:invite']) expect(g.decide(delivery(t))).toBe('wake')
  }
  expect(new WakeGate({ wake: [['surface:tools']] }).decide(delivery('surface:tools'))).toBe('wake')
  const g = new WakeGate('all')
  g.hold(delivery('surface:tools', true))
  expect(g.flush('go')).toContain('\n  [go/game:a] tools now — act {…}:\n    play(point: string)') // kept whole, not cut to a line
})

// ── a real handle against a scripted server ──

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

const HINTED = {
  version: '0.5',
  pushEvents: true,
  toolHints: true,
  toolsets: { lamp: { title: 'Lamp', summary: 'A lamp', default: 'closed' } },
}
const LAMP_TOOLS = [
  { name: 'status', description: 'Status.', inputSchema: obj(), _meta: { 'mcpl/presence': 'static' } },
  dyn('on', 'Switch on.', 'lamp', obj(), false),
  dyn('off', 'Switch off.', 'lamp', obj(), false),
  dyn('wave', 'Wave a hand.', 'gestures', obj(), true),
]

async function setup(opts: { mcpl?: Record<string, unknown>; tools?: unknown[]; cfg?: Partial<ServerConfig>; peerOpts?: Parameters<typeof McplPeer.start>[0] } = {}) {
  const peer = await McplPeer.start({ mcpl: opts.mcpl ?? HINTED, tools: (opts.tools ?? LAMP_TOOLS) as never, ...opts.peerOpts })
  const delivered: IncomingDelivery[] = []
  let toolsChanged = 0
  const h = new McplServerHandle('lamp', { transport: { url: peer.url }, grant: ['tools', 'pushEvents'], reconnectIntervalMs: 100, ...opts.cfg }, {
    deliver: d => delivered.push(d),
    toolsChanged: () => toolsChanged++,
    log: () => {},
  })
  cleanup.push(() => peer.close(), () => h.close())
  h.start()
  await h.firstAttempt
  return { peer, h, delivered, changes: () => toolsChanged, handles: new Map([['lamp', h]]) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

test('handle: advertises toolHints, lists static tools only, and visibility changes never touch the tool list', async () => {
  const { peer, h, delivered, changes } = await setup()
  const init = peer.inits[0] as { capabilities: { experimental: { mcpl: Record<string, unknown> } } }
  expect(init.capabilities.experimental.mcpl.toolHints).toBe(true)
  expect(h.listedTools().map(t => t.name)).toEqual(['status'])
  const n = changes()
  // tools/hints standalone → a held surface:tools notification, no list change
  peer.notify('tools/hints', { rev: 1, tools: [{ name: 'wave', visible: false }] })
  peer.notify('tools/hints', { rev: 2, toolsets: [{ toolset: 'lamp', state: 'open' }], tools: [{ name: 'on', visible: true }] })
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.meta.tags).toBe('surface:tools')
  expect(delivered[0]!.text).toBe('[lamp/lamp] tools now — act {server:"lamp", tool, args}:\n  on() — Switch on.\nclose {server:"lamp", toolset:"lamp"} closes it.')
  // a stale rev is ignored (and the host resyncs through toolsets/list, which this peer cannot answer)
  peer.notify('tools/hints', { rev: 2, tools: [{ name: 'on', visible: false }] })
  await sleep(300)
  expect([...h.presence.view().get(keyOf('lamp'))!.tools.keys()]).toEqual(['on'])
  expect(delivered).toHaveLength(1)
  // a push carrying hints: the change follows the event's own text
  await peer.request('push/event', { featureSet: 'x', eventId: 'e1', timestamp: '', toolset: 'lamp', tags: ['surface:alert'], payload: { content: [{ type: 'text', text: 'The fuse blew.' }] }, hints: { rev: 3, tools: [{ name: 'on', visible: false }, { name: 'off', visible: true }] } })
  expect(delivered[1]!.text).toBe('The fuse blew.\n[lamp/lamp] tools now — act {server:"lamp", tool, args}:\n  off() — Switch off.\nnow unavailable: on')
  expect(delivered[1]!.meta).toMatchObject({ tags: 'surface:alert', toolset: 'lamp' })
  expect(changes()).toBe(n)
})

test('handle: a suggestion is shown, never acted on', async () => {
  const { peer, h, delivered } = await setup()
  peer.notify('tools/hints', { rev: 1, suggest: [{ toolset: 'lamp', action: 'open', reason: 'it is getting dark' }] })
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.meta.tags).toBe('surface:invite')
  expect(delivered[0]!.text).toBe('lamp suggests opening lamp: it is getting dark — open {server:"lamp", toolset:"lamp"} if you want to (nothing was done).')
  expect(h.presence.isOpen('lamp')).toBe(false)
})

test('handle: an undeclared toolset is opened by the host without telling the server; act is refused while it is closed', async () => {
  const { peer, handles } = await setup()
  const closed = await callMetaTool('act', { server: 'lamp', tool: 'wave' }, handles)
  expect(closed.isError).toBe(true)
  expect(closed.content[0]!.text).toContain('wave is in gestures, which is not open')
  const opened = await callMetaTool('open', { server: 'lamp', toolset: 'gestures' }, handles)
  expect(opened.content[0]!.text).toContain('[lamp/gestures] open.\ntools now — act {server:"lamp", tool, args}:\n  wave() — Wave a hand.')
  const shut = await callMetaTool('close', { server: 'lamp', toolset: 'gestures' }, handles)
  expect(shut.content[0]!.text).toBe('[lamp/gestures] closed. Now unavailable: wave.')
  expect(peer.policies).toHaveLength(1) // and no toolsets/* request ever reached the server (the peer would have errored)
})

test('compat: a server without hints is listed and called as today; a host that opts out advertises nothing', async () => {
  const plain = await setup({ mcpl: { version: '0.5', pushEvents: true }, tools: [{ name: 'ping', description: 'Ping.', inputSchema: obj(), _meta: { 'mcpl/presence': 'dynamic', 'mcpl/toolset': 'x' } }] })
  expect(plain.h.presence.active).toBe(false)
  expect(plain.h.listedTools().map(t => t.name)).toEqual(['ping']) // hints in _meta mean nothing without toolHints
  expect(plain.h.presence.presents).toBe(false)
  const optOut = await setup({ cfg: { toolHints: false } })
  const init = optOut.peer.inits[0] as { capabilities: { experimental: { mcpl: Record<string, unknown> } } }
  expect('toolHints' in init.capabilities.experimental.mcpl).toBe(false)
  expect(optOut.h.listedTools().map(t => t.name)).toEqual(['status', 'on', 'off', 'wave'])
})

test('handle: a refused push\'s hints are not applied; the same rev re-sent as tools/hints applies once, and again is a duplicate (no resync)', async () => {
  const lists: number[] = []
  const { peer, h, delivered } = await setup({
    cfg: { dmAllowlist: [] }, // refuses every DM-tagged push
    peerOpts: { handlers: { 'toolsets/list': () => (lists.push(1), { open: [] }) } },
  })
  const hints = { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] }
  const r = await peer.request('push/event', { featureSet: 'x', eventId: 'e1', timestamp: '', tags: ['chat:dm'], payload: { content: [{ type: 'text', text: 'psst' }] }, hints })
  expect(r.result).toMatchObject({ accepted: false })
  expect(h.presence.isOpen('lamp')).toBe(false) // not applied
  peer.notify('tools/hints', hints) // the server re-sends, same rev
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.text).toContain('[lamp/lamp] Lamp tools now — act {server:"lamp", tool, args}:\n  on() — Switch on.')
  peer.notify('tools/hints', hints) // and once more: a duplicate
  await sleep(350)
  expect(delivered).toHaveLength(1)
  expect(lists).toHaveLength(1) // only the one at connect: a duplicate is no reason to resync
  expect(h.presence.rev).toBe(1)
})

test('handle: tools/list carries mcpl/rev — earlier changes are covered by it, later ones apply on top', async () => {
  const lists: number[] = []
  const { peer, h, delivered } = await setup({ peerOpts: { listRev: 5, handlers: { 'toolsets/list': () => (lists.push(1), { open: [] }) } } })
  expect(h.presence.rev).toBe(5)
  peer.notify('tools/hints', { rev: 3, toolsets: [{ toolset: 'lamp', state: 'open' }] })
  await sleep(300)
  expect(h.presence.isOpen('lamp')).toBe(false)
  expect(lists).toHaveLength(1) // covered, not lost: no resync
  peer.notify('tools/hints', { rev: 6, toolsets: [{ toolset: 'lamp', state: 'open' }], tools: [{ name: 'on', visible: true }] })
  await waitFor(() => delivered.length === 1)
  expect(h.presence.isOpen('lamp')).toBe(true)
})

test('handle: on reconnect toolsets/list is the truth — what it does not report is closed and never re-opened; ended toolsets are told', async () => {
  let report: Record<string, unknown> = { open: [] }
  const { peer, h, delivered, handles } = await setup({
    peerOpts: {
      handlers: {
        'toolsets/list': () => report,
        'toolsets/open': p => ({ toolset: p.toolset, title: 'Lamp', content: [{ type: 'text', text: 'lamp off' }], _meta: { 'mcpl/hints': { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] } } }),
      },
    },
  })
  const opened = await callMetaTool('open', { server: 'lamp', toolset: 'lamp' }, handles)
  expect(opened.content[0]!.text).toBe('[lamp/lamp] Lamp\nlamp off\ntools now — act {server:"lamp", tool, args}:\n  on() — Switch on.\nclose {server:"lamp", toolset:"lamp"} closes it.')
  report = { open: [], ended: [{ toolset: 'lamp', reason: 'the bulb burned out' }] }
  await h.restart()
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.text).toBe('[lamp/lamp] ended while you were away: the bulb burned out.')
  expect(h.presence.isOpen('lamp')).toBe(false)
  expect(peer.received.filter(m => m === 'toolsets/open')).toHaveLength(1) // never re-opened on its own
  // and a later look tells what ended in between, too
  report = { open: [], ended: [{ toolset: 'lamp', reason: 'nobody was home' }] }
  const look = await callMetaTool('look', { server: 'lamp' }, handles)
  expect(look.content.map(b => b.text).join('\n')).toContain('[lamp/lamp] ended while you were away: nobody was home.')
})
