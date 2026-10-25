/**
 * The bridge identity against a fake issuer (no network): key file, key id,
 * the exact signed statements, the POST /token and /enroll bodies, expiry
 * reporting, refusals — and the config shape that turns it on.
 */
import { afterAll, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessRefused } from '../src/access'
import { loadConfig, resolveIdentity } from '../src/config'
import { Identity, aid1Payload, enrollStatement, tokenStatement } from '../src/identity'

const TMP = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-identity-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

type Call = { url: string; body: Record<string, unknown> }
function fakeFetch(answer: (path: string, body: Record<string, unknown>) => { status: number; json: unknown }) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    const a = answer(new URL(url).pathname, body)
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { f, calls }
}

/** Verify a proof with the public key named by an `ed25519:<b64url raw>` id. */
function proofVerifies(keyId: string, statement: string, proof: string): boolean {
  const raw = Buffer.from(keyId.slice('ed25519:'.length), 'base64url')
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return verify(null, Buffer.from(statement), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(proof, 'base64url'))
}

const aid1 = (payload: object) => `aid1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.from('x'.repeat(64)).toString('base64url')}`

test('key created 0600 on first use, id in the archipelago format, stable across instances', () => {
  const keyPath = join(TMP, 'k1', 'identity-key.pem')
  const a = new Identity({ home: 'id.example', keyPath })
  const id = a.keyId()
  expect(id).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/)
  expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  expect(new Identity({ home: 'id.example', keyPath }).keyId()).toBe(id)
  expect(a.recordPath).toBe(join(TMP, 'k1', 'identity-key.json'))
  expect(a.url).toBe('https://id.example')
})

test('enroll: signed enroll statement, record written beside the key, first token discarded; one-time', async () => {
  const keyPath = join(TMP, 'k2', 'identity-key.pem')
  const { f, calls } = fakeFetch(() => ({ status: 200, json: { sub: 'agent:cc-bridge@guest', token: aid1({ exp: 1 }) } }))
  const idn = new Identity({ home: 'id.example', keyPath, url: 'http://127.0.0.1:9', fetchImpl: f })
  const rec = await idn.enroll('inv_abc', 'cc-bridge')
  expect(rec).toMatchObject({ sub: 'agent:cc-bridge@guest', name: 'cc-bridge', home: 'id.example' })
  expect(calls[0]!.url).toBe('http://127.0.0.1:9/enroll')
  const b = calls[0]!.body
  expect(Object.keys(b).sort()).toEqual(['id', 'invite', 'name', 'proof', 'timestamp'])
  expect(b.id).toBe(idn.keyId())
  expect(proofVerifies(String(b.id), enrollStatement('id.example', 'inv_abc', String(b.timestamp)), String(b.proof))).toBe(true)
  const onDisk = readFileSync(idn.recordPath, 'utf8')
  expect(JSON.parse(onDisk)).toEqual(rec)
  expect(onDisk).not.toContain('aid1.')
  await expect(idn.enroll('inv_def', 'again')).rejects.toThrow(/already enrolled/)
})

