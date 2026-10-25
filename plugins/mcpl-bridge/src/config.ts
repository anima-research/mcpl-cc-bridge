/**
 * Bridge configuration.
 *
 * Resolution order:
 *   1. $MCPL_BRIDGE_CONFIG (explicit path)
 *   2. $CLAUDE_PROJECT_DIR/.mcpl-bridge.json (per-project)
 *   3. ~/.claude/mcpl-bridge/config.json (user-global)
 *
 * The grant list is the security boundary (SPEC §5.4): every capability path
 * not present is denied. `*` matches exactly one segment and segment counts
 * must be equal — `contextHooks.*` grants NONE of the depth-4 inject leaves.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import type { WakeConfig } from './wake'

export type StdioTransportConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type WsTransportConfig = {
  /** ws://, wss://, or mcpl:// (rewritten to wss:// per RFC-004) */
  url: string
  /** env var holding the auth token appended as ?token= */
  tokenEnv?: string
  token?: string
  /**
   * Audience to mint a credential for at EVERY dial (first connect and each
   * reconnect) from the bridge's `identity`, with a 15-minute lifetime; it
   * goes where `token` would. Takes precedence over `token` / `tokenEnv`. A
   * failed mint fails the dial (naming the audience and the reason).
   */
  access?: string
}

export type TransportConfig = StdioTransportConfig | WsTransportConfig

/**
 * Default grant when a server config omits "grant": everything the bridge can
 * honor except the sensitive inject positions (system prompt, afterUser) and
 * the unimplemented channel extras (streaming/typing).
 * An EXPLICIT `"grant": []` still means plain-MCP passthrough — absence of a
 * path is denial once a grant list exists; only the missing field defaults.
 */
export const DEFAULT_GRANT: string[] = [
  'tools',
  'pushEvents',
  'modelInfo',
  'inferenceRequest',
  'inferenceLifecycle',
  'channels.register',
  'channels.lifecycle',
  'channels.incoming',
  'channels.publish',
  'channels.acknowledge',
  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.beforeUser',
]

export type ServerConfig = {
  transport: TransportConfig
  /** Capability-path allowlist. Omitted = DEFAULT_GRANT; explicit [] = plain MCP. */
  grant?: string[]
  /** Feature sets to enable, wildcards allowed. Default: ["*"] (everything the grant admits). */
  enableFeatureSets?: string[]
  /** Tool namespace prefix as exposed to Claude. Default: the server id. */
  toolPrefix?: string
  /**
   * What to do with server-initiated inference/request:
   *  - "channel": deliver as a channel message (starts a turn; the main-loop
   *    model answers in-context — closest CC analog to §11)
   *  - "deny": answer -32002 capability denied
   * Default: "channel" when the grant includes "inferenceRequest", else "deny".
   */
  inferenceRequest?: 'channel' | 'deny'
  /**
   * When a delivery starts a turn. "all" (default): every push/event and
   * channels/incoming wakes the session. "chat": the loop-break preset (DMs
   * wake; a bot addressing the bot, and ambient traffic, are held for the next
   * wake). Or an explicit { wake, hold, holdCap } rule set — see wake.ts.
   */
  wake?: WakeConfig
  /**
   * Channel ids to hold open (channels/open) whenever the server registers
   * them — the host's durable desired-open state. Requires channels.lifecycle
   * in the grant and the server advertising it. mcpl_open/mcpl_close adjust
   * the live set; this list is what survives a restart.
   */
  openChannels?: string[]
  /**
   * Open a registered channel the moment a push/event tagged `chat:addressed`
   * arrives from it while it is closed — the host-side analog of "follow the
   * room you were just spoken to in". A closed channel delivers only what
   * addresses the agent, so everything said between two mentions is never
   * seen; once open, its ordinary traffic arrives as channels/incoming and the
   * wake policy decides whether that wakes or is held (`"wake": "chat"` holds
   * it). Default: on when the server's wake policy HOLDS chat:ambient (the
   * "chat" preset, or a hold rule matching it), off otherwise — under
   * `"wake": "all"` an implicit open would turn one mention into a wake per
   * message for the rest of the session. Set explicitly to override. Needs
   * channels.lifecycle in the grant. The open joins the session's desired-open
   * set (survives reconnects, not restarts — put the id in `openChannels` for
   * that).
   */
  openOnAddressed?: boolean
  /**
   * Treat the open set as a whitelist: a push/event or channels/incoming from
   * a registered channel that is NOT open (neither in `openChannels` nor opened
   * with mcpl_open this session) is dropped — not delivered, not held, not
   * opened — and the server is told so (accepted: false). Being addressed in
   * such a channel therefore never wakes the session. DMs (`chat:dm`) are
   * judged the same way — by the open set — unless `dmAllowlist` is set.
   * Default: false (any addressed push is accepted and, with
   * `openOnAddressed`, opens its channel).
   */
  openChannelsOnly?: boolean
  /**
   * The gate for DMs (deliveries tagged `chat:dm`), replacing the open set for
   * them: a DM is admitted only when its channel id or its author id is
   * listed. Applies whenever present, with or without `openChannelsOnly`;
   * `[]` admits no DMs. Absent: DMs are gated by `openChannelsOnly` like any
   * channel (and not at all without it).
   */
  dmAllowlist?: string[]
  /**
   * Configured but not started: nothing is spawned or dialed and no tools are
   * proxied, but the server is listed by mcpl_status and `mcpl_enable` starts
   * it for the session. Lets one config carry a whole roster of servers with
   * only the everyday ones live. Default: false. mcpl_enable / mcpl_disable
   * override this per session; editing it here applies on reload to every
   * session that has not overridden it.
   */
  disabled?: boolean
  /**
   * MCPL RFC-014 tool presence. Default true: the bridge advertises toolHints;
   * a server that hints keeps its static tools in the tool list, announces its
   * dynamic tools in the conversation and is reached through open/act/look/close
   * (a `surface` server entirely so). false: the bridge does not advertise
   * toolHints and lists the server's tools as a plain host would.
   */
  toolHints?: boolean
  /** Reconnect on transport failure. Default: true for ws, false for stdio. */
  reconnect?: boolean
  reconnectIntervalMs?: number
  reconnectMaxIntervalMs?: number
}

