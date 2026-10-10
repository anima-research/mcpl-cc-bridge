import { expect, test } from 'bun:test'
import { McplServerHandle } from '../src/mcpl-host'

test('an id matching another channel label never routes silently', () => {
  const handle = new McplServerHandle('toy', { transport: { type: 'stdio', command: 'true' } }, {
    deliver() {}, toolsChanged() {}, log() {},
  })
  handle.channels.set('general', { id: 'general', type: 'chat', label: 'Announcements', direction: 'bidirectional' })
  handle.channels.set('room-2', { id: 'room-2', type: 'chat', label: 'general', direction: 'bidirectional' })

  expect(() => handle.resolveChannel('general')).toThrow(/"general" is ambiguous/)
  expect(() => handle.resolveChannel('general')).toThrow(/\(id general\)/)
  expect(() => handle.resolveChannel('general')).toThrow(/\(id room-2\)/)
  expect(handle.resolveChannel('id:general')).toBe('general')
  expect(handle.resolveChannel('id:room-2')).toBe('room-2')
  expect(handle.resolveChannel('Announcements')).toBe('general')
  // The label that read as another channel's id is shown — and addressable — qualified.
  expect(handle.labelOf('room-2')).toBe('general (room-2)')
  expect(handle.resolveChannel(handle.labelOf('room-2'))).toBe('room-2')
})

// The two label paths beyond an exact match (the README's own safety claim):
// the trailing-(qualifier) drop, and ambiguity-as-error. Each is a
// wrong-room delivery if it regresses, so each goes red on its own.
function stubHandle() {
  const handle = new McplServerHandle('toy', { transport: { type: 'stdio', command: 'true' } }, {
    deliver() {}, toolsChanged() {}, log() {},
  })
  handle.channels.set('toy:lobby', { id: 'toy:lobby', type: 'chat', label: 'Toy Lobby', direction: 'bidirectional' })
  handle.channels.set('toy:lobby-east', { id: 'toy:lobby-east', type: 'chat', label: 'Toy Lobby (East)', direction: 'bidirectional' })
  handle.channels.set('toy:lobby-west', { id: 'toy:lobby-west', type: 'chat', label: 'Toy Lobby (West)', direction: 'bidirectional' })
  handle.channels.set('toy:kitchen-a', { id: 'toy:kitchen-a', type: 'chat', label: 'Kitchen (A)', direction: 'bidirectional' })
  handle.channels.set('toy:kitchen-b', { id: 'toy:kitchen-b', type: 'chat', label: 'Kitchen (B)', direction: 'bidirectional' })
  return handle
}

test('a qualified label resolves to its own channel; a bare form that qualified siblings also answer to is ambiguous, and the bare channel is shown qualified', () => {
  const handle = stubHandle()
  expect(handle.resolveChannel('toy lobby (east)')).toBe('toy:lobby-east')
  expect(handle.resolveChannel('#Toy Lobby (West)')).toBe('toy:lobby-west')
  // No form wins over another (antra's ruling on #2): `toy lobby` is the
  // exact label of one channel and the unqualified label of two more, so it
  // names nobody in particular. Exact-wins would deliver a reply meant for
  // `Toy Lobby (East)` with the qualifier dropped into the bare room.
  expect(() => handle.resolveChannel('toy lobby')).toThrow(/"toy lobby" is ambiguous — 3 channels/)
  // …and active disambiguation keeps the bare channel addressable by what it prints.
  expect(handle.labelOf('toy:lobby')).toBe('Toy Lobby (toy:lobby)')
  expect(handle.resolveChannel('Toy Lobby (toy:lobby)')).toBe('toy:lobby')
  // Siblings that collided with nothing keep the server's label.
  expect(handle.labelOf('toy:lobby-east')).toBe('Toy Lobby (East)')
})

test('an unqualified reference with no exact label and several qualified matches is an error naming each match — never a first-match delivery', () => {
  const handle = stubHandle()
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"kitchen" is ambiguous/)
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"Kitchen \(A\)" \(id toy:kitchen-a\)/)
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"Kitchen \(B\)" \(id toy:kitchen-b\)/)
  expect(handle.resolveChannel('kitchen (b)')).toBe('toy:kitchen-b')
})

// ── Active disambiguation: every display label answers for its own channel only ──

function handleWith(...descs: Array<{ id: string; label?: unknown }>) {
  const handle = new McplServerHandle('toy', { transport: { type: 'stdio', command: 'true' } }, {
    deliver() {}, toolsChanged() {}, log() {},
  })
  for (const d of descs) handle.channels.set(d.id, { type: 'chat', direction: 'bidirectional', ...d } as never)
  return handle
}

test('exact duplicate labels are both qualified; the shared form is ambiguous', () => {
  const h = handleWith({ id: 'd:1', label: '#general (Connectome)' }, { id: 'd:2', label: '#general (Connectome)' })
  expect(h.labelOf('d:1')).toBe('#general (Connectome) (d:1)')
  expect(h.labelOf('d:2')).toBe('#general (Connectome) (d:2)')
  expect(h.resolveChannel('#general (Connectome) (d:2)')).toBe('d:2')
  expect(() => h.resolveChannel('#general (Connectome)')).toThrow(/ambiguous — 2 channels/)
})

test('a bare label beside its qualified twin is qualified, the twin keeps its label', () => {
  const h = handleWith({ id: 'd:1', label: '#general' }, { id: 'd:2', label: '#general (Guild)' })
  expect(h.labelOf('d:1')).toBe('#general (d:1)')
  expect(h.labelOf('d:2')).toBe('#general (Guild)')
  // The shorthand someone might type for either room names both: error, not a guess.
  expect(() => h.resolveChannel('#general')).toThrow(/ambiguous/)
  expect(h.resolveChannel('#general (guild)')).toBe('d:2')
})

