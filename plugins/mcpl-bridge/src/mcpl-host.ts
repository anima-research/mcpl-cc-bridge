/**
 * McplServerHandle — a standalone MCPL host connection for one server.
 *
 * Implements the host duties mcpl-core leaves open: stdio spawn / WS dial,
 * reconnect with jittered backoff and grant reset at every transport epoch,
 * grant computation (advertised ∩ policy), mandatory initial featureSets/update
 * as a Request, inbound method→capability enforcement, dual-shape featureSets
 * normalization, per-descriptor channel authorization, manifest re-fetch on
 * mcpl/manifestChanged, and answer-or-error discipline on every inbound id.
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
//   Re-sync: cp <mcpl-core-ts>/src/*.ts src/vendor/mcpl-core/
import { ERR, computeGrant, expandTags, granted, methodCapability } from './grants'
import { DEFAULT_GRANT, isWs, resolveUrl, type ServerConfig, type StdioTransportConfig } from './config'

export type McplTool = { name: string; description?: string; inputSchema?: unknown }

export type IncomingDelivery = {
  server: string
  kind: 'channel-message' | 'push-event' | 'inference-request'
  text: string
  meta: Record<string, string>
}

export type HostCallbacks = {
  deliver(msg: IncomingDelivery): void
  toolsChanged(): void
  log(line: string): void
}

type PendingInference = {
  resolve(result: { content: string; model: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } }): void
  reject(err: { code: number; message: string }): void
}

const HOST_MCPL_CAPS = {
  version: '0.5',
  pushEvents: true,
  inferenceRequest: true,
  inferenceLifecycle: true,
  modelInfo: true,
  contextHooks: { beforeInference: { observe: true, inject: { system: true, beforeUser: true, afterUser: true } } },
  channels: { register: true, lifecycle: true, publish: true, incoming: true, acknowledge: true },
  featureSets: true,
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

export class McplServerHandle {
  readonly id: string
  readonly cfg: ServerConfig
  readonly prefix: string
  /** Operator policy patterns; the effective grant is advertised ∩ this. */
  readonly policy: readonly string[]

  status: 'connecting' | 'ready' | 'mcp-only' | 'disconnected' | 'disabled' | 'closed' = 'disconnected'
  /** Why the latest connect attempt or connection failed; cleared by a good handshake. */
  lastError: string | null = null
  /** When the live connection finished its handshake (ms since epoch); null when not connected. */
  connectedAt: number | null = null
  /** The last lines a stdio server wrote to stderr since it was spawned — what
   *  a hot reload that died on startup needs to show. */
  stderrTail: string[] = []
  tools: McplTool[] = []
  channels = new Map<string, ChannelDescriptor>()
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

  constructor(id: string, cfg: ServerConfig, cb: HostCallbacks, opts: { disabled?: boolean } = {}) {
    this.id = id
    this.cfg = cfg
    this.prefix = cfg.toolPrefix ?? id
    this.cb = cb
    this.policy = cfg.grant ?? DEFAULT_GRANT
    this.desiredOpen = new Set(cfg.openChannels ?? [])
    this.backoffMs = cfg.reconnectIntervalMs ?? 5000
    this.firstAttempt = new Promise<void>(r => (this.firstAttemptResolve = r))
    if (opts.disabled) {
      // Nothing will be attempted, so nothing should wait on an attempt.
      this.paused = true
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

  /** Stopped by disable() (or constructed disabled) and not since re-enabled. */
  get disabled(): boolean {
    return this.paused
  }

  /** The stdio server's process id; null for ws servers and when not running. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** The most recent connect attempt — resolves once it settles, either way (status / lastError say which). */
  get attempt(): Promise<void> {
    return this.latestAttempt
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

  /** Non-blocking: failures schedule reconnect instead of throwing. */
  start(): void {
    if (this.halted) {
      this.firstAttemptResolve()
      return
    }
    void this.connectOnce()
  }

  close(): void {
    this.retired = true
    this.teardown('closed')
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
    return this.serialize(async () => {
      if (this.halted) return
      this.paused = true
      const child = this.child
      this.teardown('disabled')
      await reap(child)
    })
  }

  /** Start a disabled server. Resolves when its connect attempt settles. */
  enable(): Promise<void> {
    return this.serialize(async () => {
      if (this.retired) throw new Error(`${this.id}: this handle was replaced; check mcpl_status`)
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
      if (this.paused) throw new Error(`${this.id}: disabled; mcpl_enable starts it`)
      const child = this.child
      this.teardown('disconnected')
      await reap(child)
      if (this.halted) return // closed while the old process wound down
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
    try {
      this.child?.kill()
    } catch {}
    this.child = null
    if (this.tools.length) {
      this.tools = []
      this.cb.toolsChanged()
    }
    this.status = status
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
      const { default: WebSocket } = await import('ws')
      const url = resolveUrl(this.cfg.transport) // credential resolved per-dial
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
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trimEnd()
      this.log(`stderr: ${s}`)
      for (const line of s.split('\n')) keep(line)
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
      try {
        child?.kill()
      } catch {}
      return
    }
    this.conn = conn
    this.child = child
    this.stderrTail = dialed.stderrTail
    this.childClosed = dialed.closed
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
    const initResult = (await conn.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, experimental: { mcpl: HOST_MCPL_CAPS } },
      clientInfo: { name: 'mcpl-cc-bridge', version: '0.1.0' },
    })) as McplInitializeResult
    if (myEpoch !== this.epoch) throw new Error('stale epoch')
    conn.sendNotification('notifications/initialized', {})

    const caps: InitializeCapabilities = initResult.capabilities ?? {}
    const mcpl = extractMcpl(caps)
    this.isMcpl = mcpl != null

    if (mcpl != null) {
      // §5.4: effective grant = advertised ∩ operator policy. tools comes only
      // from the OUTER capabilities — advertisedCapabilitiesFromInitialize handles that.
      const advertised = advertisedCapabilitiesFromInitialize(caps)
      this.grant = computeGrant(advertised, this.policy)

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
    this.log(`connected: ${this.status}, ${this.tools.length} tools, grant=[${this.grant.join(', ')}]`)
  }

  private async refreshTools(conn: McplConnection): Promise<void> {
    let tools: McplTool[] = []
    try {
      const r = (await conn.sendRequest('tools/list', {})) as { tools?: McplTool[] }
      tools = r?.tools ?? []
    } catch (e) {
      this.log(`tools/list failed: ${e instanceof Error ? e.message : e}`)
    }
    // A connection torn down while the list was in flight (restart, disable)
    // must not repopulate the tools of the one that replaced it.
    if (conn !== this.conn) return
    this.tools = tools
    this.cb.toolsChanged()
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
    const deny = (code: number, message: string) => {
      if (id != null) conn.sendError(id as never, code, message)
    }

    const cap = methodCapability(methodName)
    if (cap === undefined) {
      // A method that will never be answered MUST return an error (SPEC §4).
      deny(ERR.METHOD_NOT_FOUND, `method not supported by this host: ${methodName}`)
      return
    }
    if (cap !== null && !granted(this.grant, cap)) {
      deny(ERR.CAPABILITY_DENIED, `capability ${cap} not granted`)
      return
    }

    switch (methodName) {
      case 'notifications/tools/list_changed': {
        await this.refreshTools(conn)
        return
      }
      case 'push/event': {
        const p = params as PushEventParams
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
        // Whitelist mode: only a channel this host holds open is one this
        // session listens to — addressed or not, anything else is refused
        // (§6.6: a rejection is diagnostics for the server, nothing more).
        // Fail closed on a channel id that maps to nothing: an unregistered
        // room is not a whitelisted one.
        if (this.cfg.openChannelsOnly === true && (mcplChannel || native) && (!from || !this.isOpen(from))) {
          const why = from ? `closed channel ${this.labelOf(from) || from}` : `unregistered channel ${mcplChannel || native}`
          console.error(`${this.id}: dropped push from ${why} (openChannelsOnly)`)
          respond({ accepted: false, reason: `channel not open on this host (openChannelsOnly): ${why}` })
          return
        }
        this.cb.deliver({
          server: this.id,
          kind: 'push-event',
          text: renderContent(p.payload?.content),
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
        if (this.cfg.openOnAddressed !== false && tags.includes('chat:addressed') && addressedIn && !this.openChannels.has(addressedIn) && !this.opening.has(addressedIn)) {
          if (!granted(this.grant, 'channels.lifecycle')) {
            if (!this.warnedNoLifecycle) {
              this.warnedNoLifecycle = true
              console.error(`${this.id}: addressed in ${this.labelOf(addressedIn) || addressedIn} but cannot open it: channels.lifecycle not granted (openOnAddressed is inert)`)
            }
          } else {
            void this.openChannel(addressedIn).then(
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
          if (this.cfg.openChannelsOnly === true && !this.isOpen(m.channelId)) {
            console.error(`${this.id}: dropped incoming from closed channel ${this.labelOf(m.channelId) || m.channelId} (openChannelsOnly)`)
            return { messageId: m.messageId, accepted: false }
          }
          const tags = expandTags(m.tags)
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

  /**
   * channels/open — host-owned subscription to a registered channel. After
   * this the server delivers that channel's ambient traffic as
   * channels/incoming instead of only addressed pushes. Returns any history
   * the server handed back with the open (oldest first).
   */
  async openChannel(ref: string, historyLimit = 0): Promise<{ channelId: string; label: string; history: IncomingChannelMessage[]; truncated: boolean; open: boolean }> {
    const conn = this.liveConn()
    if (!granted(this.grant, 'channels.lifecycle')) throw new Error(`${this.id}: channels.lifecycle not granted (add it to the server's grant; the server must advertise it too)`)
    const channelId = this.resolveChannel(ref)
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
      return { channelId, label: desc.label, history: [], truncated: false, open: false }
    }
    this.openChannels.add(channelId)
    return { channelId, label: desc.label, history: r?.history ?? [], truncated: r?.historyTruncated === true, open: true }
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
    // An id we no longer know (channel removed) may still sit in desiredOpen —
    // let it through so the intent can be cleared; a label must resolve.
    const channelId = this.channels.has(ref) || this.desiredOpen.has(ref) ? ref : this.resolveChannel(ref)
    // Forget the intent first: a close that fails on the wire must not be
    // silently undone by the next reconnect's reconcile.
    this.desiredOpen.delete(channelId)
    this.openChannels.delete(channelId)
    const r = (await conn.sendRequest('channels/close', { channelId })) as ChannelsCloseResult
    return { channelId, label: this.labelOf(channelId) || channelId, closed: r?.closed === true }
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

  /** The registered label for a channel id ('' when unknown). */
  labelOf(channelId: string): string {
    return this.channels.get(channelId)?.label ?? ''
  }

  /**
   * Resolve a channel reference to a registered channel id. Accepts the exact
   * id, or the label as mcpl_channels / <channel channel="…"> print it —
   * display form == address form. Exact match after trimming, a leading `#`
   * optional, case-insensitive; a label's trailing ` (qualifier)` may be
   * omitted when the remainder is unique. NO fuzzy matching: a "did you mean"
   * would turn a mistyped room into a silent wrong-room delivery. Ambiguity is
   * an error that quotes label + id for each match, so the answer is pasteable.
   */
  resolveChannel(ref: string): string {
    const raw = ref.trim()
    if (this.channels.has(raw)) return raw
    const norm = (s: string) => s.trim().replace(/^#/, '').toLowerCase()
    const want = norm(raw)
    if (!want) throw new Error(`${this.id}: empty channel reference`)
    const unqualified = (label: string) => norm(label.replace(/\s*\([^()]*\)\s*$/, ''))
    let matches = [...this.channels.values()].filter(d => norm(d.label) === want)
    if (matches.length === 0) matches = [...this.channels.values()].filter(d => unqualified(d.label) === want)
    if (matches.length === 1) return matches[0].id
    if (matches.length === 0) {
      throw new Error(`${this.id}: unknown channel "${ref}" (${this.channels.size} registered — use mcpl_channels to list labels and ids)`)
    }
    const options = matches.map(d => `"${d.label}" (id ${d.id})`).join(', ')
    throw new Error(`${this.id}: "${ref}" is ambiguous — ${matches.length} channels match. Re-send with one of: ${options}`)
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
        const r = await this.openChannel(cid)
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
    await this.refreshTools(conn)
  }

  // ── Host → Server surface ──

  async callTool(name: string, args: unknown): Promise<unknown> {
    const conn = this.liveConn()
    return conn.sendRequest('tools/call', { name, arguments: args ?? {} }, 120_000)
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