test('mint: signed token statement with ttl; expiresAt from the reply, else from the token; refusals carry the issuer reason', async () => {
  const keyPath = join(TMP, 'k3', 'identity-key.pem')
  const now = Math.floor(Date.now() / 1000)
  let reply: { status: number; json: unknown } = { status: 200, json: {} }
  const { f, calls } = fakeFetch(() => reply)
  const idn = new Identity({ home: 'id.example', keyPath, fetchImpl: f })

  // not enrolled: refused locally, nothing sent
  await expect(idn.mint('games', { ttl: '15m' })).rejects.toMatchObject({ kind: 'no_identity' })
  expect(calls).toHaveLength(0)
  idn.keyId() // creates the key (and its directory)
  writeFileSync(idn.recordPath, JSON.stringify({ sub: 'agent:cc@guest', name: 'cc', home: 'id.example', enrolledAt: 'x' }))

  reply = { status: 200, json: { token: aid1({ sub: 'agent:cc@guest', aud: 'games', exp: now + 900 }), sub: 'agent:cc@guest', exp: now + 900 } }
  const c = await idn.mint('games', { ttl: '15m' })
  expect(c.expiresAt).toBe((now + 900) * 1000)
  expect(c.principal).toBe('agent:cc@guest')
  const b = calls[0]!.body
  expect(calls[0]!.url).toBe('https://id.example/token')
  expect(Object.keys(b).sort()).toEqual(['audience', 'id', 'proof', 'timestamp', 'ttl'])
  expect(b.ttl).toBe('15m')
  expect(proofVerifies(String(b.id), tokenStatement('id.example', 'games', String(b.timestamp)), String(b.proof))).toBe(true)
  expect(tokenStatement('id.example', 'games', 'T')).toBe('archipelago-token|v1|id.example|games|T')

  // an issuer without token-ttl: no `exp` in the reply → the token's own claim
  reply = { status: 200, json: { token: aid1({ sub: 'agent:cc@guest', exp: now + 7 * 86400 }), sub: 'agent:cc@guest' } }
  expect((await idn.mint('games')).expiresAt).toBe((now + 7 * 86400) * 1000)

  // no expiry anywhere → MUST NOT answer (RFC-015 §3.2)
  reply = { status: 200, json: { token: 'opaque-credential-without-exp' } }
  await expect(idn.mint('games')).rejects.toMatchObject({ kind: 'unavailable', reason: 'id.example did not say when the credential expires' })

  reply = { status: 403, json: { error: 'audience not allowed' } }
  const e = await idn.mint('orrery').catch(x => x)
  expect(e).toBeInstanceOf(AccessRefused)
  expect(e).toMatchObject({ audience: 'orrery', kind: 'provider_refused', reason: 'id.example refused: audience not allowed' })
  // RFC-015 r3 refusal kinds by what the provider said
  reply = { status: 400, json: { error: 'unknown audience' } }
  expect(await idn.mint('nope').catch(x => x)).toMatchObject({ kind: 'provider_refused' })
  reply = { status: 429, json: { error: 'rate limited' } }
  expect(await idn.mint('games').catch(x => x)).toMatchObject({ kind: 'rate_limited', reason: 'id.example is rate-limiting: rate limited' })
  reply = { status: 503, json: {} }
  expect(await idn.mint('games').catch(x => x)).toMatchObject({ kind: 'unavailable', reason: 'id.example gave no credential: HTTP 503' })
  const down = new Identity({ home: 'id.example', keyPath, fetchImpl: (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch })
  expect(await down.mint('games').catch(x => x)).toMatchObject({ kind: 'unavailable', reason: 'id.example unreachable: connect ECONNREFUSED' })

  // a record from another home is not this identity
  writeFileSync(idn.recordPath, JSON.stringify({ sub: 'agent:cc@guest', name: 'cc', home: 'id.elsewhere', enrolledAt: 'x' }))
  await expect(idn.mint('games')).rejects.toMatchObject({ kind: 'no_identity', reason: 'this host is enrolled with id.elsewhere, not id.example' })
})

test('aid1Payload reads exp/sub; anything else is null', () => {
  expect(aid1Payload(aid1({ exp: 5, sub: 's' }))).toMatchObject({ exp: 5, sub: 's' })
  expect(aid1Payload('jwt.like.thing')).toBeNull()
  expect(aid1Payload('aid1.!!!.x')).toBeNull()
})

// ── config ──

function load(cfg: unknown): ReturnType<typeof loadConfig> {
  const p = join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify(cfg))
  const prev = process.env.MCPL_BRIDGE_CONFIG
  process.env.MCPL_BRIDGE_CONFIG = p
  try {
    return loadConfig()
  } finally {
    if (prev === undefined) delete process.env.MCPL_BRIDGE_CONFIG
    else process.env.MCPL_BRIDGE_CONFIG = prev
  }
}

test('config: identity + transport.access validated; defaults resolved', () => {
  const ok = load({ identity: { home: 'id.animalabs.ai' }, servers: { games: { transport: { url: 'wss://games.example/mcpl', access: 'games' } } } })
  const r = resolveIdentity(ok.config.identity!)
  expect(r.home).toBe('id.animalabs.ai')
  expect(r.url).toBe('https://id.animalabs.ai')
  expect(r.keyPath.endsWith('/.config/mcpl-bridge/identity-key.pem')).toBe(true)
  expect(r.keyPath.startsWith('/')).toBe(true)
  expect(resolveIdentity({ home: 'id.x', url: 'http://127.0.0.1:7360/' }).url).toBe('http://127.0.0.1:7360')

  const bad = (cfg: unknown) => expect(() => load(cfg)).toThrow()
  bad({ identity: 'id.animalabs.ai', servers: {} })
  bad({ identity: { home: 'https://id.animalabs.ai' }, servers: {} })
  bad({ identity: { home: 'id|x' }, servers: {} })
  bad({ identity: { home: 'id.x', keyPath: 'relative/key.pem' }, servers: {} })
  bad({ identity: { home: 'id.x', url: 'http://id.x' }, servers: {} }) // plaintext to a non-loopback issuer
  bad({ identity: { home: 'id.x', extra: 1 }, servers: {} })
  bad({ servers: { s: { transport: { command: 'node', access: 'games' } } } }) // stdio is not dialed
  bad({ servers: { s: { transport: { url: 'wss://x', access: '' } } } })
  bad({ servers: { s: { transport: { url: 'wss://x', access: 5 } } } })
  expect(load({ identity: { home: 'id.x', keyPath: '~/k.pem', url: 'https://id.x:8443' }, servers: {} }).config.identity?.home).toBe('id.x')
})
