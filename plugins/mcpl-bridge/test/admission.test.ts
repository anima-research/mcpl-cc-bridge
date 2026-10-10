import { expect, test } from 'bun:test'
import { expandTags } from '../src/grants'
import { McplServerHandle } from '../src/mcpl-host'
import type { ServerConfig } from '../src/config'
import { holdsAmbient } from '../src/wake'

const make = (cfg: Partial<ServerConfig>) =>
  new McplServerHandle('t', { transport: { command: 'true' }, ...cfg }, { deliver() {}, toolsChanged() {}, log() {} })

test('openOnAddressed defaults on exactly when the wake policy holds ambient traffic', () => {
  expect(holdsAmbient(undefined)).toBe(false)
  expect(holdsAmbient('all')).toBe(false)
  expect(holdsAmbient('chat')).toBe(true)
  expect(holdsAmbient({ wake: [['chat:addressed']], hold: [['chat:ambient']] })).toBe(true)
  // holds only bot ambient: human ambient would still wake per message
  expect(holdsAmbient({ hold: [['chat:ambient', 'chat:from-bot']] })).toBe(false)
  // a wake rule that catches ambient first
  expect(holdsAmbient({ wake: [['chat:ambient']], hold: [['chat:ambient']] })).toBe(false)

  expect(make({}).openOnAddressed).toBe(false)
  expect(make({ wake: 'chat' }).openOnAddressed).toBe(true)
  expect(make({ wake: 'all', openOnAddressed: true }).openOnAddressed).toBe(true)
  expect(make({ wake: 'chat', openOnAddressed: false }).openOnAddressed).toBe(false)
})

test('reactions, edits and deletes are ambient unless the producer marked them addressed', () => {
  for (const t of ['chat:reaction', 'chat:reaction-remove', 'chat:edited', 'chat:deleted']) {
    const tags = expandTags([t])
    expect(tags).toContain('chat:ambient')
    expect(tags).not.toContain('chat:addressed')
  }
  const mentionedEdit = expandTags(['chat:edited', 'chat:mention'])
  expect(mentionedEdit).toContain('chat:addressed')
  expect(mentionedEdit).not.toContain('chat:ambient')
  expect(expandTags(['chat:reaction', 'chat:to-self'])).toEqual(expect.arrayContaining(['chat:reaction', 'chat:to-self', 'chat:ambient']))
})

const dm = (over: Partial<{ channelId: string; rawChannel: string; authorId: string }> = {}) => ({ channelId: '', rawChannel: '', authorId: '', isDm: true, ...over })

test('whitelist mode judges DMs by the open set when there is no dmAllowlist — and fails closed on a DM naming no channel', () => {
  const h = make({ openChannelsOnly: true })
  h.channels.set('x:dm:1', { id: 'x:dm:1', type: 'chat', label: 'DM alice', direction: 'bidirectional' })
  expect(h.refusal(dm({ channelId: 'x:dm:1', rawChannel: 'x:dm:1' }))).toMatch(/DM in closed channel DM alice/)
  expect(h.refusal(dm({ authorId: 'u1' }))).toMatch(/DM in unregistered channel/)
  // a channel-less non-DM push (a heartbeat) is not channel traffic
  expect(h.refusal({ channelId: '', rawChannel: '', authorId: '', isDm: false })).toBeNull()
})

test('dmAllowlist replaces the open set for DMs: listed author or channel admits, anything else is refused', () => {
  const h = make({ openChannelsOnly: true, dmAllowlist: ['u2', 'x:dm:9'] })
  h.channels.set('x:dm:1', { id: 'x:dm:1', type: 'chat', label: 'DM alice', direction: 'bidirectional' })
  expect(h.refusal(dm({ authorId: 'u2' }))).toBeNull()
  expect(h.refusal(dm({ rawChannel: 'x:dm:9', authorId: 'u7' }))).toBeNull()
  expect(h.refusal(dm({ channelId: 'x:dm:1', rawChannel: 'x:dm:1', authorId: 'u1' }))).toMatch(/not in dmAllowlist/)
  // non-DM traffic is still the open set's business
  expect(h.refusal({ channelId: 'x:dm:1', rawChannel: 'x:dm:1', authorId: 'u2', isDm: false })).toMatch(/closed channel/)
})

test('dmAllowlist applies without openChannelsOnly too; [] admits no DMs', () => {
  const h = make({ dmAllowlist: [] })
  expect(h.refusal(dm({ authorId: 'u2' }))).toMatch(/not in dmAllowlist/)
  expect(h.refusal({ channelId: '', rawChannel: 'c:1', authorId: 'u2', isDm: false })).toBeNull()
  expect(make({}).refusal(dm({ authorId: 'u2' }))).toBeNull()
})
