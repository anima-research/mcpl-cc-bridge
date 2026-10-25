/**
 * McplServerHandle — a standalone MCPL host connection for one server.
 *
 * Implements the host duties mcpl-core leaves open: stdio spawn / WS dial,
 * reconnect with jittered backoff and grant reset at every transport epoch,
 * grant computation (advertised ∩ policy), mandatory initial featureSets/update
 * as a Request, inbound method→capability enforcement, dual-shape featureSets
 * normalization, per-descriptor channel authorization, manifest re-fetch on
 * mcpl/manifestChanged, and answer-or-error discipline on every inbound id.
 * Delegated access (MCPL RFC-015): per-dial credentials for `transport.access`
 * and `access/token` answered for servers granted `access.token`.
 * Tool presence (MCPL RFC-014 r2): hint changes from every carrier through one
 * apply path (src/presence.ts), toolsets/open|close|list, instance-bound calls.
 */
import { spawn, type ChildProcess } from 'child_process'
import {
  McplConnection,
  advertisedCapabilitiesFromInitialize,
  deriveFeatureSets,
  extractMcpl,
  manifestDigest,
  textContent,
  type CapabilityPath,
  type ChannelDescriptor,
  type ChannelsCloseResult,
  type ChannelsIncomingParams,
  type ChannelsOpenParams,
  type ChannelsOpenResult,
  type ChannelsRegisterParams,
  type ContentBlock,
  type ContextBeforeInferenceParams,
  type ContextBeforeInferenceResult,
  type ContextInjection,
  type FeatureSetDeclaration,
  type FeatureSetsUpdateResult,
  type InferenceLifecycleParams,
  type InferenceRequestParams,
  type IncomingChannelMessage,
  type InitializeCapabilities,
  type McplInitializeResult,
  type PushEventParams,
} from './vendor/mcpl-core/index.js'
// ^ vendored from anima-research/mcpl-core-ts src/ (npm @animalabs/mcpl-core@0.2.2
//   is a stale publish missing the grant/manifest helpers).
//   Re-sync: cp <mcpl-core-ts>/src/*.ts src/vendor/mcpl-core/ — and keep the
//   local `access.token` path in capabilities.ts (RFC-015) until upstream has it.
import { ERR, computeGrant, expandTags, granted, methodCapability, wildcardOnlyMatches } from './grants'
import { holdsAmbient } from './wake'
import { DEFAULT_GRANT, dialUrl, isLoopbackHost, isWs, resolveUrl, staticToken, type ServerConfig, type StdioTransportConfig } from './config'
import {
  ACCESS_TIME_BOUND,
  ACCESS_TTL,
  DEFAULT_TIMEOUT_MS,
  cacheKey,
  AccessRefused,
  SCHEME,
  CredentialCache,
  auditEndpoint,
  auditFields,
  rfc3339,
  validateAccessParams,
  type RefusalKind,
  type AccessAuditRecord,
  type AccessIssuer,
} from './access'
import { secrets } from './redact'
import { ToolPresence, emptyChange, isEmpty, keyOf, type ChangeSet } from './presence'
import { ChannelRefError, ChannelRegistry, buildLabelView, isAddressableId, norm, resolveChannelRef, type LabelView } from './channel-labels'

export type McplTool = { name: string; description?: string; inputSchema?: unknown; _meta?: Record<string, unknown> }

export type IncomingDelivery = {
  server: string
  kind: 'channel-message' | 'push-event' | 'inference-request'
  text: string
  meta: Record<string, string>
  /** Carries a tool announcement (RFC-014): when held, keep it whole instead of a one-line summary. */
  keepWhole?: boolean
}

export type HostCallbacks = {
  deliver(msg: IncomingDelivery): void
  toolsChanged(): void
  log(line: string): void
  /**
   * The bridge identity to mint credentials from (RFC-015), or null when none
   * is configured — then the host does not advertise `access`, `access/token`
   * is refused (-32040) and a `transport.access` dial fails. Asked at each
   * use, so a reload that changes the identity reaches new requests.
   */
  issuer?(): AccessIssuer | null
  /** RFC-015 §8.2 audit sink: one record per access/token request and per access dial. Never carries the credential. */
  audit?(rec: AccessAuditRecord): void
}

type PendingInference = {
  resolve(result: { content: string; model: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } }): void
  reject(err: { code: number; message: string }): void
}

/**
 * The host's `experimental.mcpl` advertisement. `access` (RFC-015 §4.2) only
 * when it holds an identity to mint from; `toolHints` (RFC-014 §6.3) unless
 * the server's config opts out.
 */
export function hostMcplCaps(canMint: boolean, toolHints = true): Record<string, unknown> {
  return {
    version: '0.5',
    pushEvents: true,
    inferenceRequest: true,
    inferenceLifecycle: true,
    modelInfo: true,
    contextHooks: { beforeInference: { observe: true, inject: { system: true, beforeUser: true, afterUser: true } } },
    channels: { register: true, lifecycle: true, publish: true, incoming: true, acknowledge: true },
    featureSets: true,
    ...(canMint ? { access: { token: true } } : {}),
    ...(toolHints ? { toolHints: true } : {}),
  }
}

export function renderContent(content: string | ContentBlock[] | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map(b => {
      if (b.type === 'text') return b.text
      if (b.type === 'resource') return `[resource: ${b.uri}]`
      const uri = 'uri' in b && b.uri ? b.uri : '(inline data)'
      return `[${b.type}: ${uri}]`
    })
    .join('\n')
}

let inferenceSeq = 0

/** How long a tool call / a toolsets request is waited for (exported for tests). A late result still applies when read. */
export const REQUEST_TIMEOUTS = { call: 120_000, toolset: 60_000 }

/** Requests whose results carry hint state (RFC-014): the tap applies them as they are read. */
const HINTED_RESULTS = new Set(['tools/call', 'toolsets/open', 'toolsets/close', 'toolsets/list', 'tools/list'])

/** A result's `_meta["mcpl/hints"]`. */
function metaHints(res: Record<string, unknown>): unknown {
  return res._meta && typeof res._meta === 'object' ? (res._meta as Record<string, unknown>)['mcpl/hints'] : undefined
}

export class McplServerHandle {
  readonly id: string
  readonly cfg: ServerConfig
  readonly prefix: string
  /** Operator policy patterns; the effective grant is advertised ∩ this. */
  readonly policy: readonly string[]
  /** Effective openOnAddressed: the config's, else on exactly when the wake policy holds chat:ambient. */
  readonly openOnAddressed: boolean

  status: 'connecting' | 'ready' | 'mcp-only' | 'disconnected' | 'disabled' | 'closed' = 'disconnected'
  /** Why the latest connect attempt or connection failed; cleared by a good handshake. */
  lastError: string | null = null
  /** When the live connection finished its handshake (ms since epoch); null when not connected. */
  connectedAt: number | null = null
  /** The last lines a stdio server wrote to stderr since it was spawned — what
   *  a hot reload that died on startup needs to show. */
  stderrTail: string[] = []
  tools: McplTool[] = []
  channels = new ChannelRegistry()
  private labelCache: { version: number; view: LabelView } | null = null
  /** Every display label (normalized) each channel id has been shown with —
   *  kept across reconnects so a reference printed earlier never silently
   *  names a different channel later (see channel-labels.ts). */
  private shownLabels = new Map<string, Set<string>>()
  /** Channels currently open on the live connection (channels/open succeeded this epoch). */
  openChannels = new Set<string>()
  /** Desired-open state: config `openChannels` plus mcpl_open/mcpl_close during the session.
   *  Survives reconnects — reconciled against each channels/register. */
  private desiredOpen: Set<string>
  /** channels/open requests in flight (auto-open must not double-send). */
  private opening = new Set<string>()
  private warnedNoLifecycle = false
  grant: CapabilityPath[] = []
  featureSetsEnabled: string[] = []
  manifestRevision: string | null = null

  /** Resolves when the first connect attempt finishes (success OR failure) —
   *  lets the MCP ListTools handler wait so the startup tool list is complete. */
  readonly firstAttempt: Promise<void>
  private firstAttemptResolve!: () => void

  private conn: McplConnection | null = null
  private child: ChildProcess | null = null
  private epoch = 0
  /** close(): for good — the handle was replaced or its server removed. */
  private retired = false
  /** disable(): stopped until enable(). */
  private paused = false
  /** The latest REQUESTED on/off state, set when enable()/disable() is called
   *  rather than when its queued op runs — so a check made while ops are
   *  queued sees where the server is headed, and a queued op that a later
   *  request superseded does nothing. */
  private wantOff = false
  /** Resolves once every stdio child this handle has stopped has really
   *  exited (SIGKILL after a grace period). Each spawn waits on it: a new
   *  process must never start beside an old one still holding a port or lock. */
  private childGone: Promise<void> = Promise.resolve()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** enable / disable / restart take turns (see serialize). */
  private lifecycleChain: Promise<unknown> = Promise.resolve()
  private latestAttempt: Promise<void> = Promise.resolve()
  /** Resolves when the latest spawned stdio child has exited and its stdio drained. */
  private childClosed: Promise<void> = Promise.resolve()
  private backoffMs: number
  private readonly cb: HostCallbacks
  private pendingInference = new Map<string, PendingInference>()
  private manifestFetchAt = 0
  private isMcpl = false
  /** RFC-015: credentials handed to this server, per audience (RFC §5 caching). */
  private accessCache = new CredentialCache()
  private warnedPlainWs = false
  /** RFC-014: this server's tool presence — hints, toolsets, instances, what the model was shown. Survives reconnects. */
  readonly presence: ToolPresence
  /** What Claude Code's tool list holds of this server, last reported (toolsChanged fires only when it changes). */
  private listedDigest = ''
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private recovering = false
  private recoverAgain = false
  /** This connection's requests whose results carry hint state, by id (RFC-014 r4: applied as read). */
  private sentHinted = new Map<string, { method: string; params: Record<string, unknown> }>()
  /** What applying a message's hints changed, for whoever renders it — keyed by the result or params object the caller later gets. */
  private readChanges = new WeakMap<object, ChangeSet>()
  /** eventIds of pushes read on this connection (bounded): a repeated one's hints are ignored (r5 §6.1). */
  private seenEvents = new Set<string>()

