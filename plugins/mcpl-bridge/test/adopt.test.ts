/**
 * identity adopt: static aid1 tokens → transport.access, against a fake issuer
 * that knows which key is which principal. The rule under test above all:
 * a server only moves if a key here IS the token's principal.
 */
import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptCommand, adoptTokens, type RawConfig } from '../src/adopt'
import { resolveIdentity, type IdentityConfig } from '../src/config'
import { Identity } from '../src/identity'

const TMP = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-adopt-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const HOME = 'id.example'
const token = (claims: object) => `aid1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${'c2lnbmF0dXJl'.repeat(6)}`
const ownerToken = (aud: string, exp = 1793816877) => token({ iss: HOME, sub: 'agent:owner@guest', aud, exp })

/** An issuer: key id → principal + the audiences it may have. */
function issuer(known: Map<string, { sub: string; audiences?: string[] }>) {
  return (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { id: string; audience: string }
    const p = known.get(b.id)
    const said = (status: number, json: object) => new Response(JSON.stringify(json), { status })
    if (!p) return said(403, { error: 'no principal for key' })
    if (p.audiences && !p.audiences.includes(b.audience)) return said(403, { error: 'audience not allowed' })
    const exp = Math.floor(Date.now() / 1000) + 60
    return said(200, { token: token({ sub: p.sub, aud: b.audience, exp }), sub: p.sub, exp })
  }) as unknown as typeof fetch
}

/** Keys live under a throwaway dir: `~/` in a config resolves against the real home, so tests name every path, and the default one is redirected. */
function world(name: string) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  const known = new Map<string, { sub: string; audiences?: string[] }>()
  const defaultKey = resolveIdentity({ home: HOME }).keyPath
  const makeIdentity = (c: IdentityConfig) => {
    const r = resolveIdentity(c)
    // the bridge's default key path must not be touched by a test
    return new Identity({ home: r.home, keyPath: r.keyPath === defaultKey ? join(dir, 'default.pem') : r.keyPath, fetchImpl: issuer(known) })
  }
  return { dir, known, makeIdentity, defaultKeyId: () => makeIdentity({ home: HOME }).keyId() }
}

test('no identity in the config: the default key is the principal → the server moves, the token is gone, the bridge gains an identity', async () => {
  const w = world('plain')
  w.known.set(w.defaultKeyId(), { sub: 'agent:owner@guest', audiences: ['docs', 'ecowitt'] })
  const raw: RawConfig = {
    files: { maxBytes: 200 },
    servers: {
      docs: { transport: { url: 'wss://docs.example/mcpl', token: ownerToken('docs') }, grant: ['tools'] },
      eco: { transport: { url: 'wss://eco.example/mcpl', token: ownerToken('ecowitt') } },
      board: { transport: { url: 'ws://127.0.0.1:1/mcpl', token: 'opaque-local-secret' } },
      portal: { transport: { command: 'node' } },
    },
  }
  const out = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(out.map(r => [r.server, r.outcome])).toEqual([['docs', 'adopted'], ['eco', 'adopted']])
  expect(raw.identity).toEqual({ home: HOME })
  expect(raw.servers!.docs).toEqual({ transport: { url: 'wss://docs.example/mcpl', access: 'docs' }, grant: ['tools'] })
  expect(raw.servers!.eco!.transport).toEqual({ url: 'wss://eco.example/mcpl', access: 'ecowitt' })
  // everything it does not name stays as written
  expect(raw.servers!.board!.transport!.token).toBe('opaque-local-secret')
  expect(raw.servers!.portal).toEqual({ transport: { command: 'node' } })
  expect(raw.files).toEqual({ maxBytes: 200 })
  expect(JSON.stringify(out)).not.toContain('aid1.')
})

test('the rule: a key that is someone else never takes a server over — the token stays and the operator is told what to do', async () => {
  const w = world('mismatch')
  w.known.set(w.defaultKeyId(), { sub: 'agent:someone-else@guest' })
  const original = ownerToken('docs')
  const raw: RawConfig = { servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: original } } } }
  const [r] = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(r!.outcome).toBe('kept')
  expect(raw.servers!.docs!.transport!.token).toBe(original)
  expect(raw.servers!.docs!.transport!.access).toBeUndefined()
  expect(raw.identity).toBeUndefined()
  expect(r!.detail).toContain('is agent:someone-else@guest')
  expect(r!.detail).not.toContain(original)
})

test('an unbound key: the token stays, and the answer is the exact change to make at the home node', async () => {
  const w = world('unbound')
  const raw: RawConfig = { servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: ownerToken('docs') } } } }
  const [r] = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(r!.outcome).toBe('kept')
  expect(r!.detail).toContain('no principal for key')
  expect(r!.detail).toContain(`give agent:owner@guest "key": "${w.defaultKeyId()}" and "docs" in its "audiences"`)
  expect(r!.detail).toContain('expired 2026-11-04T18:27:57Z')
})

