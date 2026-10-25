/**
 * The bridge's identity — an ed25519 key enrolled as a principal at an
 * archipelago-home identity provider (connectome docs/home-node.md §4).
 *
 * Mirrors the host's identity module (connectome-host
 * src/modules/identity-module.ts: `accessFor`, `loadOrCreateKey`,
 * `acceptInvite`) — same key file format, key id, enrollment record and wire
 * statements; archipelago-home src/statements.ts is the source of truth for
 * the statements: re-copy, don't fork. One addition: `mint` asks for a
 * lifetime (`ttl`, archipelago-home's `token-ttl` change) and reports the
 * real expiry, which RFC-015 §3.2 requires.
 *
 * Host-side plumbing only. Nothing here is a tool, and no key, proof or
 * credential ever reaches model context: callers hand credentials to a
 * transport or to a server's `access/token` answer and nowhere else.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccessIssuer, MintedCredential, RefusalKind } from './access'
import { AccessRefused } from './access'
import { secrets } from './redact'

/** Signed statements — archipelago-home src/statements.ts (exact bytes, pipe-separated). */
export const tokenStatement = (home: string, audience: string, timestamp: string): string =>
  `archipelago-token|v1|${home}|${audience}|${timestamp}`
export const enrollStatement = (home: string, invite: string, timestamp: string): string =>
  `archipelago-enroll|v1|${home}|${invite}|${timestamp}`

/** Persisted beside the key after enrollment (identity-module.ts IdentityRecord). */
export type IdentityRecord = { sub: string; name: string; home: string; enrolledAt: string }

