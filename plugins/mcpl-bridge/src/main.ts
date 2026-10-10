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
import { existsSync, mkdirSync, rmSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { loadConfig, type ServerConfig } from './config'
import { McplServerHandle, type IncomingDelivery } from './mcpl-host'
import { withBridgeClass } from './tool-classes'
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

let { config, path: configPathUsed } = loadConfig()
log(configPathUsed ? `config: ${configPathUsed}` : 'no config found — running with zero MCPL servers (create .mcpl-bridge.json)')

// ── MCP server face ──

const mcp = new Server(
  { name: 'mcpl', version: '0.1.0' },
  {
    capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
    instructions: [
      'This server bridges MCPL servers into this session.',
      'Messages from MCPL servers arrive as <channel source="mcpl" server="..." ...> blocks:',
      '- kind="channel-message" / kind="push-event": events from the MCPL server. To reply on a channel, call mcpl_send with that server and the channel\'s label (the channel="…" attribute) or its channel_id — both are accepted everywhere a channel is named.',
      '- kind="inference-request": the MCPL server is asking for a completion. Compose the answer and call mcpl_answer with the request_id from the message. Do this promptly — the request is held open.',
      'A <held server="..." count="N"> block at the top of a message lists deliveries the wake policy held back since the last turn (e.g. a bot replying to you, ambient traffic) — context, not a separate ping; the same block reaches a user turn via the UserPromptSubmit hook.',
      'Proxied MCPL tools are named <server>__<tool>. mcpl_status shows connections, grants, channel counts, open channels, and held count; mcpl_channels lists registered channels by label. mcpl_open / mcpl_close subscribe to or leave a registered channel\'s ambient traffic (channels/open).',
      'Managing the servers themselves: mcpl_enable / mcpl_disable start or stop configured servers for this session (a server can be configured with "disabled": true and enabled only when needed). mcpl_reload re-reads the config; mcpl_reload with server="<id>" also hot-reloads that server — respawns a stdio server or redials a ws one — which is how a rebuilt MCPL server\'s new code takes effect without restarting the session.',
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

function scheduleToolsChanged(): void {
  if (toolsChangedTimer) clearTimeout(toolsChangedTimer)
  toolsChangedTimer = setTimeout(() => {
    void mcp.notification({ method: 'notifications/tools/list_changed' }).catch(() => {})
  }, 100)
}

// ── Enabled / disabled ──
// A server runs when the config does not say `"disabled": true` — unless this
// session said otherwise with mcpl_enable / mcpl_disable. An override exists
// only while it disagrees with the config: it is dropped when the config
// comes round to it, and with its server. Session-scoped by design — the
// config file is shared by every session that resolves it, and one session
// switching a server off must not switch it off for the rest.
const sessionOverride = new Map<string, boolean>()
const configEnabled = (s: ServerConfig | undefined): boolean => s !== undefined && s.disabled !== true
function wantEnabled(id: string, s: ServerConfig | undefined = config.servers[id]): boolean {
  if (!s) return false
  return sessionOverride.get(id) ?? configEnabled(s)
}

/** `predecessor`: exit of the process a replaced handle ran — the new one's first spawn waits on it. */
function makeHandle(id: string, serverCfg: ServerConfig, predecessor?: Promise<void>): McplServerHandle {
  const handle = new McplServerHandle(
    id,
    serverCfg,
    {
      deliver: msg => deliverToSession(msg),
      toolsChanged: scheduleToolsChanged,
      log,
    },
    { disabled: !wantEnabled(id, serverCfg), predecessor },
  )
  handles.set(id, handle)
  gates.set(id, new WakeGate(serverCfg.wake))
  return handle
}

/**
 * Bring a server's running state in line with `want`. Returns the op's
 * promise (enable resolves when the connect attempt settles), or null when
 * there was nothing to do. Before the fleet has started — a replica, or a
 * reload ahead of startup — nothing has been dialed, so the handle is simply
 * rebuilt in the wanted state for startHandles to pick up.
 */
function applyEnabled(id: string, want: boolean): Promise<void> | null {
  const h = handles.get(id)
  if (!h || want === !h.disabled) return null
  if (!handlesStarted) {
    h.close()
    makeHandle(id, config.servers[id])
    return null
  }
  return want ? h.enable() : h.disable()
}

for (const [id, serverCfg] of Object.entries(config.servers)) makeHandle(id, serverCfg)

// ── Config reload ──────────────────────────────────────────────────────────
// Re-read the config and reconcile the fleet in place: added servers connect,
// removed ones close, changed ones (any field) reconnect, unchanged ones — and
// their held deliveries, open channels, pending inference — are untouched.
// Triggers: the mcpl_reload tool, SIGHUP, and a watcher on the config file
// (MCPL_BRIDGE_WATCH=0 disables). A config that fails to parse or validate is
// rejected whole; the running fleet keeps its last good config.

/** Key-order-independent JSON so a reordered file is not a "change". */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** A server's config minus `disabled`: flipping only that flag switches the
 *  server on or off in place instead of replacing its connection. */
function connectionJson(s: ServerConfig): string {
  const { disabled: _flag, ...rest } = s
  return stableJson(rest)
}

/** `fresh`: servers this reload (re)connected, each with its connect attempt —
 *  a hot reload named in the same call waits on that instead of restarting. */
type ReloadResult = { summary: string; fresh: Map<string, Promise<void>> }

let reloading: Promise<ReloadResult> | null = null
function reloadConfig(reason: string): Promise<ReloadResult> {
  if (reloading) return reloading
  reloading = reloadConfigInner(reason).finally(() => {
    reloading = null
  })
  return reloading
}

async function reloadConfigInner(reason: string): Promise<ReloadResult> {
  let next: ReturnType<typeof loadConfig>
  try {
    next = loadConfig()
  } catch (e) {
    const msg = `reload (${reason}) rejected: ${e instanceof Error ? e.message : e} — keeping the running config`
    log(msg)
    return { summary: msg, fresh: new Map() }
  }
  const prev = config.servers
  const nextServers = next.config.servers
  const added = Object.keys(nextServers).filter(id => !(id in prev))
  const removed = Object.keys(prev).filter(id => !(id in nextServers))
  const changed = Object.keys(prev).filter(id => id in nextServers && connectionJson(prev[id]) !== connectionJson(nextServers[id]))
  for (const [id, on] of [...sessionOverride]) {
    if (!(id in nextServers) || on === configEnabled(nextServers[id])) sessionOverride.delete(id)
  }
  const dropped: string[] = []
  const exiting = new Map<string, Promise<void>>()
  for (const id of [...removed, ...changed]) {
    const held = gates.get(id)?.heldCount ?? 0
    if (held) dropped.push(`${id}:${held}`)
    const gone = handles.get(id)?.close()
    if (gone) exiting.set(id, gone)
    handles.delete(id)
    gates.delete(id)
  }
  config = next.config
  const fresh = new Map<string, Promise<void>>()
  for (const id of [...added, ...changed]) {
    // A changed stdio server is respawned only after its old process exits.
    const h = makeHandle(id, nextServers[id], exiting.get(id))
    if (!handlesStarted || h.disabled) continue
    h.start()
    fresh.set(id, h.attempt)
  }
  // Same connection, possibly a different on/off state: the `disabled` flag flipped.
  const switchedOn: string[] = []
  const switchedOff: string[] = []
  for (const id of Object.keys(nextServers)) {
    if (added.includes(id) || changed.includes(id)) continue
    const h = handles.get(id)
    const want = wantEnabled(id)
    if (!h || want === !h.disabled) continue
    ;(want ? switchedOn : switchedOff).push(id)
    const op = applyEnabled(id, want)?.catch(e => log(`[${id}] ${want ? 'enable' : 'disable'} on reload failed: ${e instanceof Error ? e.message : e}`))
    if (want && op) fresh.set(id, op)
  }
  if (next.path !== configPathUsed) {
    configPathUsed = next.path
    installConfigWatch()
  }
  if (added.length || removed.length || changed.length) scheduleToolsChanged()
  const summary =
    `reload (${reason}) from ${configPathUsed ?? 'no config'}: ` +
    `added [${added.join(', ') || '—'}] removed [${removed.join(', ') || '—'}] changed [${changed.join(', ') || '—'}]` +
    (switchedOn.length ? ` enabled [${switchedOn.join(', ')}]` : '') +
    (switchedOff.length ? ` disabled [${switchedOff.join(', ')}]` : '') +
    ` unchanged ${Object.keys(nextServers).length - added.length - changed.length - switchedOn.length - switchedOff.length}` +
    (dropped.length ? ` (dropped held deliveries: ${dropped.join(', ')})` : '')
  log(summary)
  return { summary, fresh }
}

let configWatcher: FSWatcher | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null
/** Watch the config's directory (editors save by rename, which breaks a watch on the file itself). */
function installConfigWatch(): void {
  configWatcher?.close()
  configWatcher = null
  if (process.env.MCPL_BRIDGE_WATCH === '0' || !configPathUsed || role !== 'primary') return
  const file = basename(configPathUsed)
  try {
    configWatcher = watch(dirname(configPathUsed), (_event, name) => {
      if (name && name !== file) return
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => void reloadConfig('config file changed'), 300)
    })
    configWatcher.unref?.()
  } catch (e) {
    log(`config watch failed: ${e instanceof Error ? e.message : e}`)
  }
}
process.on('SIGHUP', () => {
  if (role === 'primary') void reloadConfig('SIGHUP')
  else log('SIGHUP ignored on a replica — signal the primary or call mcpl_reload')
})

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> }

// Each declares its RFC-008 class in _meta (src/tool-classes.ts).
const BRIDGE_TOOLS: ToolDef[] = [
  {
    name: 'mcpl_status',
    description: 'Show every configured MCPL server: connection status (or disabled, and whether by config or this session), effective capability grant, enabled feature sets, registered channel count, open channels (by label), proxied tool count, pending inference requests, process id and uptime, last connection error. Use mcpl_channels for the channel list.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcpl_channels',
    description: 'List the registered channels of a bridged MCPL server as `label — id` (open ones marked *). The label is the address form: pass it as channel_id to mcpl_send / mcpl_open / mcpl_close. Optional case-insensitive substring filter over labels and ids.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id (omit for all servers)' },
        filter: { type: 'string', description: 'substring to match against label or id' },
        open_only: { type: 'boolean', description: 'only channels currently open' },
      },
    },
  },
  {
    name: 'mcpl_send',
    description: 'Publish a message into a registered channel of a bridged MCPL server (channels/publish). channel_id accepts the channel\'s label exactly as mcpl_channels / a received <channel channel="…"> print it (case-insensitive, leading # optional, no fuzzy matching) or its registered id. If an id collides with another label, use id:<channel id>; the unprefixed reference errors.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        channel_id: { type: 'string', description: 'channel label (e.g. "#lena_dev (Connectome)") or registered id' },
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
        channel_id: { type: 'string', description: 'channel label (as listed by mcpl_channels) or registered id' },
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
        channel_id: { type: 'string', description: 'channel label (as listed by mcpl_channels) or registered id' },
      },
      required: ['server', 'channel_id'],
    },
  },
  {
    name: 'mcpl_reload',
    description: 'Re-read the bridge config and reconcile in place: servers added to the file connect, removed ones close, changed ones reconnect, ones whose "disabled" flag flipped start or stop; unchanged servers keep their connections, open channels and held deliveries. (The bridge also reloads on SIGHUP and when the config file changes on disk.) With `server`, also HOT-RELOAD those servers after the re-read: the connection is torn down and brought back — a stdio server is killed and respawned (so a rebuilt server\'s new code runs), a ws server is redialed — with a fresh handshake and tool list; channels opened this session re-open and held deliveries are kept. Waits up to 20s for the new connection and reports status, tool count, and on failure the server\'s last stderr lines.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'server id(s) to hot-reload, comma-separated, or "*" for every enabled server (omit to only re-read the config)' },
      },
    },
  },
  {
    name: 'mcpl_enable',
    description: 'Start configured MCPL servers that are disabled — by "disabled": true in the config, or by mcpl_disable earlier in this session. Connects, handshakes and proxies their tools (waits up to 20s and reports the result). This session only: the config file is shared with other sessions and is not written; remove "disabled" from the config to enable a server everywhere.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'server id(s), comma-separated, or "*" for every configured server' },
      },
      required: ['server'],
    },
  },
  {
    name: 'mcpl_disable',
    description: 'Stop bridged MCPL servers for this session: close the connection (a stdio server process is stopped), withdraw their tools, refuse their pending inference requests, and stop reconnecting. Held deliveries are kept for the next turn, and channels opened this session re-open on mcpl_enable. This session only: the config file is not written; set "disabled": true in the config to keep a server off everywhere.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'server id(s), comma-separated, or "*" for every configured server' },
      },
      required: ['server'],
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
].map(withBridgeClass)

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

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
        // The upstream tool's _meta rides through unchanged, every key — notably
        // RFC-008's mcpl/class, which the host reads for policy. Only a non-object
        // is dropped: it would fail the client's validation of the whole list.
        ...(isPlainObject(t._meta) ? { _meta: t._meta } : {}),
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

