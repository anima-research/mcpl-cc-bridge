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

  status: 'connecting' | 'ready' | 'mcp-only' | 'disconnected' | 'closed' = 'disconnected'
  tools: McplTool[] = []
  channels = new Map<string, ChannelDescriptor>()
  /** Channels currently open on the live connection (channels/open succeeded this epoch). */
  openChannels = new Set<string>()
  /** Desired-open state: config `openChannels` plus mcpl_open/mcpl_close during the session.
   *  Survives reconnects — reconciled against each channels/register. */
  private desiredOpen: Set<string>
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
  private closedByUs = false
  private backoffMs: number
  private readonly cb: HostCallbacks
  private pendingInference = new Map<string, PendingInference>()
  private manifestFetchAt = 0
  private isMcpl = false

  constructor(id: string, cfg: ServerConfig, cb: HostCallbacks) {
    this.id = id
    this.cfg = cfg
    this.prefix = cfg.toolPrefix ?? id
    this.cb = cb
    this.policy = cfg.grant ?? DEFAULT_GRANT
    this.desiredOpen = new Set(cfg.openChannels ?? [])
    this.backoffMs = cfg.reconnectIntervalMs ?? 5000
    this.firstAttempt = new Promise<void>(r => (this.firstAttemptResolve = r))
  }

  private get reconnectEnabled(): boolean {
    return this.cfg.reconnect ?? isWs(this.cfg.transport)
  }

  private log(line: string) {
    this.cb.log(`[${this.id}] ${line}`)
  }

  /** Non-blocking: failures schedule reconnect instead of throwing. */
  start(): void {
    void this.connectOnce()
  }

  close(): void {
    this.closedByUs = true
    this.teardown('closed')
  }

  private teardown(status: 'disconnected' | 'closed'): void {
    this.epoch++ // invalidate any in-flight handshake/loop
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
    if (this.closedByUs || !this.reconnectEnabled) return
    const max = this.cfg.reconnectMaxIntervalMs ?? 300_000
    const jitter = 0.75 + Math.random() * 0.5 // ±25%
    const delay = Math.min(this.backoffMs, max) * jitter
    this.backoffMs = Math.min(this.backoffMs * 2, max)
    this.log(`reconnect in ${Math.round(delay / 1000)}s`)
    setTimeout(() => void this.connectOnce(), delay)
  }

  private async dial(): Promise<McplConnection> {
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
      return McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0])
    }
    const t = this.cfg.transport as StdioTransportConfig
    const child = spawn(t.command, t.args ?? [], {
      cwd: t.cwd,
      env: { ...process.env, ...t.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr?.on('data', (d: Buffer) => this.log(`stderr: ${d.toString().trimEnd()}`))
    this.child = child
    return McplConnection.fromStreams(child.stdout!, child.stdin!)
  }

  private async connectOnce(): Promise<void> {
    try {
      await this.connectOnceInner()
    } finally {
      this.firstAttemptResolve()
    }
  }

  private async connectOnceInner(): Promise<void> {
    if (this.closedByUs) return
    const myEpoch = ++this.epoch
    this.status = 'connecting'
    let conn: McplConnection
    try {
      conn = await this.dial()
    } catch (e) {
      this.log(`connect failed: ${e instanceof Error ? e.message : e}`)
      this.status = 'disconnected'
      this.scheduleReconnect()
      return
    }
    if (myEpoch !== this.epoch) {
      conn.close()
      return
    }
    this.conn = conn
    conn.on('error', err => this.log(`conn error: ${err.message}`))
    conn.on('close', () => {
      if (myEpoch !== this.epoch) return
      this.log('connection closed')
      this.teardown('disconnected')
      this.scheduleReconnect()
    })

    try {
      await this.handshake(conn, myEpoch)
    } catch (e) {
      this.log(`handshake failed: ${e instanceof Error ? e.message : e}`)
      if (myEpoch === this.epoch) {
        this.teardown('disconnected')
        this.scheduleReconnect()
      }
      return
    }
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
    try {
      const r = (await conn.sendRequest('tools/list', {})) as { tools?: McplTool[] }
      this.tools = r?.tools ?? []
    } catch (e) {
      this.tools = []
      this.log(`tools/list failed: ${e instanceof Error ? e.message : e}`)
    }
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
        this.cb.deliver({
          server: this.id,
          kind: 'push-event',
          text: renderContent(p.payload?.content),
          meta: {
            event_id: String(p.eventId ?? ''),
            feature_set: String(p.featureSet ?? ''),
            ts: String(p.timestamp ?? ''),
            channel_id: mcplChannel || s(o.channelId),
            native_channel_id: mcplChannel ? s(o.channelId) : '',
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
          .filter(cid => this.desiredOpen.has(cid) || (this.cfg.openChannels === undefined && this.channels.get(cid)?.initiallyOpen === true))
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
          this.cb.deliver({
            server: this.id,
            kind: 'channel-message',
            text: renderContent(m.content),
            meta: {
              channel_id: m.channelId,
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
  async openChannel(channelId: string, historyLimit = 0): Promise<{ history: IncomingChannelMessage[]; truncated: boolean }> {
    const conn = this.conn
    if (!conn || conn.isClosed) throw new Error(`${this.id}: not connected`)
    if (!granted(this.grant, 'channels.lifecycle')) throw new Error(`${this.id}: channels.lifecycle not granted (add it to the server's grant; the server must advertise it too)`)
    const desc = this.channels.get(channelId)
    if (!desc) throw new Error(`${this.id}: unknown channel ${channelId} (known: ${[...this.channels.keys()].join(', ') || 'none'})`)
    const params: ChannelsOpenParams = {
      channelId,
      type: desc.type,
      address: desc.address ?? {},
      ...(historyLimit > 0 ? { history: { limit: historyLimit } } : {}),
    }
    const r = (await conn.sendRequest('channels/open', params)) as ChannelsOpenResult
    this.openChannels.add(channelId)
    this.desiredOpen.add(channelId)
    return { history: r?.history ?? [], truncated: r?.historyTruncated === true }
  }

  async closeChannel(channelId: string): Promise<boolean> {
    const conn = this.conn
    if (!conn || conn.isClosed) throw new Error(`${this.id}: not connected`)
    if (!granted(this.grant, 'channels.lifecycle')) throw new Error(`${this.id}: channels.lifecycle not granted`)
    // Forget the intent first: a close that fails on the wire must not be
    // silently undone by the next reconnect's reconcile.
    this.desiredOpen.delete(channelId)
    this.openChannels.delete(channelId)
    const r = (await conn.sendRequest('channels/close', { channelId })) as ChannelsCloseResult
    return r?.closed === true
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
        await this.openChannel(cid)
        this.log(`opened ${cid}`)
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
    const conn = this.conn
    if (!conn || conn.isClosed) throw new Error(`${this.id}: not connected`)
    return conn.sendRequest('tools/call', { name, arguments: args ?? {} }, 120_000)
  }

  async publish(channelId: string, text: string): Promise<unknown> {
    const conn = this.conn
    if (!conn || conn.isClosed) throw new Error(`${this.id}: not connected`)
    if (!granted(this.grant, 'channels.publish')) throw new Error(`${this.id}: channels.publish not granted`)
    if (!this.channels.has(channelId)) throw new Error(`${this.id}: unknown channel ${channelId} (known: ${[...this.channels.keys()].join(', ') || 'none'})`)
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

function normalizeFeatureSets(
  raw: Record<string, FeatureSetDeclaration> | boolean | Array<FeatureSetDeclaration & { name: string }> | undefined | null,
): Record<string, FeatureSetDeclaration> {
  if (raw == null || typeof raw === 'boolean') return {}
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter(fs => fs && typeof fs.name === 'string').map(fs => [fs.name, fs] as const))
  return raw
}
