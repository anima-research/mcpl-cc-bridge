/**
 * Moving a bridge config off static aid1 tokens and onto `transport.access`,
 * so the bridge mints its own and they stop expiring on it (identity-cli
 * `adopt`). One rule above all: who you are on a server does not change. Your
 * documents, games and grants there belong to the token's principal, so a
 * server only moves if a key on this machine proves to be that same principal.
 *
 * Works on the raw config: everything it does not name stays as written.
 * Never reports a credential.
 */
import { ACCESS_TTL, AccessRefused, rfc3339 } from './access'
import { resolveIdentity, type IdentityConfig } from './config'
import { aid1ExpiresAt, aid1Payload, type Identity } from './identity'

type RawTransport = { token?: unknown; access?: unknown; identity?: IdentityConfig } & Record<string, unknown>
export type RawConfig = { identity?: IdentityConfig; servers?: Record<string, { transport?: RawTransport } & Record<string, unknown>> } & Record<string, unknown>

export type Adoption = {
  server: string
  outcome: 'adopted' | 'kept'
  /** One or more lines for the operator. */
  detail: string
}

export type AdoptOptions = {
  makeIdentity(c: IdentityConfig): Identity
  /** Only these servers (default: every server with an aid1 token). */
  only?: string[]
}

/** Mutates `raw`. Returns one entry per server with an aid1 token, whether it moved or not. */
export async function adoptTokens(raw: RawConfig, opts: AdoptOptions): Promise<Adoption[]> {
  const results: Adoption[] = []
  for (const [server, s] of Object.entries(raw.servers ?? {})) {
    if (opts.only && !opts.only.includes(server)) continue
    const t = s.transport
    if (!t || typeof t.token !== 'string' || t.access !== undefined) continue
    const p = aid1Payload(t.token)
    if (!p || typeof p.sub !== 'string' || typeof p.aud !== 'string' || typeof p.iss !== 'string') continue
    results.push(await adoptOne(raw, server, t, { sub: p.sub, aud: p.aud, iss: p.iss, exp: aid1ExpiresAt(t.token) }, opts))
  }
  return results
}

async function adoptOne(raw: RawConfig, server: string, t: RawTransport, tok: { sub: string; aud: string; iss: string; exp: number | null }, opts: AdoptOptions): Promise<Adoption> {
  const dflt: IdentityConfig = { home: tok.iss }
  const candidates = [raw.identity?.home === tok.iss ? raw.identity : null, dflt].filter((c): c is IdentityConfig => c !== null)
  const tried = new Set<string>()
  const notes: string[] = []
  let unknownKey: string | null = null // the first key the issuer has never heard of: the one to bind
  let audienceRefused = false
  for (const c of candidates) {
    const resolved = resolveIdentity(c)
    if (tried.has(resolved.keyPath)) continue
    tried.add(resolved.keyPath)
    const idn = opts.makeIdentity(c)
    const keyId = idn.keyId()
    try {
      const rec = await idn.link(tok.aud)
      if (rec.sub !== tok.sub) {
        notes.push(`${resolved.keyPath} (${keyId}) is ${rec.sub}`)
        continue
      }
      await idn.mint(tok.aud, { ttl: ACCESS_TTL }) // proves the path works before anything is rewritten; the credential goes unused
      delete t.token
      t.access = tok.aud
      if (c !== raw.identity) {
        // The default key turned out to be the one: the bridge's identity, unless this bridge already has another.
        if (raw.identity === undefined) raw.identity = dflt
        else t.identity = dflt
      }
      return { server, outcome: 'adopted', detail: `${server}: now renews itself, as ${tok.sub} (access "${tok.aud}")` }
    } catch (e) {
      if (!(e instanceof AccessRefused)) throw e
      notes.push(`${resolved.keyPath} (${keyId}): ${e.reason}`)
      if (e.reason.endsWith('no principal for key')) unknownKey ??= keyId
      else if (e.kind === 'provider_refused') audienceRefused = true
    }
  }
  const exp = tok.exp === null ? '' : tok.exp <= Date.now() ? `, expired ${rfc3339(tok.exp)}` : `, expires ${rfc3339(tok.exp)}`
  const next = unknownKey
    ? `On the home node ${tok.iss}, once: in data/principals.json, give ${tok.sub} "key": "${unknownKey}" and "${tok.aud}" in its "audiences". Then run this again.`
    : audienceRefused
      ? `On the home node ${tok.iss}, once: allow "${tok.aud}" in the "audiences" of ${tok.sub}. Then run this again.`
      : `Run this again once ${tok.iss} answers, or with a key that is ${tok.sub}.`
  return { server, outcome: 'kept', detail: [`${server}: still on its token (${tok.sub}${exp}). No key here can renew it:`, ...notes.map(n => `  ${n}`), `  ${next}`].join('\n') }
}