/** A `server` argument: one id, several (comma/space-separated), or "*" for every configured server. */
function selectServers(arg: unknown): string[] {
  const raw = typeof arg === 'string' ? arg.trim() : ''
  if (!raw) throw new Error('name a server: an id, several comma-separated, or "*"')
  const known = [...handles.keys()]
  if (raw === '*') return known
  const ids = [...new Set(raw.split(/[\s,]+/).filter(Boolean))]
  const unknown = ids.filter(id => !handles.has(id))
  if (unknown.length) throw new Error(`unknown server${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (configured: ${known.join(', ') || 'none'})`)
  return ids
}

type Outcome = { ok: boolean; line: string }
/** Run a lifecycle op per server, concurrently; one server's failure is its own line, not the whole call's. */
function eachServer(ids: string[], fn: (id: string) => Promise<Outcome>): Promise<Outcome[]> {
  return Promise.all(ids.map(id => fn(id).catch(e => ({ ok: false, line: `${id}: ${e instanceof Error ? e.message : e}` }))))
}

/** How long enable / hot reload wait for the new connection before reporting. */
const SETTLE_MS = 20_000
/** true when `p` settled within SETTLE_MS; false on timeout. A rejection propagates. */
async function settle(p: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p.then(() => true), new Promise<boolean>(r => (timer = setTimeout(() => r(false), SETTLE_MS)))])
  } finally {
    clearTimeout(timer)
  }
}

