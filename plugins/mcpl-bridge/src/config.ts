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
import { join } from 'path'

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
}

export type TransportConfig = StdioTransportConfig | WsTransportConfig

/**
 * Default grant when a server config omits "grant": everything the bridge can
 * honor except the sensitive inject positions (system prompt, afterUser) and
 * the unimplemented channel extras (lifecycle/streaming/typing).
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
  /** Reconnect on transport failure. Default: true for ws, false for stdio. */
  reconnect?: boolean
  reconnectIntervalMs?: number
  reconnectMaxIntervalMs?: number
}

export type BridgeConfig = {
  servers: Record<string, ServerConfig>
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
  for (const [id, s] of Object.entries(raw.servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${path}: bad server id ${JSON.stringify(id)}`)
    if (!s.transport) throw new Error(`${path}: servers.${id}: missing transport`)
    if (s.grant !== undefined && !Array.isArray(s.grant)) throw new Error(`${path}: servers.${id}: grant must be an array when present (omit for the default grant; [] = plain MCP)`)
  }
  return { config: raw, path }
}

export function isWs(t: TransportConfig): t is WsTransportConfig {
  return typeof (t as WsTransportConfig).url === 'string'
}

/** RFC-004: mcpl:// → wss:// pure syntactic rewrite; no mcpls://; localhost not special. */
export function resolveUrl(t: WsTransportConfig): string {
  let url = t.url
  if (url.startsWith('mcpl://')) url = 'wss://' + url.slice('mcpl://'.length)
  const token = t.token ?? (t.tokenEnv ? process.env[t.tokenEnv] : undefined)
  if (token) {
    const u = new URL(url)
    u.searchParams.set('token', token)
    url = u.toString()
  }
  return url
}
