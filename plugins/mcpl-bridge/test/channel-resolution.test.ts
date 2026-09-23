import { expect, test } from 'bun:test'
import { McplServerHandle } from '../src/mcpl-host'

test('an id matching another channel label never routes silently', () => {
  const handle = new McplServerHandle('toy', { transport: { type: 'stdio', command: 'true' } }, {
    deliver() {}, toolsChanged() {}, log() {},
  })
  handle.channels.set('general', { id: 'general', type: 'chat', label: 'Announcements', direction: 'bidirectional' })
  handle.channels.set('room-2', { id: 'room-2', type: 'chat', label: 'general', direction: 'bidirectional' })

  expect(() => handle.resolveChannel('general')).toThrow(/matches channel id general and label "general"/)
  expect(handle.resolveChannel('id:general')).toBe('general')
  expect(handle.resolveChannel('id:room-2')).toBe('room-2')
  expect(handle.resolveChannel('Announcements')).toBe('general')
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

test('a qualified label resolves to its own channel; the exact label wins over the qualifier-drop fallback', () => {
  const handle = stubHandle()
  expect(handle.resolveChannel('toy lobby (east)')).toBe('toy:lobby-east')
  expect(handle.resolveChannel('#Toy Lobby (West)')).toBe('toy:lobby-west')
  // bare `toy lobby` matches `Toy Lobby` exactly and must not become ambiguous
  // just because qualified siblings exist
  expect(handle.resolveChannel('toy lobby')).toBe('toy:lobby')
})

test('an unqualified reference with no exact label and several qualified matches is an error naming each match — never a first-match delivery', () => {
  const handle = stubHandle()
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"kitchen" is ambiguous/)
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"Kitchen \(A\)" \(id toy:kitchen-a\)/)
  expect(() => handle.resolveChannel('kitchen')).toThrow(/"Kitchen \(B\)" \(id toy:kitchen-b\)/)
  expect(handle.resolveChannel('kitchen (b)')).toBe('toy:kitchen-b')
})