/**
 * The bridge's own identity: an ed25519 key enrolled as a principal at an
 * archipelago-home identity provider. Used for `transport.access` (per-dial
 * credentials) and to answer RFC-015 `access/token` for servers granted
 * `access.token`. Enroll with the operator CLI (src/identity-cli.ts); nothing
 * about it is model-visible.
 */
export type IdentityConfig = {
  /** Identity home domain — the issuer (`iss`) signed into every proof, e.g. "id.animalabs.ai". */
  home: string
  /** ed25519 PKCS#8 PEM, created 0600 on first use. `~/` expands. Default ~/.config/mcpl-bridge/identity-key.pem.
   *  The enrollment record lives beside it (same path, `.json`). */
  keyPath?: string
  /** Base URL of the home's HTTP API. Default https://<home>. For a local or test
   *  issuer; plain http:// is accepted only for loopback. */
  url?: string
}

export type BridgeConfig = {
  servers: Record<string, ServerConfig>
  identity?: IdentityConfig
}

export const DEFAULT_IDENTITY_KEY_PATH = '~/.config/mcpl-bridge/identity-key.pem'

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** The identity config with defaults applied: absolute keyPath, base URL. */
export function resolveIdentity(id: IdentityConfig): { home: string; keyPath: string; url: string } {
  return {
    home: id.home,
    keyPath: expandHome(id.keyPath ?? DEFAULT_IDENTITY_KEY_PATH),
    url: (id.url ?? `https://${id.home}`).replace(/\/+$/, ''),
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.has(hostname.toLowerCase())

/** Throws with what is wrong; `where` prefixes the message. */
export function validateIdentity(id: unknown, where: string): void {
  if (typeof id !== 'object' || id === null || Array.isArray(id)) throw new Error(`${where}: identity must be an object { home, keyPath?, url? }`)
  const o = id as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['home', 'keyPath', 'url'].includes(k)) throw new Error(`${where}: identity.${k} is not a known member (home, keyPath, url)`)
  // The home is signed into every proof as-is and names the issuer: a bare host[:port].
  if (typeof o.home !== 'string' || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(o.home)) throw new Error(`${where}: identity.home must be the issuer's domain, e.g. "id.animalabs.ai"`)
  if (o.keyPath !== undefined) {
    if (typeof o.keyPath !== 'string' || !o.keyPath) throw new Error(`${where}: identity.keyPath must be a path`)
    if (!isAbsolute(expandHome(o.keyPath))) throw new Error(`${where}: identity.keyPath must be absolute (or start with ~/)`)
  }
  if (o.url !== undefined) {
    let u: URL
    try {
      u = new URL(String(o.url))
    } catch {
      throw new Error(`${where}: identity.url must be a URL`)
    }
    if (typeof o.url !== 'string' || !(u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname)))) {
      throw new Error(`${where}: identity.url must be https:// (http:// only for a loopback issuer)`)
    }
  }
}

