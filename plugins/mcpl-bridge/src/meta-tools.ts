/**
 * The host's own interface to dynamic tools (MCPL RFC-014 §8.2): four tools,
 * listed once and constant, aggregated across every bridged server.
 *
 *   open  {server, toolset?, instance?, options?}
 *   act   {server, tool, instance?, args}
 *   look  {server?, toolset?, instance?, tool?}
 *   close {server, toolset?, instance?}
 *
 * Dynamic tools never enter Claude Code's tool list (that would rebuild the
 * prompt cache on every change); they are announced in the conversation —
 * in these tools' results, and in channel notifications — and called here.
 */
import type { McplServerHandle } from './mcpl-host'
import { keyOf, type ChangeSet } from './presence'
import { renderToolDefinition, type ToolDef } from './tool-render'

type Block = { type: string; text?: string; [k: string]: unknown }
export type MetaResult = { content: Block[]; isError?: boolean }

export const META_TOOLS = [
  {
    name: 'open',
    description:
      'Open a toolset of a bridged MCPL server — a game, a building mode, a card table — so its tools become usable through act. ' +
      'Returns what the server shows on opening and the tools available now. toolset may be omitted when the server has only one; ' +
      'instance names a separate copy where a toolset allows several (two games at once); options as look lists them.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        toolset: { type: 'string' },
        instance: { type: 'string', description: 'a name for this copy (toolsets with instances only)' },
        options: { type: 'object', description: 'toolset options, as look shows them' },
      },
      required: ['server'],
    },
  },
  {
    name: 'act',
    description:
      'Call a tool that was announced in the conversation (from an open toolset), or any tool of a server whose tools are not in your tool list. ' +
      'args are the arguments its signature shows; instance picks the open copy when several are open. ' +
      'Returns the server\'s result, then any change in which tools are available.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        tool: { type: 'string' },
        instance: { type: 'string', description: 'which open copy (only needed when several are open)' },
        args: { type: 'object' },
      },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'look',
    description:
      'Show what is open and what can be opened on bridged MCPL servers, with the tools usable now — announcements earlier in the conversation may be out of date. ' +
      'With server and tool: that tool\'s full description and input schema. With toolset or instance: just that one.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        toolset: { type: 'string' },
        instance: { type: 'string' },
        tool: { type: 'string' },
      },
    },
  },
  {
    name: 'close',
    description: 'Close an open toolset or instance: its tools and its events stop. Closing a game in progress may count as leaving it.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'bridged server id' },
        toolset: { type: 'string', description: 'may be omitted when only one thing is open on the server' },
        instance: { type: 'string' },
      },
      required: ['server'],
    },
  },
]

export const META_TOOL_NAMES: ReadonlySet<string> = new Set(META_TOOLS.map(t => t.name))

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (t: string, isError = false): MetaResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

class MetaError extends Error {}
const fail = (msg: string): never => {
  throw new MetaError(msg)
}

/** Servers the meta-tools speak for: hints in effect and something dynamic (toolsets, dynamic tools, surface). */
export function presenting(handles: Map<string, McplServerHandle>): McplServerHandle[] {
  return [...handles.values()].filter(h => h.presence.presents)
}

function pick(handles: Map<string, McplServerHandle>, server: unknown): McplServerHandle {
  const id = str(server)
  const ids = presenting(handles).map(h => h.id)
  if (!id) {
    if (ids.length === 1) return handles.get(ids[0]!)!
    fail(`name a server: ${ids.join(', ') || '(no bridged server has toolsets)'}`)
  }
  const h = handles.get(id!)
  if (!h) fail(`no server "${id}" — servers with toolsets: ${ids.join(', ') || 'none'}`)
  if (h!.disabled) fail(`${id} is disabled — mcpl_enable starts it`)
  if (!h!.presence.active) fail(`${id} sends no tool hints: its tools are in your tool list as ${h!.prefix}__<tool>`)
  return h!
}

function rpcMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^RPC error -?\d+: /, '')
}

