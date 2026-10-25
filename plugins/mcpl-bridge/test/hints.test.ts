/**
 * MCPL RFC-014 r2 host side, without go-mcpl: the presence state and its one
 * apply path, rendering, the wake defaults, and a real McplServerHandle
 * against a scripted peer for what go-mcpl cannot be made to do (a stale rev,
 * a suggestion, an undeclared toolset, a server without hints).
 */
import { afterEach, expect, test } from 'bun:test'
import type { ServerConfig } from '../src/config'
import { callMetaTool } from '../src/meta-tools'
import { McplServerHandle, REQUEST_TIMEOUTS, type IncomingDelivery } from '../src/mcpl-host'
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

test('hint changes apply in rev order; a reversal or a gap is flagged for recovery; visibility is per instance; open/closed from toolsets entries', () => {
  const p = goLike()
  expect(p.presents).toBe(true)
  expect(p.presenceOf('games')).toBe('static')
  expect(p.presenceOf('play')).toBe('dynamic')
  const before = p.view()
  expect(p.apply({ rev: 2, toolsets: [{ toolset: 'game', instance: 'a', state: 'open', title: 'Go vs bot' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'pass', instance: 'a', visible: true }] })).toMatchObject({ applied: true, gap: true })
  const cs = p.diff(before, p.view())
  expect(cs.changes).toHaveLength(1)
  expect(cs.changes[0]).toMatchObject({ key: keyOf('game', 'a'), opened: true, title: 'Go vs bot' })
  expect(cs.changes[0]!.appeared.map(t => t.name)).toEqual(['play', 'pass'])
  // the first change skipped rev 1, which this host never saw: applied, and flagged as a gap
  // rev 1 after 2, and rev 2 again: reversals — ignored, flagged for recovery (r3 §6.1)
  expect(p.apply({ rev: 1, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, reversal: true })
  expect(p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, reversal: true })
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
  expect(p.apply({ tools: [] })).toMatchObject({ applied: false, covered: false, reversal: false })
  // a retitle: "open" again, with a new title, for one already open
  const b3 = p.view()
  p.apply({ rev: 5, toolsets: [{ toolset: 'game', instance: 'b', state: 'open', title: 'Go vs bo' }] })
  expect(p.render(p.diff(b3, p.view()))).toBe('[go/game:b] Go vs bo')
  // tools/list's mcpl/rev covers what came before it: earlier revs are covered, not losses
  p.noteListRev(9)
  expect(p.apply({ rev: 8 })).toMatchObject({ covered: true, reversal: false })
  expect(p.apply({ rev: 10 })).toMatchObject({ applied: true, gap: false })
  // a refused push's rev is seen, not applied: its restatement under the next rev is no gap
  p.noteRefused({ rev: 11 })
  expect(p.apply({ rev: 12 })).toMatchObject({ applied: true, gap: false })
  expect(p.apply({ rev: 14 })).toMatchObject({ applied: true, gap: true })
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

test('r3: a toolset beats an explicit presence "static"; a hint definition changes description, schema and annotations only; an instance toolset statement needs its instance', () => {
  const p = new ToolPresence('x')
  p.beginConnection({ toolHints: true, toolsets: { game: { instances: true } } }, true)
  p.setTools([
    { name: 'build', description: 'Build.', inputSchema: obj(), _meta: { 'mcpl/presence': 'static', 'mcpl/toolset': 'builder' } },
    { name: 'play', description: 'Play a move.', inputSchema: obj({ point: { type: 'string' } }), _meta: { 'mcpl/toolset': 'game', 'mcpl/class': ['control'] } },
  ])
  expect(p.presenceOf('build')).toBe('dynamic') // toolset wins
  p.apply({ rev: 1, tools: [{ name: 'build', presence: 'static' }] })
  expect(p.applyMoves()).toEqual([]) // ignored on a toolset's tool
  p.apply({ rev: 2, toolsets: [{ toolset: 'game', instance: 'a', state: 'open' }], tools: [{ name: 'play', instance: 'a', visible: true }] })
  p.apply({
    rev: 3,
    tools: [{ name: 'play', instance: 'a', definition: { name: 'renamed', description: 'Play: D4 or E5.', inputSchema: obj({ point: { enum: ['D4', 'E5'] } }), annotations: { readOnlyHint: false }, _meta: { 'mcpl/class': ['shell'], 'mcpl/toolset': 'other' } } }],
  })
  const def = p.view().get(keyOf('game', 'a'))!.tools.get('play')!
  expect(def.name).toBe('play')
  expect(def._meta).toEqual({ 'mcpl/toolset': 'game', 'mcpl/class': ['control'] }) // the listed class, not the hint's
  expect(def.description).toBe('Play: D4 or E5.')
  expect(signature(def)).toBe('play(point?: "D4"|"E5")')
  expect(def.annotations).toEqual({ readOnlyHint: false })
  // no instance on a statement about an instance toolset: ignored
  p.apply({ rev: 4, tools: [{ name: 'play', visible: false }] })
  expect(p.view().get(keyOf('game', 'a'))!.tools.has('play')).toBe(true)
  // a server that declares toolsets but does not advertise toolHints: hints mean nothing (r3 §6.1)
  const q = new ToolPresence('y')
  q.beginConnection({ toolsets: { game: {} } }, true)
  expect(q.active).toBe(false)
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

/** A lamp peer whose tools/list and toolsets/list tell a consistent story, counting the lists it is asked for. */
function lampPeer(state: { open: boolean; on: boolean }, counts: { tools: number; toolsets: number }) {
  return {
    handlers: {
      'tools/list': () => (counts.tools++, { tools: LAMP_TOOLS.map(t => (t.name === 'on' ? { ...t, _meta: { ...t._meta, 'mcpl/visible': state.open && state.on } } : t)) }),
      'toolsets/list': () => (counts.toolsets++, { open: state.open ? [{ toolset: 'lamp', title: 'Lamp' }] : [] }),
    },
  }
}

test('handle (r3): a refused push\'s hints are not applied; their restatement under a new rev applies, and is no gap', async () => {
  const counts = { tools: 0, toolsets: 0 }
  const { peer, h, delivered } = await setup({ cfg: { dmAllowlist: [] }, peerOpts: lampPeer({ open: false, on: false }, counts) }) // dmAllowlist [] refuses every DM-tagged push
  const r = await peer.request('push/event', { featureSet: 'x', eventId: 'e1', timestamp: '', tags: ['chat:dm'], payload: { content: [{ type: 'text', text: 'psst' }] }, hints: { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] } })
  expect(r.result).toMatchObject({ accepted: false })
  expect(h.presence.isOpen('lamp')).toBe(false) // not applied
  peer.notify('tools/hints', { rev: 2, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] }) // restated, new rev
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.text).toContain('[lamp/lamp] Lamp tools now — act {server:"lamp", tool, args}:\n  on() — Switch on.')
  await sleep(350)
  expect(counts).toEqual({ tools: 1, toolsets: 1 }) // only the reads at connect: rev 1 was seen (refused), so rev 2 is no gap
})

test('handle (r3): a reversal, a gap, a coalesced push with hints and a lost result each recover from tools/list AND toolsets/list', async () => {
  const state = { open: true, on: true }
  const counts = { tools: 0, toolsets: 0 }
  const peerOpts = { ...lampPeer(state, counts), silent: ['tools/call'] }
  const { peer, h, delivered, handles } = await setup({ peerOpts })
  expect(h.presence.isOpen('lamp')).toBe(true) // adopted at connect
  const reads = () => ({ ...counts })
  const recovered = async (from: { tools: number; toolsets: number }) => {
    await waitFor(() => counts.tools > from.tools && counts.toolsets > from.toolsets, 2000)
  }
  // reversal: rev 2, then rev 2 again
  peer.notify('tools/hints', { rev: 1, tools: [{ name: 'on', visible: true }] })
  peer.notify('tools/hints', { rev: 2, tools: [{ name: 'off', visible: true }] })
  let from = reads()
  peer.notify('tools/hints', { rev: 2, tools: [{ name: 'off', visible: false }] })
  await recovered(from)
  // gap: revs skipped that were never seen (the change still applies)
  from = reads()
  peer.notify('tools/hints', { rev: 9, tools: [{ name: 'off', visible: false }] })
  await recovered(from)
  // a push carrying hints AND coalesce: hints ignored (r3 §7), recovered instead
  await sleep(250)
  from = reads()
  await peer.request('push/event', { featureSet: 'x', eventId: 'e2', timestamp: '', tags: [], coalesce: { key: 'lamp/state' }, payload: { content: [{ type: 'text', text: 'flicker' }] }, hints: { rev: 99, toolsets: [{ toolset: 'lamp', state: 'closed' }] } })
  expect(h.presence.isOpen('lamp')).toBe(true)
  expect(delivered.at(-1)!.text).toBe('flicker') // the event itself is delivered, without a change
  await recovered(from)
  // a lost result: the call times out, so what it changed is unknown
  await sleep(250)
  const was = REQUEST_TIMEOUTS.call
  REQUEST_TIMEOUTS.call = 150
  try {
    from = reads()
    const r = await callMetaTool('act', { server: 'lamp', tool: 'status' }, handles)
    expect(r.isError).toBe(true)
    await recovered(from)
  } finally {
    REQUEST_TIMEOUTS.call = was
  }
})

test('handle (r3): an adopting open says "already open"; a close result\'s hints are applied', async () => {
  const { handles } = await setup({
    peerOpts: {
      handlers: {
        'toolsets/list': () => ({ open: [] }),
        'toolsets/open': () => ({ toolset: 'lamp', title: 'Lamp', adopted: true, content: [{ type: 'text', text: 'Already on; brightness 3 was not applied.' }], _meta: { 'mcpl/hints': { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'off', visible: true }] } } }),
        'toolsets/close': () => ({ content: [{ type: 'text', text: 'Lamp off.' }], _meta: { 'mcpl/hints': { rev: 2, toolsets: [{ toolset: 'lamp', state: 'closed' }] } } }),
      },
    },
  })
  const o = await callMetaTool('open', { server: 'lamp', toolset: 'lamp', options: { brightness: 3 } }, handles)
  expect(o.content[0]!.text).toStartWith('[lamp/lamp] Lamp — already open\nAlready on; brightness 3 was not applied.\ntools now — act {server:"lamp", tool, args}:\n  off() — Switch off.')
  const c = await callMetaTool('close', { server: 'lamp', toolset: 'lamp' }, handles)
  expect(c.content[0]!.text).toBe('Lamp off.\n[lamp/lamp] closed. Now unavailable: off.')
  expect(handles.get('lamp')!.presence.rev).toBe(2) // the close's hints went through the apply path
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
