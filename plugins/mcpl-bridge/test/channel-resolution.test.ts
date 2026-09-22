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
