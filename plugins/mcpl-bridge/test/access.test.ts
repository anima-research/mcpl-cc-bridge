/**
 * Dial credentials (`transport.access`), without a network issuer: the
 * credential cache, audit records, redaction and what a failed dial says —
 * against a real McplServerHandle talking to an in-process MCPL peer, with a
 * fake issuer standing in for the identity provider.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity'
import {
  DIAL_TTL,
  AccessRefused,
  CredentialCache,
  RENEW_EARLY_MS,
  rfc3339,
  type RefusalKind,
  type AccessAuditRecord,
  type AccessIssuer,
  type MintedCredential,
} from '../src/access'
import { resolveUrl, type ServerConfig } from '../src/config'
import { McplServerHandle, dialFailure } from '../src/mcpl-host'
import { REDACTED, SecretRegistry } from '../src/redact'
import { McplPeer } from './mcpl-peer'

test('RFC 3339 UTC expiry', () => {
  expect(rfc3339(Date.UTC(2026, 9, 25, 4, 15, 0))).toBe('2026-10-25T04:15:00Z')
  expect(rfc3339(Date.UTC(2026, 9, 25, 4, 15, 0, 250))).toBe('2026-10-25T04:15:00.250Z')
})

test('transport.access credential wins over the static token at the query', () => {
  const t = { url: 'mcpl://games.example/mcpl', token: 'static-token-123' }
  expect(resolveUrl(t)).toBe('wss://games.example/mcpl?token=static-token-123')
  expect(resolveUrl(t, 'minted-credential-9')).toBe('wss://games.example/mcpl?token=minted-credential-9')
})

// ── cache ──

test('cache: reused until 60 s before expiry, `fresh` always mints, concurrent asks share one mint, a failure drops the entry', async () => {
  let now = 1_000_000
  const cache = new CredentialCache(() => now)
  let n = 0
  const mint = async (): Promise<MintedCredential> => ({ credential: `cred-${++n}`, expiresAt: now + 15 * 60_000 })
  expect((await cache.get('games', false, mint)).cached).toBe(false)
  const again = await cache.get('games', false, mint)
  expect(again).toEqual({ credential: { credential: 'cred-1', expiresAt: 1_000_000 + 900_000 }, cached: true })
  expect((await cache.get('games', true, mint)).credential.credential).toBe('cred-2')
  expect((await cache.get('orrery', false, mint)).credential.credential).toBe('cred-3') // per audience
  now += 15 * 60_000 - RENEW_EARLY_MS // inside the renewal window
  expect((await cache.get('games', false, mint)).credential.credential).toBe('cred-4')
  const [a, b] = await Promise.all([cache.get('x', false, mint), cache.get('x', false, mint)])
  expect(a.credential.credential).toBe(b.credential.credential)
  expect(n).toBe(5)
  await expect(cache.get('games', true, async () => { throw new AccessRefused('games', 'nope') })).rejects.toThrow('nope')
  expect((await cache.get('games', false, mint)).cached).toBe(false) // nothing stale left behind
})

// ── redaction ──

test('redaction: known credentials, aid1-shaped tokens, and (in logs) ?token= values', () => {
  let now = 0
  const r = new SecretRegistry(() => now)
  r.add('s3cr3t-static-token')
  r.add('short') // too short to track: would shred ordinary text
  r.add('minted-credential-abc', 1000)
  const aid1 = 'aid1.eyJ2IjoxLCJzdWIiOiJ4In0.c2lnbmF0dXJlLWJ5dGVz'
  expect(r.scrub(`a s3cr3t-static-token b ${aid1} c short`)).toBe(`a ${REDACTED} b ${REDACTED} c short`)
  expect(r.scrub('x minted-credential-abc')).toBe(`x ${REDACTED}`)
  expect(r.scrub('https://docs.example/share?token=abcdef123')).toBe('https://docs.example/share?token=abcdef123')
  expect(r.scrubLog('dial wss://h/mcpl?x=1&token=abcdef123&y=2')).toBe(`dial wss://h/mcpl?x=1&token=${REDACTED}&y=2`)
  now = 1000 + 60 * 60_000 + 1 // an hour past expiry: forgotten
  expect(r.scrub('x minted-credential-abc')).toBe('x minted-credential-abc')
  const v = { content: [{ type: 'text', text: `t ${aid1}` }], n: 1, keep: 'plain' }
  const out = r.scrubDeep(v)
  expect(out).toEqual({ content: [{ type: 'text', text: `t ${REDACTED}` }], n: 1, keep: 'plain' })
  expect(r.scrubDeep({ a: 'plain' })).toEqual({ a: 'plain' })
  const unchanged = { a: ['plain'] }
  expect(r.scrubDeep(unchanged)).toBe(unchanged) // nothing to redact → same object
  const proto = JSON.parse(`{"__proto__": "${aid1}"}`)
  expect(Object.keys(r.scrubDeep(proto))).toEqual(['__proto__'])
})

// ── the handle, end to end against an in-process peer ──

class FakeIssuer implements AccessIssuer {
  mints: Array<{ audience: string; ttl: string }> = []
  refuse: { kind: RefusalKind; reason: string } | null = null
  lifetimeMs = 15 * 60_000
  hang = false
  timeouts: Array<number | undefined> = []
  constructor(readonly who = 'agent:test@guest') {}
  principal(): string {
    return this.who
  }
  async mint(audience: string, opts: { ttl: string; timeoutMs?: number }): Promise<MintedCredential> {
    this.mints.push({ audience, ttl: opts.ttl })
    this.timeouts.push(opts.timeoutMs)
    if (this.hang) await new Promise(() => {})
    if (this.refuse) throw new AccessRefused(audience, this.refuse.kind, this.refuse.reason)
    const payload = Buffer.from(JSON.stringify({ aud: audience, n: this.mints.length })).toString('base64url')
    return { credential: `aid1.${payload}.${Buffer.from(this.who).toString('base64url')}${'c2lnbmF0dXJl'.repeat(3)}${this.mints.length}`, expiresAt: Date.now() + this.lifetimeMs, principal: this.who }
  }
}

const cleanup: Array<() => unknown> = []
const aid1Token = (claims: object) => `aid1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${'c2lnbmF0dXJl'.repeat(6)}`
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

const SERVER_CAPS = { version: '0.5', pushEvents: true, featureSets: { apps: { description: 'apps', uses: ['pushEvents'] } } }

async function setup(opts: { verifyUpgrade?: (url: URL) => true | number; renewCommand?: string; grant?: string[]; issuer?: AccessIssuer | null; issuerFn?: () => AccessIssuer | null; transport?: Partial<{ access: string; token: string; tokenEnv: string }> } = {}) {
  const peer = await McplPeer.start({ mcpl: SERVER_CAPS, ...(opts.verifyUpgrade ? { verifyUpgrade: opts.verifyUpgrade } : {}) })
  const audits: AccessAuditRecord[] = []
  const logs: string[] = []
  const issuer = opts.issuer === undefined ? new FakeIssuer() : opts.issuer
  const cfg: ServerConfig = { transport: { url: peer.url, ...opts.transport }, grant: opts.grant ?? ['pushEvents'], reconnectIntervalMs: 100 }
  const h = new McplServerHandle('svc', cfg, {
    deliver() {},
    toolsChanged() {},
    log: l => logs.push(l),
    issuer: opts.issuerFn ?? (() => issuer),
    audit: r => audits.push(r),
    ...(opts.renewCommand ? { renewCommand: () => opts.renewCommand! } : {}),
  })
  cleanup.push(() => peer.close(), () => h.close())
  h.start()
  await h.firstAttempt
  return { peer, h, audits, logs, issuer }
}

test('a gated method without its grant: -32002 with data.capability', async () => {
  const { peer, h } = await setup()
  await peer.policyCount(1)
  expect(h.grant).toEqual(['pushEvents'])
  const inf = await peer.request('inference/request', { featureSet: 'x', messages: [] })
  expect(inf.error).toMatchObject({ code: -32002, data: { capability: 'inferenceRequest' } })
})

test('access/token is not a method this host knows: -32601', async () => {
  const { peer, issuer } = await setup()
  await peer.policyCount(1)
  expect((await peer.request('access/token', { audience: 'games' })).error?.code).toBe(-32601)
  expect((issuer as FakeIssuer).mints).toHaveLength(0)
})

test('dial credential: transport.access at the upgrade, reused across a drop, fresh on a reload; a failed mint fails the dial without the credential', async () => {
  const { peer, h, issuer, audits } = await setup({ transport: { access: 'games', token: 'static-fallback-token' } })
  await peer.policyCount(1)
  const first = peer.token(0)!
  expect(first.startsWith('aid1.')).toBe(true)
  expect(first).not.toBe('static-fallback-token')
  expect(issuer!.mints[0]).toEqual({ audience: 'games', ttl: DIAL_TTL })
  expect(h.accessAudience).toBe('games')

  await h.restart() // mcpl_reload: someone asked for a clean start
  await peer.policyCount(2)
  const second = peer.token(1)!
  expect(second).not.toBe(first)

  peer.dropAll() // a network blip: the bridge redials on its own, and spends no mint on it
  await peer.policyCount(3)
  expect(peer.token(2)).toBe(second)
  expect(issuer!.mints.map(m => m.audience)).toEqual(['games', 'games'])
  expect(audits.filter(a => a.kind === 'dial').map(a => a.outcome)).toEqual(['granted', 'granted', 'cached'])

  issuer!.refuse = { kind: 'provider_refused', reason: 'id.example refused: principal expired' }
  await h.restart()
  expect(h.status).toBe('disconnected')
  expect(h.lastError).toBe('connect failed: access "games": id.example refused: principal expired')
  expect(peer.upgrades).toHaveLength(3) // never dialed without its credential
})

test('transport.access with no identity configured: a dial error that says so', async () => {
  const { h, peer } = await setup({ issuer: null, transport: { access: 'games' } })
  expect(h.status).toBe('disconnected')
  expect(h.lastError).toMatch(/access "games": no identity configured/)
  expect(peer.upgrades).toHaveLength(0)
})

test('a provider answer without an expiry fails the dial: the credential is not used', async () => {
  const dir = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-v15-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const keyPath = join(dir, 'identity-key.pem')
  const fetchImpl = (async () => new Response(JSON.stringify({ token: 'opaque-credential-without-expiry', sub: 'agent:x@guest' }), { status: 200 })) as unknown as typeof fetch
  const identity = new Identity({ home: 'id.example', keyPath, fetchImpl })
  identity.keyId()
  writeFileSync(identity.recordPath, JSON.stringify({ sub: 'agent:x@guest', name: 'x', home: 'id.example', enrolledAt: 'x' }))
  const { h, peer, audits } = await setup({ issuer: identity, transport: { access: 'games' } })
  expect(h.status).toBe('disconnected')
  expect(h.lastError).toContain('id.example did not say when the credential expires')
  expect(peer.upgrades).toHaveLength(0)
  expect(audits.at(-1)).toMatchObject({ kind: 'dial', audience: 'games', outcome: 'refused', refusal: 'unavailable' })
})

test('a cached credential always has at least two minutes left', async () => {
  let now = 0
  const cache = new CredentialCache(() => now)
  let n = 0
  const mint = async (): Promise<MintedCredential> => ({ credential: `c${++n}`, expiresAt: now + 150_000 }) // 2.5 minutes
  expect((await cache.get('k', false, mint)).cached).toBe(false)
  now = 29_000 // 2:01 left → still served
  expect((await cache.get('k', false, mint)).cached).toBe(true)
  now = 31_000 // 1:59 left → never from the cache
  expect(cache.peek('k')).toBeUndefined()
  const again = await cache.get('k', false, mint)
  expect(again).toMatchObject({ cached: false, credential: { credential: 'c2' } })
  expect(RENEW_EARLY_MS).toBe(120_000)
})

test('two principals on one configured server get different cached dial credentials for the same audience', async () => {
  const ada = new FakeIssuer('agent:ada@guest')
  const bo = new FakeIssuer('agent:bo@guest')
  let current: FakeIssuer = ada
  const { peer } = await setup({ issuerFn: () => current, transport: { access: 'games' } })
  await peer.policyCount(1)
  const a1 = peer.token(0)
  current = bo
  peer.dropAll()
  await peer.policyCount(2)
  const b1 = peer.token(1)
  expect(b1).not.toBe(a1)
  current = ada
  peer.dropAll()
  await peer.policyCount(3)
  expect(peer.token(2)).toBe(a1) // ada's own cached entry
  expect(ada.mints).toHaveLength(1)
  expect(bo.mints).toHaveLength(1)
})

// ── when a dial fails: say why, and never with the credential ──

test('a refused credential is not offered twice: the next dial mints', async () => {
  let refuse = false
  const issuer = new FakeIssuer()
  const { peer, h } = await setup({ issuer, transport: { access: 'games' }, verifyUpgrade: () => (refuse ? 401 : true) })
  await peer.policyCount(1)
  const n = issuer.mints.length
  refuse = true
  peer.dropAll()
  while (!h.lastError?.includes('refused')) await Bun.sleep(20) // the cached one, turned down
  expect(issuer.mints.length).toBe(n)
  refuse = false
  await peer.policyCount(2)
  expect(issuer.mints.length).toBe(n + 1)
  expect(peer.token()).not.toBe(peer.token(0))
})

test('an expired static token is never dialed: the error names when, who and the way out, not the token', async () => {
  const token = aid1Token({ sub: 'agent:someone@guest', aud: 'docs', exp: 1793816877 })
  const { peer, h, logs } = await setup({ transport: { token }, renewCommand: 'bun run identity adopt --config /x.json' })
  expect(h.status).toBe('disconnected')
  expect(peer.upgrades).toHaveLength(0)
  expect(h.staticTokenExpiresAt).toBe(1793816877_000)
  expect(h.lastError).toBe('connect failed: static token expired 2026-11-04T18:27:57Z (agent:someone@guest, audience docs) — not a server outage, and it will not come back on its own. To make it renew itself: bun run identity adopt --config /x.json')
  expect(JSON.stringify(logs)).not.toContain(token)
})

test('an expired token from the environment is not told to run a command that cannot reach it', async () => {
  process.env.MCPL_TEST_EXPIRED = aid1Token({ sub: 'agent:someone@guest', aud: 'docs', exp: 1793816877 })
  cleanup.push(() => delete process.env.MCPL_TEST_EXPIRED)
  const { peer, h } = await setup({ transport: { tokenEnv: 'MCPL_TEST_EXPIRED' }, renewCommand: 'bun run identity adopt' })
  expect(peer.upgrades).toHaveLength(0)
  expect(h.lastError).toContain('static token expired')
  expect(h.lastError).toContain('It comes from $MCPL_TEST_EXPIRED')
  expect(h.lastError).not.toContain('identity adopt')
})

test('a static token with time left dials as before, and reports how long it has', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = aid1Token({ sub: 'agent:someone@guest', aud: 'docs', exp })
  const { peer, h } = await setup({ transport: { token } })
  expect(h.status).toBe('ready')
  expect(peer.token(0)).toBe(token)
  expect(h.staticTokenExpiresAt).toBe(exp * 1000)
})

test('an opaque static token is left alone: nothing to read an expiry from', async () => {
  const { peer, h } = await setup({ transport: { token: 'opaque-shared-secret' } })
  expect(h.status).toBe('ready')
  expect(peer.token(0)).toBe('opaque-shared-secret')
  expect(h.staticTokenExpiresAt).toBeNull()
})

test('a refused upgrade reads as one, not as [object ErrorEvent], and the URL with the credential stays out of it', async () => {
  const token = aid1Token({ sub: 'agent:someone@guest', aud: 'docs', exp: Math.floor(Date.now() / 1000) + 3600 })
  const { h, logs } = await setup({ transport: { token }, verifyUpgrade: () => 401 })
  expect(h.status).toBe('disconnected')
  expect(h.lastError).toContain('the server refused the WebSocket upgrade')
  expect(h.lastError).not.toContain('object')
  expect(h.lastError).not.toContain('token=')
  expect(h.lastError).not.toContain(token)
  expect(JSON.stringify(logs)).not.toContain(token)
})

test('an unreachable server reads as such, with the credential stripped', async () => {
  const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = dead.port
  dead.stop(true)
  const logs: string[] = []
  const h = new McplServerHandle('svc', { transport: { url: `ws://127.0.0.1:${port}/mcpl`, token: 'some-opaque-secret' }, grant: [], reconnect: false } as ServerConfig, { deliver() {}, toolsChanged() {}, log: l => logs.push(l) })
  cleanup.push(() => h.close())
  h.start()
  await h.firstAttempt
  expect(h.lastError).toBe('connect failed: Failed to connect')
  expect(JSON.stringify(logs)).not.toContain('some-opaque-secret')
})

test('dialFailure: an ErrorEvent loses the URL, an aid1 token anywhere in the text is scrubbed, anything else still says something', () => {
  const token = aid1Token({ exp: 1 })
  const event = { message: `WebSocket connection to 'wss://docs.example/mcpl?token=${token}' failed: Failed to connect` }
  expect(dialFailure(event)).toBe('Failed to connect')
  expect(dialFailure(new Error(`boom ${token}`))).not.toContain(token)
  expect(dialFailure({ message: 'getaddrinfo ENOTFOUND wss://x?token=abc123' })).not.toContain('abc123')
  expect(dialFailure('plain')).toBe('plain')
})

test('a close reason echoing the dialed query does not carry an encoded credential to the model', async () => {
  const door = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (r, srv) => (srv.upgrade(r) ? undefined : new Response('', { status: 400 })),
    websocket: { open: ws => void setTimeout(() => ws.close(4401, 'refused /mcpl?token=opaque%2Bshared%2Fsecret'), 20), message() {} },
  })
  const h = new McplServerHandle('svc', { transport: { url: `ws://127.0.0.1:${door.port}/mcpl`, token: 'opaque+shared/secret' }, grant: [], reconnectIntervalMs: 60_000 }, { deliver() {}, toolsChanged() {}, log() {} })
  cleanup.push(() => void door.stop(true), () => h.close())
  h.start()
  await h.firstAttempt
  expect(h.lastError).toContain('4401 refused')
  expect(h.lastError).not.toContain('opaque')
})

for (const [when, delayMs] of [['at once', 0], ['a moment later', 20]] as const) {
  test(`a door that accepts the upgrade and closes ${when} is heard: its code and reason reach the error without a timeout, and the credential is not offered again`, async () => {
    const door = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (r, srv) => (srv.upgrade(r) ? undefined : new Response('', { status: 400 })),
      websocket: {
        open(ws) {
          if (delayMs) setTimeout(() => ws.close(4401, 'unauthorized'), delayMs)
          else ws.close(4401, 'unauthorized')
        },
        message() {},
      },
    })
    const issuer = new FakeIssuer()
    const h = new McplServerHandle('svc', { transport: { url: `ws://127.0.0.1:${door.port}/mcpl`, access: 'games' }, grant: [], reconnectIntervalMs: 50 }, { deliver() {}, toolsChanged() {}, log() {}, issuer: () => issuer })
    cleanup.push(() => void door.stop(true), () => h.close())
    const started = Date.now()
    h.start()
    await h.firstAttempt
    expect(Date.now() - started).toBeLessThan(2000)
    expect(h.lastError).toContain('(4401 unauthorized)')
    const n = issuer.mints.length
    while (issuer.mints.length === n) await Bun.sleep(20)
    expect(issuer.mints.length).toBeGreaterThan(n)
  })
}
