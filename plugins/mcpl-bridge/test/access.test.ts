/**
 * MCPL RFC-015 host side, without a network issuer: params validation, the
 * grant rule, the credential cache, audit records and redaction — the last
 * three against a real McplServerHandle talking to an in-process MCPL peer,
 * with a fake issuer standing in for the identity provider.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity'
import {
  ACCESS_TIME_BOUND,
  ACCESS_TTL,
  AccessRefused,
  CredentialCache,
  RENEW_EARLY_MS,
  auditEndpoint,
  rfc3339,
  validateAccessParams,
  type RefusalKind,
  type AccessAuditRecord,
  type AccessIssuer,
  type MintedCredential,
} from '../src/access'
import { DEFAULT_GRANT, resolveUrl, type ServerConfig } from '../src/config'
import { computeGrant, wildcardOnlyMatches } from '../src/grants'
import { McplServerHandle, hostMcplCaps } from '../src/mcpl-host'
import { REDACTED, SecretRegistry } from '../src/redact'
import { advertisedCapabilities, deriveFeatureSets } from '../src/vendor/mcpl-core/index.js'
import { McplPeer } from './mcpl-peer'

// ── params (RFC §3.1) ──

test('access/token params: the four members, typed and bounded; anything else is -32602 material', () => {
  expect(validateAccessParams({ audience: 'games' })).toEqual({ ok: true, params: { audience: 'games' } })
  expect(validateAccessParams({ audience: 'games', endpoint: 'wss://games.example/mcpl', purpose: 'doom-1', fresh: true })).toEqual({
    ok: true,
    params: { audience: 'games', endpoint: 'wss://games.example/mcpl', purpose: 'doom-1', fresh: true },
  })
  const bad = (p: unknown) => {
    const r = validateAccessParams(p)
    return r.ok ? null : r.field
  }
  expect(bad({ audience: 'games', scope: 'x' })).toBe('scope') // unknown member
  expect(bad({ audience: 'games', Audience: 'x' })).toBe('Audience')
  expect(bad({})).toBe('audience')
  expect(bad({ audience: '' })).toBe('audience')
  expect(bad({ audience: 'a'.repeat(129) })).toBe('audience')
  expect(bad({ audience: 'a'.repeat(128) })).toBeNull()
  expect(bad({ audience: 7 })).toBe('audience')
  expect(bad({ audience: 'games', endpoint: 'not a uri' })).toBe('endpoint')
  expect(bad({ audience: 'games', endpoint: 5 })).toBe('endpoint')
  expect(bad({ audience: 'games', purpose: 'p'.repeat(257) })).toBe('purpose')
  expect(bad({ audience: 'games', purpose: 'é'.repeat(256) })).toBeNull() // characters, not UTF-16 halves
  expect(bad({ audience: 'games', fresh: 'yes' })).toBe('fresh')
  expect(bad(null)).toBe('params')
  expect(bad(['games'])).toBe('params')
  expect(bad('games')).toBe('params')
  // MCP's reserved _meta rides on any request; accepted as an object, ignored.
  expect(validateAccessParams({ audience: 'games', _meta: { trace: 1 } })).toEqual({ ok: true, params: { audience: 'games' } })
  expect(bad({ audience: 'games', _meta: 'x' })).toBe('_meta')
})

// ── grant (RFC §4.1) ──

test('access.token is granted only by name: never by default, never by a wildcard', () => {
  const advertised = advertisedCapabilities({ version: '0.5', pushEvents: true, access: { token: true } } as never)
  expect([...advertised]).toContain('access.token')
  expect([...advertisedCapabilities({ version: '0.5', access: true } as never)]).toEqual(['access.token'])
  expect(DEFAULT_GRANT).not.toContain('access.token')
  expect(computeGrant(advertised, DEFAULT_GRANT)).not.toContain('access.token')
  expect(computeGrant(advertised, ['pushEvents', 'access.token'])).toEqual(['pushEvents', 'access.token'])
  expect(computeGrant(advertised, ['access.*'])).toEqual([])
  expect(computeGrant(advertised, ['*.token'])).toEqual([]) // RFC §12 vector 10
  expect(computeGrant(advertised, ['*.*', '*'])).toEqual(['pushEvents'])
  expect(wildcardOnlyMatches(advertised, ['access.*'])).toEqual(['access.token'])
  expect(wildcardOnlyMatches(advertised, ['access.*', 'access.token'])).toEqual([])
  // not advertised → not granted, whatever the policy says (§5.4)
  expect(computeGrant(advertisedCapabilities({ version: '0.5', pushEvents: true } as never), ['access.token'])).toEqual([])
  // a feature set may list it in `uses` (RFC §4.2) — valid vocabulary, derived from the grant
  const fs = { apps: { description: 'apps', uses: ['pushEvents', 'access.token'] } } as never
  expect(deriveFeatureSets(fs, ['pushEvents', 'access.token']).enabled).toEqual(['apps'])
  expect(deriveFeatureSets(fs, ['pushEvents']).disabled.apps?.reason).toBe('capability_denied')
})

test('RFC 3339 UTC expiry and audited endpoints without userinfo, query or fragment (r3 §3.2, §8.2)', () => {
  expect(rfc3339(Date.UTC(2026, 9, 25, 4, 15, 0))).toBe('2026-10-25T04:15:00Z')
  expect(rfc3339(Date.UTC(2026, 9, 25, 4, 15, 0, 250))).toBe('2026-10-25T04:15:00.250Z')
  expect(auditEndpoint('wss://user:pw@games.example:8443/mcpl?token=abc#frag')).toBe('wss://games.example:8443/mcpl')
  expect(auditEndpoint('https://api.example/v1/run?key=1')).toBe('https://api.example/v1/run')
  expect(auditEndpoint('urn:example:service?x')).toBe('urn:example:service')
  expect(auditEndpoint('not a uri')).toBeUndefined()
})

test('the host advertises access only when it can mint', () => {
  expect(hostMcplCaps(true).access).toEqual({ token: true })
  expect('access' in hostMcplCaps(false)).toBe(false)
})

test('transport.access credential wins over the static token at the query', () => {
  const t = { url: 'mcpl://games.example/mcpl', token: 'static-token-123' }
  expect(resolveUrl(t)).toBe('wss://games.example/mcpl?token=static-token-123')
  expect(resolveUrl(t, 'minted-credential-9')).toBe('wss://games.example/mcpl?token=minted-credential-9')
})

// ── cache (RFC §5) ──

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
  constructor(readonly principal = 'agent:test@guest') {}
  async mint(audience: string, opts: { ttl: string }): Promise<MintedCredential> {
    this.mints.push({ audience, ttl: opts.ttl })
    if (this.hang) await new Promise(() => {})
    if (this.refuse) throw new AccessRefused(audience, this.refuse.kind, this.refuse.reason)
    const payload = Buffer.from(JSON.stringify({ aud: audience, n: this.mints.length })).toString('base64url')
    return { credential: `aid1.${payload}.${Buffer.from(this.principal).toString('base64url')}${'c2lnbmF0dXJl'.repeat(3)}${this.mints.length}`, expiresAt: Date.now() + this.lifetimeMs, principal: this.principal }
  }
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

const SERVER_CAPS = { version: '0.5', pushEvents: true, access: { token: true }, featureSets: { apps: { description: 'apps', uses: ['access.token'] } } }

async function setup(opts: { grant?: string[]; issuer?: AccessIssuer | null; transport?: Partial<{ access: string; token: string }> } = {}) {
  const peer = await McplPeer.start({ mcpl: SERVER_CAPS })
  const audits: AccessAuditRecord[] = []
  const logs: string[] = []
  const issuer = opts.issuer === undefined ? new FakeIssuer() : opts.issuer
  const cfg: ServerConfig = { transport: { url: peer.url, ...opts.transport }, grant: opts.grant ?? ['pushEvents', 'access.token'], reconnectIntervalMs: 100 }
  const h = new McplServerHandle('svc', cfg, {
    deliver() {},
    toolsChanged() {},
    log: l => logs.push(l),
    issuer: () => issuer,
    audit: r => audits.push(r),
  })
  cleanup.push(() => peer.close(), () => h.close())
  h.start()
  await h.firstAttempt
  return { peer, h, audits, logs, issuer }
}

test('host advertises access and grants access.token by name; a granted request gets a bearer credential with the real expiry', async () => {
  const { peer, h, audits, issuer } = await setup()
  expect(h.status).toBe('ready')
  const init = peer.inits[0] as { capabilities: { experimental: { mcpl: { access?: unknown } } } }
  expect(init.capabilities.experimental.mcpl.access).toEqual({ token: true })
  expect((await peer.policyCount(1)).effectiveCapabilities).toEqual(['pushEvents', 'access.token'])
  expect((peer.policies[0] as { enabled: string[] }).enabled).toEqual(['apps'])

  const r = await peer.request('access/token', { audience: 'games', endpoint: 'wss://games.example/mcpl', purpose: 'doom-1: opened by the agent' })
  const res = r.result as { scheme: string; credential: string; expiresAt: string; principal: string }
  expect(res.scheme).toBe('bearer')
  expect(res.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/) // RFC 3339, UTC
  expect(res.credential.startsWith('aid1.')).toBe(true)
  expect(res.principal).toBe('agent:test@guest')
  const left = Date.parse(res.expiresAt) - Date.now()
  expect(left).toBeGreaterThan(14 * 60_000)
  expect(left).toBeLessThanOrEqual(15 * 60_000)
  expect(issuer!.mints).toEqual([{ audience: 'games', ttl: ACCESS_TTL }])
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ server: 'svc', kind: 'request', audience: 'games', endpoint: 'wss://games.example/mcpl', purpose: 'doom-1: opened by the agent', outcome: 'granted', expiresAt: res.expiresAt })

  // cached on the second ask; `fresh` mints again
  const again = (await peer.request('access/token', { audience: 'games' })).result as { credential: string }
  expect(again.credential).toBe(res.credential)
  expect(issuer!.mints).toHaveLength(1)
  const fresh = (await peer.request('access/token', { audience: 'games', fresh: true })).result as { credential: string }
  expect(fresh.credential).not.toBe(res.credential)
  expect(issuer!.mints).toHaveLength(2)
  expect(audits.map(a => a.outcome)).toEqual(['granted', 'cached', 'granted'])
  // the audit never carries a credential
  expect(JSON.stringify(audits)).not.toContain(res.credential)
  expect(JSON.stringify(audits)).not.toContain(fresh.credential)
})

test('the audit keeps an endpoint\'s scheme, host and path only — never userinfo, query or fragment (vector 13)', async () => {
  const { peer, audits, logs } = await setup()
  await peer.policyCount(1)
  const leaky = 'wss://user:pw@games.example:8443/mcpl?token=abc123secret#frag'
  await peer.request('access/token', { audience: 'games', endpoint: leaky })
  await peer.request('access/token', { audience: 'games', endpoint: leaky, bogus: 1 }) // invalid: audited from raw params
  expect(audits.map(a => a.endpoint)).toEqual(['wss://games.example:8443/mcpl', 'wss://games.example:8443/mcpl'])
  for (const text of [JSON.stringify(audits), logs.join('\n')]) {
    expect(text).not.toContain('abc123secret')
    expect(text).not.toContain('user:pw')
    expect(text).not.toContain('#frag')
  }
})

test('a credential near its expiry is not handed out again', async () => {
  const issuer = new FakeIssuer()
  issuer.lifetimeMs = RENEW_EARLY_MS - 1000
  const { peer } = await setup({ issuer })
  await peer.policyCount(1)
  await peer.request('access/token', { audience: 'games' })
  await peer.request('access/token', { audience: 'games' })
  expect(issuer.mints).toHaveLength(2)
})

test('without the grant: -32002 with data.capability — before params are even looked at', async () => {
  const { peer, h, audits, issuer } = await setup({ grant: ['pushEvents'] })
  await peer.policyCount(1)
  expect(h.grant).toEqual(['pushEvents'])
  for (const params of [{ audience: 'games' }, { audience: 'games', bogus: 1 }, undefined]) {
    const r = await peer.request('access/token', params)
    expect(r.error?.code).toBe(-32002)
    expect(r.error?.data).toEqual({ capability: 'access.token' })
  }
  expect(issuer!.mints).toHaveLength(0)
  expect(audits.every(a => a.outcome === 'denied')).toBe(true)
  // the other gated methods carry data.capability too now (SPEC App. A)
  const inf = await peer.request('inference/request', { featureSet: 'x', messages: [] })
  expect(inf.error).toMatchObject({ code: -32002, data: { capability: 'inferenceRequest' } })
})

test('a wildcard alone grants nothing, and the operator is told', async () => {
  const { peer, h, logs } = await setup({ grant: ['pushEvents', 'access.*'] })
  await peer.policyCount(1)
  expect(h.grant).toEqual(['pushEvents'])
  expect(logs.some(l => /access\.token is matched only by a wildcard/.test(l))).toBe(true)
  expect((await peer.request('access/token', { audience: 'games' })).error?.code).toBe(-32002)
})

test('malformed params from a granted server: -32602 with { field, reason }', async () => {
  const { peer, audits, issuer } = await setup()
  await peer.policyCount(1)
  const r = await peer.request('access/token', { audience: 'games', scopes: ['all'] })
  expect(r.error?.code).toBe(-32602)
  expect(r.error?.data).toEqual({ field: 'scopes', reason: 'unknown member' })
  const r2 = await peer.request('access/token', { audience: 'games', fresh: 1 })
  expect(r2.error?.data).toEqual({ field: 'fresh', reason: 'must be a boolean' })
  expect(issuer!.mints).toHaveLength(0)
  expect(audits.map(a => a.outcome)).toEqual(['invalid', 'invalid'])
})

test('identity provider refuses → -32040 { audience, kind, reason }, no credential; no identity → kind no_identity and no advertisement', async () => {
  const issuer = new FakeIssuer()
  issuer.refuse = { kind: 'provider_refused', reason: 'id.example refused: audience not allowed' }
  const a = await setup({ issuer })
  await a.peer.policyCount(1)
  const r = await a.peer.request('access/token', { audience: 'orrery' })
  expect(r.result).toBeUndefined()
  expect(r.error).toMatchObject({ code: -32040, data: { audience: 'orrery', kind: 'provider_refused', reason: 'id.example refused: audience not allowed' } })
  expect(a.audits[0]).toMatchObject({ outcome: 'refused', audience: 'orrery', refusal: 'provider_refused', reason: 'id.example refused: audience not allowed' })
  issuer.refuse = { kind: 'rate_limited', reason: 'slow down' }
  expect((await a.peer.request('access/token', { audience: 'orrery' })).error?.data).toEqual({ audience: 'orrery', kind: 'rate_limited', reason: 'slow down' })

  const b = await setup({ issuer: null })
  await b.peer.policyCount(1)
  const init = b.peer.inits[0] as { capabilities: { experimental: { mcpl: Record<string, unknown> } } }
  expect('access' in init.capabilities.experimental.mcpl).toBe(false)
  expect(b.logs.some(l => /access\.token granted but no identity/.test(l))).toBe(true)
  const r2 = await b.peer.request('access/token', { audience: 'games' })
  expect(r2.error).toMatchObject({ code: -32040, data: { audience: 'games', kind: 'no_identity', reason: 'this host has no identity to mint from' } }) // RFC §12 vector 12
})

test('revoking access.token by manifest change takes effect for the next request', async () => {
  const { peer, h } = await setup()
  await peer.policyCount(1)
  expect((await peer.request('access/token', { audience: 'games' })).result).toBeDefined()
  peer.changeManifest({ version: '0.5', pushEvents: true })
  await peer.policyCount(2)
  expect(peer.policies[1]!.effectiveCapabilities).toEqual(['pushEvents'])
  expect(h.grant).toEqual(['pushEvents'])
  expect((await peer.request('access/token', { audience: 'games' })).error).toMatchObject({ code: -32002, data: { capability: 'access.token' } })
})

test('per-dial minting: transport.access credential at the upgrade, fresh at each reconnect; a failed mint fails the dial without the credential', async () => {
  const { peer, h, issuer, audits } = await setup({ transport: { access: 'games', token: 'static-fallback-token' } })
  await peer.policyCount(1)
  const first = peer.token(0)!
  expect(first.startsWith('aid1.')).toBe(true)
  expect(first).not.toBe('static-fallback-token')
  expect(issuer!.mints[0]).toEqual({ audience: 'games', ttl: ACCESS_TTL })
  expect(h.accessAudience).toBe('games')

  await h.restart()
  await peer.policyCount(2)
  const second = peer.token(1)!
  expect(second).not.toBe(first)

  peer.dropAll() // server-side drop → the bridge redials on its own
  await peer.policyCount(3)
  expect(peer.token(2)).not.toBe(second)
  expect(issuer!.mints.map(m => m.audience)).toEqual(['games', 'games', 'games'])
  expect(audits.filter(a => a.kind === 'dial').map(a => a.outcome)).toEqual(['granted', 'granted', 'granted'])

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

// ── revision 4 vectors (RFC-015 §12) ──

test('vector 14: bounds — each -32602; 128 astral-plane characters are accepted', () => {
  const field = (p: unknown) => {
    const r = validateAccessParams(p)
    return r.ok ? null : r.field
  }
  expect(field({ audience: '' })).toBe('audience')
  expect(field({ audience: 'a'.repeat(129) })).toBe('audience')
  expect(field({ audience: '😀'.repeat(128) })).toBeNull() // 256 UTF-16 units, 128 code points
  expect(field({ audience: '😀'.repeat(129) })).toBe('audience')
  expect(field({ audience: 'games', endpoint: '/mcpl' })).toBe('endpoint') // relative
  expect(field({ audience: 'games', endpoint: 'wss://user:pw@games.example/mcpl' })).toBe('endpoint') // userinfo
  expect(field({ audience: 'games', endpoint: 'wss://user@games.example/mcpl' })).toBe('endpoint')
  expect(field({ audience: 'games', endpoint: `https://e.example/${'a'.repeat(2049 - 'https://e.example/'.length)}` })).toBe('endpoint') // 2049
  expect(field({ audience: 'games', endpoint: `https://e.example/${'a'.repeat(2048 - 'https://e.example/'.length)}` })).toBeNull() // 2048
  expect(field({ audience: 'games', fresh: 'true' })).toBe('fresh')
  expect(field({ audience: 'games', purpose: 'line one\nline two' })).toBe('purpose')
  expect(field({ audience: 'games', purpose: 'next line\u0085' })).toBe('purpose') // C1 control
  expect(field({ audience: 'games', purpose: 'tab\there' })).toBe('purpose')
  expect(field({ audience: 'games', schemes: [] })).toBe('schemes')
  expect(field({ audience: 'games', schemes: ['bearer', ''] })).toBe('schemes')
  expect(field({ audience: 'games', schemes: Array(9).fill('bearer') })).toBe('schemes')
  expect(field({ audience: 'games', schemes: 'bearer' })).toBe('schemes')
  expect(field({ audience: 'games', schemes: ['example-pop', 'bearer'], purpose: 'Doom — level 2' })).toBeNull()
})

test('vector 13: the audit drops the query and keeps a non-default port', () => {
  expect(auditEndpoint('https://api.example:8443/v1/run?key=1')).toBe('https://api.example:8443/v1/run')
  expect(auditEndpoint('https://api.example:443/v1/run?key=1')).toBe('https://api.example/v1/run') // 443 is https's default
})

test('vector 17: schemes — none the host can offer → -32040 host_policy; absent or including bearer → bearer', async () => {
  const { peer, issuer, audits } = await setup()
  await peer.policyCount(1)
  const pop = await peer.request('access/token', { audience: 'games', schemes: ['example-pop'] })
  expect(pop.error).toMatchObject({ code: -32040, data: { audience: 'games', kind: 'host_policy' } })
  expect((issuer as FakeIssuer).mints).toHaveLength(0) // refused before minting
  expect(audits.at(-1)).toMatchObject({ outcome: 'refused', refusal: 'host_policy' })
  expect((await peer.request('access/token', { audience: 'games' })).result).toMatchObject({ scheme: 'bearer' })
  expect((await peer.request('access/token', { audience: 'games', schemes: ['example-pop', 'bearer'] })).result).toMatchObject({ scheme: 'bearer' })
})

test('vector 16: cache — two requests share one credential, fresh mints a new one, two principals never share an entry', async () => {
  const ada = await setup({ issuer: new FakeIssuer('agent:ada@guest') })
  const bo = await setup({ issuer: new FakeIssuer('agent:bo@guest') })
  await ada.peer.policyCount(1)
  await bo.peer.policyCount(1)
  const a1 = (await ada.peer.request('access/token', { audience: 'games' })).result as { credential: string; principal: string }
  const a2 = (await ada.peer.request('access/token', { audience: 'games' })).result as { credential: string }
  expect(a2.credential).toBe(a1.credential)
  const a3 = (await ada.peer.request('access/token', { audience: 'games', fresh: true })).result as { credential: string }
  expect(a3.credential).not.toBe(a1.credential)
  const b1 = (await bo.peer.request('access/token', { audience: 'games' })).result as { credential: string; principal: string }
  expect(b1.principal).toBe('agent:bo@guest')
  expect(a1.principal).toBe('agent:ada@guest')
  expect(b1.credential).not.toBe(a1.credential)
  expect((bo.issuer as FakeIssuer).mints).toHaveLength(1) // bo's own mint, nothing of ada's
})

test('vector 15: a provider answer without an expiry is -32040 unavailable — no result, no silence', async () => {
  const dir = mkdtempSync(join(process.env.MCPL_TEST_TMP ?? tmpdir(), 'mcpl-v15-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const keyPath = join(dir, 'identity-key.pem')
  const fetchImpl = (async () => new Response(JSON.stringify({ token: 'opaque-credential-without-expiry', sub: 'agent:x@guest' }), { status: 200 })) as unknown as typeof fetch
  const identity = new Identity({ home: 'id.example', keyPath, fetchImpl })
  identity.keyId()
  writeFileSync(identity.recordPath, JSON.stringify({ sub: 'agent:x@guest', name: 'x', home: 'id.example', enrolledAt: 'x' }))
  const { peer } = await setup({ issuer: identity })
  await peer.policyCount(1)
  const r = await peer.request('access/token', { audience: 'games' })
  expect(r.result).toBeUndefined()
  expect(r.error).toMatchObject({ code: -32040, data: { audience: 'games', kind: 'unavailable', reason: 'id.example did not say when the credential expires' } })
})

test('time bound (r4 §3.4): a provider that does not answer gets the server -32040 unavailable, not silence', async () => {
  const issuer = new FakeIssuer()
  issuer.hang = true
  const was = ACCESS_TIME_BOUND.ms
  ACCESS_TIME_BOUND.ms = 200
  try {
    const { peer } = await setup({ issuer })
    await peer.policyCount(1)
    const t0 = Date.now()
    const r = await peer.request('access/token', { audience: 'games' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.error).toMatchObject({ code: -32040, data: { audience: 'games', kind: 'unavailable' } })
  } finally {
    ACCESS_TIME_BOUND.ms = was
  }
})