function toolsAt(h: McplServerHandle, key: string): ToolDef[] {
  return [...(h.presence.view().get(key)?.tools.values() ?? [])]
}

/** Render a change set minus one key the caller has already shown in full. */
function renderOthers(h: McplServerHandle, cs: ChangeSet, key: string): string {
  return h.presence.render({ ...cs, changes: cs.changes.filter(c => c.key !== key) })
}

export async function callMetaTool(name: string, args: Record<string, unknown>, handles: Map<string, McplServerHandle>): Promise<MetaResult> {
  try {
    switch (name) {
      case 'open':
        return await open(handles, args)
      case 'act':
        return await act(handles, args)
      case 'look':
        return await look(handles, args)
      case 'close':
        return await close(handles, args)
    }
    return text(`unknown tool ${name}`, true)
  } catch (e) {
    return text(e instanceof MetaError ? e.message : `${name}: ${rpcMessage(e)}`, true)
  }
}

async function open(handles: Map<string, McplServerHandle>, args: Record<string, unknown>): Promise<MetaResult> {
  const h = pick(handles, args.server)
  const p = h.presence
  const openable = [...Object.keys(p.declared), ...p.undeclaredGroups]
  let toolset = str(args.toolset)
  if (!toolset) {
    if (openable.length !== 1) fail(`${h.id} has ${openable.length ? `several toolsets — name one: ${openable.join(', ')}` : 'no toolsets'}`)
    toolset = openable[0]!
  }
  const instance = str(args.instance)
  if (args.options !== undefined && !isObj(args.options)) fail('options must be an object')
  const options = args.options as Record<string, unknown> | undefined

  if (p.isDeclared(toolset!)) {
    if (instance && !p.declared[toolset!]!.instances) fail(`${h.id}/${toolset} has no instances — open it without one`)
    let o: Awaited<ReturnType<McplServerHandle['openToolset']>>
    try {
      o = await h.openToolset(toolset!, instance, options)
    } catch (e) {
      fail(`${h.id} did not open ${toolset}: ${rpcMessage(e)}`)
    }
    // r3 §5.2: opening what is open adopts it; its content says which options were not applied.
    const blocks: Block[] = [{ type: 'text', text: `[${p.label(o!.key)}]${o!.title ? ` ${o!.title}` : ''}${o!.adopted ? ' — already open' : ''}` }, ...(o!.content as Block[])]
    const tail = [...p.toolBlock(o!.key, toolsAt(h, o!.key), { headed: false })]
    const gone = o!.change.changes.find(c => c.key === o!.key)?.gone ?? []
    if (gone.length) tail.push(`now unavailable: ${gone.join(', ')}`)
    const others = renderOthers(h, o!.change, o!.key)
    if (others) tail.push(others)
    tail.push(`${p.closeHint(o!.key)} closes it.`)
    blocks.push({ type: 'text', text: tail.join('\n') })
    return { content: mergeText(blocks) }
  }
  if (p.undeclaredGroups.includes(toolset!)) {
    // RFC-014 §5.4: a grouping the server offers but does not track — the host opens it, the server is not told.
    if (instance || options) fail(`${h.id}/${toolset} takes no instance or options (the server does not declare it)`)
    const cs = h.setGroupOpen(toolset!, true)
    const key = keyOf(toolset!)
    const lines = [`[${p.label(key)}] open.`, ...p.toolBlock(key, toolsAt(h, key), { headed: false })]
    const others = renderOthers(h, cs, key)
    if (others) lines.push(others)
    lines.push(`${p.closeHint(key)} closes it.`)
    return text(lines.join('\n'))
  }
  return fail(`${h.id} has no toolset "${toolset}"${openable.length ? ` — it has: ${openable.join(', ')}` : ''}`)
}