const isUp = (h: McplServerHandle) => h.status === 'ready' || h.status === 'mcp-only'

/** One server's state after a lifecycle op — on failure, with the stderr a crashed respawn left. */
function describe(h: McplServerHandle, settled: boolean): string {
  if (!settled) return `still ${h.status} after ${SETTLE_MS / 1000}s (mcpl_status shows when it lands)`
  if (isUp(h)) return `${h.status}, ${h.tools.length} tool${h.tools.length === 1 ? '' : 's'}${h.pid ? `, pid ${h.pid}` : ''}`
  const tail = h.stderrTail.slice(-8)
  return `${h.status}${h.lastError ? `: ${h.lastError}` : ''}` + (tail.length ? `\n  stderr (last ${tail.length} lines):\n${tail.map(l => `    ${l}`).join('\n')}` : '')
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d`
}

async function callToolImpl(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === 'mcpl_status') {
      const lines: string[] = []
      for (const [id, h] of handles) {
        const held = gates.get(id)?.heldCount ?? 0
        if (h.disabled) {
          lines.push(`${id}: disabled (${sessionOverride.get(id) === false ? 'this session — mcpl_enable restarts it' : 'config — mcpl_enable starts it for this session'})${held ? ` | held=${held}` : ''}`)
          continue
        }
        // A server can register hundreds of channels (every Discord channel a
        // persona can see) and ids are unreadable anyway: count here, labels
        // via mcpl_channels. Open channels are few and named by label — the
        // address form mcpl_send/open/close accept back.
        const open = [...h.openChannels].map(cid => h.labelOf(cid) || cid)
        lines.push(
          `${id}: ${h.status}` +
            ` | grant=[${h.grant.join(', ') || '—'}]` +
            ` | featureSets=[${h.featureSetsEnabled.join(', ') || '—'}]` +
            ` | tools=${h.tools.length}` +
            ` | channels=${h.channels.size}` +
            ` | open=[${open.join(', ') || '—'}]` +
            (held > 0 ? ` | held=${held}` : '') +
            (h.pendingInferenceIds.length ? ` | pending inference: ${h.pendingInferenceIds.join(', ')}` : '') +
            (h.manifestRevision ? ` | rev=${h.manifestRevision.slice(0, 18)}…` : '') +
            (h.pid ? ` | pid=${h.pid}` : '') +
            (h.connectedAt ? ` | up ${duration(Date.now() - h.connectedAt)}` : '') +
            (sessionOverride.get(id) === true ? ' | enabled this session (config: disabled)' : '') +
            (h.status !== 'ready' && h.status !== 'mcp-only' && h.lastError ? ` | last error: ${h.lastError}` : ''),
        )
      }
      lines.push(`config: ${configPathUsed ?? 'none'}${configWatcher ? ' (watched)' : ''}`)
      return text(lines.join('\n'))
    }
    if (name === 'mcpl_reload') {
      const targets = typeof args.server === 'string' && args.server.trim() ? args.server.trim() : null
      // Re-read first, so a hot reload runs on the config as it is now.
      const r = await reloadConfig('mcpl_reload')
      if (!targets) return text(r.summary)
      let ids: string[]
      try {
        ids = targets === '*' ? [...handles.keys()].filter(id => !handles.get(id)!.disabled) : selectServers(targets)
      } catch (e) {
        return text(`${r.summary}\n${e instanceof Error ? e.message : e}`, true)
      }
      const results = await eachServer(ids, async id => {
        const h = handles.get(id)
        if (!h) return { ok: false, line: `${id}: not configured` }
        if (h.disabled) return { ok: false, line: `${id}: disabled — not reloaded (mcpl_enable starts it)` }
        const freshAttempt = r.fresh.get(id)
        if (freshAttempt) {
          // The re-read already gave it a new connection; a second restart would only churn.
          const settled = await settle(freshAttempt)
          if (settled && !isUp(h)) await h.stderrSettled()
          return { ok: isUp(h), line: `${id}: reconnected by the config change — ${describe(h, settled)}` }
        }
        const pidBefore = h.pid
        const settled = await settle(h.restart())
        if (settled && !isUp(h)) await h.stderrSettled()
        const pidNote = pidBefore && h.pid && pidBefore !== h.pid ? ` (pid ${pidBefore} → ${h.pid})` : ''
        return { ok: isUp(h), line: `${id}: reloaded — ${describe(h, settled)}${pidNote}` }
      })
      if (!results.length) return text(`${r.summary}\nno enabled servers to reload`)
      return text([r.summary, ...results.map(x => x.line)].join('\n'), results.some(x => !x.ok))
    }
    if (name === 'mcpl_enable' || name === 'mcpl_disable') {
      const want = name === 'mcpl_enable'
      const ids = selectServers(args.server)
      const results = await eachServer(ids, async id => {
        const s = config.servers[id]
        if (want === configEnabled(s)) sessionOverride.delete(id)
        else sessionOverride.set(id, want)
        const scope =
          sessionOverride.get(id) === true
            ? ' — this session only (config has "disabled": true)'
            : sessionOverride.get(id) === false
              ? ' — this session only (set "disabled": true in the config to keep it off everywhere)'
              : ''
        const h = handles.get(id)!
        if (want === !h.disabled) {
          const down = want && !isUp(h) && h.status !== 'connecting' ? ` — mcpl_reload server=${id} reconnects it` : ''
          return { ok: true, line: `${id}: already ${want ? `enabled (${h.status})` : 'disabled'}${down}${scope}` }
        }
        const toolsBefore = h.tools.length
        const pendingBefore = h.pendingInferenceIds.length
        const op = applyEnabled(id, want)
        // Report the connection the server ends up with: when an earlier queued
        // op (a hot reload) is what is connecting, wait on that attempt too.
        const settled = op ? await settle(want ? op.then(() => handles.get(id)!.idle()) : op) : true
        const now = handles.get(id)!
        if (want && settled && !isUp(now)) await now.stderrSettled()
        if (want) return { ok: isUp(now) || !settled, line: `${id}: enabled — ${describe(now, settled)}${scope}` }
        const held = gates.get(id)?.heldCount ?? 0
        return {
          ok: true,
          line:
            `${id}: disabled — ${toolsBefore} tool${toolsBefore === 1 ? '' : 's'} withdrawn` +
            (pendingBefore ? `, ${pendingBefore} pending inference request${pendingBefore === 1 ? '' : 's'} refused` : '') +
            (held ? `, ${held} held deliver${held === 1 ? 'y' : 'ies'} kept for the next turn` : '') +
            scope,
        }
      })
      return text(results.map(x => x.line).join('\n'), results.some(x => !x.ok))
    }
    if (name === 'mcpl_channels') {
      const wanted = args.server === undefined ? [...handles.keys()] : [String(args.server)]
      const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : ''
      const openOnly = args.open_only === true
      const CAP = 150
      const lines: string[] = []
      for (const id of wanted) {
        const h = handles.get(id)
        if (!h) return text(`unknown server: ${id}`, true)
        const rows = [...h.channels.values()]
          .filter(d => !openOnly || h.openChannels.has(d.id))
          .filter(d => !filter || h.labelOf(d.id).toLowerCase().includes(filter) || d.id.toLowerCase().includes(filter))
          .sort((a, b) => h.labelOf(a.id).localeCompare(h.labelOf(b.id), 'en', { sensitivity: 'base' }))
        lines.push(`${id}: ${rows.length}${rows.length !== h.channels.size ? ` of ${h.channels.size}` : ''} channel(s)${openOnly ? ', open only' : ''}${filter ? ` matching "${args.filter}"` : ''}`)
        for (const d of rows.slice(0, CAP)) lines.push(`${h.openChannels.has(d.id) ? '*' : ' '} ${h.labelOf(d.id)} — ${d.id}`)
        if (rows.length > CAP) lines.push(`  … ${rows.length - CAP} more; narrow with filter`)
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
      // A close issued while this open was in flight wins; say so instead of "opened".
      if (!r.open) return text(`${r.label} (${r.channelId}) was not opened: a close for it landed while the open was in flight, and the close wins. Call mcpl_open again to open it.`, true)
      const lines = [`opened ${r.label} (${r.channelId})`]
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
      const r = await h.closeChannel(String(args.channel_id))
      return text(r.closed ? `closed ${r.label} (${r.channelId})` : `${r.label} (${r.channelId}) was not open (desired-open state cleared)`)
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
    // A stale call into a server that is off or down: say which, not just
    // "unknown". The owner is the LONGEST matching prefix — `foo__bar__ping`
    // belongs to server `foo__bar`, not `foo`.
    let owner: [string, McplServerHandle] | null = null
    for (const [id, h] of handles) {
      const prefix = toolName(id, h, '')
      if (name.startsWith(prefix) && (!owner || prefix.length > toolName(owner[0], owner[1], '').length)) owner = [id, h]
    }
    if (owner) {
      const [id, h] = owner
      if (h.disabled) return text(`${name}: server ${id} is disabled — mcpl_enable starts it`, true)
      if (!isUp(h)) return text(`${name}: server ${id} is ${h.status}${h.lastError ? ` (${h.lastError})` : ''} — its tools come back when it reconnects (mcpl_reload server=${id} forces that)`, true)
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
  log(`[${msg.server}] wake ${msg.kind} [${msg.meta.tags ?? 'no tags'}] → notifications/claude/channel`)
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
  installConfigWatch()
}

// Sweep stale sockets. A pid-keyed socket is stale when its pid is gone. A
// session-keyed one cannot be liveness-checked by name, and its mtime says
// nothing either: a unix socket file's mtime is its creation time, so a
// healthy primary that has served hooks for a week reads as "a day old". The
// earlier sweep deleted on exactly that basis — every later adapter start
// (a headless doorbell session, a pulse, a second CC window) unlinked the
// live session's socket, and from then on every hook of that session
// fail-opened with "socket: NOT FOUND": held deliveries never surfaced, no
// lifecycle reached the servers, and nothing said so (found 2026-09-14: a
// week-old session with 13 held pings and a socket directory with no socket
// in it). So a session-keyed socket is asked, not aged: a live primary
// answers ping; anything that does not is a corpse. Our own path is not in
// the directory yet — this runs before bindSocket.
try {
  const { readdirSync } = await import('fs')
  for (const f of readdirSync(SOCK_DIR)) {
    const m = /^sock-(.+)\.sock$/.exec(f)
    if (!m) continue
    const p = join(SOCK_DIR, f)
    if (/^\d+$/.test(m[1])) {
      try {
        process.kill(Number(m[1]), 0)
      } catch {
        rmSync(p, { force: true })
      }
    } else if (!(await socketAlive(p))) {
      rmSync(p, { force: true })
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

/** Is there a live primary behind this socket path? A ping answered with
 *  pong within the timeout is the only evidence accepted; a refused connect,
 *  a plain file, or silence all mean no. */
async function socketAlive(path: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const reply = await socketRoundtrip(JSON.stringify({ kind: 'ping' }) + '\n', timeoutMs, path)
    return /"pong"\s*:\s*true/.test(reply)
  } catch {
    return false
  }
}

function socketRoundtrip(payload: string, timeoutMs: number, path: string = sockPath): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => reject(new Error('socket timeout')), timeoutMs)
    Bun.connect({
      unix: path,
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
  configWatcher?.close()
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