test('labels re-disambiguate when a look-alike registers or leaves', () => {
  const h = handleWith({ id: 'd:1', label: 'general' })
  expect(h.labelOf('d:1')).toBe('general')
  expect(h.resolveChannel('general')).toBe('d:1')
  h.channels.set('d:2', { id: 'd:2', type: 'chat', direction: 'bidirectional', label: 'general (Other)' })
  expect(h.labelOf('d:1')).toBe('general (d:1)')
  expect(() => h.resolveChannel('general')).toThrow(/ambiguous/) // the old printed form now errs, never misroutes
  h.channels.delete('d:2')
  expect(h.labelOf('d:1')).toBe('general')
  expect(h.resolveChannel('general')).toBe('d:1')
})

test('a label that looks like the id: escape is shown with a #, and the escape stays authoritative', () => {
  const h = handleWith({ id: 'lobby', label: 'Lobby' }, { id: 'x:7', label: 'id:lobby' })
  expect(h.labelOf('x:7')).toBe('#id:lobby')
  expect(h.resolveChannel('#id:lobby')).toBe('x:7')
  expect(h.resolveChannel('id:lobby')).toBe('lobby')
})

test('a missing or non-string label falls back to the id', () => {
  const h = handleWith({ id: 'd:1' }, { id: 'd:2', label: 42 }, { id: 'd:3', label: '   ' })
  expect(h.labelOf('d:1')).toBe('d:1')
  expect(h.labelOf('d:2')).toBe('d:2')
  expect(h.labelOf('d:3')).toBe('d:3')
  expect(h.resolveChannel('d:2')).toBe('d:2')
})

test('every display label resolves to its own channel across a dense collision set', () => {
  const labels = ['general', 'general', 'general (A)', 'general (A)', 'General (B)', 'g', 'general (g)', 'id:general', '#general', 'Kitchen (A)', 'kitchen']
  const h = handleWith(...labels.map((label, i) => ({ id: i === 5 ? 'general' : `c:${i}`, label })))
  const shown = new Set<string>()
  for (const id of h.channels.keys()) {
    const l = h.labelOf(id)
    expect(shown.has(l.toLowerCase())).toBe(false)
    shown.add(l.toLowerCase())
    expect(h.resolveChannel(l)).toBe(id)
    expect(h.resolveChannel(`id:${id}`)).toBe(id)
  }
})

// ── Review round 2 (greptile): saved references across label shifts; case-only id differences ──

test('a form printed earlier never silently names another channel after labels shift', () => {
  const h = handleWith({ id: 'a', label: 'general' })
  expect(h.labelOf('a')).toBe('general') // printed — remembered
  h.channels.set('b', { id: 'b', type: 'chat', direction: 'bidirectional', label: 'general (Guild)' })
  expect(h.labelOf('a')).toBe('general (a)') // printed — remembered
  h.channels.set('c', { id: 'c', type: 'chat', direction: 'bidirectional', label: 'general (a)' })
  // c's server label is a's earlier display label: neither may claim it alone now
  expect(() => h.resolveChannel('general (a)')).toThrow(/ambiguous/)
  expect(() => h.resolveChannel('general')).toThrow(/ambiguous/)
  for (const id of ['a', 'b', 'c']) expect(h.resolveChannel(h.labelOf(id))).toBe(id)
  expect(h.labelOf('a')).toBe('id:a')
})

test('ids differing only in case get the exact id: escape, which tells them apart', () => {
  const h = handleWith({ id: 'room:a', label: 'General' }, { id: 'room:A', label: 'General' })
  expect(h.labelOf('room:a')).toBe('id:room:a')
  expect(h.labelOf('room:A')).toBe('id:room:A')
  expect(h.resolveChannel(h.labelOf('room:a'))).toBe('room:a')
  expect(h.resolveChannel(h.labelOf('room:A'))).toBe('room:A')
})

test('labels are one printable line', () => {
  const h = handleWith({ id: 'd:1', label: 'line one\nline\ttwo\u0007' })
  expect(h.labelOf('d:1')).toBe('line one line two')
  expect(h.resolveChannel('line one line two')).toBe('d:1')
})

test('property: across random comings and goings, every printed label names its channel or errs — never another channel', () => {
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const pool = ['general', 'General', 'general (A)', 'general (a)', 'general (x:1)', 'x:1', 'id:x:1', '#general', 'lobby', 'lobby (East)', 'Lobby (east)', 'x:2']
  const idPool = ['x:1', 'x:2', 'x:3', 'X:1', 'a', 'A', 'general', 'lobby']
  for (let run = 0; run < 40; run++) {
    const h = handleWith()
    const printed: Array<[string, string]> = []
    for (let step = 0; step < 25; step++) {
      const id = idPool[rand(idPool.length)]
      if (h.channels.has(id) && rand(3) === 0) h.channels.delete(id)
      else h.channels.set(id, { id, type: 'chat', direction: 'bidirectional', label: pool[rand(pool.length)] })
      for (const cid of h.channels.keys()) {
        const l = h.labelOf(cid)
        expect(h.resolveChannel(l)).toBe(cid) // the current label works
        printed.push([cid, l])
      }
      for (const [cid, l] of printed) {
        if (!h.channels.has(cid)) continue
        let got: string | null = null
        try {
          got = h.resolveChannel(l)
        } catch (e) {
          expect(String((e as Error).message)).toMatch(/ambiguous/) // a remembered form may become ambiguous…
          continue
        }
        expect(got).toBe(cid) // …but never names another channel
      }
    }
  }
})
