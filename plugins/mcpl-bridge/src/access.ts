/**
 * MCPL RFC-015 "Delegated Access", host side — the pieces that are not wire
 * plumbing: strict `access/token` params validation (RFC §3.1), the
 * per-(server, audience) credential cache (RFC §5), and the audit record
 * (RFC §8.2). McplServerHandle wires them to the connection.
 *
 * Granting `access.token` is the trust decision (RFC §4.3): there is no
 * per-audience list here. What the principal may obtain from its identity
 * provider is the outer bound; the provider's refusal comes back as -32040.
 */

/** Lifetime asked of the identity provider for every credential this host mints (RFC §5: SHOULD expire within 15 minutes). */
export const ACCESS_TTL = '15m'
/** A cached credential is reused until this long before it expires (RFC §5: the reference implementation renews 60 s early). */
/** RFC-015 r5 §5: never answer from the cache with less than two minutes left. */
export const RENEW_EARLY_MS = 120_000
/** RFC-015 r5 §3.1: the requester's wait when it names none. */
export const DEFAULT_TIMEOUT_MS = 30_000

export type MintedCredential = {
  credential: string
  /** ms since epoch — the real expiry, as the identity provider stated it. */
  expiresAt: number
  /** Whom it identifies, e.g. `agent:example@animalabs.ai`. */
  principal?: string
}

/** Something that can mint a credential for an audience — the bridge's Identity. */
export interface AccessIssuer {
  /** `timeoutMs`: how long the provider may take before the mint fails `unavailable`. */
  mint(audience: string, opts: { ttl: string; timeoutMs?: number }): Promise<MintedCredential>
  /** Whom this issuer mints for — part of the cache key (RFC-015 r5 §5). */
  principal?(): string | undefined
}

/** The cache key within one configured server (RFC-015 r5 §5): principal, audience, scheme. */
export const cacheKey = (principal: string, audience: string, scheme: string): string => `${principal}\u0000${audience}\u0000${scheme}`

/**
 * RFC-015 §3.3: what kind of refusal — servers branch on this, never on
 * `reason`. The set is open (r4); these are the ones this host sends.
 *  no_identity       the host has none to mint from (none configured, not enrolled)
 *  host_policy       the host's own policy refuses — including: it can offer none of the server's `schemes`
 *  provider_refused  the identity provider said no
 *  rate_limited      the provider (or host) is throttling
 *  unavailable       no usable answer within the time bound (unreachable, an error, no credential or no expiry)
 * (This host is no chain hop, so it never forwards a refusal.)
 */
export type RefusalKind = 'no_identity' | 'host_policy' | 'provider_refused' | 'rate_limited' | 'unavailable'

/** RFC-015 r4 §3.4: answer an access/token within this (exported for tests). The provider call itself is bounded shorter. */
export const ACCESS_TIME_BOUND = { ms: 20_000 }
/** The only credential scheme this host mints. */
export const SCHEME = 'bearer'

/** A refusal from (or for want of) the identity provider: becomes -32040 `{ audience, kind, reason }`. Never carries a credential. */
export class AccessRefused extends Error {
  constructor(
    readonly audience: string,
    readonly kind: RefusalKind,
    readonly reason: string,
  ) {
    super(`access "${audience}" refused (${kind}): ${reason}`)
    this.name = 'AccessRefused'
  }
}

/** RFC 3339 in UTC with a `Z` (RFC-015 r3 §3.2): `2026-10-25T04:15:00Z` — no milliseconds when there are none. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z')
}

/**
 * An endpoint as the audit keeps it (RFC-015 r3 §8.2): scheme, host and path —
 * never userinfo, query or fragment, where some deployments carry tokens.
 * Undefined for something that is not a URI.
 */
export function auditEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || !endpoint) return undefined
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return undefined
  }
  return (u.host ? `${u.protocol}//${u.host}${u.pathname}` : `${u.protocol}${u.pathname}`).slice(0, 512)
}

export type AccessTokenParams = { audience: string; endpoint?: string; purpose?: string; fresh?: boolean; schemes?: string[]; timeoutMs?: number }

export type ParamsCheck = { ok: true; params: AccessTokenParams } | { ok: false; field: string; reason: string }

const ENDPOINT_MAX = 2048
/** RFC-015 r6 §3.1: a scheme name. */
const SCHEME_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/
/** C0 and C1 controls, and DEL (r4 §3.1): a purpose reaches the audit as data. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** Length in code points, so a limit means characters rather than UTF-16 halves. */
const chars = (s: string) => [...s].length

/**
 * RFC-015 §3.1: an object; each known member its type and bound. Unknown
 * members are ignored (r5), so later revisions can add some. `_meta` is MCP's
 * reserved member: accepted when it is an object, and ignored.
 */