async function act(handles: Map<string, McplServerHandle>, args: Record<string, unknown>): Promise<MetaResult> {
  const h = pick(handles, args.server)
  const p = h.presence
  const tool = str(args.tool) ?? fail('name the tool')
  if (!p.tool(tool)) fail(`${h.id} has no tool "${tool}" — look {server:"${h.id}"} shows what is available`)
  if (args.args !== undefined && !isObj(args.args)) fail('args must be an object of the tool\'s arguments')
  let instance = str(args.instance)
  const ts = p.toolsetOf(tool)
  if (ts && p.isDeclared(ts) && p.declared[ts]!.instances && !instance) {
    // The instance a call is for rides in _meta (RFC-014 §5.5); with exactly one open, it is that one.
    const open = p.openRecords(ts)
    if (open.length === 1) instance = open[0]!.instance
    else if (!open.length) fail(`${tool} belongs to ${ts}, which is not open — ${p.openHint(ts)}`)
    else fail(`several ${ts} instances are open (${open.map(o => o.instance).join(', ')}) — say which with instance`)
  }
  if (ts && !p.isDeclared(ts) && !p.isOpen(ts)) fail(`${tool} is in ${ts}, which is not open — ${p.openHint(ts)}`)
  const r = (await h.callTool(tool, args.args ?? {}, { instance })) as { content?: Block[]; isError?: boolean }
  return { content: Array.isArray(r?.content) ? r.content : [{ type: 'text', text: JSON.stringify(r) }], ...(r?.isError ? { isError: true } : {}) }
}

/** look restates the present: titles and visibility are re-read from the servers first (toolsets/list). */
async function look(handles: Map<string, McplServerHandle>, args: Record<string, unknown>): Promise<MetaResult> {
  const server = str(args.server)
  const tool = str(args.tool)
  const targets = server ? [handles.get(server)].filter((h): h is McplServerHandle => !!h && h.presence.presents) : presenting(handles)
  const notes = (await Promise.all(targets.map(h => h.refreshOpen().catch(() => [] as string[])))).flat()
  const withNotes = (r: MetaResult): MetaResult => (notes.length && !r.isError ? { ...r, content: [...r.content, { type: 'text', text: notes.join('\n') }] } : r)
  return withNotes(lookNow(handles, args, server, tool))
}

function lookNow(handles: Map<string, McplServerHandle>, args: Record<string, unknown>, server: string | undefined, tool: string | undefined): MetaResult {
  if (!server) {
    const hs = presenting(handles)
    if (tool) {
      const owners = hs.filter(h => h.presence.tool(tool))
      if (owners.length === 1) return lookTool(owners[0]!, tool, str(args.instance))
      fail(owners.length ? `several servers have "${tool}": ${owners.map(h => h.id).join(', ')} — add server` : `no server with toolsets has a tool "${tool}"`)
    }
    if (!hs.length) return text('No bridged server has toolsets or dynamic tools; every tool is in your tool list.')
    return text(hs.map(h => h.presence.catalog()).join('\n\n'))
  }
  const h = pick(handles, server)
  if (tool) return lookTool(h, tool, str(args.instance))
  const p = h.presence
  let toolset = str(args.toolset)
  const instance = str(args.instance)
  if (!toolset && instance) toolset = p.openRecords().find(o => o.instance === instance)?.toolset ?? fail(`no open instance "${instance}" on ${h.id}`)
  if (!toolset) return text(p.catalog())
  if (p.isOpen(toolset!, instance) || (!instance && p.openRecords(toolset).length === 1)) {
    const rec = p.isDeclared(toolset!) ? (instance ? p.openRecords(toolset).find(o => o.instance === instance) : p.openRecords(toolset)[0]) : undefined
    const key = keyOf(toolset!, rec?.instance)
    const lines = p.toolBlock(key, toolsAt(h, key), { describeAll: true, title: rec?.title })
    const close = p.closeHint(key)
    if (close) lines.push(`${close} closes it.`)
    return text(lines.join('\n'))
  }
  const d = p.declared[toolset!]
  if (d) {
    const open = p.openRecords(toolset)
    return text(
      [
        `${h.id}/${toolset}${d.title ? ` — ${d.title}` : ''}${d.summary ? `: ${d.summary}` : ''}`,
        open.length ? `open: ${open.map(o => o.instance ?? toolset).join(', ')}` : 'not open',
        ...(d.instances ? ['several can be open at once; name each with instance'] : []),
        ...(d.options ? [`options: ${JSON.stringify(d.options)}`] : []),
        `${p.openHint(toolset!)} opens it.`,
      ].join('\n'),
    )
  }
  if (p.undeclaredGroups.includes(toolset!)) {
    const names = p.allTools.filter(t => p.toolsetOf(t.name) === toolset).map(t => t.name)
    return text(`${h.id}/${toolset}: ${names.join(', ')} — not open; ${p.openHint(toolset!)} opens it.`)
  }
  return fail(`${h.id} has no toolset "${toolset}"`)
}

