/**
 * Credentials the bridge mints from its identity for its own dials
 * (`transport.access`): the lifetimes it asks for, the per-server credential
 * cache, the refusal a failed mint becomes, and the audit record.
 * McplServerHandle wires them to the dial.
 */

/** Lifetime asked for a credential minted only to prove an identity works (the identity CLI, adopting a static token). Dials: DIAL_TTL. */
export const ACCESS_TTL = '15m'
/**
 * Lifetime asked for the credential a dial carries (`transport.access`) — on
 * purpose not ACCESS_TTL. MCPL doors commonly hold a socket no longer than the
 * token that opened it (they close with 4001 at `exp`), so a 15-minute dial
 * credential forces a reconnect, with the server's tools gone meanwhile, every
 * 15 minutes. This one only ever goes to the audience it names. A day also
 * bounds how long a revocation at the identity provider takes to bite, which
 * is why this is not simply the provider's ceiling (commonly 7 days).
 */
export const DIAL_TTL = '24h'
/** A cached credential is reused until this long before it expires. */
export const RENEW_EARLY_MS = 120_000

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
  /** Whom this issuer mints for — part of the cache key. */
  principal?(): string | undefined
}

/** The cache key within one configured server: principal, audience, scheme. */
export const cacheKey = (principal: string, audience: string, scheme: string): string => `${principal}\u0000${audience}\u0000${scheme}`

/**
 * Why a mint failed — callers branch on this, never on `reason`.
 *  no_identity       the host has none to mint from (none configured, not enrolled)
 *  provider_refused  the identity provider said no
 *  rate_limited      the provider is throttling
 *  unavailable       no usable answer (unreachable, an error, no credential or no expiry)
 */
export type RefusalKind = 'no_identity' | 'provider_refused' | 'rate_limited' | 'unavailable'

/** The only credential scheme this host mints. */
export const SCHEME = 'bearer'

/** A refusal from (or for want of) the identity provider. Never carries a credential. */
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

/** RFC 3339 in UTC with a `Z`: `2026-10-25T04:15:00Z` — no milliseconds when there are none. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z')
}

/**
 * Credentials for one configured server, keyed by cacheKey (principal,
 * audience, scheme), reused until RENEW_EARLY_MS before expiry. Concurrent
 * dials for one key share one mint. `fresh` (the server refused the last
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
 * One audit line per credential minted or reused for a dial
 * (`transport.access`): for what audience and what happened. Never the
 * credential.
 *  - outcome: granted (minted) | cached (reused) | refused (a failed dial).
 */
export type AccessAuditRecord = {
  at: string
  server: string
  kind: 'dial'
  audience: string
  outcome: 'granted' | 'cached' | 'refused'
  /** For outcome "refused": why the mint failed. */
  refusal?: RefusalKind
  reason?: string
  expiresAt?: string
  principal?: string
}