export function validateAccessParams(raw: unknown): ParamsCheck {
  const bad = (field: string, reason: string): ParamsCheck => ({ ok: false, field: field.slice(0, 64), reason })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('params', 'must be an object')
  const p = raw as Record<string, unknown>
  const { audience, endpoint, purpose, fresh, schemes, timeoutMs, _meta } = p
  if (audience === undefined) return bad('audience', 'required')
  if (typeof audience !== 'string') return bad('audience', 'must be a string')
  if (chars(audience) < 1 || chars(audience) > 128) return bad('audience', 'must be 1-128 characters')
  if (CONTROL.test(audience)) return bad('audience', 'must not contain control characters')
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string') return bad('endpoint', 'must be a string (URI)')
    if (chars(endpoint) > ENDPOINT_MAX) return bad('endpoint', `must be at most ${ENDPOINT_MAX} characters`)
    let u: URL
    try {
      u = new URL(endpoint)
    } catch {
      return bad('endpoint', 'must be an absolute URI')
    }
    // r4 §3.1: no userinfo — where some deployments carry a credential.
    if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(endpoint)) return bad('endpoint', 'must not carry userinfo')
  }
  if (purpose !== undefined) {
    if (typeof purpose !== 'string') return bad('purpose', 'must be a string')
    if (chars(purpose) > 256) return bad('purpose', 'must be at most 256 characters')
    if (CONTROL.test(purpose)) return bad('purpose', 'must not contain control characters')
  }
  if (fresh !== undefined && typeof fresh !== 'boolean') return bad('fresh', 'must be a boolean')
  if (schemes !== undefined) {
    if (!Array.isArray(schemes) || schemes.length < 1 || schemes.length > 8) return bad('schemes', 'must be an array of 1-8 scheme names')
    // r6 §3.1: scheme names have a grammar.
    if (!schemes.every(x => typeof x === 'string' && SCHEME_NAME.test(x))) return bad('schemes', 'entries must match ^[a-z0-9][a-z0-9._-]{0,31}$')
  }
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && (timeoutMs as number) >= 5000 && (timeoutMs as number) <= 120_000)) return bad('timeoutMs', 'must be an integer from 5000 to 120000')
  if (_meta !== undefined && (typeof _meta !== 'object' || _meta === null || Array.isArray(_meta))) return bad('_meta', 'must be an object')
  return {
    ok: true,
    params: {
      audience,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(fresh !== undefined ? { fresh } : {}),
      ...(schemes !== undefined ? { schemes: schemes as string[] } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    },
  }
}

/**
 * Credentials for one configured server, keyed by cacheKey (principal,
 * audience, scheme), reused until RENEW_EARLY_MS before expiry. Concurrent
 * requests for one key share one mint. `fresh` (the endpoint refused the last
 * one) always mints. A failed mint drops whatever was cached for the key.
 */
export class CredentialCache {
  private entries = new Map<string, MintedCredential>()
  private inflight = new Map<string, Promise<MintedCredential>>()

  constructor(private now: () => number = Date.now) {}

  async get(audience: string, fresh: boolean, mint: () => Promise<MintedCredential>): Promise<{ credential: MintedCredential; cached: boolean }> {
    if (!fresh) {
      const hit = this.entries.get(audience)
      if (hit && hit.expiresAt - this.now() > RENEW_EARLY_MS) return { credential: hit, cached: true }
      const pending = this.inflight.get(audience)
      if (pending) return { credential: await pending, cached: true }
    }
    const p = mint().then(
      c => {
        this.entries.set(audience, c)
        return c
      },
      e => {
        this.entries.delete(audience)
        throw e
      },
    )
    this.inflight.set(audience, p)
    try {
      return { credential: await p, cached: false }
    } finally {
      if (this.inflight.get(audience) === p) this.inflight.delete(audience)
    }
  }

  /** A mint that outlived the requester's time bound: later requests must not wait on it (they mint anew). */
  abandon(key: string): void {
    this.inflight.delete(key)
  }

  /** A cached credential with more than RENEW_EARLY_MS left, without minting. */
  peek(key: string): MintedCredential | undefined {
    const hit = this.entries.get(key)
    return hit && hit.expiresAt - this.now() > RENEW_EARLY_MS ? hit : undefined
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * One audit line (RFC §8.2): who asked, for what, where it was going, why,
 * and what happened. Never the credential.
 *  - kind "request": an `access/token` from the server; "dial": a credential
 *    minted for the bridge's own dial (`transport.access`).
 *  - outcome: granted (minted) | cached (reused) | refused (-32040, or a
 *    failed dial) | denied (-32002) | invalid (-32602).
 */
export type AccessAuditRecord = {
  at: string
  server: string
  kind: 'request' | 'dial'
  audience: string
  endpoint?: string
  purpose?: string
  outcome: 'granted' | 'cached' | 'refused' | 'denied' | 'invalid'
  /** For outcome "refused": the -32040 kind. */
  refusal?: RefusalKind
  reason?: string
  expiresAt?: string
  principal?: string
}

/** Audit fields from params that may not have validated: strings only, bounded, the endpoint reduced to scheme/host/path. */
export function auditFields(raw: unknown): { audience: string; endpoint?: string; purpose?: string } {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)
  const endpoint = auditEndpoint(p.endpoint)
  const purpose = cut(p.purpose, 256)
  return { audience: cut(p.audience, 128) ?? '', ...(endpoint !== undefined ? { endpoint } : {}), ...(purpose !== undefined ? { purpose } : {}) }
}
