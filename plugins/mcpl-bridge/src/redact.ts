/**
 * Credential redaction at every edge Claude Code shows the model: tool
 * results, tool lists, channel notifications, hook context, and the bridge's
 * own logs (MCPL RFC-015 §6.2, §8.3 — credentials move between host and
 * server and nowhere else).
 *
 * The bridge knows the credentials it handles — every one it minted (per-dial
 * `access`, RFC-015 `access/token`) and every static token it dialed with —
 * and registers them here. Anything that crosses into model context or a log
 * line is scrubbed of those exact strings, and of anything shaped like an
 * aid1 token whatever its source. Logs additionally lose `?token=` values.
 */

export const REDACTED = '[redacted credential]'

/** aid1.<b64url payload>.<b64url sig> — '.' is outside both base64 alphabets, so this never matches inside encoded binary. */
const AID1 = /aid1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
/** A credential in a URL query (`?token=`, `&access_token=`). Logs only: a share link shown to the model may legitimately carry one. */
const TOKEN_PARAM = /([?&](?:token|access_token)=)[^&\s"'<>]+/gi

/** Credentials shorter than this are not tracked: scrubbing every "abc" would shred ordinary text. */
const MIN_SECRET = 8
/** How long a credential is still scrubbed after it expires. */
const GRACE_MS = 60 * 60_000

export class SecretRegistry {
  /** secret → scrub until (ms since epoch). */
  private secrets = new Map<string, number>()
  private sorted: string[] | null = null

  constructor(private now: () => number = Date.now) {}

  /** Track a credential. `expiresAt` (ms): scrubbed until an hour past it; omitted = for the life of the process. */
  add(secret: string | undefined | null, expiresAt?: number): void {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET) return
    const until = expiresAt === undefined ? Infinity : expiresAt + GRACE_MS
    const prev = this.secrets.get(secret)
    if (prev === undefined || until > prev) this.secrets.set(secret, until)
    this.sorted = null
  }

  get size(): number {
    return this.secrets.size
  }

  private live(): string[] {
    const now = this.now()
    let pruned = false
    for (const [s, until] of this.secrets) {
      if (until <= now) {
        this.secrets.delete(s)
        pruned = true
      }
    }
    // Longest first: a secret that contains another must be replaced whole.
    if (pruned || !this.sorted) this.sorted = [...this.secrets.keys()].sort((a, b) => b.length - a.length)
    return this.sorted
  }

  /** Model-facing text: known credentials and aid1-shaped tokens removed. */
  scrub(text: string): string {
    if (typeof text !== 'string' || !text) return text
    let out = text
    for (const s of this.live()) if (out.includes(s)) out = out.split(s).join(REDACTED)
    if (out.includes('aid1.')) out = out.replace(AID1, REDACTED)
    return out
  }

  /** Log lines and error strings: `scrub` plus credential-bearing URL query values. */
  scrubLog(text: string): string {
    const out = this.scrub(text)
    return typeof out === 'string' && /token=/i.test(out) ? out.replace(TOKEN_PARAM, `$1${REDACTED}`) : out
  }

  /** A JSON-shaped value with every string scrubbed; the input itself when nothing changed. */
  scrubDeep<T>(value: T): T {
    return this.walk(value) as T
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.scrub(v)
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map(x => {
        const y = this.walk(x)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    if (v && typeof v === 'object') {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const y = this.walk(x)
        if (y !== x) changed = true
        // defineProperty, not assignment: a "__proto__" key stays a key.
        Object.defineProperty(out, k, { value: y, enumerable: true, writable: true, configurable: true })
      }
      return changed ? out : v
    }
    return v
  }
}

/** The process-wide registry: the bridge is one process, and every edge consults the same set. */
export const secrets = new SecretRegistry()