test('the right key, a forbidden audience: the token stays, and the answer does not ask to rebind the key', async () => {
  const w = world('audience')
  w.known.set(w.defaultKeyId(), { sub: 'agent:owner@guest', audiences: ['docs'] })
  const raw: RawConfig = { identity: { home: HOME, keyPath: join(w.dir, 'default.pem') }, servers: { games: { transport: { url: 'wss://g.example/mcpl', token: ownerToken('games') } } } }
  const [r] = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(r!.outcome).toBe('kept')
  expect(r!.detail).toContain('audience not allowed')
  expect(r!.detail).toContain('allow "games" in the "audiences" of agent:owner@guest')
  expect(r!.detail).not.toContain('"key":')
  expect(raw.servers!.games!.transport!.access).toBeUndefined()
})

test('a bridge whose own identity is someone else: the server moves on the default key, as its own `transport.identity`', async () => {
  const w = world('two')
  const own = new Identity({ home: HOME, keyPath: join(w.dir, 'own.pem'), fetchImpl: issuer(w.known) })
  w.known.set(own.keyId(), { sub: 'agent:other@guest', audiences: ['speakers'] })
  w.known.set(w.defaultKeyId(), { sub: 'agent:owner@guest', audiences: ['docs'] })
  const ownCfg: IdentityConfig = { home: HOME, keyPath: join(w.dir, 'own.pem') }
  const raw: RawConfig = {
    identity: ownCfg,
    servers: {
      docs: { transport: { url: 'wss://docs.example/mcpl', token: ownerToken('docs') } },
      curation: { transport: { url: 'wss://c.example/mcpl', access: 'speakers' } },
    },
  }
  const [r, ...rest] = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(rest).toHaveLength(0) // curation already renews itself
  expect(r!.outcome).toBe('adopted')
  expect(raw.identity).toEqual(ownCfg)
  expect(raw.servers!.docs!.transport).toEqual({ url: 'wss://docs.example/mcpl', access: 'docs', identity: { home: HOME } })
  expect(raw.servers!.curation!.transport).toEqual({ url: 'wss://c.example/mcpl', access: 'speakers' })
})

test('--only limits it to the servers named', async () => {
  const w = world('only')
  w.known.set(w.defaultKeyId(), { sub: 'agent:owner@guest' })
  const raw: RawConfig = {
    servers: {
      docs: { transport: { url: 'wss://docs.example/mcpl', token: ownerToken('docs') } },
      games: { transport: { url: 'wss://g.example/mcpl', token: ownerToken('games') } },
    },
  }
  const out = await adoptTokens(raw, { makeIdentity: w.makeIdentity, only: ['docs'] })
  expect(out.map(r => r.server)).toEqual(['docs'])
  expect(typeof raw.servers!.games!.transport!.token).toBe('string')
})

test('the CLI against a real issuer URL: nothing moves when the issuer is unreachable, the file is untouched, no backup, nothing printed holds a token, exit 2', () => {
  const dir = join(TMP, 'cli')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'bridge.json')
  const secret = token({ iss: 'localhost:9', sub: 'agent:owner@guest', aud: 'docs', exp: 1793816877 })
  const body = JSON.stringify({ identity: { home: 'localhost:9', keyPath: join(dir, 'k.pem'), url: 'http://127.0.0.1:9' }, servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: secret } } } })
  writeFileSync(cfg, body, { mode: 0o644 })
  const r = spawnSync('bun', ['run', 'src/identity-cli.ts', 'adopt', '--config', cfg], { cwd: join(import.meta.dir, '..'), encoding: 'utf8', env: { ...process.env, HOME: dir } })
  expect(r.status).toBe(2)
  expect(r.stdout).toContain('still on its token')
  expect(r.stdout).toContain('Run this again once localhost:9 answers') // unreachable is not "bind this key"
  expect(r.stdout).not.toContain('"key":')
  expect(r.stdout + r.stderr).not.toContain('aid1.')
  expect(readFileSync(cfg, 'utf8')).toBe(body)
  expect(readdirSync(dir).filter(f => f.includes('.bak-'))).toHaveLength(0)
  expect(statSync(cfg).mode & 0o777).toBe(0o644)
  expect(existsSync(join(dir, 'k.pem'))).toBe(true) // the key to bind exists now
})