export type IdentityOptions = {
  /** Issuer domain, signed into every statement. */
  home: string
  /** ed25519 PKCS#8 PEM path (absolute). */
  keyPath: string
  /** Base URL of the issuer's HTTP API (default https://<home>). */
  url?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const REASON_MAX = 300

export class Identity implements AccessIssuer {
  readonly home: string
  readonly keyPath: string
  readonly url: string
  readonly recordPath: string
  private key: { privateKey: KeyObject; id: string } | null = null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: IdentityOptions) {
    this.home = opts.home
    this.keyPath = opts.keyPath
    this.url = (opts.url ?? `https://${opts.home}`).replace(/\/+$/, '')
    this.recordPath = opts.keyPath.replace(/\.pem$/, '') + '.json'
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** The public key id, `ed25519:<base64url raw 32 bytes>` — what the issuer knows the key by. Creates the key on first use. */
  keyId(): string {
    return this.loadOrCreateKey().id
  }

  /** The enrollment record, or null when not enrolled. Re-read each call, so an enroll by the CLI reaches a running bridge. */
  record(): IdentityRecord | null {
    try {
      const r = JSON.parse(readFileSync(this.recordPath, 'utf8')) as IdentityRecord
      return r && typeof r.sub === 'string' ? r : null
    } catch {
      return null
    }
  }

  /**
   * Mint a credential for `audience` from a fresh key proof (POST /token).
   * Rejects with AccessRefused (audience + reason) when not enrolled, when the
   * issuer is unreachable, refuses, or answers without a stated expiry.
   */
  async mint(audience: string, opts: { ttl?: string } = {}): Promise<MintedCredential> {
    const refuse = (kind: RefusalKind, reason: string): never => {
      throw new AccessRefused(audience, kind, secrets.scrubLog(reason).slice(0, REASON_MAX))
    }
    const rec = this.record()
    if (!rec) refuse('no_identity', `this host is not enrolled with ${this.home} (operator: identity-cli enroll)`)
    if (rec!.home !== this.home) refuse('no_identity', `this host is enrolled with ${rec!.home}, not ${this.home}`)
    const key = this.loadOrCreateKey()
    const timestamp = new Date().toISOString()
    const proof = cryptoSign(null, Buffer.from(tokenStatement(this.home, audience, timestamp), 'utf8'), key.privateKey).toString('base64url')
    let res: { status: number; json: Record<string, unknown> }
    try {
      res = await this.post('/token', { id: key.id, audience, timestamp, proof, ...(opts.ttl ? { ttl: opts.ttl } : {}) })
    } catch (e) {
      return refuse('unavailable', `${this.home} unreachable: ${e instanceof Error ? e.message : String(e)}`)
    }
    const token = res.json.token
    if (res.status !== 200 || typeof token !== 'string' || !token) {
      const said = typeof res.json.error === 'string' ? res.json.error : `HTTP ${res.status}`
      // 429: throttled; 5xx, or a 200 without a token: no usable answer; any other status: the provider said no.
      if (res.status === 429) return refuse('rate_limited', `${this.home} is rate-limiting: ${said}`)
      if (res.status >= 500 || res.status === 200) return refuse('unavailable', `${this.home} gave no credential: ${said}`)
      return refuse('provider_refused', `${this.home} refused: ${said}`)
    }
    // RFC-015 §3.2: a host that cannot state the expiry MUST NOT answer. The
    // reply's `exp` (archipelago-home token-ttl), else the token's own claim.
    const payload = aid1Payload(token)
    const exp = typeof res.json.exp === 'number' ? res.json.exp : payload?.exp
    const known = typeof exp === 'number' && Number.isFinite(exp)
    // The credential exists from here: track it for redaction before anything can print it.
    secrets.add(token, known ? exp * 1000 : undefined)
    if (!known) return refuse('unavailable', `${this.home} did not say when the credential expires`)
    const expiresAt = (exp as number) * 1000
    if (expiresAt <= Date.now()) return refuse('unavailable', `${this.home} returned an expired credential`)
    const principal = typeof res.json.sub === 'string' ? res.json.sub : typeof payload?.sub === 'string' ? payload.sub : rec!.sub
    return { credential: token, expiresAt, principal }
  }

  /**
   * One-time enrollment: invite + key proof → a principal at the issuer
   * (POST /enroll). Writes the record beside the key. The first token the
   * issuer mints with the enrollment is discarded: the host fetches its own,
   * fresh, per use.
   */
  async enroll(invite: string, name: string): Promise<IdentityRecord> {
    const existing = this.record()
    if (existing) throw new Error(`already enrolled with ${existing.home} as "${existing.name}" (${existing.sub}) — enrollment is one-time; remove ${this.recordPath} to start over`)
    const key = this.loadOrCreateKey()
    const timestamp = new Date().toISOString()
    const proof = cryptoSign(null, Buffer.from(enrollStatement(this.home, invite, timestamp), 'utf8'), key.privateKey).toString('base64url')
    const { status, json } = await this.post('/enroll', { invite, id: key.id, name, timestamp, proof })
    if (typeof json.token === 'string') secrets.add(json.token)
    if (status !== 200 || typeof json.sub !== 'string') {
      throw new Error(`enrollment refused by ${this.home} (${status}): ${typeof json.error === 'string' ? json.error : 'unknown'}`)
    }
    const rec: IdentityRecord = { sub: json.sub, name, home: this.home, enrolledAt: timestamp }
    writeFileSync(this.recordPath + '.tmp', JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
    renameSync(this.recordPath + '.tmp', this.recordPath)
    return rec
  }

  private loadOrCreateKey(): { privateKey: KeyObject; id: string } {
    if (this.key) return this.key
    let privateKey: KeyObject
    if (existsSync(this.keyPath)) {
      privateKey = createPrivateKey(readFileSync(this.keyPath, 'utf8'))
    } else {
      privateKey = generateKeyPairSync('ed25519').privateKey
      mkdirSync(dirname(this.keyPath), { recursive: true, mode: 0o700 })
      try {
        // 'wx': two sessions starting at once must not each write a different key.
        writeFileSync(this.keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        privateKey = createPrivateKey(readFileSync(this.keyPath, 'utf8'))
      }
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${this.keyPath}: not an ed25519 key`)
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
    this.key = { privateKey, id: `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}` }
    return this.key
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A redirect would carry a signed proof somewhere else; the issuer never redirects these.
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const json = (await res.json().catch(() => ({}))) as unknown
    return { status: res.status, json: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {} }
  }
}

/** The payload of an aid1 token (unverified — only to read `exp`/`sub` the issuer already vouched for), or null. */
export function aid1Payload(token: string): { exp?: unknown; sub?: unknown; aud?: unknown } | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'aid1') return null
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    return p && typeof p === 'object' ? (p as { exp?: unknown; sub?: unknown }) : null
  } catch {
    return null
  }
}
