import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../src/config'

const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'))
const load = (files: unknown) => {
  const p = join(dir, `c-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify({ servers: {}, files }))
  process.env.MCPL_BRIDGE_CONFIG = p
  try { return loadConfig().config } finally { delete process.env.MCPL_BRIDGE_CONFIG }
}

test('files settings are validated on load', () => {
  expect(load({ roots: ['/tmp/x'], maxBytes: 4 }).files).toEqual({ roots: ['/tmp/x'], maxBytes: 4 })
  expect(() => load({ roots: '/tmp/x' })).toThrow(/files.roots/)       // a string would be iterated character by character
  expect(() => load({ roots: ['relative'] })).toThrow(/files.roots/)
  expect(() => load({ maxBytes: 'big' })).toThrow(/files.maxBytes/)
  expect(() => load({ maxBytes: 0 })).toThrow(/files.maxBytes/)
  expect(() => load([])).toThrow(/files must be/)
})