  /**
   * `opts.predecessor`: the exit of the process a replaced handle for this
   * server was running (its close() result); the first spawn waits on it.
   */
  constructor(id: string, cfg: ServerConfig, cb: HostCallbacks, opts: { disabled?: boolean; predecessor?: Promise<void> } = {}) {
    this.id = id
    this.cfg = cfg
    this.prefix = cfg.toolPrefix ?? id
    this.presence = new ToolPresence(id)
    this.cb = cb
    this.policy = cfg.grant ?? DEFAULT_GRANT
    this.openOnAddressed = cfg.openOnAddressed ?? holdsAmbient(cfg.wake)
    this.desiredOpen = new Set(cfg.openChannels ?? [])
    this.backoffMs = cfg.reconnectIntervalMs ?? 5000
    this.firstAttempt = new Promise<void>(r => (this.firstAttemptResolve = r))
    if (opts.predecessor) this.childGone = opts.predecessor
    if (opts.disabled) {
      // Nothing will be attempted, so nothing should wait on an attempt.
      this.paused = true
      this.wantOff = true
      this.status = 'disabled'
      this.firstAttemptResolve()
    }
  }

  private get reconnectEnabled(): boolean {
    return this.cfg.reconnect ?? isWs(this.cfg.transport)
  }

  private get halted(): boolean {
    return this.retired || this.paused
  }

  /** Off, or headed there: the latest request was disable() (or it was constructed disabled). */
  get disabled(): boolean {
    return this.wantOff
  }

  /** The stdio server's process id; null for ws servers and when not running. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** The most recent connect attempt — resolves once it settles, either way (status / lastError say which). */
  get attempt(): Promise<void> {
    return this.latestAttempt
  }

