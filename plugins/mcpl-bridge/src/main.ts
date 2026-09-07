#!/usr/bin/env bun
/**
 * mcpl-bridge adapter: hosts MCPL servers from inside Claude Code.
 *
 * Three faces:
 *  1. MCP server (stdio, @modelcontextprotocol/sdk) — proxies MCPL tools as
 *     `<prefix>__<tool>`, plus bridge tools (status / send / answer).
 *  2. Channel provider (`claude/channel`) — push/event, channels/incoming and
 *     inference/request arrive as <channel source="mcpl" ...> messages.
 *  3. Hook endpoint — a unix socket at ~/.claude/mcpl-bridge/sock-<claude-pid>.sock;
 *     hooks/relay.ts forwards UserPromptSubmit (→ context/beforeInference fan-out,
 *     returned as additionalContext) and Stop/SessionEnd (→ inference/lifecycle).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadConfig } from './config'
import { McplServerHandle, type IncomingDelivery } from './mcpl-host'
import { WakeGate } from './wake'

import { appendFileSync } from 'fs'
const DEBUG_LOG = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'mcpl-bridge', 'debug.log')
try {
  mkdirSync(join(DEBUG_LOG, '..'), { recursive: true })
} catch {}
const log = (line: string) => {
  process.stderr.write(`mcpl-bridge: ${line}\n`)
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {}
}

const { config, path: configPathUsed } = loadConfig()
log(configPathUsed ? `config: ${configPathUsed}` : 'no config found — running with zero MCPL servers (create .mcpl-bridge.json)')

// ── MCP server face ──

const mcp = new Server(
  { name: 'mcpl', version: '0.1.0' },
  {
    capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
    instructions: [
      'This server bridges MCPL servers into this session.',
      'Messages from MCPL servers arrive as <channel source="mcpl" server="..." ...> blocks:',
      '- kind="channel-message" / kind="push-event": events from the MCPL server. To reply on a channel, call mcpl_send with that server and channel_id.',
      '- kind="inference-request": the MCPL server is asking for a completion. Compose the answer and call mcpl_answer with the request_id from the message. Do this promptly — the request is held open.',
      'A <held server="..." count="N"> block at the top of a message lists deliveries the wake policy held back since the last turn (e.g. a bot replying to you, ambient traffic) — context, not a separate ping; the same block reaches a user turn via the UserPromptSubmit hook.',
      'Proxied MCPL tools are named <server>__<tool>. mcpl_status shows connections, grants, channels, open channels, and held count. mcpl_open / mcpl_close subscribe to or leave a registered channel\'s ambient traffic (channels/open).',
    ].join('\n'),
  },
)

let deliverToSession: (msg: IncomingDelivery) => void = msg => {
  // Before the MCP transport is up, drop to stderr (channel messages are best-effort).
  log(`(early, dropped) ${msg.server}/${msg.kind}: ${msg.text.slice(0, 120)}`)
}

const handles = new Map<string, McplServerHandle>()
const gates = new Map<string, WakeGate>()
let toolsChangedTimer: ReturnType<typeof setTimeout> | null = null

for (const [id, serverCfg] of Object.entries(config.servers)) {
  const handle = new McplServerHandle(id, serverCfg, {
    deliver: msg => deliverToSession(msg),
    toolsChanged: () => {
      if (toolsChangedTimer) clearTimeout(toolsChangedTimer)
      toolsChangedTimer = setTimeout(() => {
        void mcp.notification({ method: 'notifications/tools/list_changed' }).catch(() => {})
      }, 100)
    },
    log,
  })
  handles.set(id, handle)
  gates.set(id, new WakeGate(serverCfg.wake))
}

const BRIDGE_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'mcpl_status',
    description: 'Show every bridged MCPL server: connection status, effective capability grant, enabled feature sets, registered channels, proxied tool count, pending inference requests.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcpl_send',
    description: 'Publish a message into a registered channel of a bridged MCPL server (channels/publish). Use the server id and channel_id from a received <channel> message or from mcpl_status.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        channel_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['server', 'channel_id', 'text'],
    },
  },
  {
    name: 'mcpl_open',
    description: 'Open a registered channel of a bridged MCPL server (channels/open): the server then delivers that channel\'s ordinary traffic as channels/incoming, not only messages that address you. Optionally returns recent history with the open. Stays open across reconnects for this session; put the id in the server\'s openChannels config to keep it across restarts. Needs channels.lifecycle granted.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        channel_id: { type: 'string', description: 'registered channel id, as listed by mcpl_status' },
        history_limit: { type: 'number', description: 'messages of history to return with the open (default 0)' },
      },
      required: ['server', 'channel_id'],
    },
  },
  {
    name: 'mcpl_close',
    description: 'Close an open channel of a bridged MCPL server (channels/close): back to addressed-only delivery for that channel. Also drops it from the session\'s desired-open set.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        channel_id: { type: 'string' },
      },
      required: ['server', 'channel_id'],
    },
  },
  {
    name: 'mcpl_answer',
    description: 'Answer a pending inference-request from a bridged MCPL server. Pass the request_id from the <channel kind="inference-request"> message and the completion text.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        request_id: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['server', 'request_id', 'content'],
    },
  },
]

function toolName(serverId: string, handle: McplServerHandle, raw: string): string {
  return `${handle.prefix}__${raw}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// Startup gate: hold the first tools/list until every server's first connect
// attempt settles (or 4s), so Claude Code's initial list already carries the
// proxied tools instead of relying on a mid-session list_changed re-fetch.
const firstConnectionsSettled = Promise.race([
  Promise.all([...handles.values()].map(h => h.firstAttempt)),
  new Promise(r => setTimeout(r, 4000)),
])

async function listToolsImpl() {
  await firstConnectionsSettled
  const tools = [...BRIDGE_TOOLS]
  for (const [id, h] of handles) {
    for (const t of h.tools) {
      tools.push({
        name: toolName(id, h, t.name),
        description: `[mcpl:${id}] ${t.description ?? t.name}`,
        inputSchema: (t.inputSchema as { type: 'object' }) ?? { type: 'object', properties: {} },
      })
    }
  }
  return { tools }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (role === 'replica') return (await rpcToPrimary({ kind: 'listTools' }, 15_000)) as { tools: never[] }
  return listToolsImpl()
})

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) })

async function callToolImpl(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === 'mcpl_status') {
      const lines: string[] = []
      for (const [id, h] of handles) {
        lines.push(
          `${id}: ${h.status}` +
            ` | grant=[${h.grant.join(', ') || '—'}]` +
            ` | featureSets=[${h.featureSetsEnabled.join(', ') || '—'}]` +
            ` | tools=${h.tools.length}` +
            ` | channels=[${[...h.channels.keys()].join(', ') || '—'}]` +
            ` | open=[${[...h.openChannels].join(', ') || '—'}]` +
            ((gates.get(id)?.heldCount ?? 0) > 0 ? ` | held=${gates.get(id)!.heldCount}` : '') +
            (h.pendingInferenceIds.length ? ` | pending inference: ${h.pendingInferenceIds.join(', ')}` : '') +
            (h.manifestRevision ? ` | rev=${h.manifestRevision.slice(0, 18)}…` : ''),
        )
      }
      return text(lines.join('\n') || 'no MCPL servers configured')
    }
    if (name === 'mcpl_send') {
      const h = handles.get(String(args.server))
      if (!h) return text(`unknown server: ${args.server}`, true)
      const r = (await h.publish(String(args.channel_id), String(args.text))) as { delivered?: boolean; messageId?: string }
      return text(r?.delivered ? `delivered${r.messageId ? ` (${r.messageId})` : ''}` : 'not delivered')
    }
    if (name === 'mcpl_open') {
      const h = handles.get(String(args.server))
      if (!h) return text(`unknown server: ${args.server}`, true)
      const limit = typeof args.history_limit === 'number' ? Math.max(0, Math.floor(args.history_limit)) : 0
      const r = await h.openChannel(String(args.channel_id), limit)
      const lines = [`opened ${args.channel_id}`]
      if (r.history.length) {
        lines.push(`history (${r.history.length}${r.truncated ? ', truncated' : ''}, oldest first):`)
        for (const m of r.history) {
          const body = typeof m.content === 'string' ? m.content : m.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')
          lines.push(`- [${m.timestamp ?? ''} id=${m.messageId}] ${m.author?.name ?? 'unknown'}: ${body}`)
        }
      }
      return text(lines.join('\n'))
    }
    if (name === 'mcpl_close') {
      const h = handles.get(String(args.server))
      if (!h) return text(`unknown server: ${args.server}`, true)
      const closed = await h.closeChannel(String(args.channel_id))
      return text(closed ? `closed ${args.channel_id}` : `${args.channel_id} was not open (desired-open state cleared)`)
    }
    if (name === 'mcpl_answer') {
      const h = handles.get(String(args.server))
      if (!h) return text(`unknown server: ${args.server}`, true)
      const ok = h.answerInference(String(args.request_id), String(args.content))
      return text(ok ? 'answered' : `no pending inference request ${args.request_id} (it may have timed out)`, !ok)
    }
    // Proxied MCPL tool
    for (const [id, h] of handles) {
      for (const t of h.tools) {
        if (toolName(id, h, t.name) === name) {
          const result = (await h.callTool(t.name, args)) as { content?: unknown[]; isError?: boolean }
          if (result && Array.isArray(result.content)) return result as never
          return text(JSON.stringify(result))
        }
      }
    }
    return text(`unknown tool: ${name}`, true)
  } catch (err) {
    return text(`${name}: ${err instanceof Error ? err.message : err}`, true)
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  if (role === 'replica') return (await rpcToPrimary({ kind: 'callTool', name, args }, 180_000)) as never
  return (await callToolImpl(name, args)) as never
})

await mcp.connect(new StdioServerTransport())

deliverToSession = msg => {
  const gate = gates.get(msg.server)
  if (gate && gate.decide(msg) === 'hold') {
    gate.hold(msg)
    log(`[${msg.server}] held ${msg.kind} [${msg.meta.tags ?? 'no tags'}] — ${gate.heldCount} pending for the next wake`)
    return
  }
  const meta: Record<string, string> = { server: msg.server, kind: msg.kind }
  for (const [k, v] of Object.entries(msg.meta)) {
    const key = k.replace(/[^a-zA-Z0-9_]/g, '_')
    if (v) meta[key] = v
  }
  // Anything held since the last wake rides in ahead of the message that woke
  // us — but not into an inference-request, which asks the model for a
  // completion on the server's behalf rather than opening a conversation.
  const folds = msg.kind !== 'inference-request'
  const heldCount = folds ? (gate?.heldCount ?? 0) : 0
  const held = folds ? (gate?.flush(msg.server) ?? '') : ''
  if (heldCount) meta.held = String(heldCount)
  const body = msg.text || '(empty message)'
  void mcp
    .notification({
      method: 'notifications/claude/channel',
      params: { content: held ? `${held}\n\n${body}` : body, meta },
    })
    .catch(e => log(`channel push failed: ${e instanceof Error ? e.message : e}`))
}

// ── Hook socket face ──

type HookEvent = {
  hook_event_name?: string
  session_id?: string
  prompt?: string
}

const SOCK_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'mcpl-bridge')
mkdirSync(SOCK_DIR, { recursive: true })
// Keyed by session id — CC exports CLAUDE_CODE_SESSION_ID to both MCP servers
// and hook commands, so the relay finds us without pid heuristics.
//
// CC can spawn this adapter TWICE in one session (once for the plugin's
// mcpServers entry, once for the --channels registration). Two independent
// instances would each dial the MCPL servers — split state, duplicate stdio
// children, and a pending inference held by one instance unanswerable through
// the other. So instances coordinate: the first to bind the session socket is
// PRIMARY and owns every MCPL connection; any later instance becomes a REPLICA
// that forwards tools/list and tools/call over the socket and dials nothing.
// If the primary dies, the next forwarded call takes over.
const sessionKey = process.env.CLAUDE_CODE_SESSION_ID ?? String(process.ppid)
const sockPath = join(SOCK_DIR, `sock-${sessionKey}.sock`)

let role: 'primary' | 'replica' = 'primary'
let sockOwned = false
let handlesStarted = false

function startHandles() {
  if (handlesStarted) return
  handlesStarted = true
  for (const h of handles.values()) h.start()
}

// Sweep stale sockets: pid-keyed ones whose pid died, and any socket file
// older than a day (session-id-keyed ones can't be liveness-checked by name).
try {
  const { readdirSync, statSync } = await import('fs')
  for (const f of readdirSync(SOCK_DIR)) {
    const m = /^sock-(.+)\.sock$/.exec(f)
    if (!m) continue
    if (/^\d+$/.test(m[1])) {
      try {
        process.kill(Number(m[1]), 0)
      } catch {
        rmSync(join(SOCK_DIR, f), { force: true })
      }
    } else {
      try {
        if (Date.now() - statSync(join(SOCK_DIR, f)).mtimeMs > 86_400_000) rmSync(join(SOCK_DIR, f), { force: true })
      } catch {}
    }
  }
} catch {}

let turnIndex = 0
let currentInferenceId: string | null = null
let conversationId = 'claude-code'

async function handleHook(event: HookEvent): Promise<string> {
  const name = event.hook_event_name
  if (event.session_id) conversationId = event.session_id
  // The first UserPromptSubmit of a session can beat the MCPL handshakes.
  if (name === 'UserPromptSubmit') await firstConnectionsSettled
  const ready = [...handles.values()].filter(h => h.status === 'ready')
  log(`hook ${name}: ${ready.length}/${handles.size} servers ready`)

  if (name === 'UserPromptSubmit') {
    turnIndex++
    currentInferenceId = `${conversationId}-t${turnIndex}`
    for (const h of ready) h.lifecycle({ inferenceId: currentInferenceId, conversationId, turnIndex, phase: 'started' })
    const results = await Promise.allSettled(
      ready.map(h => h.beforeInference(event.prompt ?? '', currentInferenceId!, conversationId, turnIndex).then(inj => ({ h, inj }))),
    )
    const parts: string[] = []
    // Held deliveries reach the user's turn too — a user prompt is as good a
    // wake as any, and it keeps "held" from meaning "until someone pings me".
    for (const [id, gate] of gates) {
      const block = gate.flush(id)
      if (block) parts.push(block)
    }
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const inj of r.value.inj) {
        const content = typeof inj.content === 'string' ? inj.content : inj.content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
        parts.push(`<mcpl-context server="${r.value.h.id}" namespace="${inj.namespace}" position="${inj.position}">\n${content}\n</mcpl-context>`)
      }
    }
    if (!parts.length) return ''
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n') },
    })
  }

  if (name === 'Stop' && currentInferenceId) {
    for (const h of ready) h.lifecycle({ inferenceId: currentInferenceId, conversationId, turnIndex, phase: 'completed' })
    currentInferenceId = null
    return ''
  }

  if (name === 'SessionEnd') {
    if (currentInferenceId) {
      for (const h of ready) h.lifecycle({ inferenceId: currentInferenceId, conversationId, turnIndex, phase: 'aborted' })
      currentInferenceId = null
    }
    return ''
  }
  return ''
}

type SocketOp = { kind?: string; event?: HookEvent; name?: string; args?: Record<string, unknown> }

async function serveOp(parsed: SocketOp): Promise<string> {
  if (parsed.kind === 'hook' && parsed.event) return handleHook(parsed.event)
  if (parsed.kind === 'ping') return JSON.stringify({ pong: true, pid: process.pid })
  if (parsed.kind === 'listTools') return JSON.stringify(await listToolsImpl())
  if (parsed.kind === 'callTool') return JSON.stringify(await callToolImpl(String(parsed.name), parsed.args ?? {}))
  return ''
}

function bindSocket(steal = false): boolean {
  // Bun.listen silently unlinks an existing unix socket file, so an existing
  // file must be treated as a live primary until proven dead — never bind
  // over it blindly or two instances both believe they are primary.
  if (!steal && existsSync(sockPath)) return false
  try {
    Bun.listen({
      unix: sockPath,
      socket: {
        data(socket, data) {
          const buf = ((socket.data as { buf?: string })?.buf ?? '') + data.toString()
          const nl = buf.indexOf('\n')
          if (nl === -1) {
            socket.data = { buf }
            return
          }
          const line = buf.slice(0, nl)
          void (async () => {
            let reply = ''
            try {
              reply = await serveOp(JSON.parse(line) as SocketOp)
            } catch (e) {
              log(`socket op failed: ${e instanceof Error ? e.message : e}`)
            }
            try {
              if (reply) socket.write(reply)
              socket.end()
            } catch {}
          })()
        },
        open(socket) {
          socket.data = { buf: '' }
        },
        error() {},
      },
    })
    sockOwned = true
    return true
  } catch {
    return false
  }
}

function socketRoundtrip(payload: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => reject(new Error('socket timeout')), timeoutMs)
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(payload)
        },
        data(_s, d) {
          chunks.push(Buffer.from(d))
        },
        close() {
          clearTimeout(timer)
          resolve(Buffer.concat(chunks).toString('utf8'))
        },
        error(_s, err) {
          clearTimeout(timer)
          reject(err)
        },
      },
    }).catch(err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function primaryAlive(): Promise<boolean> {
  try {
    const r = await socketRoundtrip(JSON.stringify({ kind: 'ping' }) + '\n', 1500)
    return r.includes('"pong"')
  } catch {
    return false
  }
}

async function acquireRole(): Promise<void> {
  if (bindSocket()) {
    role = 'primary'
    return
  }
  if (await primaryAlive()) {
    role = 'replica'
    return
  }
  // Dead primary left a stale file — steal the bind. A concurrent booter may
  // race us here; add a beat of jitter and re-check before stealing.
  await new Promise(r => setTimeout(r, Math.random() * 150))
  if (await primaryAlive()) {
    role = 'replica'
    return
  }
  try {
    rmSync(sockPath, { force: true })
  } catch {}
  role = bindSocket(true) ? 'primary' : 'replica'
}

async function rpcToPrimary(op: SocketOp, timeoutMs: number): Promise<unknown> {
  try {
    const raw = await socketRoundtrip(JSON.stringify(op) + '\n', timeoutMs)
    if (!raw.trim()) throw new Error('empty reply from primary')
    return JSON.parse(raw)
  } catch (e) {
    // Primary gone? Take over: bind, dial the MCPL fleet, serve locally.
    await acquireRole()
    if (role === 'primary') {
      log('promoted to primary (previous instance gone)')
      startHandles()
      if (op.kind === 'listTools') return listToolsImpl()
      if (op.kind === 'callTool') return callToolImpl(String(op.name), op.args ?? {})
    }
    throw e
  }
}

function shutdown() {
  if (sockOwned) {
    try {
      rmSync(sockPath, { force: true })
    } catch {}
  }
  for (const h of handles.values()) h.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Claude Code closing the MCP stdio transport must take the adapter down —
// otherwise ended sessions leak orphaned adapters (and their MCPL children).
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('exit', () => {
  if (sockOwned) {
    try {
      rmSync(sockPath, { force: true })
    } catch {}
  }
})

// ── Acquire role, then (primary only) connect the fleet ──
await acquireRole()
if (role === 'primary') {
  log(`primary: hook socket ${sockPath}`)
  startHandles()
} else {
  log('replica: a primary instance already serves this session — forwarding tool calls, dialing nothing')
}
