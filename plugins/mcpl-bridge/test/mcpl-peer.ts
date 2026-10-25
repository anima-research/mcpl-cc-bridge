/**
 * An in-process MCPL server on a loopback WebSocket, for tests that need to
 * play the server side against a real McplServerHandle (or the whole
 * adapter): answers the handshake, records each upgrade URL (where a dial
 * credential arrives), and lets the test send Server → Host requests such
 * as RFC-015 `access/token`.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'http'

type Json = Record<string, unknown>
export type RpcAnswer = { result?: unknown; error?: { code: number; message: string; data?: unknown } }

export type PeerOptions = {
  /** experimental.mcpl advertised in the initialize result. */
  mcpl?: Json
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
  onToolCall?(name: string, args: unknown): unknown
  /** Decide an upgrade (return an HTTP status to refuse it). */
  verifyUpgrade?(url: URL): true | number
  /** tools/list result `_meta["mcpl/rev"]` (RFC-014). */
  listRev?: number
  /** Answers for other host → server methods (toolsets/list, …). */
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>
}

export class McplPeer {
  readonly upgrades: URL[] = []
  /** Host initialize params, per connection, newest last. */
  readonly inits: Json[] = []
  /** featureSets/update params, newest last. */
  readonly policies: Json[] = []
  /** Every host → server request method, in order. */
  readonly received: string[] = []
  private sockets: WebSocket[] = []
  private seq = 1000
  private pending = new Map<number, (a: RpcAnswer) => void>()
  private policyWaiters: Array<() => void> = []

  private constructor(
    private wss: WebSocketServer,
    readonly port: number,
    private opts: PeerOptions,
  ) {}

  static start(opts: PeerOptions = {}): Promise<McplPeer> {
    return new Promise((resolve, reject) => {
      let peer: McplPeer
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        verifyClient: (info: { req: IncomingMessage }, cb: (ok: boolean, code?: number) => void) => {
          const url = new URL(info.req.url ?? '/', 'ws://127.0.0.1')
          peer.upgrades.push(url)
          const v = opts.verifyUpgrade ? opts.verifyUpgrade(url) : true
          v === true ? cb(true) : cb(false, v)
        },
      })
      wss.on('error', reject)
      wss.on('listening', () => {
        peer = new McplPeer(wss, (wss.address() as { port: number }).port, opts)
        wss.on('connection', ws => peer.attach(ws))
        resolve(peer)
      })
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/mcpl`
  }

  get connections(): number {
    return this.sockets.filter(s => s.readyState === 1).length
  }

  /** The token that came with the n-th upgrade (default: the latest). */
  token(n = this.upgrades.length - 1): string | null {
    return this.upgrades[n]?.searchParams.get('token') ?? null
  }

  private attach(ws: WebSocket): void {
    this.sockets.push(ws)
    ws.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) continue
        this.handle(ws, JSON.parse(line) as Json)
      }
    })
  }

  private send(ws: WebSocket, msg: Json): void {
    if (ws.readyState === 1) ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }))
  }

  private handle(ws: WebSocket, msg: Json): void {
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const done = this.pending.get(msg.id as number)
      this.pending.delete(msg.id as number)
      done?.({ result: msg.result, error: msg.error as RpcAnswer['error'] })
      return
    }
    const id = msg.id
    const params = (msg.params ?? {}) as Json
    if (id != null) this.received.push(String(msg.method))
    const custom = this.opts.handlers?.[String(msg.method)]
    if (custom) {
      this.send(ws, { id, result: custom(params) })
      return
    }
    switch (msg.method) {
      case 'initialize':
        this.inits.push(params)
        this.send(ws, {
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, ...(this.opts.mcpl ? { experimental: { mcpl: this.opts.mcpl } } : {}) },
            serverInfo: { name: 'mcpl-peer', version: '0.0.0' },
          },
        })
        return
      case 'featureSets/update':
        this.policies.push(params)
        if (id != null) this.send(ws, { id, result: { accepted: true } })
        for (const w of this.policyWaiters.splice(0)) w()
        return
      case 'mcpl/manifest':
        this.send(ws, { id, result: this.opts.mcpl ?? {} })
        return
      case 'tools/list':
        this.send(ws, { id, result: { tools: this.opts.tools ?? [], ...(this.opts.listRev !== undefined ? { _meta: { 'mcpl/rev': this.opts.listRev } } : {}) } })
        return
      case 'tools/call': {
        const r = this.opts.onToolCall?.(String(params.name), params.arguments) ?? { content: [{ type: 'text', text: 'ok' }] }
        this.send(ws, { id, result: r })
        return
      }
      default:
        if (id != null) this.send(ws, { id, error: { code: -32601, message: `peer: no ${String(msg.method)}` } })
    }
  }

  /** Resolves once `count` featureSets/update requests have arrived in total. */
  async policyCount(count: number, timeoutMs = 5000): Promise<Json> {
    const deadline = Date.now() + timeoutMs
    while (this.policies.length < count) {
      if (Date.now() > deadline) throw new Error(`peer: no policy #${count} within ${timeoutMs}ms`)
      await new Promise<void>(r => {
        this.policyWaiters.push(r)
        setTimeout(r, 50)
      })
    }
    return this.policies[count - 1]!
  }

  /** A Server → Host request on the newest live connection. */
  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<RpcAnswer> {
    const ws = [...this.sockets].reverse().find(s => s.readyState === 1)
    if (!ws) return Promise.reject(new Error('peer: no live connection'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`peer: ${method} unanswered after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, a => {
        clearTimeout(t)
        resolve(a)
      })
      this.send(ws, { id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params: unknown): void {
    const ws = [...this.sockets].reverse().find(s => s.readyState === 1)
    if (ws) this.send(ws, { method, params })
  }

  /** Change the advertised manifest and tell the host (mcpl/manifestChanged); it re-fetches and re-grants. */
  changeManifest(mcpl: Json): void {
    this.opts.mcpl = mcpl
    this.notify('mcpl/manifestChanged', {})
  }

  /** Drop every connection from the server side (the host should redial). */
  dropAll(): void {
    for (const s of this.sockets) s.terminate()
  }

  close(): Promise<void> {
    this.dropAll()
    // Under bun the http server's close callback can wait on sockets it already
    // let go of; nothing listens after this, so don't hang a test on it.
    return new Promise(r => {
      this.wss.close(() => r())
      setTimeout(r, 200)
    })
  }
}