export function configPath(): string | null {
  const explicit = process.env.MCPL_BRIDGE_CONFIG
  if (explicit && existsSync(explicit)) return explicit
  const proj = process.env.CLAUDE_PROJECT_DIR
  if (proj) {
    const p = join(proj, '.mcpl-bridge.json')
    if (existsSync(p)) return p
  }
  const home = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'mcpl-bridge',
    'config.json',
  )
  if (existsSync(home)) return home
  return null
}

export function loadConfig(): { config: BridgeConfig; path: string | null } {
  const path = configPath()
  if (!path) return { config: { servers: {} }, path: null }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig
  if (!raw || typeof raw !== 'object' || typeof raw.servers !== 'object' || raw.servers === null) {
    throw new Error(`${path}: expected { "servers": { ... } }`)
  }
  if (raw.identity !== undefined) validateIdentity(raw.identity, path)
  for (const [id, s] of Object.entries(raw.servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${path}: bad server id ${JSON.stringify(id)}`)
    if (!s.transport) throw new Error(`${path}: servers.${id}: missing transport`)
    const access = (s.transport as { access?: unknown }).access
    if (access !== undefined) {
      if (!isWs(s.transport)) throw new Error(`${path}: servers.${id}: transport.access needs a ws/wss/mcpl url (a stdio server is not dialed)`)
      if (typeof access !== 'string' || access.length < 1 || access.length > 128) throw new Error(`${path}: servers.${id}: transport.access must be an audience name (1-128 chars)`)
    }
    if (s.grant !== undefined && !Array.isArray(s.grant)) throw new Error(`${path}: servers.${id}: grant must be an array when present (omit for the default grant; [] = plain MCP)`)
    if (s.wake !== undefined && s.wake !== 'all' && s.wake !== 'chat' && (typeof s.wake !== 'object' || s.wake === null || Array.isArray(s.wake))) {
      throw new Error(`${path}: servers.${id}: wake must be "all", "chat", or a { wake, hold, holdCap } object`)
    }
    if (typeof s.wake === 'object' && s.wake !== null) {
      for (const k of ['wake', 'hold'] as const) {
        const rules = s.wake[k]
        if (rules !== undefined && !(Array.isArray(rules) && rules.every(r => Array.isArray(r) && r.every(t => typeof t === 'string')))) {
          throw new Error(`${path}: servers.${id}: wake.${k} must be an array of tag arrays`)
        }
      }
    }
    if (s.openChannels !== undefined && !(Array.isArray(s.openChannels) && s.openChannels.every(c => typeof c === 'string'))) {
      throw new Error(`${path}: servers.${id}: openChannels must be an array of channel ids`)
    }
    if (s.dmAllowlist !== undefined && !(Array.isArray(s.dmAllowlist) && s.dmAllowlist.every(c => typeof c === 'string'))) {
      throw new Error(`${path}: servers.${id}: dmAllowlist must be an array of channel or author ids`)
    }
    for (const k of ['openOnAddressed', 'openChannelsOnly', 'disabled', 'toolHints'] as const) {
      if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new Error(`${path}: servers.${id}: ${k} must be a boolean`)
    }
  }
  return { config: raw, path }
}

export function isWs(t: TransportConfig): t is WsTransportConfig {
  return typeof (t as WsTransportConfig).url === 'string'
}

/** RFC-004: mcpl:// → wss:// pure syntactic rewrite; no mcpls://; localhost not special. */
export function dialUrl(t: WsTransportConfig): string {
  return t.url.startsWith('mcpl://') ? 'wss://' + t.url.slice('mcpl://'.length) : t.url
}

/** The static credential, if any: `token`, else the `tokenEnv` variable (read per dial). */
export function staticToken(t: WsTransportConfig): string | undefined {
  return t.token ?? (t.tokenEnv ? process.env[t.tokenEnv] : undefined)
}

/**
 * The URL to dial, credential attached as ?token=. `credential` (minted for
 * `access`) wins over the static token. The result carries a secret: never
 * log it or put it in an error.
 */
export function resolveUrl(t: WsTransportConfig, credential?: string): string {
  let url = dialUrl(t)
  const token = credential ?? staticToken(t)
  if (token) {
    const u = new URL(url)
    u.searchParams.set('token', token)
    url = u.toString()
  }
  return url
}