test('a record is not proof: a key whose record says the right principal, but which the issuer now knows as another, takes nothing over', async () => {
  const w = world('rebound')
  const keyPath = join(w.dir, 'rebound.pem')
  const stale = w.makeIdentity({ home: HOME, keyPath })
  writeFileSync(stale.recordPath, JSON.stringify({ sub: 'agent:owner@guest', name: 'x', home: HOME, enrolledAt: 'then' }))
  w.known.set(stale.keyId(), { sub: 'agent:someone-else@guest' })
  const original = ownerToken('docs')
  const raw: RawConfig = { identity: { home: HOME, keyPath }, servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: original } } } }
  const [r] = await adoptTokens(raw, { makeIdentity: w.makeIdentity })
  expect(r!.outcome).toBe('kept')
  expect(r!.detail).toContain('is agent:someone-else@guest now')
  expect(raw.servers!.docs!.transport!.token).toBe(original)
  expect(raw.servers!.docs!.transport!.access).toBeUndefined()
})

test('a server\'s own identity: tried first and kept when it is the one; replaced when another key is, so the dial uses what was proven', async () => {
  const w = world('own')
  const bridgeKey = join(w.dir, 'bridge.pem')
  const ownKey = join(w.dir, 'own-server.pem')
  const bridge = w.makeIdentity({ home: HOME, keyPath: bridgeKey })
  const own = w.makeIdentity({ home: HOME, keyPath: ownKey })
  // The server's own identity is the token's principal: nothing else needs to change.
  w.known.set(own.keyId(), { sub: 'agent:owner@guest' })
  w.known.set(bridge.keyId(), { sub: 'agent:other@guest' })
  const ownCfg: IdentityConfig = { home: HOME, keyPath: ownKey }
  const first: RawConfig = { identity: { home: HOME, keyPath: bridgeKey }, servers: { docs: { transport: { url: 'wss://d/mcpl', token: ownerToken('docs'), identity: ownCfg } } } }
  const [a] = await adoptTokens(first, { makeIdentity: w.makeIdentity })
  expect(a!.outcome).toBe('adopted')
  expect(first.servers!.docs!.transport).toEqual({ url: 'wss://d/mcpl', access: 'docs', identity: ownCfg })

  // The bridge's identity is the principal and the server's own is someone else: the override goes, or it would dial as them.
  w.known.set(own.keyId(), { sub: 'agent:other@guest' })
  w.known.set(bridge.keyId(), { sub: 'agent:owner@guest' })
  rmSync(own.recordPath, { force: true })
  rmSync(bridge.recordPath, { force: true })
  const second: RawConfig = { identity: { home: HOME, keyPath: bridgeKey }, servers: { docs: { transport: { url: 'wss://d/mcpl', token: ownerToken('docs'), identity: ownCfg } } } }
  const [b] = await adoptTokens(second, { makeIdentity: w.makeIdentity })
  expect(b!.outcome).toBe('adopted')
  expect(second.servers!.docs!.transport).toEqual({ url: 'wss://d/mcpl', access: 'docs' })
})

test('the recovery command survives a path with a space or a quote', () => {
  expect(adoptCommand('/opt/bridge', '/home/me/cfg.json')).toBe('bun run --cwd /opt/bridge identity adopt --config /home/me/cfg.json')
  expect(adoptCommand('/opt/my bridge', "/home/me/o'brien/cfg.json")).toBe(`bun run --cwd '/opt/my bridge' identity adopt --config '/home/me/o'\\''brien/cfg.json'`)
  expect(adoptCommand('/opt/bridge', null)).toBe('bun run --cwd /opt/bridge identity adopt')
})

test('the CLI writes nothing if the config changed while it waited on the issuer: that edit stays', async () => {
  const dir = join(TMP, 'race')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'bridge.json')
  const secret = token({ iss: 'localhost:9', sub: 'agent:owner@guest', aud: 'docs', exp: 1793816877 })
  const edited = () => JSON.stringify({ identity: { home: 'localhost:9', keyPath: join(dir, 'k.pem'), url: `http://127.0.0.1:${issuerPort.port}` }, servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: secret } }, added: { transport: { url: 'wss://new.example/mcpl' } } } })
  const issuerPort = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async r => {
      await r.json()
      writeFileSync(cfg, edited()) // someone saves the config just now
      const exp = Math.floor(Date.now() / 1000) + 60
      return Response.json({ token: token({ sub: 'agent:owner@guest', aud: 'docs', exp }), sub: 'agent:owner@guest', exp })
    },
  })
  try {
    writeFileSync(cfg, JSON.stringify({ identity: { home: 'localhost:9', keyPath: join(dir, 'k.pem'), url: `http://127.0.0.1:${issuerPort.port}` }, servers: { docs: { transport: { url: 'wss://docs.example/mcpl', token: secret } } } }))
    const proc = Bun.spawn(['bun', 'run', 'src/identity-cli.ts', 'adopt', '--config', cfg], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: dir } })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(2)
    expect(out).toContain('changed while this ran: nothing written')
    expect(out).not.toContain('now renews itself')
    expect(readFileSync(cfg, 'utf8')).toBe(edited())
    expect(readdirSync(dir).filter(f => f.includes('.bak-'))).toHaveLength(0)
  } finally {
    issuerPort.stop(true)
  }
})

