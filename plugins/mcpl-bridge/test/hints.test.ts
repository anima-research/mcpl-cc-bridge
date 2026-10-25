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

test('r4 revs: consecutive, applied on arrival; a skip or a rev not after the last is flagged for recovery; visibility per instance; open/closed from toolsets entries', () => {
  const p = goLike()
  expect(p.presents).toBe(true)
  expect(p.presenceOf('games')).toBe('static')
  expect(p.presenceOf('play')).toBe('dynamic')
  const before = p.view()
  expect(p.apply({ rev: 2, toolsets: [{ toolset: 'game', instance: 'a', state: 'open', title: 'Go vs bot' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'pass', instance: 'a', visible: true }] })).toMatchObject({ applied: true, skipped: true })
  const cs = p.diff(before, p.view())
  expect(cs.changes).toHaveLength(1)
  expect(cs.changes[0]).toMatchObject({ key: keyOf('game', 'a'), opened: true, title: 'Go vs bot' })
  expect(cs.changes[0]!.appeared.map(t => t.name)).toEqual(['play', 'pass'])
  // rev 2 first: rev 1 was lost — applied, and flagged (vector 4)
  // rev 1 after 2, and rev 2 again: not after the last — ignored, flagged
  expect(p.apply({ rev: 1, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, behind: true })
  expect(p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', visible: false }] })).toMatchObject({ applied: false, behind: true })
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
  expect(p.apply({ tools: [] })).toMatchObject({ applied: false, skipped: false, behind: false })
  // a retitle: "open" again, with a new title, for one already open
  const b3 = p.view()
  p.apply({ rev: 5, toolsets: [{ toolset: 'game', instance: 'b', state: 'open', title: 'Go vs bo' }] })
  expect(p.render(p.diff(b3, p.view()))).toBe('[go/game:b] Go vs bo')
  // tools/list's mcpl/rev takes no rev: equal to the last read, nothing lost; beyond it, something was
  expect(p.noteListRev(5)).toBe(false)
  expect(p.apply({ rev: 6 })).toMatchObject({ applied: true, skipped: false })
  expect(p.noteListRev(8)).toBe(true)
  expect(p.apply({ rev: 9 })).toMatchObject({ applied: true, skipped: false })
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

test('a toolset beats an explicit presence "static" (vector 24); a hint definition changes description, schema and annotations only — never name, class, toolset or presence (vectors 20, 21); visibility needs an instance on an instance toolset', () => {
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

test('vector 22: a definition with instance is that instance\'s own; another open instance keeps its own; without instance it is the toolset\'s', () => {
  const p = goLike()
  p.apply({ rev: 1, toolsets: [{ toolset: 'game', instance: 'a', state: 'open' }, { toolset: 'game', instance: 'b', state: 'open' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'play', instance: 'b', visible: true }] })
  p.apply({ rev: 2, tools: [{ name: 'play', instance: 'a', definition: { name: 'play', inputSchema: obj({ point: { enum: ['D4', 'E5'] } }, ['point']) } }] })
  p.apply({ rev: 3, tools: [{ name: 'play', instance: 'b', definition: { inputSchema: obj({ point: { enum: ['C3'] } }, ['point']) } }] })
  const v = p.view()
  expect(signature(v.get(keyOf('game', 'a'))!.tools.get('play')!)).toBe('play(point: "D4"|"E5")')
  expect(signature(v.get(keyOf('game', 'b'))!.tools.get('play')!)).toBe('play(point: "C3")')
  expect(p.hasOwnDefinition(keyOf('game', 'a'), 'play')).toBe(true)
  // a toolset-wide definition reaches an instance that has none of its own
  p.apply({ rev: 4, toolsets: [{ toolset: 'game', instance: 'c', state: 'open' }], tools: [{ name: 'play', instance: 'c', visible: true }, { name: 'play', definition: { description: 'Place a stone (toolset-wide).' } }] })
  expect(p.view().get(keyOf('game', 'c'))!.tools.get('play')!.description).toBe('Place a stone (toolset-wide).')
  expect(signature(p.view().get(keyOf('game', 'a'))!.tools.get('play')!)).toBe('play(point: "D4"|"E5")') // its own still wins
})

test('vector 23: toolsets/list hints are a full statement — a tool visible before and not stated visible is invisible; definitions are replaced', () => {
  const p = goLike()
  p.apply({ rev: 1, toolsets: [{ toolset: 'game', instance: 'a', state: 'open' }], tools: [{ name: 'play', instance: 'a', visible: true }, { name: 'pass', instance: 'a', visible: true }, { name: 'play', instance: 'a', definition: { description: 'old own' } }] })
  p.adopt({ open: [{ toolset: 'game', instance: 'a' }], _meta: { 'mcpl/hints': { rev: 2, tools: [{ name: 'pass', instance: 'a', visible: true }] } } })
  expect([...p.view().get(keyOf('game', 'a'))!.tools.keys()]).toEqual(['pass'])
  expect(p.hasOwnDefinition(keyOf('game', 'a'), 'play')).toBe(false)
})

test('vector 13: ended records repeat with the same id; the agent hears each id once, across adoptions', () => {
  const p = goLike()
  const list = { open: [], ended: [{ id: 'e7', toolset: 'game', instance: 'x', reason: 'idle for 30 minutes' }] }
  const first = p.adopt(list)
  expect(p.adoptionNotes(first.lost, first.ended)).toEqual(['[go/game:x] ended while you were away: idle for 30 minutes.'])
  const again = p.adopt(list)
  expect(p.adoptionNotes(again.lost, again.ended)).toEqual([])
  p.beginConnection({ toolHints: true, toolsets: { game: { instances: true } } }, true) // a reconnect
  const third = p.adopt(list)
  expect(p.adoptionNotes(third.lost, third.ended)).toEqual([])
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
function lampPeer(state: { open: boolean; on: boolean }, counts: { tools: number; toolsets: number }, extra: unknown[] = []) {
  return {
    handlers: {
      'tools/list': () => (counts.tools++, { tools: [...LAMP_TOOLS.map(t => (t.name === 'on' ? { ...t, _meta: { ...t._meta, 'mcpl/visible': state.open && state.on } } : t)), ...extra] }),
      'toolsets/list': () => (counts.toolsets++, { open: state.open ? [{ toolset: 'lamp', title: 'Lamp' }] : [] }),
    },
  }
}

test('handle, vectors 3 + 11: a refused push\'s hints apply on arrival, its tool change is still told, the server restates nothing, and the next rev follows on', async () => {
  const counts = { tools: 0, toolsets: 0 }
  const { peer, h, delivered } = await setup({ cfg: { dmAllowlist: [] }, peerOpts: lampPeer({ open: false, on: false }, counts) }) // dmAllowlist [] refuses every DM-tagged push
  const r = await peer.request('push/event', { featureSet: 'x', eventId: 'e1', timestamp: '', tags: ['chat:dm'], payload: { content: [{ type: 'text', text: 'psst' }] }, hints: { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] } })
  expect(r.result).toMatchObject({ accepted: false })
  expect(h.presence.isOpen('lamp')).toBe(true) // applied, refused or not
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.meta.tags).toBe('surface:tools') // the event was refused; its tool change is told on its own
  expect(delivered[0]!.text).toContain('[lamp/lamp] Lamp tools now — act {server:"lamp", tool, args}:\n  on() — Switch on.')
  peer.notify('tools/hints', { rev: 2, tools: [{ name: 'off', visible: true }] }) // the next rev
  await waitFor(() => delivered.length === 2)
  await sleep(350)
  expect(counts).toEqual({ tools: 1, toolsets: 1 }) // only the reads at connect: nothing to recover
})

test('handle, vectors 4 + 12: a skipped rev recovers from toolsets/list then tools/list — including an instance\'s current definition, which act then checks against', async () => {
  const state = { open: true, on: true }
  const counts = { tools: 0, toolsets: 0 }
  const dim = dyn('dim', 'Dim the lamp.', 'lamp', obj({ level: { type: 'integer' } }, ['level']))
  const peerOpts = lampPeer(state, counts, [dim])
  const { peer, h, delivered, handles } = await setup({
    mcpl: { ...HINTED, toolsets: { lamp: { title: 'Lamp', summary: 'A lamp', default: 'closed' } } },
    peerOpts: {
      handlers: {
        ...peerOpts.handlers,
        // after the loss, the server's full statement: dim is visible with a narrower definition
        'toolsets/list': () => (counts.toolsets++, {
          open: [{ toolset: 'lamp', title: 'Lamp' }],
          _meta: counts.toolsets > 1 ? { 'mcpl/hints': { rev: 5, tools: [{ name: 'dim', visible: true, definition: { inputSchema: obj({ level: { enum: [1, 2] } }, ['level']) } }] } } : undefined,
        }),
      },
    },
  })
  const order = () => peer.received.filter(m => m === 'toolsets/list' || m === 'tools/list')
  expect(order()).toEqual(['tools/list', 'toolsets/list']) // a new connection: definitions, then the per-instance baseline
  peer.notify('tools/hints', { rev: 1, tools: [{ name: 'on', visible: true }] })
  peer.notify('tools/hints', { rev: 3, tools: [{ name: 'off', visible: true }] }) // rev 2 was "dropped unread"
  await waitFor(() => counts.toolsets === 2 && counts.tools === 2)
  expect(order().slice(2)).toEqual(['toolsets/list', 'tools/list']) // r4 §6.1: recovery reads toolsets/list, then tools/list
  await waitFor(() => delivered.some(d => /dim\(level: 1\|2\)/.test(d.text)))
  expect([...h.presence.view().get(keyOf('lamp'))!.tools.keys()]).toEqual(['dim']) // a full statement: on and off were not stated visible
  // act checks arguments against the toolset's current definition, not the listed one
  const bad = await callMetaTool('act', { server: 'lamp', tool: 'dim', args: { level: 7 } }, handles)
  expect(bad.isError).toBe(true)
  expect(bad.content[0]!.text).toContain('Invalid arguments for dim in lamp/lamp — args.level: must be one of 1|2. Nothing was sent;')
  expect(peer.received).not.toContain('tools/call')
})

test('handle, vector 28: a result nobody waits for any more is applied when it arrives, and told; a coalesced push\'s hints are ignored and recovered', async () => {
  const counts = { tools: 0, toolsets: 0 }
  const state = { open: true, on: true }
  const base = lampPeer(state, counts)
  const { peer, h, delivered, handles } = await setup({
    peerOpts: {
      handlers: {
        ...base.handlers,
        'tools/call': () => ({ content: [{ type: 'text', text: 'status: late' }], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'off', visible: true }] } } }),
      },
      delay: { 'tools/call': 400 },
    },
  })
  const was = REQUEST_TIMEOUTS.call
  REQUEST_TIMEOUTS.call = 100
  try {
    const r = await callMetaTool('act', { server: 'lamp', tool: 'status' }, handles)
    expect(r.isError).toBe(true) // timed out
  } finally {
    REQUEST_TIMEOUTS.call = was
  }
  await waitFor(() => h.presence.rev === 1, 3000) // the late result's rev, applied when read
  await waitFor(() => delivered.length === 2, 3000) // [0] is the adoption at connect
  expect(delivered[1]!.text).toContain('off() — Switch off.')
  expect(counts).toEqual({ tools: 1, toolsets: 1 }) // no recovery: nothing was lost
  // a push carrying hints and coalesce: hints ignored, recovered instead
  await peer.request('push/event', { featureSet: 'x', eventId: 'e2', timestamp: '', tags: [], coalesce: { key: 'lamp/state' }, payload: { content: [{ type: 'text', text: 'flicker' }] }, hints: { rev: 2, toolsets: [{ toolset: 'lamp', state: 'closed' }] } })
  expect(h.presence.isOpen('lamp')).toBe(true)
  await waitFor(() => counts.toolsets === 2 && counts.tools === 2)
})

test('handle, vector 13: an ended record repeated on every toolsets/list is told once across two reconnects', async () => {
  const { h, delivered } = await setup({ peerOpts: { handlers: { 'toolsets/list': () => ({ open: [], ended: [{ id: 'e7', toolset: 'lamp', reason: 'the bulb burned out' }] }) } } })
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.text).toBe('[lamp/lamp] ended while you were away: the bulb burned out.')
  await h.restart()
  await h.restart()
  await sleep(300)
  expect(delivered).toHaveLength(1)
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

test('handle: tools/list carries mcpl/rev (it takes none) — the next change follows it; one written beyond the last rev read means a loss and a recovery', async () => {
  const counts = { tools: 0, toolsets: 0 }
  const { peer, h, delivered } = await setup({ peerOpts: { listRev: 0, handlers: { 'toolsets/list': () => (counts.toolsets++, { open: [] }) } } })
  expect(h.presence.rev).toBe(0)
  peer.notify('tools/hints', { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open' }], tools: [{ name: 'on', visible: true }] })
  await waitFor(() => delivered.length === 1)
  expect(h.presence.isOpen('lamp')).toBe(true)
  await sleep(300)
  expect(counts.toolsets).toBe(1) // consecutive: no recovery
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

// ── revision 5 vectors (RFC-014 §13) ──

test('vector 27: toolsets/open, toolsets/close and toolsets/list results carrying hints take the next rev; tools/list takes none — no recovery along the way', async () => {
  let rev = 0
  const counts = { tools: 0, toolsets: 0 }
  const { peer, h, delivered, handles } = await setup({
    peerOpts: {
      handlers: {
        'tools/list': () => (counts.tools++, { tools: LAMP_TOOLS, _meta: { 'mcpl/rev': rev } }),
        'toolsets/list': () => (counts.toolsets++, counts.toolsets === 1 ? { open: [] } : { open: [{ toolset: 'lamp', title: 'Lamp' }], _meta: { 'mcpl/hints': { rev: ++rev, tools: [{ name: 'on', visible: true }] } } }),
        'toolsets/open': () => ({ toolset: 'lamp', title: 'Lamp', _meta: { 'mcpl/hints': { rev: ++rev, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] } } }),
        'toolsets/close': () => ({ _meta: { 'mcpl/hints': { rev: ++rev, toolsets: [{ toolset: 'lamp', state: 'closed' }] } } }),
      },
    },
  })
  rev = 1
  peer.notify('tools/hints', { rev: 1, tools: [{ name: 'wave', visible: false }] })
  await sleep(50)
  await callMetaTool('open', { server: 'lamp', toolset: 'lamp' }, handles) // rev 2
  await callMetaTool('close', { server: 'lamp', toolset: 'lamp' }, handles) // rev 3
  await callMetaTool('look', { server: 'lamp' }, handles) // toolsets/list: rev 4
  peer.notify('notifications/tools/list_changed', {}) // tools/list says rev 4 and takes none
  await sleep(400)
  expect(h.presence.rev).toBe(4)
  expect(counts).toEqual({ tools: 2, toolsets: 2 }) // connect + list_changed; connect + look — no recovery
  peer.notify('tools/hints', { rev: 5, tools: [{ name: 'wave', visible: true }] })
  await sleep(300)
  expect(counts).toEqual({ tools: 2, toolsets: 2 })
  void delivered
})

test('vector 30: a push whose eventId was seen before has its hints ignored — no double apply, no recovery', async () => {
  const counts = { tools: 0, toolsets: 0 }
  const { peer, h, delivered } = await setup({ peerOpts: lampPeer({ open: false, on: false }, counts) })
  const push = { featureSet: 'x', eventId: 'e1', timestamp: '', toolset: 'lamp', tags: ['surface:alert'], payload: { content: [{ type: 'text', text: 'Lamp ready.' }] }, hints: { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] } }
  await peer.request('push/event', push)
  await peer.request('push/event', push) // the same push again
  expect(delivered[0]!.text).toContain('[lamp/lamp] Lamp tools now')
  expect(delivered[1]!.text).toBe('Lamp ready.') // the event, without a second change
  peer.notify('tools/hints', { rev: 2, tools: [{ name: 'off', visible: true }] })
  await sleep(350)
  expect(h.presence.rev).toBe(2)
  expect(counts).toEqual({ tools: 1, toolsets: 1 })
})

test('vector 33: a manifest change removing a toolset closes its open instances; a toolset that becomes undeclared starts closed under the host\'s gating', async () => {
  const { peer, h, delivered } = await setup({ peerOpts: { handlers: { 'toolsets/list': () => ({ open: [] }) } } })
  peer.notify('tools/hints', { rev: 1, toolsets: [{ toolset: 'lamp', state: 'open', title: 'Lamp' }], tools: [{ name: 'on', visible: true }] })
  await waitFor(() => delivered.length === 1)
  expect(h.presence.isOpen('lamp')).toBe(true)
  peer.changeManifest({ version: '0.5', pushEvents: true, toolHints: true }) // lamp no longer declared
  await waitFor(() => delivered.length === 2)
  expect(delivered[1]!.text).toBe('[lamp/lamp] closed. Now unavailable: on.')
  expect(h.presence.isDeclared('lamp')).toBe(false)
  expect(h.presence.undeclaredGroups).toContain('lamp') // its tools are still tagged: now a host-gated group…
  expect(h.presence.isOpen('lamp')).toBe(false) // …that starts closed
})

test('r5 §5.1: a server that withdraws toolHints is hint-less from then on — every tool in the tool list', async () => {
  const { peer, h, delivered, changes } = await setup({ peerOpts: { handlers: { 'toolsets/list': () => ({ open: [] }) } } })
  expect(h.listedTools().map(t => t.name)).toEqual(['status'])
  const n = changes()
  peer.changeManifest({ version: '0.5', pushEvents: true }) // no toolHints
  await waitFor(() => delivered.length === 1)
  expect(delivered[0]!.text).toBe('[lamp] no longer sends tool hints: its tools are in your tool list as lamp__<tool>.')
  await waitFor(() => changes() > n)
  expect(h.presence.active).toBe(false)
  expect(h.listedTools().map(t => t.name)).toEqual(['status', 'on', 'off', 'wave'])
})

test('vector 34: a server with toolHints and no declared toolsets is asked toolsets/list, which states its dynamic tools in full', async () => {
  const { peer, h } = await setup({
    mcpl: { version: '0.5', pushEvents: true, toolHints: true },
    tools: [{ name: 'status', description: 'Status.', inputSchema: obj() }, dyn('beam', 'Beam a message.', undefined, obj({ text: { type: 'string' } }), false), dyn('glow', 'Glow.', undefined, obj(), true)],
    peerOpts: { handlers: { 'toolsets/list': () => ({ open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'beam', visible: true, definition: { description: 'Beam a message now.' } }] } } }) } },
  })
  expect(peer.received).toContain('toolsets/list')
  const v = h.presence.view().get(keyOf(''))!
  expect([...v.tools.keys()]).toEqual(['beam']) // glow was visible by the list, not stated visible by the full statement
  expect(v.tools.get('beam')!.description).toBe('Beam a message now.')
})