  /** Resolves once no lifecycle op is queued and the latest connect attempt
   *  has settled — what a report of "where did this server end up" waits on
   *  when other ops (a hot reload) are in flight around it. */
  async idle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const chain = this.lifecycleChain
      await chain
      await this.latestAttempt
      if (chain === this.lifecycleChain) return
    }
  }

  /** A server that died on startup can close stdout before its last stderr
   *  lines arrive: wait (bounded) for its process to finish closing so
   *  `stderrTail` holds the whole crash report. */
  async stderrSettled(maxMs = 1000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.childClosed, new Promise<void>(r => (timer = setTimeout(r, maxMs)))])
    clearTimeout(timer)
  }

  private log(line: string) {
    this.cb.log(`[${this.id}] ${line}`)
  }

  private audit(rec: Omit<AccessAuditRecord, 'at' | 'server'>): void {
    const full: AccessAuditRecord = { at: new Date().toISOString(), server: this.id, ...rec }
    this.log(
      `access ${full.kind} "${full.audience}": ${full.outcome}` +
        (full.refusal ? ` (${full.refusal})` : '') +
        (full.expiresAt ? ` until ${full.expiresAt}` : '') +
        (full.reason ? ` — ${full.reason}` : '') +
        (full.endpoint ? ` endpoint=${full.endpoint}` : '') +
        (full.purpose ? ` purpose=${JSON.stringify(full.purpose)}` : ''),
    )
    try {
      this.cb.audit?.(full)
    } catch {}
  }

  /** The audience this server's dial mints for (`transport.access`), if any. */
  get accessAudience(): string | null {
    return isWs(this.cfg.transport) ? (this.cfg.transport.access ?? null) : null
  }

  /**
   * Mint the dial credential for `transport.access` (RFC-015 §5: requested at
   * each dial and reconnect). Throws an error naming the audience and the
   * reason — never the credential — so the dial fails loudly.
   */
  private async dialCredential(audience: string): Promise<string> {
    const issuer = this.cb.issuer?.() ?? null
    if (!issuer) {
      const reason = 'no identity configured (add "identity" to the bridge config)'
      this.audit({ kind: 'dial', audience, outcome: 'refused', refusal: 'no_identity', reason })
      throw new Error(`access "${audience}": ${reason}`)
    }
    try {
      const c = await issuer.mint(audience, { ttl: ACCESS_TTL })
      secrets.add(c.credential, c.expiresAt)
      this.audit({ kind: 'dial', audience, outcome: 'granted', expiresAt: rfc3339(c.expiresAt), ...(c.principal ? { principal: c.principal } : {}) })
      return c.credential
    } catch (e) {
      const refusal: RefusalKind = e instanceof AccessRefused ? e.kind : 'unavailable'
      const reason = e instanceof AccessRefused ? e.reason : secrets.scrubLog(e instanceof Error ? e.message : String(e))
      this.audit({ kind: 'dial', audience, outcome: 'refused', refusal, reason })
      throw new Error(`access "${audience}": ${reason}`)
    }
  }

  /** Non-blocking: failures schedule reconnect instead of throwing. */
  start(): void {
    if (this.halted) {
      this.firstAttemptResolve()
      return
    }
    void this.connectOnce()
  }

  /** Retire the handle for good. Resolves when its stdio child (if any) has exited. */
  close(): Promise<void> {
    this.retired = true
    this.teardown('closed')
    this.accessCache.clear()
    return this.childGone
  }

  /**
   * Run enable / disable / restart one at a time, in call order: a restart
   * racing a disable must not interleave one's teardown with the other's dial.
   * An op returns the connect attempt it started (if any) as `settled` instead
   * of awaiting it, so the next op waits for a teardown, never for a handshake.
   */
  private serialize(op: () => Promise<{ settled?: Promise<void> } | void>): Promise<void> {
    const run = this.lifecycleChain.then(op)
    this.lifecycleChain = run.then(
      () => {},
      () => {},
    )
    return run.then(r => r?.settled)
  }

  /**
   * Stop the server until enable(): connection closed, a stdio child reaped,
   * tools withdrawn, pending inference refused, no reconnects. The host's own
   * session state — the desired-open channel set — is kept, so enable()
   * re-opens what was open.
   */
  disable(): Promise<void> {
    this.wantOff = true
    return this.serialize(async () => {
      if (!this.wantOff || this.halted) return // superseded by a later enable(), or already stopped
      this.paused = true
      this.teardown('disabled')
      await this.childGone
    })
  }

  /** Start a disabled server. Resolves when its connect attempt settles. */
  enable(): Promise<void> {
    if (this.retired) return Promise.reject(new Error(`${this.id}: this handle was replaced; check mcpl_status`))
    this.wantOff = false
    return this.serialize(async () => {
      if (this.wantOff || this.retired) return // superseded by a later disable(), or replaced
      if (!this.paused) return
      this.paused = false
      this.status = 'disconnected'
      this.backoffMs = this.cfg.reconnectIntervalMs ?? 5000
      return { settled: this.connectOnce() }
    })
  }

  /**
   * Hot reload: tear the connection down and bring it back. A stdio server is
   * killed (SIGTERM; SIGKILL after 3s) and respawned only once the old process
   * has exited, so whatever was rebuilt on disk is what runs and a port the
   * old one held is free again. A ws server is redialed. Full handshake, fresh
   * grant, tools re-fetched; desired-open channels re-open when the server
   * re-registers them. Resolves when the new connect attempt settles.
   */
  restart(): Promise<void> {
    return this.serialize(async () => {
      if (this.retired) throw new Error(`${this.id}: this handle was replaced; check mcpl_status`)
      if (this.wantOff || this.paused) throw new Error(`${this.id}: disabled; mcpl_enable starts it`)
      this.teardown('disconnected')
      await this.childGone
      if (this.halted || this.wantOff) return // closed or disabled while the old process wound down
      this.backoffMs = this.cfg.reconnectIntervalMs ?? 5000
      return { settled: this.connectOnce() }
    })
  }

  private teardown(status: 'disconnected' | 'disabled' | 'closed'): void {
    this.epoch++ // invalidate any in-flight handshake/loop
    // A reconnect already scheduled must not fire into whatever comes next —
    // it would dial a second connection beside the live one and leak it.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
    this.connectedAt = null
    // Transport-epoch boundary: revoke all authority from the dead epoch (SPEC §5.3).
    this.grant = []
    this.featureSetsEnabled = []
    this.channels.clear()
    this.openChannels.clear()
    this.manifestRevision = null
    for (const [, p] of this.pendingInference) p.reject({ code: ERR.CAPABILITY_DENIED, message: 'connection lost' })
    this.pendingInference.clear()
    const conn = this.conn
    this.conn = null
    try {
      conn?.close()
    } catch {}
    this.stopChild(this.child)
    this.child = null
    if (this.tools.length) {
      this.tools = []
      this.listedChanged()
    }
    this.status = status
  }

  /** SIGTERM a child and track its exit (SIGKILL after the grace period) in childGone. */
  private stopChild(child: ChildProcess | null): void {
    if (!child) return
    try {
      child.kill()
    } catch {}
    const gone = reap(child)
    const prev = this.childGone
    this.childGone = Promise.all([prev, gone]).then(() => {})
  }

  private scheduleReconnect(): void {
    if (this.halted || !this.reconnectEnabled) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const max = this.cfg.reconnectMaxIntervalMs ?? 300_000
    const jitter = 0.75 + Math.random() * 0.5 // ±25%
    const delay = Math.min(this.backoffMs, max) * jitter
    this.backoffMs = Math.min(this.backoffMs * 2, max)
    this.log(`reconnect in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectOnce()
    }, delay)
  }

  private async dial(): Promise<{ conn: McplConnection; child: ChildProcess | null; stderrTail: string[]; closed: Promise<void> }> {
    const stderrTail: string[] = []
    if (isWs(this.cfg.transport)) {
      const t = this.cfg.transport
      const { default: WebSocket } = await import('ws')
      // Credential resolved per dial: minted for `access` (wins), else the static token / env var.
      const minted = t.access ? await this.dialCredential(t.access) : undefined
      if (minted && !this.warnedPlainWs) {
        const u = new URL(dialUrl(t))
        if (u.protocol === 'ws:' && !isLoopbackHost(u.hostname)) {
          this.warnedPlainWs = true
          this.log(`warning: access credential for "${t.access}" sent over plain ws:// to ${u.hostname} — use wss:// unless the link is already private (tailnet)`)
        }
      }
      if (!minted) secrets.add(staticToken(t))
      const url = resolveUrl(t, minted) // carries the credential: never logged
      const ws = new WebSocket(url)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws open timeout')), 15_000)
        ws.on('open', () => {
          clearTimeout(t)
          resolve()
        })
        ws.on('error', (e: Error) => {
          clearTimeout(t)
          reject(e)
        })
      })
      return { conn: McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0]), child: null, stderrTail, closed: Promise.resolve() }
    }
    const t = this.cfg.transport as StdioTransportConfig
    const child = spawn(t.command, t.args ?? [], {
      cwd: t.cwd,
      env: { ...process.env, ...t.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const keep = (line: string) => {
      stderrTail.push(line)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES)
    }
    // Line-buffered: one line can arrive split across chunks, and the tail
    // must hold whole lines. A partial line is flushed at exit (or past 4 KB).
    let partial = ''
    const flushLine = (line: string) => {
      const l = line.replace(/\r$/, '')
      this.log(`stderr: ${l}`)
      keep(l)
    }
    child.stderr?.on('data', (d: Buffer) => {
      partial += d.toString()
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) flushLine(line)
      if (partial.length > 4096) {
        flushLine(partial)
        partial = ''
      }
    })
    const conn = McplConnection.fromStreams(child.stdout!, child.stdin!)
    let markClosed!: () => void
    const closed = new Promise<void>(r => (markClosed = r))
    // A command that cannot be spawned (ENOENT, EACCES) is reported here, not
    // thrown; unheard, the 'error' event would take the whole bridge down.
    // Its pipes may never end, so close the connection ourselves — otherwise
    // the handshake sits out its full request timeout before failing.
    child.on('error', e => {
      this.log(`spawn ${t.command}: ${e.message}`)
      keep(`[spawn failed: ${e.message}]`)
      if (child.pid === undefined) {
        conn.close()
        markClosed()
      }
    })
    // Same for a write into a server that already died (EPIPE): the
    // connection's close path reports it; the stream error must not throw.
    child.stdin?.on('error', e => this.log(`stdin: ${e.message}`))
    // 'close', not 'exit': it fires after stdio drains, so the marker lands after the last stderr line.
    child.once('close', (code, signal) => {
      if (partial) flushLine(partial)
      partial = ''
      keep(`[exited ${signal ?? `code ${code}`}]`)
      markClosed()
    })
    return { conn, child, stderrTail, closed }
  }

  private connectOnce(): Promise<void> {
    const attempt = this.connectOnceInner().finally(() => this.firstAttemptResolve())
    this.latestAttempt = attempt
    return attempt
  }

  private async connectOnceInner(): Promise<void> {
    if (this.halted) return
    const myEpoch = ++this.epoch
    this.status = 'connecting'
    // Every stdio spawn waits for the processes this handle (or the one it
    // replaced) stopped to have exited — after a crash, a failed handshake, a
    // restart or a config change alike. Bounded by reap's SIGKILL.
    if (!isWs(this.cfg.transport)) {
      await this.childGone
      if (myEpoch !== this.epoch || this.halted) return
    }
    let dialed: Awaited<ReturnType<McplServerHandle['dial']>>
    try {
      dialed = await this.dial()
    } catch (e) {
      if (myEpoch !== this.epoch) return // superseded while dialing (restart / disable / close): not ours to report or retry
      this.lastError = `connect failed: ${e instanceof Error ? e.message : e}`
      this.log(this.lastError)
      this.status = 'disconnected'
      this.scheduleReconnect()
      return
    }
    const { conn, child } = dialed
    if (myEpoch !== this.epoch) {
      conn.close()
      this.stopChild(child)
      return
    }
    this.conn = conn
    this.child = child
    this.stderrTail = dialed.stderrTail
    this.childClosed = dialed.closed
    this.attachTap(conn, myEpoch)
    conn.on('error', err => this.log(`conn error: ${err.message}`))
    conn.on('close', () => {
      if (myEpoch !== this.epoch) return
      this.lastError = 'connection closed'
      this.log('connection closed')
      this.teardown('disconnected')
      this.scheduleReconnect()
    })

    try {
      await this.handshake(conn, myEpoch)
    } catch (e) {
      this.log(`handshake failed: ${e instanceof Error ? e.message : e}`)
      if (myEpoch === this.epoch) {
        this.lastError = `handshake failed: ${e instanceof Error ? e.message : e}`
        this.teardown('disconnected')
        this.scheduleReconnect()
      }
      return
    }
    if (myEpoch !== this.epoch) return
    this.lastError = null
    this.connectedAt = Date.now()
    this.backoffMs = this.cfg.reconnectIntervalMs ?? 5000
    void this.pullLoop(conn, myEpoch)
  }

  private async handshake(conn: McplConnection, myEpoch: number): Promise<void> {
    const canMint = (this.cb.issuer?.() ?? null) !== null
    const initResult = (await conn.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl: hostMcplCaps(canMint, this.hintsAdvertised) } },
      clientInfo: { name: 'mcpl-cc-bridge', version: '0.1.0' },
    })) as McplInitializeResult
    if (myEpoch !== this.epoch) throw new Error('stale epoch')
    conn.sendNotification('notifications/initialized', {})

    const caps: InitializeCapabilities = initResult.capabilities ?? {}
    const mcpl = extractMcpl(caps)
    this.isMcpl = mcpl != null
    // RFC-014: a new connection — revs start over; its manifest declares toolsets.
    this.presence.beginConnection(mcpl as Record<string, unknown> | undefined, this.hintsAdvertised)

    if (mcpl != null) {
      // §5.4: effective grant = advertised ∩ operator policy. tools comes only
      // from the OUTER capabilities — advertisedCapabilitiesFromInitialize handles that.
      const advertised = advertisedCapabilitiesFromInitialize(caps)
      this.grant = computeGrant(advertised, this.policy)
      this.noteAccessGrant(advertised, canMint)

      // Dual-shape featureSets normalization (0.5 object vs 0.4 array). Digest
      // is computed over the manifest AS SENT, before normalization.
      try {
        this.manifestRevision = manifestDigest(mcpl as Record<string, unknown>)
      } catch {
        this.manifestRevision = null
      }
      const declared = normalizeFeatureSets(mcpl.featureSets)
      const derivation = deriveFeatureSets(declared, this.grant)
      const wanted = this.cfg.enableFeatureSets ?? ['*']
      const enabled = derivation.enabled.filter(name =>
        wanted.some(w => w === '*' || w === name || (w.endsWith('.*') && name.startsWith(w.slice(0, -1)))),
      )

      // §6.7: initial policy is mandatory, as a Request, even when empty.
      const receipt = (await conn.sendRequest('featureSets/update', {
        effectiveCapabilities: [...this.grant],
        enabled,
      })) as FeatureSetsUpdateResult
      if (myEpoch !== this.epoch) throw new Error('stale epoch')
      if (receipt && receipt.accepted === false) {
        // Consequence testimony is not policy authority: never widen. Honor fallback.
        this.log(`policy refused (${receipt.reason ?? 'no reason'}), fallback=${receipt.fallback}`)
        if (receipt.fallback === 'close') throw new Error('server refused policy and asked to close')
        this.grant = []
        this.featureSetsEnabled = []
        this.status = 'mcp-only'
      } else {
        this.featureSetsEnabled = enabled
        for (const u of (receipt?.unavailableFeatures ?? [])) {
          this.log(`degraded: ${u.featureSet} missing [${u.missingCapabilities.join(', ')}] — ${u.effect}`)
        }
        this.status = 'ready'
      }
    } else {
      this.grant = []
      this.status = 'mcp-only'
      this.log('no MCPL advertisement — plain MCP passthrough')
    }

    await this.refreshTools(conn)
    // RFC-014 §5.2–5.3: after every (re)connect, ask what the server still holds open and adopt it.
    if (this.presence.active) await this.reattach(conn, myEpoch) // r5 §5.3: every server with toolHints answers toolsets/list
    this.log(`connected: ${this.status}, ${this.tools.length} tools, grant=[${this.grant.join(', ')}]` + (this.presence.active ? `, toolHints${this.presence.surface ? ' (surface)' : ''}: ${this.listedTools().length} listed, ${this.presence.openRecords().length} open` : ''))
  }

  /**
   * tools/list. The result is applied where it is read, in arrival order (the
   * tap, readToolList); this returns what that changed for the model.
   */
  private async refreshTools(conn: McplConnection): Promise<ChangeSet> {
    try {
      const r = await conn.sendRequest('tools/list', {})
      return (r && typeof r === 'object' ? this.readChanges.get(r) : undefined) ?? emptyChange()
    } catch (e) {
      this.log(`tools/list failed: ${e instanceof Error ? e.message : e}`)
      return emptyChange()
    }
  }

  // ── RFC-014: tool presence ──

  /** The host advertises toolHints to this server (config `toolHints: false` opts out: the server then sees a plain host). */
  get hintsAdvertised(): boolean {
    return this.cfg.toolHints !== false
  }

  /**
   * What Claude Code's tool list carries of this server: everything when hints
   * are off (today's behaviour); static tools in mixed mode; nothing in
   * surface mode (RFC-014 §8.1).
   */
  listedTools(): McplTool[] {
    if (!this.presence.active) return this.tools
    if (this.presence.surface) return []
    return this.tools.filter(t => this.presence.presenceOf(t.name) === 'static')
  }

  /** Tell the client only when what it lists changed — never for a dynamic tool's visibility (that is the point of RFC-014). */
  private listedChanged(): void {
    const d = JSON.stringify([this.presence.presents, this.listedTools().map(t => [t.name, t.description ?? '', t.inputSchema ?? null, t._meta ?? null])])
    if (d === this.listedDigest) return
    this.listedDigest = d
    this.cb.toolsChanged()
  }

  /** Apply pending static↔dynamic moves at a boundary (compaction); true when the listed tools changed. */
  applyPresenceMoves(): Array<{ name: string; to: 'static' | 'dynamic' }> {
    const moves = this.presence.applyMoves()
    if (moves.length) this.listedChanged()
    return moves
  }

  /**
   * The one apply path (RFC-014 §6.1) for a HintChanges from any carrier — a
   * call or open/close result, a push's `hints`, a standalone tools/hints —
   * called as the message is read (the tap). Returns what changed for the
   * model. Revs are consecutive (r4): anything but the last + 1 means a
   * message was lost or misordered, and the host recovers.
   */
  private applyHints(h: unknown, source: string): ChangeSet {
    if (h === undefined || !this.presence.active) return emptyChange()
    const before = this.presence.view()
    const last = this.presence.rev
    const r = this.presence.apply(h)
    const rev = String((h as { rev?: unknown }).rev)
    if (r.behind) {
      this.log(`hint change rev ${rev} (${source}) is not after rev ${last} — ignored; recovering from toolsets/list + tools/list`)
      this.scheduleRecovery()
    } else if (r.skipped) {
      this.log(`hint change rev ${rev} (${source}) after rev ${last}: a rev was lost — applied; recovering from toolsets/list + tools/list`)
      this.scheduleRecovery()
    } else if (!r.applied) this.log(`malformed hint change (${source}) ignored`)
    const cs = this.presence.diff(before, this.presence.view())
    cs.suggest.push(...r.suggest)
    return cs
  }

  // ── RFC-014 r4 §6.1: apply on arrival ──

  /**
   * Hint changes apply when a message is READ, in arrival order — whatever
   * then becomes of the message: a push refused or not yet decided on, a
   * result nobody waits for any more (a timed-out call). The connection emits
   * every message here before routing it (`wire`, a local addition to the
   * vendored McplConnection, which would otherwise drop a late response
   * unseen), and `sent` names the request each response answers.
   */
  private attachTap(conn: McplConnection, myEpoch: number): void {
    this.sentHinted = new Map()
    this.seenEvents = new Set()
    conn.on('sent', (id, method, params) => {
      if (!HINTED_RESULTS.has(method)) return
      this.sentHinted.set(String(id), { method, params: params && typeof params === 'object' ? (params as Record<string, unknown>) : {} })
      if (this.sentHinted.size > 1000) this.sentHinted.delete(this.sentHinted.keys().next().value!)
    })
    conn.on('wire', msg => {
      if (myEpoch !== this.epoch) return
      try {
        this.onRead(conn, msg)
      } catch (e) {
        this.log(`hint tap: ${e instanceof Error ? e.message : e}`)
      }
    })
  }

  private onRead(conn: McplConnection, msg: Record<string, unknown>): void {
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const sent = this.sentHinted.get(String(msg.id))
      if (!sent) return
      this.sentHinted.delete(String(msg.id))
      const result = msg.result
      if (!result || typeof result !== 'object' || Array.isArray(result)) return // an error carries no state
      const res = result as Record<string, unknown>
      const awaited = conn.isPending(msg.id)
      let cs: ChangeSet
      switch (sent.method) {
        case 'tools/list':
          cs = this.readToolList(res)
          break
        case 'toolsets/list':
          cs = this.readToolsetList(res)
          break
        case 'toolsets/open': {
          cs = this.applyHints(metaHints(res), 'toolsets/open')
          const before = this.presence.view()
          const toolset = typeof res.toolset === 'string' ? res.toolset : String(sent.params.toolset ?? '')
          const instance = typeof res.instance === 'string' && res.instance ? res.instance : typeof sent.params.instance === 'string' ? sent.params.instance : undefined
          this.presence.noteOpened(toolset, instance, typeof res.title === 'string' && res.title ? res.title : undefined)
          cs.changes.push(...this.presence.diff(before, this.presence.view()).changes)
          break
        }
        case 'toolsets/close': {
          // The hint changes the close caused ride in its result (r3 §5.2), like an open's.
          cs = this.applyHints(metaHints(res), 'toolsets/close')
          const before = this.presence.view()
          this.presence.noteClosed(String(sent.params.toolset ?? ''), typeof sent.params.instance === 'string' ? sent.params.instance : undefined)
          cs.changes.push(...this.presence.diff(before, this.presence.view()).changes)
          break
        }
        default:
          cs = this.applyHints(metaHints(res), sent.method)
      }
      if (awaited) this.readChanges.set(res, cs)
      else {
        // Nobody waits for this result any more (it timed out): applied all the same, and told on its own.
        this.log(`late ${sent.method} result read — its hint changes applied`)
        if (sent.method !== 'tools/list') this.deliverChange(cs)
      }
      return
    }
    const params = msg.params
    if (!params || typeof params !== 'object' || Array.isArray(params) || !this.presence.active) return
    const p = params as Record<string, unknown>
    if (msg.method === 'tools/hints') {
      this.readChanges.set(p, this.applyHints(p, 'tools/hints'))
    } else if (msg.method === 'push/event' && p.hints !== undefined) {
      // RFC-014 r3 §7: a push carrying hints is never coalesced — when its changes would apply is undefined.
      if (p.coalesce != null) {
        this.log(`push ${String(p.eventId ?? '')} carries hints and coalesce (RFC-014 §7 forbids it) — hints ignored; recovering`)
        this.scheduleRecovery()
        return
      }
      // r5 §6.1: a push carrying hints is never retried; one whose eventId was seen is a duplicate — its hints were applied once.
      const eventId = typeof p.eventId === 'string' || typeof p.eventId === 'number' ? String(p.eventId) : ''
      if (eventId) {
        if (this.seenEvents.has(eventId)) {
          this.log(`push ${eventId} seen before — its hints ignored`)
          return
        }
        this.seenEvents.add(eventId)
        if (this.seenEvents.size > 1000) this.seenEvents.delete(this.seenEvents.values().next().value!)
      }
      // Applied now, before (and whatever) the host decides about the push.
      this.readChanges.set(p, this.applyHints(p.hints, 'push'))
    }
  }

  /** tools/list, as read: definitions and presence as of its `mcpl/rev`, which takes no rev of its own (r4 §4.1). */
  private readToolList(res: Record<string, unknown>): ChangeSet {
    const tools = Array.isArray(res.tools) ? (res.tools as McplTool[]) : []
    const before = this.presence.view()
    this.tools = tools
    this.presence.setTools(tools)
    const meta = res._meta && typeof res._meta === 'object' ? (res._meta as Record<string, unknown>) : {}
    if (this.presence.active && this.presence.noteListRev(meta['mcpl/rev'])) {
      this.log(`tools/list was written after rev ${String(meta['mcpl/rev'])}, beyond the last rev read — a message was lost; recovering`)
      this.scheduleRecovery()
    }
    this.listedChanged()
    return this.presence.diff(before, this.presence.view())
  }

  /** toolsets/list, as read: a full statement of per-instance state at its own rev (r4 §5.3, §6.1). */
  private readToolsetList(res: Record<string, unknown>): ChangeSet {
    if (!this.presence.active) return emptyChange()
    const before = this.presence.view()
    const { lost, ended, suggest, skipped } = this.presence.adopt(res)
    if (skipped && !this.recovering) {
      // Per-instance state is restated in full; what else was lost (presence, groups) comes from tools/list.
      this.log('toolsets/list rev skipped one — re-reading tools/list')
      this.scheduleRecovery()
    }
    const cs = this.presence.diff(before, this.presence.view())
    cs.suggest.push(...suggest)
    // A lost toolset gets its note, not also a "closed" line.
    cs.changes = cs.changes.filter(c => !lost.some(o => keyOf(o.toolset, o.instance) === c.key))
    cs.notes.push(...this.presence.adoptionNotes(lost, ended))
    return cs
  }

  /**
   * A change with no result or event to ride on  /**
   * A change with no result or event to ride on (tools/hints, a reconnect,
   * a recovery): a short channel notification. Tagged surface:tools — held,
   * not woken on, by default — or surface:invite when it suggests an open.
   * Needs pushEvents, like any delivery into the conversation.
   */
  private deliverChange(cs: ChangeSet): void {
    if (isEmpty(cs)) return
    if (!granted(this.grant, 'pushEvents')) {
      this.log('tool change not delivered (pushEvents not granted) — look shows it')
      return
    }
    const one = cs.changes.length === 1 ? cs.changes[0]! : null
    this.cb.deliver({
      server: this.id,
      kind: 'push-event',
      text: this.presence.render(cs),
      meta: {
        tags: cs.suggest.some(s => s.action === 'open') ? 'surface:invite' : 'surface:tools',
        ...(one?.toolset ? { toolset: one.toolset } : {}),
        ...(one?.instance ? { instance: one.instance } : {}),
      },
      keepWhole: true,
    })
  }

  /** The tool result, `mcpl/hints` taken out of its _meta, the change (applied when the result was read) appended after the server's content. */
  private withChange(conn: McplConnection, result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result
    const r = result as { content?: unknown; _meta?: Record<string, unknown> }
    const cs = this.readChanges.get(r)
    const out: Record<string, unknown> = { ...r }
    if (r._meta && typeof r._meta === 'object' && 'mcpl/hints' in r._meta) {
      const { 'mcpl/hints': _hints, ...meta } = r._meta
      if (Object.keys(meta).length) out._meta = meta
      else delete out._meta
    }
    if (conn !== this.conn || !cs) return out
    const text = this.presence.render(cs)
    if (text) out.content = [...(Array.isArray(r.content) ? r.content : []), { type: 'text', text }]
    return out
  }

  /** Debounced: a burst of anomalies is one recovery; one that arrives during a recovery runs another after it. */
  private scheduleRecovery(): void {
    if (!this.presence.active) return
    if (this.recovering) {
      this.recoverAgain = true
      return
    }
    if (this.recoveryTimer) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      void this.recover()
    }, 200)
  }

  /**
   * Recovering (r6 §6.1): re-read tools/list (presence, declared definitions)
   * then toolsets/list (dynamic-tool state in full) — so every tool the
   * statement names is already known — each applied where it is read in
   * arrival order. What changed is announced. (This host speaks stdio and
   * WebSocket only, where arrival order is rev order; it has no Streamable
   * HTTP transport, so it never holds an early rev.)
   */
  private async recover(): Promise<void> {
    const conn = this.conn
    if (!conn || conn.isClosed) return
    this.recovering = true
    try {
      const tools = await this.refreshTools(conn)
      if (conn !== this.conn) return
      let cs = emptyChange()
      try {
        const r = await conn.sendRequest('toolsets/list', {}, 15_000)
        cs = (r && typeof r === 'object' ? this.readChanges.get(r) : undefined) ?? cs
      } catch (e) {
        this.log(`toolsets/list (recovery) failed: ${e instanceof Error ? e.message : e}`)
      }
      if (conn !== this.conn) return
      this.deliverChange({ changes: [...tools.changes, ...cs.changes], suggest: cs.suggest, notes: cs.notes })
    } finally {
      this.recovering = false
      if (this.recoverAgain) {
        this.recoverAgain = false
        this.scheduleRecovery()
      }
    }
  }

  /**
   * Re-read what the server holds open — titles, visibility — without
   * announcing it: for a reminder or a look, which restate everything anyway.
   * (A title changes with state — "waiting for an opponent" becomes "vs bo" —
   * and hint changes carry no title unless a toolset opens.) Returns notes
   * for what the server no longer holds.
   */
  async refreshOpen(): Promise<string[]> {
    if (!this.presence.active) return []
    const conn = this.conn
    if (!conn || conn.isClosed) return []
    let r: unknown
    try {
      r = await conn.sendRequest('toolsets/list', {}, 5000)
    } catch (e) {
      this.log(`toolsets/list (refresh) failed: ${e instanceof Error ? e.message : e}`)
      return []
    }
    if (conn !== this.conn || !r || typeof r !== 'object') return []
    return this.readChanges.get(r)?.notes ?? []
  }

  /**
   * After a (re)connect: toolsets/list is the truth (RFC-014 §5.2–5.3). What
   * it reports is adopted (a game kept across the reconnect); anything the
   * host believed open and it does not report is closed — and never re-opened
   * here, since opening can start a new game. `ended` toolsets are told.
   */
  private async reattach(conn: McplConnection, myEpoch: number): Promise<void> {
    let r: unknown
    try {
      r = await conn.sendRequest('toolsets/list', {}, 15_000)
    } catch (e) {
      this.log(`toolsets/list failed: ${e instanceof Error ? e.message : e}`)
      return
    }
    if (myEpoch !== this.epoch || !r || typeof r !== 'object') return
    this.deliverChange(this.readChanges.get(r) ?? emptyChange())
  }

  /** toolsets/open (RFC-014 §5.2). The server's refusal propagates (RpcError). */
  async openToolset(toolset: string, instance: string | undefined, options: Record<string, unknown> | undefined): Promise<{ key: string; title?: string; content: ContentBlock[]; change: ChangeSet; adopted: boolean }> {
    const conn = this.liveConn()
    const r = (await conn.sendRequest('toolsets/open', { toolset, ...(instance ? { instance } : {}), ...(options ? { options } : {}) }, REQUEST_TIMEOUTS.toolset)) as Record<string, unknown> | null
    if (conn !== this.conn) throw new Error(`${this.id}: the connection was replaced while opening ${toolset}`)
    const res = r && typeof r === 'object' ? r : {}
    const inst = typeof res.instance === 'string' && res.instance ? res.instance : instance
    // r3 §5.2: a proposed name is used as given or the open refused — never another name.
    if (instance && inst !== instance) this.log(`warning: proposed instance "${instance}" came back as "${inst}" (RFC-014 r3 §5.2 forbids renaming) — using the server's`)
    const title = typeof res.title === 'string' && res.title ? res.title : undefined
    // Applied (hints, then the open itself) when the result was read.
    const change = this.readChanges.get(res) ?? emptyChange()
    const key = keyOf(toolset, this.presence.declared[toolset]?.instances ? inst : undefined)
    return {
      key,
      title: title ?? this.presence.openRecords().find(o => keyOf(o.toolset, o.instance) === key)?.title,
      content: Array.isArray(res.content) ? (res.content as ContentBlock[]) : [],
      change,
      // r3 §5.2: it was already open; the content says which options were not applied.
      adopted: res.adopted === true,
    }
  }

  /** toolsets/close. */
  async closeToolset(toolset: string, instance: string | undefined): Promise<{ content: ContentBlock[]; change: ChangeSet }> {
    const conn = this.liveConn()
    const r = (await conn.sendRequest('toolsets/close', { toolset, ...(instance ? { instance } : {}) }, REQUEST_TIMEOUTS.toolset)) as Record<string, unknown> | null
    if (conn !== this.conn) throw new Error(`${this.id}: the connection was replaced while closing ${toolset}`)
    const res = r && typeof r === 'object' ? r : {}
    // Applied (its hints, then the close) when the result was read.
    const change = this.readChanges.get(res) ?? emptyChange()
    return { content: Array.isArray(res.content) ? (res.content as ContentBlock[]) : [], change }
  }

  /** Open / close an undeclared group (RFC-014 §5.4): the host's own act, the server is not told. */
  setGroupOpen(group: string, open: boolean): ChangeSet {
    const before = this.presence.view()
    if (open) this.presence.openGroup(group)
    else this.presence.closeGroup(group)
    return this.presence.diff(before, this.presence.view())
  }

  // ── Inbound: pull-based loop (event style leaks incomingQueue) ──

  private async pullLoop(conn: McplConnection, myEpoch: number): Promise<void> {
    while (myEpoch === this.epoch && !conn.isClosed) {
      let msg
      try {
        msg = await conn.nextMessage()
      } catch {
        return // ConnectionClosedError — close handler owns teardown
      }
      const isReq = msg.type === 'request'
      const m = isReq ? msg.request : msg.notification
      const id = isReq ? msg.request.id : null
      // Answer-or-error discipline: every id gets a result or an error.
      void this.dispatch(conn, m.method, m.params, id, myEpoch).catch(e => {
        this.log(`handler ${m.method} threw: ${e instanceof Error ? e.message : e}`)
        if (id != null) conn.sendError(id, -32000, 'internal error')
      })
    }
  }

  private async dispatch(conn: McplConnection, methodName: string, params: unknown, id: unknown, myEpoch: number): Promise<void> {
    const respond = (result: unknown) => {
      if (id != null) conn.sendResponse(id as never, result)
    }
    const deny = (code: number, message: string, data?: unknown) => {
      if (id != null) conn.sendError(id as never, code, message, data)
    }

    if (methodName === 'access/token') {
      await this.answerAccessToken(conn, id, params)
      return
    }

    const cap = methodCapability(methodName)
    if (cap === undefined) {
      // A method that will never be answered MUST return an error (SPEC §4).
      deny(ERR.METHOD_NOT_FOUND, `method not supported by this host: ${methodName}`)
      return
    }
    if (cap !== null && !granted(this.grant, cap)) {
      deny(ERR.CAPABILITY_DENIED, `capability ${cap} not granted`, { capability: cap }) // SPEC App. A: data { capability }
      return
    }

    switch (methodName) {
      case 'notifications/tools/list_changed': {
        this.deliverChange(await this.refreshTools(conn))
        return
      }
      case 'tools/hints': {
        // RFC-014 §6.1 carrier 3: a change with nothing to say. A server sends it
        // only to a host that advertised toolHints (§6.3); otherwise it is ignored.
        // Applied when read (the tap); here only told.
        if (!this.presence.active || !params || typeof params !== 'object') return
        this.deliverChange(this.readChanges.get(params) ?? emptyChange())
        return
      }
      case 'push/event': {
        const p = params as PushEventParams & { hints?: unknown; toolset?: unknown; instance?: unknown }
        const tags = expandTags(p.tags)
        // origin is opaque to the spec, but chat-shaped producers put the
        // routing facts there (which channel, which message, who). Pass the
        // common ones through as meta so a wake is addressable without a
        // history call; the empty ones are dropped at the notification edge.
        const o = (p.origin && typeof p.origin === 'object' ? p.origin : {}) as Record<string, unknown>
        const s = (v: unknown) => (v == null ? '' : String(v))
        const mcplChannel = s(o.mcplChannelId)
        const native = s(o.channelId)
        // The registered channel this push is from — by MCPL id, or by the
        // producer's native id through the descriptors' address (discord-mcpl
        // sends several pushes with only the native id). '' when nothing maps.
        const from = this.channelFromOrigin(mcplChannel, native)
        // Whitelist admission (openChannelsOnly / dmAllowlist) — §6.6: a
        // rejection is diagnostics for the server, nothing more.
        const refused = this.refusal({ channelId: from, refs: [mcplChannel, native], isDm: tags.includes('chat:dm'), authorId: s(o.authorId) })
        if (refused) {
          console.error(`${this.id}: dropped push from ${refused}`)
          // Its hints were applied when it was read (r4 §6.1); the event is refused, the tool change is still told.
          this.deliverChange(this.readChanges.get(p) ?? emptyChange())
          respond({ accepted: false, reason: `not admitted on this host: ${refused}` })
          return
        }
        // RFC-014 §6.1 carrier 2: the change the event explains, applied when
        // the push was read (the tap) and appended to the event it explains.
        const changeText = this.presence.render(this.readChanges.get(p) ?? emptyChange())
        const body = renderContent(p.payload?.content)
        this.cb.deliver({
          server: this.id,
          kind: 'push-event',
          text: changeText ? (body ? `${body}\n${changeText}` : changeText) : body,
          ...(changeText ? { keepWhole: true } : {}),
          meta: {
            event_id: String(p.eventId ?? ''),
            feature_set: String(p.featureSet ?? ''),
            ts: String(p.timestamp ?? ''),
            channel_id: from || mcplChannel || native,
            native_channel_id: from && from !== native ? native : mcplChannel ? native : '',
            // The registered label (what mcpl_send/mcpl_open accept back);
            // channel_name is whatever the producer put on origin.
            channel: this.labelOf(from || mcplChannel || native),
            channel_name: s(o.channelName),
            guild: s(o.guildName),
            thread_id: s(o.threadId),
            message_id: s(o.messageId),
            author: s(o.authorName),
            author_id: s(o.authorId),
            // RFC-014 §7: the toolset / instance the event belongs to.
            toolset: s(p.toolset),
            instance: s(p.instance),
            ...(tags.length ? { tags: tags.join(' ') } : {}),
          },
        })
        respond({ accepted: true })
        // Addressed in a channel we don't follow → follow it (see config
        // `openOnAddressed`). After the response: the open is a separate
        // request on the same connection and must not gate this ack.
        // Live-open or already being opened is the test — not desired-open:
        // a configured channel whose open failed must be retried, not skipped.
        const addressedIn = from
        if (this.openOnAddressed && tags.includes('chat:addressed') && addressedIn && !this.openChannels.has(addressedIn) && !this.opening.has(addressedIn)) {
          if (!granted(this.grant, 'channels.lifecycle')) {
            if (!this.warnedNoLifecycle) {
              this.warnedNoLifecycle = true
              console.error(`${this.id}: addressed in ${this.labelOf(addressedIn) || addressedIn} but cannot open it: channels.lifecycle not granted (openOnAddressed is inert)`)
            }
          } else {
            void this.openChannel(addressedIn, 0, { byId: true }).then(
              r => { if (r.open) console.error(`${this.id}: opened ${r.label || addressedIn} (addressed there)`) },
              err => console.error(`${this.id}: open-on-addressed failed for ${addressedIn}: ${(err as Error).message}`),
            )
          }
        }
        return
      }
      case 'channels/register':
      case 'channels/changed': {
        const p = (params ?? {}) as ChannelsRegisterParams & { added?: ChannelDescriptor[]; removed?: string[]; updated?: ChannelDescriptor[] }
        const incoming = methodName === 'channels/register' ? (p.channels ?? []) : [...(p.added ?? []), ...(p.updated ?? [])]
        for (const rid of methodName === 'channels/changed' ? (p.removed ?? []) : []) {
          this.channels.delete(rid)
          this.openChannels.delete(rid)
        }
        // Per-descriptor authorization; itemized results are mandatory (§14.5).
        const results = incoming.map(d => {
          if (!d || typeof d.id !== 'string' || !d.id) return { id: String(d?.id ?? ''), accepted: false, reason: 'invalid descriptor' }
          // An id must read back as itself when printed (id:<id> is the escape every label falls back to).
          if (!isAddressableId(d.id)) return { id: d.id, accepted: false, reason: 'channel id has leading/trailing whitespace or control characters' }
          this.channels.set(d.id, d)
          return { id: d.id, accepted: true }
        })
        respond({ results })
        // Desired-open state is the host's; the server's initiallyOpen hint
        // counts only where we hold no state of our own (§14 descriptor note).
        const toOpen = results
          .filter(r => r.accepted)
          .map(r => r.id)
          .filter(cid => this.desiredOpen.has(cid) || (this.cfg.openChannels === undefined && this.cfg.openChannelsOnly !== true && this.channels.get(cid)?.initiallyOpen === true))
        if (toOpen.length) void this.reconcileOpen(toOpen, myEpoch)
        return
      }
      case 'channels/list': {
        respond({ channels: [...this.channels.values()] })
        return
      }
      case 'channels/incoming': {
        const p = (params ?? {}) as ChannelsIncomingParams
        const results = (p.messages ?? []).map(m => {
          const known = this.channels.has(m.channelId)
          if (!known) return { messageId: m.messageId, accepted: false }
          const tags = expandTags(m.tags)
          const native = (this.channels.get(m.channelId)?.address as { channelId?: unknown } | undefined)?.channelId
          const refused = this.refusal({ channelId: m.channelId, refs: [m.channelId, native == null ? '' : String(native)], isDm: tags.includes('chat:dm'), authorId: String(m.author?.id ?? '') })
          if (refused) {
            console.error(`${this.id}: dropped incoming from ${refused}`)
            return { messageId: m.messageId, accepted: false }
          }
          this.cb.deliver({
            server: this.id,
            kind: 'channel-message',
            text: renderContent(m.content),
            meta: {
              channel_id: m.channelId,
              channel: this.labelOf(m.channelId),
              message_id: m.messageId,
              ...(m.threadId ? { thread_id: m.threadId } : {}),
              author: `${m.author?.name ?? 'unknown'}`,
              author_id: `${m.author?.id ?? ''}`,
              ts: String(m.timestamp ?? ''),
              ...(tags.length ? { tags: tags.join(' ') } : {}),
            },
          })
          return { messageId: m.messageId, accepted: true, conversationId: 'claude-code' }
        })
        // x-mcpl/xgate send this as a Notification — only answer when id present.
        respond({ results })
        return
      }
      case 'inference/request': {
        const p = params as InferenceRequestParams
        const mode = this.cfg.inferenceRequest ?? 'channel'
        if (mode === 'deny' || id == null) {
          deny(ERR.CAPABILITY_DENIED, 'inference/request not admitted by bridge policy')
          return
        }
        const reqId = `inf-${++inferenceSeq}`
        const text = (p.messages ?? []).map(m => `${m.role}: ${m.content}`).join('\n')
        this.cb.deliver({
          server: this.id,
          kind: 'inference-request',
          text: `Inference request ${reqId} (feature set ${p.featureSet}). Answer it by calling the mcpl_answer tool with request_id="${reqId}". Messages:\n${text}`,
          meta: { request_id: reqId, feature_set: String(p.featureSet ?? '') },
        })
        // Generous hold: the model may sit behind a permission prompt before it
        // can call mcpl_answer. (Add the tool to permissions.allow to avoid that.)
        const timer = setTimeout(() => {
          if (this.pendingInference.delete(reqId)) deny(-32000, 'inference request timed out in host')
        }, 600_000)
        this.pendingInference.set(reqId, {
          resolve: result => {
            clearTimeout(timer)
            this.pendingInference.delete(reqId)
            respond(result)
          },
          reject: err => {
            clearTimeout(timer)
            this.pendingInference.delete(reqId)
            deny(err.code, err.message)
          },
        })
        return
      }
      case 'model/info': {
        respond({ id: 'claude-code', vendor: 'anthropic', contextWindow: 200_000, capabilities: ['tools'] })
        return
      }
      case 'mcpl/manifestChanged': {
        if (myEpoch !== this.epoch) return
        await this.onManifestChanged(conn)
        return
      }
      default: {
        deny(ERR.METHOD_NOT_FOUND, `method not supported by this host: ${methodName}`)
      }
    }
  }

  /** Log what the operator should know about access.token in this epoch's grant. */
  private noteAccessGrant(advertised: ReadonlySet<CapabilityPath>, canMint: boolean): void {
    for (const p of wildcardOnlyMatches(advertised, this.policy)) {
      this.log(`warning: ${p} is matched only by a wildcard in the grant — not granted; name "${p}" explicitly to grant it (RFC-015 §4.1)`)
    }
    if (granted(this.grant, 'access.token')) {
      this.log(canMint ? 'access.token granted: this server may obtain credentials acting as the agent' : 'warning: access.token granted but no identity is configured — its requests will be refused (-32040)')
    }
  }

  /**
   * RFC-015 `access/token` (Server → Host). In order: the grant (-32002, also
   * for malformed requests from an ungranted server), the params (-32602),
   * an identity to mint from, then the cache or a fresh mint (-32040 on any
   * refusal). Every request is audited; the credential only ever goes into
   * the response.
   */
  private async answerAccessToken(conn: McplConnection, id: unknown, params: unknown): Promise<void> {
    const seen = auditFields(params)
    if (id == null) {
      this.log('access/token arrived as a notification — it is a request; ignored')
      return
    }
    const rid = id as never
    if (!granted(this.grant, 'access.token')) {
      conn.sendError(rid, ERR.CAPABILITY_DENIED, 'capability access.token not granted', { capability: 'access.token' })
      this.audit({ kind: 'request', ...seen, outcome: 'denied', reason: 'access.token not granted' })
      return
    }
    const check = validateAccessParams(params)
    if (!check.ok) {
      conn.sendError(rid, ERR.INVALID_PARAMS, `Invalid params: ${check.field} ${check.reason}`, { field: check.field, reason: check.reason })
      this.audit({ kind: 'request', ...seen, outcome: 'invalid', reason: `${check.field} ${check.reason}` })
      return
    }
    const { audience, endpoint, purpose, fresh, schemes, timeoutMs } = check.params
    // RFC-015 r3 §8.2: the audit keeps the endpoint's scheme, host and path only.
    const audited = auditEndpoint(endpoint)
    const about = { kind: 'request' as const, audience, ...(audited !== undefined ? { endpoint: audited } : {}), ...(purpose !== undefined ? { purpose } : {}) }
    const refuse = (kind: RefusalKind, reason: string) => {
      conn.sendError(rid, ERR.ACCESS_REFUSED, 'Access refused', { audience, kind, reason })
      this.audit({ ...about, outcome: 'refused', refusal: kind, reason })
    }
    const issuer = this.cb.issuer?.() ?? null
    if (!issuer) return refuse('no_identity', 'this host has no identity to mint from')
    // r4 §3.1–3.3: the server names the schemes it can use; this host mints bearer only.
    if (!(schemes ?? [SCHEME]).includes(SCHEME)) return refuse('host_policy', `this host offers only the "${SCHEME}" scheme`)
    // r5 §5: per (principal, audience, scheme) within this configured server.
    const key = cacheKey(issuer.principal?.() ?? '', audience, SCHEME)
    // r5 §3.4: answer within timeoutMs − 2000 ms, and in any case within 20 s — a refusal rather than silence.
    // (r6: timeoutMs is at least 5000, so there is always time to ask the provider.)
    const budget = Math.min((timeoutMs ?? DEFAULT_TIMEOUT_MS) - 2000, ACCESS_TIME_BOUND.ms)
    let got: Awaited<ReturnType<CredentialCache['get']>>
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.accessCache.abandon(key) // the next request must not wait on this mint
          reject(new AccessRefused(audience, 'unavailable', `the identity provider did not answer within ${budget} ms`))
        }, budget)
      })
      got = await Promise.race([this.accessCache.get(key, fresh === true, () => issuer.mint(audience, { ttl: ACCESS_TTL, timeoutMs: budget })), bound])
    } catch (e) {
      if (e instanceof AccessRefused) return refuse(e.kind, e.reason)
      return refuse('unavailable', `could not mint: ${secrets.scrubLog(e instanceof Error ? e.message : String(e))}`)
    } finally {
      clearTimeout(timer)
    }
    // The mint took time: a grant revoked meanwhile (manifest change) or a
    // connection replaced meanwhile gets nothing.
    if (conn !== this.conn || !granted(this.grant, 'access.token')) {
      conn.sendError(rid, ERR.CAPABILITY_DENIED, 'capability access.token not granted', { capability: 'access.token' })
      this.audit({ ...about, outcome: 'denied', reason: 'grant or connection changed while minting' })
      return
    }
    const c = got.credential
    secrets.add(c.credential, c.expiresAt)
    const expiresAt = rfc3339(c.expiresAt) // RFC-015 r3 §3.2: RFC 3339, UTC, Z
    conn.sendResponse(rid, { scheme: SCHEME, credential: c.credential, expiresAt, ...(c.principal ? { principal: c.principal } : {}) })
    this.audit({ ...about, outcome: got.cached ? 'cached' : 'granted', expiresAt, ...(c.principal ? { principal: c.principal } : {}) })
  }

  /**
   * channels/open — host-owned subscription to a registered channel. After
   * this the server delivers that channel's ambient traffic as
   * channels/incoming instead of only addressed pushes. Returns any history
   * the server handed back with the open (oldest first).
   */
  async openChannel(ref: string, historyLimit = 0, opts: { byId?: boolean } = {}): Promise<{ channelId: string; label: string; history: IncomingChannelMessage[]; truncated: boolean; open: boolean }> {
    const conn = this.liveConn()
    if (!granted(this.grant, 'channels.lifecycle')) throw new Error(`${this.id}: channels.lifecycle not granted (add it to the server's grant; the server must advertise it too)`)
    // The host's own opens (reconcile, config) name a registered id: never
    // route those through label resolution, where an id that also reads as
    // another channel's label is (rightly) ambiguous.
    if (opts.byId && !this.channels.has(ref)) throw new Error(`${this.id}: channel ${ref} is not registered`)
    const channelId = opts.byId ? ref : this.resolveChannel(ref)
    const desc = this.channels.get(channelId)!
    const params: ChannelsOpenParams = {
      channelId,
      type: desc.type,
      address: desc.address ?? {},
      ...(historyLimit > 0 ? { history: { limit: historyLimit } } : {}),
    }
    // Intent first, mirroring closeChannel: a transport drop between the
    // request and its answer must not lose the open — the next reconcile
    // re-sends it. The in-flight set stops a second addressed push from
    // opening the same channel twice.
    this.desiredOpen.add(channelId)
    this.opening.add(channelId)
    let r: ChannelsOpenResult
    try {
      r = (await conn.sendRequest('channels/open', params)) as ChannelsOpenResult
    } finally {
      this.opening.delete(channelId)
    }
    if (!this.desiredOpen.has(channelId)) {
      // mcpl_close landed while the open was in flight: the explicit close
      // wins. The server now has it open, so close it there too.
      void conn.sendRequest('channels/close', { channelId }).catch(() => {})
      return { channelId, label: this.labelOf(channelId), history: [], truncated: false, open: false }
    }
    this.openChannels.add(channelId)
    return { channelId, label: this.labelOf(channelId), history: r?.history ?? [], truncated: r?.historyTruncated === true, open: true }
  }

  /**
   * The registered channel a push/event's origin names: its MCPL id when the
   * producer set `mcplChannelId`, else its native `channelId` mapped through
   * the descriptors' `address.channelId` (discord-mcpl's reconnect sweep,
   * edits, deletes and reactions carry only the native id), else a native id
   * that happens to be a registered id. '' when nothing maps.
   */
  private channelFromOrigin(mcplId: string, native: string): string {
    if (mcplId && this.channels.has(mcplId)) return mcplId
    if (!native) return ''
    if (this.channels.has(native)) return native
    for (const d of this.channels.values()) {
      const addr = d.address as { channelId?: unknown } | undefined
      if (addr && typeof addr === 'object' && String(addr.channelId ?? '') === native) return d.id
    }
    return ''
  }

  async closeChannel(ref: string): Promise<{ channelId: string; label: string; closed: boolean }> {
    const conn = this.liveConn()
    if (!granted(this.grant, 'channels.lifecycle')) throw new Error(`${this.id}: channels.lifecycle not granted`)
    // An id we no longer know (channel removed) may still sit in desiredOpen;
    // closing it clears that intent. Only when nothing registered answers to
    // the reference, though: a current channel's label always wins over a
    // stale id that happens to read the same.
    let channelId: string
    try {
      channelId = this.resolveChannel(ref)
    } catch (e) {
      const stale = ref.trim().replace(/^id:/, '')
      if (!(e instanceof ChannelRefError && e.kind === 'unknown' && this.desiredOpen.has(stale))) throw e
      channelId = stale
    }
    // Forget the intent first: a close that fails on the wire must not be
    // silently undone by the next reconnect's reconcile.
    this.desiredOpen.delete(channelId)
    this.openChannels.delete(channelId)
    const r = (await conn.sendRequest('channels/close', { channelId })) as ChannelsCloseResult
    return { channelId, label: this.labelOf(channelId) || channelId, closed: r?.closed === true }
  }

  /**
   * Whitelist admission for one delivery; null when admitted, else why not.
   *  - A DM (chat:dm), when `dmAllowlist` is set: its channel id (registered
   *    or raw) or author id must be listed — the open set does not apply.
   *  - Otherwise, under `openChannelsOnly`: the delivery's channel must be
   *    registered and open (or meant to be). Fail closed on a channel id
   *    that maps to nothing, and on a DM that names no channel at all.
   *    Non-DM pushes with no channel (heartbeats) are not channel traffic.
   */
  refusal(d: { channelId: string; refs: string[]; isDm: boolean; authorId: string }): string | null {
    // `refs`: every id the delivery names its channel by — the MCPL id and
    // the producer's native id alike — so an allowlist entry in either form
    // matches.
    const named = d.refs.find(Boolean) ?? ''
    const allow = this.cfg.dmAllowlist
    if (d.isDm && allow) {
      const listed = [d.channelId, ...d.refs, d.authorId].some(x => x && allow.includes(x))
      return listed ? null : `DM ${d.channelId ? this.labelOf(d.channelId) || d.channelId : named || `from ${d.authorId || 'unknown author'}`} (not in dmAllowlist)`
    }
    if (this.cfg.openChannelsOnly !== true) return null
    if (!named && !d.channelId && !d.isDm) return null
    if (!d.channelId) return `${d.isDm ? 'DM in ' : ''}unregistered channel ${named || '(none named)'} (openChannelsOnly)`
    if (!this.isOpen(d.channelId)) return `${d.isDm ? 'DM in ' : ''}closed channel ${this.labelOf(d.channelId) || d.channelId} (openChannelsOnly)`
    return null
  }

  /** The live connection, or an error that says why there is none. */
  private liveConn(): McplConnection {
    const conn = this.conn
    if (conn && !conn.isClosed) return conn
    if (this.paused) throw new Error(`${this.id}: disabled (mcpl_enable starts it)`)
    throw new Error(`${this.id}: not connected (${this.status}${this.lastError ? `: ${this.lastError}` : ''})`)
  }

  /** Open, or meant to be: live-open this epoch, or in the desired-open set
   *  (config `openChannels` + mcpl_open) awaiting reconcile. */
  private isOpen(channelId: string): boolean {
    return this.openChannels.has(channelId) || this.desiredOpen.has(channelId)
  }

  /** Display labels for the registered set, recomputed when it changes (see channel-labels.ts). */
  private get labelView(): LabelView {
    if (!this.labelCache || this.labelCache.version !== this.channels.version) {
      const view = buildLabelView(this.channels, this.shownLabels)
      for (const [id, l] of view.labels) {
        if (l.startsWith('id:')) continue // the escape needs no memory
        let seen = this.shownLabels.get(id)
        if (!seen) this.shownLabels.set(id, (seen = new Set()))
        seen.add(norm(l))
      }
      this.labelCache = { version: this.channels.version, view }
    }
    return this.labelCache.view
  }

  /** The display label for a channel id — the form mcpl_send/open/close accept back ('' when unknown). */
  labelOf(channelId: string): string {
    return this.labelView.labels.get(channelId) ?? ''
  }

  /**
   * Resolve a channel reference to a registered id: `id:<id>`, or anything
   * exactly one channel answers to — its display label (case-insensitive,
   * leading `#` optional), that label minus a trailing ` (qualifier)`, or its
   * id. More than one is an error naming each; never a guess.
   */
  resolveChannel(ref: string): string {
    return resolveChannelRef(ref, this.channels, this.labelView, this.id)
  }

  /** Re-open desired channels after a (re)registration; failures are logged, not fatal. */
  private async reconcileOpen(ids: string[], myEpoch: number): Promise<void> {
    for (const cid of ids) {
      if (myEpoch !== this.epoch) return
      if (this.openChannels.has(cid)) continue
      if (!granted(this.grant, 'channels.lifecycle')) {
        this.log(`cannot open ${cid}: channels.lifecycle not granted`)
        return
      }
      try {
        const r = await this.openChannel(cid, 0, { byId: true })
        if (r.open) this.log(`opened ${cid}`)
      } catch (e) {
        this.log(`open ${cid} failed: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  answerInference(requestId: string, content: string): boolean {
    const pending = this.pendingInference.get(requestId)
    if (!pending) return false
    pending.resolve({ content, model: 'claude-code', finishReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } })
    return true
  }

  get pendingInferenceIds(): string[] {
    return [...this.pendingInference.keys()]
  }

  private async onManifestChanged(conn: McplConnection): Promise<void> {
    // Rate-limit re-fetches; the announced revision/domains carry no authority.
    const now = Date.now()
    if (now - this.manifestFetchAt < 2000) return
    this.manifestFetchAt = now
    const manifest = (await conn.sendRequest('mcpl/manifest', {})) as Record<string, unknown>
    let revision: string | null = null
    try {
      revision = manifestDigest(manifest)
      const announced = (manifest as { revision?: string }).revision
      if (announced && announced !== revision) this.log(`manifest revision mismatch (announced ${announced}, computed ${revision}) — conformance defect, acting on content`)
    } catch {}
    this.manifestRevision = revision

    const advertised = advertisedCapabilitiesFromInitialize({ tools: {}, experimental: { mcpl: manifest as never } })
    const newGrant = computeGrant(advertised, this.policy)
    const removedPaths = this.grant.filter(g => !newGrant.includes(g))
    // Reduction applies atomically first, then tell (§6.7).
    this.grant = newGrant
    // RFC-015 §4.5: a revoked access.token takes effect at once; nothing cached outlives it here.
    if (removedPaths.includes('access.token')) this.accessCache.clear()
    const declared = normalizeFeatureSets((manifest as { featureSets?: unknown }).featureSets as never)
    const derivation = deriveFeatureSets(declared, this.grant)
    const wanted = this.cfg.enableFeatureSets ?? ['*']
    this.featureSetsEnabled = derivation.enabled.filter(name =>
      wanted.some(w => w === '*' || w === name || (w.endsWith('.*') && name.startsWith(w.slice(0, -1)))),
    )
    try {
      await conn.sendRequest('featureSets/update', {
        effectiveCapabilities: [...this.grant],
        enabled: this.featureSetsEnabled,
      })
    } catch (e) {
      this.log(`featureSets/update after manifest change failed: ${e instanceof Error ? e.message : e}`)
    }
    if (removedPaths.length) this.log(`manifest change revoked: [${removedPaths.join(', ')}]`)
    // RFC-014 §5.1: toolset declarations live in the manifest (its `toolsets` domain).
    if (this.presence.active) {
      const before = this.presence.view()
      const notes: string[] = []
      if ((manifest as { toolHints?: unknown }).toolHints !== true) {
        // r5 §5.1: hint-less from then on — every tool static, its dynamic presentation withdrawn.
        this.presence.deactivate()
        notes.push(`[${this.id}] no longer sends tool hints: its tools are in your tool list as ${this.prefix}__<tool>.`)
        this.log('the server withdrew toolHints — treated as hint-less')
      } else this.presence.setManifest(manifest)
      const cs = this.presence.diff(before, this.presence.view())
      cs.notes.push(...notes)
      this.deliverChange(cs)
    }
    await this.refreshTools(conn)
  }

  // ── Host → Server surface ──

  /**
   * tools/call. `instance` rides in `_meta["mcpl/instance"]` (RFC-014 §5.5).
   * The result's `mcpl/hints` is applied and the change appended after the
   * server's content (a call reports its own consequences, §6.2).
   */
  async callTool(name: string, args: unknown, opts: { instance?: string } = {}): Promise<unknown> {
    const conn = this.liveConn()
    const result = await conn.sendRequest('tools/call', { name, arguments: args ?? {}, ...(opts.instance ? { _meta: { 'mcpl/instance': opts.instance } } : {}) }, REQUEST_TIMEOUTS.call)
    return this.withChange(conn, result)
  }

  async publish(ref: string, text: string): Promise<unknown> {
    const conn = this.liveConn()
    if (!granted(this.grant, 'channels.publish')) throw new Error(`${this.id}: channels.publish not granted`)
    const channelId = this.resolveChannel(ref)
    return conn.sendRequest('channels/publish', {
      conversationId: 'claude-code',
      channelId,
      content: [textContent(text)],
    })
  }

  /**
   * §10.1 context hook fan-out. Still called for inject-only servers, with
   * userMessage: null. Injections are authorized per-position against the
   * grant current at response-receipt. 5s timeout, fail-open.
   */
  async beforeInference(userMessage: string, inferenceId: string, conversationId: string, turnIndex: number): Promise<ContextInjection[]> {
    const conn = this.conn
    if (!conn || conn.isClosed) return []
    const observe = granted(this.grant, 'contextHooks.beforeInference.observe')
    const canInject = (['system', 'beforeUser', 'afterUser'] as const).some(p =>
      granted(this.grant, `contextHooks.beforeInference.inject.${p}`),
    )
    if (!observe && !canInject) return []
    const params: ContextBeforeInferenceParams = {
      inferenceId,
      conversationId,
      turnIndex,
      userMessage: observe ? userMessage : null,
      model: { id: 'claude-code', vendor: 'anthropic', contextWindow: 200_000, capabilities: ['tools'] },
    }
    let result: ContextBeforeInferenceResult
    try {
      result = (await conn.sendRequest('context/beforeInference', params, 5000)) as ContextBeforeInferenceResult
    } catch {
      return [] // fail-open
    }
    return (result?.contextInjections ?? []).filter(inj => {
      const ok =
        inj &&
        (inj.position === 'system' || inj.position === 'beforeUser' || inj.position === 'afterUser') &&
        granted(this.grant, `contextHooks.beforeInference.inject.${inj.position}`)
      if (!ok && inj) this.log(`dropped injection at ${String((inj as { position?: string }).position)} — not granted`)
      return ok
    })
  }

  lifecycle(params: InferenceLifecycleParams): void {
    const conn = this.conn
    if (!conn || conn.isClosed) return
    if (!granted(this.grant, 'inferenceLifecycle')) return
    try {
      conn.sendNotification('inference/lifecycle', params)
    } catch {}
  }
}

const STDERR_TAIL_LINES = 20

/**
 * Wait for a child that teardown already signalled (SIGTERM) to exit; SIGKILL
 * it after `graceMs`. A respawn must not start beside the old process — it
 * may still hold a port, a lock, or a store the new one needs.
 */
async function reap(child: ChildProcess | null, graceMs = 3000): Promise<void> {
  // pid undefined: the spawn itself failed — there is no process to wait for.
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<'exited'>(r => child.once('exit', () => r('exited')))
  const after = (ms: number) => new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms).unref?.())
  if ((await Promise.race([exited, after(graceMs)])) === 'exited') return
  try {
    child.kill('SIGKILL')
  } catch {}
  await Promise.race([exited, after(1000)])
}

function normalizeFeatureSets(
  raw: Record<string, FeatureSetDeclaration> | boolean | Array<FeatureSetDeclaration & { name: string }> | undefined | null,
): Record<string, FeatureSetDeclaration> {
  if (raw == null || typeof raw === 'boolean') return {}
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter(fs => fs && typeof fs.name === 'string').map(fs => [fs.name, fs] as const))
  return raw
}