function lookTool(h: McplServerHandle, tool: string, instance: string | undefined): MetaResult {
  const p = h.presence
  if (!p.tool(tool)) fail(`${h.id} has no tool "${tool}"`)
  const ts = p.toolsetOf(tool)
  const v = p.view()
  const where = [...v.entries()].filter(([, e]) => e.tools.has(tool)).map(([k]) => k)
  const key = instance && ts ? keyOf(ts, instance) : where[0]
  const def = key ? p.defOf(key, tool) : p.tool(tool)!
  const status =
    p.presenceOf(tool) === 'static'
      ? `static — ${p.surface ? `call it with act {server:"${h.id}", tool:"${tool}", args}` : `in your tool list as ${h.prefix}__${tool}`}`
      : where.length
        ? `available now in ${where.map(k => p.label(k)).join(', ')} — act {server:"${h.id}", tool:"${tool}"${where.length > 1 ? ', instance' : ''}, args}`
        : `not available right now${ts ? ` (toolset ${ts})` : ''}`
  return text(`${renderToolDefinition(def)}\n${status}`)
}

async function close(handles: Map<string, McplServerHandle>, args: Record<string, unknown>): Promise<MetaResult> {
  const h = pick(handles, args.server)
  const p = h.presence
  let toolset = str(args.toolset)
  let instance = str(args.instance)
  if (!toolset) {
    const open = [...p.openRecords().filter(o => !instance || o.instance === instance), ...(instance ? [] : p.openGroups.map(g => ({ toolset: g, instance: undefined })))]
    if (open.length !== 1) fail(open.length ? `several are open on ${h.id} — name one: ${open.map(o => `${o.toolset}${o.instance ? `:${o.instance}` : ''}`).join(', ')}` : `nothing is open on ${h.id}`)
    toolset = open[0]!.toolset
    instance = open[0]!.instance
  }
  if (p.isDeclared(toolset!)) {
    if (p.declared[toolset!]!.instances && !instance) {
      const open = p.openRecords(toolset)
      if (open.length !== 1) fail(open.length ? `several ${toolset} instances are open (${open.map(o => o.instance).join(', ')}) — say which` : `${toolset} is not open`)
      instance = open[0]!.instance
    }
    let r: Awaited<ReturnType<McplServerHandle['closeToolset']>>
    try {
      r = await h.closeToolset(toolset!, instance)
    } catch (e) {
      fail(`${h.id} did not close ${toolset}${instance ? `:${instance}` : ''}: ${rpcMessage(e)}`)
    }
    const key = keyOf(toolset!, instance)
    const change = p.render(r!.change) || `[${p.label(key)}] closed.`
    return { content: mergeText([...(r!.content as Block[]), { type: 'text', text: change }]) }
  }
  if (p.undeclaredGroups.includes(toolset!)) {
    if (!p.isOpen(toolset!)) fail(`${h.id}/${toolset} is not open`)
    const cs = h.setGroupOpen(toolset!, false)
    return text(p.render(cs) || `[${p.label(keyOf(toolset!))}] closed.`)
  }
  return fail(`${h.id} has no toolset "${toolset}"`)
}

/** Adjacent text blocks merged, so a result reads as one message. */
function mergeText(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    if (b.type === 'text' && !b.text) continue
    const prev = out[out.length - 1]
    if (b.type === 'text' && prev?.type === 'text') out[out.length - 1] = { type: 'text', text: `${prev.text}\n${b.text}` }
    else out.push(b)
  }
  return out
}
