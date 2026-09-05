#!/usr/bin/env bun
/**
 * Toy MCPL server (stdio, NDJSON JSON-RPC, zero deps) for exercising the bridge.
 *
 * 0.5 discipline: does nothing privileged until the host's initial
 * featureSets/update arrives as a Request; then registers a channel, sends a
 * channels/incoming hello, a push/event, and (TOY_INFERENCE=1) an
 * inference/request. Answers context/beforeInference with a marker injection.
 */
type Json = Record<string, unknown>

let seq = 100
const pending = new Map<number, (result: unknown, error?: { code: number; message: string }) => void>()

function send(msg: Json) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function respond(id: unknown, result: unknown) {
  send({ jsonrpc: '2.0', id, result })
}
function respondError(id: unknown, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}
function request(method: string, params: Json): Promise<unknown> {
  const id = ++seq
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, (result, error) => (error ? reject(new Error(`${method}: ${error.code} ${error.message}`)) : resolve(result)))
  })
}
const log = (s: string) => process.stderr.write(`toy: ${s}\n`)

const MCPL_CAPS = {
  version: '0.5',
  pushEvents: true,
  inferenceRequest: true,
  inferenceLifecycle: true,
  channels: { register: true, lifecycle: true, incoming: true, publish: true },
  contextHooks: { beforeInference: { observe: true, inject: { beforeUser: true, system: true } } },
  featureSets: {
    toy: {
      description: 'Toy feature set exercising every bridged surface',
      uses: [
        'pushEvents',
        'inferenceRequest',
        'inferenceLifecycle',
        'channels.register',
        'channels.lifecycle',
        'channels.incoming',
        'channels.publish',
        'contextHooks.beforeInference.observe',
        'contextHooks.beforeInference.inject.beforeUser',
      ],
    },
  },
}

let policyReady = false
let demoStarted = false
const openChannels = new Set<string>()

async function startDemo() {
  if (demoStarted || !policyReady) return
  demoStarted = true
  try {
    const reg = (await request('channels/register', {
      channels: [
        { id: 'toy:lobby', type: 'chat', label: 'Toy Lobby', direction: 'bidirectional' },
        // initiallyOpen: the bridge should channels/open this one on its own.
        { id: 'toy:auto', type: 'chat', label: 'Toy Auto', direction: 'bidirectional', initiallyOpen: true },
      ],
    })) as { results?: Array<{ id: string; accepted: boolean }> }
    log(`register: ${JSON.stringify(reg?.results)}`)
    if (!reg?.results?.some(r => r.id === 'toy:lobby' && r.accepted)) return

    setTimeout(() => {
      void request('channels/incoming', {
        messages: [
          {
            channelId: 'toy:lobby',
            messageId: 'toy-m1',
            author: { id: 'u1', name: 'toybot' },
            timestamp: new Date().toISOString(),
            content: [{ type: 'text', text: 'hello from the toy lobby' }],
            tags: ['chat:mention'],
          },
        ],
      }).then(r => log(`incoming result: ${JSON.stringify(r)}`))
    }, 500)

    setTimeout(() => {
      void request('push/event', {
        featureSet: 'toy',
        eventId: 'evt-1',
        timestamp: new Date().toISOString(),
        payload: { content: [{ type: 'text', text: 'toy push event fired' }] },
        tags: ['toy:heartbeat'],
      }).then(r => log(`push result: ${JSON.stringify(r)}`))
    }, 900)

    if (process.env.TOY_INFERENCE === '1') {
      setTimeout(() => {
        void request('inference/request', {
          featureSet: 'toy',
          messages: [{ role: 'user', content: 'Say the word "marble".' }],
        }).then(
          r => log(`inference answered: ${JSON.stringify(r)}`),
          e => log(`inference failed: ${e.message}`),
        )
      }, 1300)
    }
  } catch (e) {
    log(`demo failed: ${e instanceof Error ? e.message : e}`)
  }
}

function handle(msg: Json) {
  // Response to one of our requests?
  if ('id' in msg && !('method' in msg)) {
    const cb = pending.get(msg.id as number)
    if (cb) {
      pending.delete(msg.id as number)
      cb(msg.result, msg.error as never)
    }
    return
  }
  const method = msg.method as string
  const id = 'id' in msg ? msg.id : null
  const params = (msg.params ?? {}) as Json

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, experimental: { mcpl: MCPL_CAPS } },
        serverInfo: { name: 'toy-mcpl', version: '0.1.0' },
      })
      return
    case 'notifications/initialized':
      return
    case 'featureSets/update': {
      const eff = (params.effectiveCapabilities as string[]) ?? []
      const enabled = (params.enabled as string[]) ?? []
      log(`policy: enabled=[${enabled.join(',')}] grant=[${eff.join(',')}]`)
      if (id != null) respond(id, { accepted: true })
      policyReady = enabled.includes('toy')
      if (policyReady) void startDemo()
      return
    }
    case 'tools/list':
      respond(id, {
        tools: [
          {
            name: 'ping',
            description: 'Replies pong (toy MCPL tool).',
            inputSchema: { type: 'object', properties: { echo: { type: 'string' } } },
          },
        ],
      })
      return
    case 'tools/call': {
      const name = params.name as string
      if (name === 'ping') {
        const echo = (params.arguments as Json | undefined)?.echo
        respond(id, { content: [{ type: 'text', text: `pong${echo ? ` ${echo}` : ''}` }] })
      } else respondError(id, -32602, `unknown tool ${name}`)
      return
    }
    case 'context/beforeInference': {
      const userMessage = params.userMessage
      log(`beforeInference: userMessage=${JSON.stringify(userMessage).slice(0, 80)}`)
      respond(id, {
        featureSet: 'toy',
        contextInjections: [
          { namespace: 'toy', position: 'beforeUser', content: 'TOY-CONTEXT: the toy server says hi' },
          // Should be DROPPED by the bridge unless inject.afterUser is granted:
          { namespace: 'toy', position: 'afterUser', content: 'TOY-UNGRANTED: this must not appear' },
        ],
      })
      return
    }
    case 'channels/open': {
      const channelId = String(params.channelId)
      const limit = ((params.history as Json | undefined)?.limit as number | undefined) ?? 0
      log(`open ${channelId} (history ${limit})`)
      openChannels.add(channelId)
      respond(id, {
        channel: { id: channelId, type: 'chat', label: channelId === 'toy:auto' ? 'Toy Auto' : 'Toy Lobby', direction: 'bidirectional' },
        ...(limit > 0
          ? {
              history: [
                {
                  channelId,
                  messageId: 'toy-h1',
                  author: { id: 'u1', name: 'toybot' },
                  timestamp: new Date(0).toISOString(),
                  content: [{ type: 'text', text: 'earlier lobby chatter' }],
                },
              ],
            }
          : {}),
      })
      return
    }
    case 'channels/close': {
      const channelId = String(params.channelId)
      log(`close ${channelId}`)
      respond(id, { closed: openChannels.delete(channelId) })
      return
    }
    case 'channels/publish': {
      log(`publish to ${params.channelId}: ${JSON.stringify(params.content).slice(0, 120)}`)
      respond(id, { delivered: true, messageId: `toy-pub-${++seq}` })
      return
    }
    case 'inference/lifecycle':
      log(`lifecycle: ${params.phase} ${params.inferenceId}`)
      return
    default:
      if (id != null) respondError(id, -32601, `toy server does not implement ${method}`)
  }
}

let buf = ''
process.stdin.on('data', (d: Buffer) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (e) {
      log(`bad line: ${e instanceof Error ? e.message : e}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
log('toy MCPL server up')
