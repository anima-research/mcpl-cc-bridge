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
export const RENEW_EARLY_MS = 60_000

export type MintedCredential = {
  credential: string
  /** ms since epoch — the real expiry, as the identity provider stated it. */
  expiresAt: number
  /** Whom it identifies, e.g. `agent:example@animalabs.ai`. */
  principal?: string
}

/** Something that can mint a credential for an audience — the bridge's Identity. */
export interface AccessIssuer {
  mint(audience: string, opts: { ttl: string }): Promise<MintedCredential>
}

/** A refusal from (or for want of) the identity provider: becomes -32040 `{ audience, reason }`. Never carries a credential. */
export class AccessRefused extends Error {
  constructor(
    readonly audience: string,
    readonly reason: string,
  ) {
    super(`access "${audience}" refused: ${reason}`)
    this.name = 'AccessRefused'
  }
}

export type AccessTokenParams = { audience: string; endpoint?: string; purpose?: string; fresh?: boolean }

export type ParamsCheck = { ok: true; params: AccessTokenParams } | { ok: false; field: string; reason: string }

/**
 * `_meta` is MCP's reserved request member (every request's params may carry
 * it), not an RFC-015 member — accepted when it is an object, and ignored.
 */
const MEMBERS = new Set(['audience', 'endpoint', 'purpose', 'fresh', '_meta'])
const ENDPOINT_MAX = 2048

/** Length in code points, so a limit means characters rather than UTF-16 halves. */
const chars = (s: string) => [...s].length

/** RFC-015 §3.1, strictly: an object; unknown members rejected; each member its type and bound. */
export function validateAccessParams(raw: unknown): ParamsCheck {
  const bad = (field: string, reason: string): ParamsCheck => ({ ok: false, field: field.slice(0, 64), reason })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('params', 'must be an object')
  const p = raw as Record<string, unknown>
  for (const k of Object.keys(p)) if (!MEMBERS.has(k)) return bad(k, 'unknown member')
  const { audience, endpoint, purpose, fresh, _meta } = p
  if (audience === undefined) return bad('audience', 'required')
  if (typeof audience !== 'string') return bad('audience', 'must be a string')
  if (chars(audience) < 1 || chars(audience) > 128) return bad('audience', 'must be 1-128 characters')
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string') return bad('endpoint', 'must be a string (URI)')
    if (endpoint.length > ENDPOINT_MAX) return bad('endpoint', `must be at most ${ENDPOINT_MAX} characters`)
    try {
      new URL(endpoint)
    } catch {
      return bad('endpoint', 'must be an absolute URI')
    }
  }
  if (purpose !== undefined) {
    if (typeof purpose !== 'string') return bad('purpose', 'must be a string')
    if (chars(purpose) > 256) return bad('purpose', 'must be at most 256 characters')
  }
  if (fresh !== undefined && typeof fresh !== 'boolean') return bad('fresh', 'must be a boolean')
  if (_meta !== undefined && (typeof _meta !== 'object' || _meta === null || Array.isArray(_meta))) return bad('_meta', 'must be an object')
  return {
    ok: true,
    params: {
      audience,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(fresh !== undefined ? { fresh } : {}),
    },
  }
}

/**
 * Credentials per audience for one server, reused until RENEW_EARLY_MS
 * before expiry. Concurrent requests for the same audience share one mint.
 * `fresh` (the endpoint refused the last one) always mints. A failed mint
 * drops whatever was cached for the audience.
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
  reason?: string
  expiresAt?: string
  principal?: string
}

/** Audit fields from params that may not have validated: strings only, bounded. */
export function auditFields(raw: unknown): { audience: string; endpoint?: string; purpose?: string } {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)
  const endpoint = cut(p.endpoint, 512)
  const purpose = cut(p.purpose, 256)
  return { audience: cut(p.audience, 128) ?? '', ...(endpoint !== undefined ? { endpoint } : {}), ...(purpose !== undefined ? { purpose } : {}) }
}
