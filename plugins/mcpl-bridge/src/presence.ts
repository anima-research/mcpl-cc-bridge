/**
 * MCPL RFC-014 revision 2 — tool presence, toolsets and instances — as one
 * server's state on the host side.
 *
 * The server's tool list stays its whole truth (RFC §2 principle 1); hints
 * say which tools are static (Claude Code's tool list) and which are dynamic
 * (announced in the conversation as they come and go, called through the
 * bridge's `act`). This class keeps, per server:
 *
 *  - the tool definitions (tools/list) and the toolset declarations (manifest);
 *  - which declared toolsets / instances are open (toolsets/open results,
 *    toolsets/list, hint `toolsets` entries) and which undeclared groups the
 *    host has opened itself (RFC §5.4 — the server is never told);
 *  - the server's visibility statements per instance, and definition
 *    overrides, from hint changes applied strictly in `rev` order, each rev
 *    at most once — ONE apply path for open/close results, call results,
 *    accepted pushes' `hints` and `tools/hints`; `tools/list` (`mcpl/rev`)
 *    and `toolsets/list` are full statements that later changes build on.
 *    A reversal or a gap tells the host to recover from both lists (r3 §6.1);
 *  - which definitions the model has been shown, so a tool's first sentence
 *    is said once.
 *
 * Every mutation is bracketed by view() snapshots; diff() turns the
 * difference into what the model reads.
 */
import { objectSignature, renderToolLines, signature, toolDigest, type ToolDef } from './tool-render'

export type ToolsetDecl = { title?: string; summary?: string; default?: 'open' | 'closed'; instances?: boolean; options?: unknown }
export type Suggestion = { toolset: string; instance?: string; action: 'open' | 'close'; reason: string }
export type OpenRecord = { toolset: string; instance?: string; title?: string }
/** RFC-014 §5.3: a toolset that closed while no connection was told. */
export type Ended = { toolset: string; instance?: string; reason: string }
export type Presence = 'static' | 'dynamic'

/** Toolset-less dynamic tools live under this key: always "open", visible per the server. */
export const NO_TOOLSET = ''
export const keyOf = (toolset: string, instance?: string): string => `${toolset}\u0000${instance ?? ''}`
export const splitKey = (key: string): { toolset: string; instance?: string } => {
  const [toolset, instance] = key.split('\u0000')
  return { toolset: toolset ?? '', ...(instance ? { instance } : {}) }
}

type Entry = { title?: string; tools: Map<string, ToolDef> }
/** What the model should be able to use right now: per key, the visible tools. Open-but-empty keys are present with no tools. */
export type View = Map<string, Entry>

export type Change = {
  key: string
  toolset: string
  instance?: string
  title?: string
  opened: boolean
  closed: boolean
  retitled: boolean
  appeared: ToolDef[]
  gone: string[]
  redefined: ToolDef[]
  /** The visible tools after the change. */
  now: ToolDef[]
}
export type ChangeSet = { changes: Change[]; suggest: Suggestion[]; notes: string[] }

export const emptyChange = (): ChangeSet => ({ changes: [], suggest: [], notes: [] })
export const isEmpty = (c: ChangeSet): boolean => !c.changes.length && !c.suggest.length && !c.notes.length

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * RFC-014 r3 §6.1 — servers send changes in rev order; a refused push's
 * changes are restated under a new rev. So:
 *  applied:  a rev above the last applied — applied. `gap` when revs were
 *            skipped that this host never saw (applied, refused or covered):
 *            something may be missing.
 *  covered:  at or below what a full statement (tools/list, toolsets/list)
 *            already reflects — ignored, nothing lost.
 *  reversal: at or below the last applied but newer than any full statement
 *            — ignored, and something is off.
 * A gap or a reversal is the host's cue to recover (re-read both lists).
 */
export type ApplyOutcome = { applied: boolean; covered: boolean; reversal: boolean; gap: boolean; suggest: Suggestion[] }

export class ToolPresence {
  /** Hints are in effect on the current connection: the host advertised toolHints and the server sends hints or declares toolsets. */
  active = false
  declared: Record<string, ToolsetDecl> = {}
  surface: { title?: string; summary?: string } | null = null
  /** Last applied rev — per connection (RFC §6.1), reset at each connect. */
  rev = 0
  /** The highest rev this connection has seen — applied, covered by a list, or carried by a push the host refused. */
  private seen = 0
  /** The rev the latest full statement (tools/list, toolsets/list) reflects. */
  private coveredThrough = 0
  private tools = new Map<string, ToolDef>()
  private open = new Map<string, OpenRecord>()
  private groups = new Set<string>()
  private visible = new Map<string, Set<string>>()
  private defs = new Map<string, Map<string, ToolDef>>()
  private pendingMoves = new Map<string, Presence>()
  private moved = new Map<string, Presence>()
  /** Digests of definitions the model has been shown with their first sentence. */
  readonly shown = new Set<string>()

  constructor(readonly server: string) {}

  // ── connection lifecycle ──

  /** A new connection's handshake: its manifest, and whether the host advertised toolHints. */
  beginConnection(mcpl: Record<string, unknown> | null | undefined, hostHints: boolean): void {
    this.rev = 0
    this.seen = 0
    this.coveredThrough = 0
    // r3 §6.1: hint _meta and tools/hints from a server that did not advertise toolHints are ignored.
    this.active = hostHints && !!mcpl && mcpl.toolHints === true
    this.setManifest(this.active ? mcpl : null)
  }

  /** Toolset declarations and the surface hint, from initialize or a manifest re-fetch. */
  setManifest(mcpl: Record<string, unknown> | null | undefined): void {
    const decl: Record<string, ToolsetDecl> = {}
    if (mcpl && isObj(mcpl.toolsets)) {
      for (const [name, d] of Object.entries(mcpl.toolsets)) {
        if (!isObj(d) || !name) continue
        decl[name] = {
          ...(str(d.title) ? { title: str(d.title) } : {}),
          ...(str(d.summary) ? { summary: str(d.summary) } : {}),
          default: d.default === 'open' ? 'open' : 'closed',
          ...(d.instances === true ? { instances: true } : {}),
          ...(isObj(d.options) ? { options: d.options } : {}),
        }
      }
    }
    this.declared = decl
    this.surface = mcpl && isObj(mcpl.surface) ? { title: str(mcpl.surface.title), summary: str(mcpl.surface.summary) } : null
    // A toolset no longer declared is no longer the server's to track.
    for (const [k, r] of this.open) if (!decl[r.toolset]) this.dropKey(k)
  }

  /** tools/list: every definition, visible or not (RFC §4.1). */
  setTools(list: ToolDef[]): void {
    this.tools = new Map(list.filter(t => t && typeof t.name === 'string').map(t => [t.name, t]))
    for (const set of this.visible.values()) for (const n of [...set]) if (!this.tools.has(n)) set.delete(n)
    // The list's `mcpl/visible` is the server's word for keys the host does not
    // learn per instance: toolset-less dynamic tools, undeclared groups, and
    // declared toolsets without instances. For instance toolsets it can only
    // be an aggregate ("visible in some instance"); per-instance state comes
    // from hint changes.
    for (const t of this.tools.values()) {
      if (this.presenceOf(t.name) !== 'dynamic') continue
      const ts = this.toolsetOf(t.name)
      if (ts && this.declared[ts]?.instances) continue
      this.setVisible(keyOf(ts ?? NO_TOOLSET), t.name, t._meta?.['mcpl/visible'] !== false)
    }
  }

  // ── reading ──

  /** True when this server has anything for the meta-tools: toolsets, dynamic tools, or surface mode. */
  get presents(): boolean {
    if (!this.active) return false
    if (this.surface || Object.keys(this.declared).length) return true
    for (const n of this.tools.keys()) if (this.presenceOf(n) === 'dynamic') return true
    return false
  }

  get allTools(): ToolDef[] {
    return [...this.tools.values()]
  }

  tool(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  toolsetOf(name: string): string | undefined {
    const m = this.tools.get(name)?._meta
    return m && typeof m['mcpl/toolset'] === 'string' && m['mcpl/toolset'] ? (m['mcpl/toolset'] as string) : undefined
  }

  /** static unless hinted dynamic; a toolset wins over any "static" (r3 §4.1); a move applies only at a boundary (applyMoves). */
  presenceOf(name: string): Presence {
    if (!this.active) return 'static'
    if (this.toolsetOf(name)) return 'dynamic'
    const moved = this.moved.get(name)
    if (moved) return moved
    return this.tools.get(name)?._meta?.['mcpl/presence'] === 'dynamic' ? 'dynamic' : 'static'
  }

  isDeclared(toolset: string): boolean {
    return Object.hasOwn(this.declared, toolset)
  }

  /** Undeclared toolset names the server's tools are tagged with (RFC §5.4). */
  get undeclaredGroups(): string[] {
    const out = new Set<string>()
    for (const n of this.tools.keys()) {
      const ts = this.toolsetOf(n)
      if (ts && !this.isDeclared(ts)) out.add(ts)
    }
    return [...out]
  }

  openRecords(toolset?: string): OpenRecord[] {
    return [...this.open.values()].filter(r => toolset === undefined || r.toolset === toolset)
  }

  isOpen(toolset: string, instance?: string): boolean {
    return this.isDeclared(toolset) ? this.open.has(keyOf(toolset, instance)) : this.groups.has(toolset)
  }

  get openGroups(): string[] {
    return [...this.groups]
  }

  /** The definition the model should see for `name` in `key` (a hint `definition` overrides the list's). */
  defOf(key: string, name: string): ToolDef {
    return this.defs.get(key)?.get(name) ?? this.tools.get(name)!
  }

  view(): View {
    const v: View = new Map()
    for (const [key, r] of this.open) v.set(key, { title: r.title, tools: new Map() })
    for (const g of this.groups) if (!this.isDeclared(g)) v.set(keyOf(g), { tools: new Map() })
    for (const name of this.tools.keys()) {
      if (this.presenceOf(name) !== 'dynamic') continue
      const ts = this.toolsetOf(name)
      if (ts && this.isDeclared(ts)) {
        for (const [key, r] of this.open) if (r.toolset === ts && this.visible.get(key)?.has(name)) v.get(key)!.tools.set(name, this.defOf(key, name))
      } else if (ts) {
        // Two controllers (RFC §4.1, §5.4): the host has the group open AND the server says visible.
        const key = keyOf(ts)
        if (this.groups.has(ts) && this.visible.get(key)?.has(name)) v.get(key)!.tools.set(name, this.defOf(key, name))
      } else {
        const key = keyOf(NO_TOOLSET)
        if (this.visible.get(key)?.has(name)) {
          if (!v.has(key)) v.set(key, { tools: new Map() })
          v.get(key)!.tools.set(name, this.defOf(key, name))
        }
      }
    }
    return v
  }

  diff(before: View, after: View): ChangeSet {
    const out = emptyChange()
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key)
      const a = after.get(key)
      const isGroupKey = splitKey(key).toolset !== NO_TOOLSET
      const appeared: ToolDef[] = []
      const redefined: ToolDef[] = []
      for (const [n, d] of a?.tools ?? []) {
        const was = b?.tools.get(n)
        if (!was) appeared.push(d)
        else if (toolDigest(was) !== toolDigest(d)) redefined.push(d)
      }
      const gone = [...(b?.tools.keys() ?? [])].filter(n => !a?.tools.has(n))
      const opened = isGroupKey && !b && !!a
      const closed = isGroupKey && !!b && !a
      const retitled = !!a && !!b && !!a.title && a.title !== b.title
      if (!appeared.length && !redefined.length && !gone.length && !opened && !closed && !retitled) continue
      out.changes.push({ key, ...splitKey(key), title: a?.title ?? b?.title, opened, closed, retitled, appeared, gone, redefined, now: [...(a?.tools.values() ?? [])] })
    }
    return out
  }

  // ── the one apply path ──

  /**
   * Apply a HintChanges (RFC §6.1) from any of its carriers. Strictly in rev
   * order: a rev at or below the last applied is ignored (see ApplyOutcome).
   */
  apply(h: unknown): ApplyOutcome {
    const none = { applied: false, covered: false, reversal: false, gap: false, suggest: [] as Suggestion[] }
    if (!isObj(h) || typeof h.rev !== 'number' || !Number.isFinite(h.rev)) return none
    if (h.rev <= this.coveredThrough) return { ...none, covered: true }
    if (h.rev <= this.rev) return { ...none, reversal: true }
    const gap = h.rev > this.seen + 1
    this.rev = h.rev
    this.seen = Math.max(this.seen, h.rev)
    return { ...none, applied: true, gap, suggest: this.applyBody(h) }
  }

  /** A push the host refused carried this rev: seen, not applied — the server restates its changes under a new rev (r3 §6.1). */
  noteRefused(h: unknown): void {
    if (isObj(h) && typeof h.rev === 'number' && Number.isFinite(h.rev)) this.seen = Math.max(this.seen, h.rev)
  }

  /** tools/list's `_meta["mcpl/rev"]` (RFC-014 §4.1): the list reflects changes through this rev; only later ones apply on top. */
  noteListRev(rev: unknown): void {
    if (typeof rev !== 'number' || !Number.isFinite(rev)) return
    this.coveredThrough = Math.max(this.coveredThrough, rev)
    this.rev = Math.max(this.rev, rev)
    this.seen = Math.max(this.seen, rev)
  }

  private applyBody(h: Record<string, unknown>): Suggestion[] {
    for (const e of arr(h.toolsets)) {
      if (!isObj(e) || !str(e.toolset) || !this.isDeclared(e.toolset as string)) continue // undeclared toolsets are host-local
      const ts = e.toolset as string
      const key = keyOf(ts, this.declared[ts]!.instances ? str(e.instance) : undefined)
      // "open" opens, confirms, or — with a new title for one already open — retitles (RFC-014 §6.1);
      // it may come from another connection of the same principal (§5.6).
      if (e.state === 'open') this.open.set(key, { toolset: ts, ...(this.declared[ts]!.instances && str(e.instance) ? { instance: str(e.instance) } : {}), title: str(e.title) ?? this.open.get(key)?.title })
      else if (e.state === 'closed') this.dropKey(key)
    }
    for (const e of arr(h.tools)) {
      if (!isObj(e) || !str(e.name) || !this.tools.has(e.name as string)) continue
      const name = e.name as string
      // A toolset's tool is dynamic whatever a hint says (r3 §4.1).
      if ((e.presence === 'static' || e.presence === 'dynamic') && !this.toolsetOf(name)) {
        // RFC §4.2: a move applies at a boundary the host chooses (here: compaction); until then the tool stays where it is.
        if (e.presence !== this.presenceOf(name)) this.pendingMoves.set(name, e.presence)
        else this.pendingMoves.delete(name)
      }
      for (const key of this.keysFor(name, str(e.instance))) {
        if (isObj(e.definition) && this.presenceOf(name) === 'dynamic') {
          if (!this.defs.has(key)) this.defs.set(key, new Map())
          this.defs.get(key)!.set(name, this.redefine(name, e.definition))
        }
        if (typeof e.visible === 'boolean') this.setVisible(key, name, e.visible)
      }
    }
    const suggest: Suggestion[] = []
    for (const s of arr(h.suggest)) {
      if (!isObj(s) || !str(s.toolset) || (s.action !== 'open' && s.action !== 'close')) continue
      suggest.push({ toolset: s.toolset as string, ...(str(s.instance) ? { instance: str(s.instance) } : {}), action: s.action, reason: str(s.reason) ?? '' })
    }
    return suggest
  }

  /**
   * A definition from hints changes description, inputSchema and annotations
   * only; the name and everything in _meta (its RFC-008 class above all) stay
   * the listed definition's (r3 §6.1). The result goes through the same
   * rendering and redaction as a listed tool.
   */
  private redefine(name: string, d: Record<string, unknown>): ToolDef {
    const listed = this.tools.get(name)!
    return {
      ...listed,
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
      ...(isObj(d.inputSchema) ? { inputSchema: d.inputSchema } : {}),
      ...(isObj(d.annotations) ? { annotations: d.annotations } : {}),
    }
  }

  /** Where a tool's statement lands. For a toolset with instances, `instance` is required (r3 §6.1); a statement without one is ignored. */
  private keysFor(name: string, instance: string | undefined): string[] {
    const ts = this.toolsetOf(name)
    if (!ts) return [keyOf(NO_TOOLSET)]
    const decl = this.declared[ts]
    if (!decl?.instances) return [keyOf(ts)]
    return instance ? [keyOf(ts, instance)] : []
  }

  private setVisible(key: string, name: string, on: boolean): void {
    let s = this.visible.get(key)
    if (!s) this.visible.set(key, (s = new Set()))
    if (on) s.add(name)
    else s.delete(name)
  }

  private dropKey(key: string): void {
    this.open.delete(key)
    this.visible.delete(key)
    this.defs.delete(key)
  }

  /** The result of a toolsets/open: the instance is open whatever its hints say. */
  noteOpened(toolset: string, instance: string | undefined, title: string | undefined): void {
    if (!this.isDeclared(toolset)) return
    const key = keyOf(toolset, this.declared[toolset]!.instances ? instance : undefined)
    this.open.set(key, { toolset, ...(this.declared[toolset]!.instances && instance ? { instance } : {}), title: title ?? this.open.get(key)?.title })
  }

  /** toolsets/close succeeded: it is closed whatever the hints said. */
  noteClosed(toolset: string, instance: string | undefined): void {
    this.dropKey(keyOf(toolset, this.declared[toolset]?.instances ? instance : undefined))
  }

  /**
   * toolsets/list (RFC §5.3): what the principal has open, with the full hint
   * state of their tools — the truth for declared toolsets. Anything the host
   * believed open and the server does not report is closed (never re-opened
   * here: opening can start a new game). Returns what was lost, and what the
   * server says ended while no connection was told.
   */
  adopt(result: unknown): { lost: OpenRecord[]; ended: Ended[]; suggest: Suggestion[] } {
    const had = [...this.open.values()]
    for (const k of [...this.open.keys()]) this.dropKey(k)
    for (const k of [...this.visible.keys()]) if (this.isDeclared(splitKey(k).toolset) && this.declared[splitKey(k).toolset]!.instances) this.dropKey(k)
    const r = isObj(result) ? result : {}
    for (const o of arr(r.open)) {
      if (!isObj(o) || !str(o.toolset)) continue
      this.noteOpened(o.toolset as string, str(o.instance), str(o.title))
    }
    let suggest: Suggestion[] = []
    const h = isObj(r._meta) ? r._meta['mcpl/hints'] : undefined
    if (isObj(h)) {
      // A full statement, not a delta: applied whatever its rev, and later changes build on it.
      suggest = this.applyBody(h)
      this.noteListRev(h.rev)
    }
    const ended: Ended[] = []
    for (const e of arr(r.ended)) {
      if (!isObj(e) || !str(e.toolset)) continue
      ended.push({ toolset: e.toolset as string, ...(str(e.instance) ? { instance: str(e.instance) } : {}), reason: str(e.reason) ?? '' })
    }
    return { lost: had.filter(o => !this.open.has(keyOf(o.toolset, o.instance))), ended, suggest }
  }

  /** What the agent should hear about an adoption: what ended while it was away, and what is closed now. */
  adoptionNotes(lost: OpenRecord[], ended: Ended[]): string[] {
    const notes: string[] = []
    const endedKeys = new Set(ended.map(e => keyOf(e.toolset, e.instance)))
    for (const e of ended) notes.push(`[${this.label(keyOf(e.toolset, e.instance))}] ended while you were away${e.reason ? `: ${e.reason}` : ''}.`)
    for (const o of lost) {
      if (endedKeys.has(keyOf(o.toolset, o.instance))) continue
      notes.push(`[${this.label(keyOf(o.toolset, o.instance))}] is closed: ${this.server} no longer has it open. ${this.openHint(o.toolset)} starts a new one.`)
    }
    return notes
  }

  // ── host-made opens of undeclared groups (RFC §5.4) ──

  openGroup(g: string): void {
    this.groups.add(g)
  }

  closeGroup(g: string): void {
    this.groups.delete(g)
  }

  // ── boundaries ──

  /** Apply pending static↔dynamic moves (RFC §4.2). Returns what moved, for the reminder. */
  applyMoves(): Array<{ name: string; to: Presence }> {
    const out: Array<{ name: string; to: Presence }> = []
    for (const [name, to] of this.pendingMoves) {
      if (!this.tools.has(name)) continue
      this.moved.set(name, to)
      out.push({ name, to })
    }
    this.pendingMoves.clear()
    return out
  }

  /** The model's context lost the announcements (compaction): describe everything again next time. */
  forgetShown(): void {
    this.shown.clear()
  }

  // ── rendering ──

  label(key: string): string {
    const { toolset, instance } = splitKey(key)
    return `${this.server}${toolset ? `/${toolset}` : ''}${instance ? `:${instance}` : ''}`
  }

  callHint(key: string): string {
    const { instance } = splitKey(key)
    return `act {server:"${this.server}"${instance ? `, instance:"${instance}"` : ''}, tool, args}`
  }

  closeHint(key: string): string | null {
    const { toolset, instance } = splitKey(key)
    if (!toolset) return null
    return `close {server:"${this.server}", toolset:"${toolset}"${instance ? `, instance:"${instance}"` : ''}}`
  }

  openHint(toolset: string, instance?: string): string {
    return `open {server:"${this.server}", toolset:"${toolset}"${instance ? `, instance:"${instance}"` : ''}}`
  }

  /** The tool block for one key: "tools now — act …:" and the visible tools (new or changed ones described). */
  toolBlock(key: string, tools: ToolDef[], opts: { describeAll?: boolean; headed?: boolean; title?: string } = {}): string[] {
    const head = opts.headed === false ? '' : `[${this.label(key)}]${opts.title ? ` ${opts.title}` : ''} `
    if (!tools.length) return [`${head}no tools available right now.`]
    return [`${head}tools now — ${this.callHint(key)}:`, ...renderToolLines(tools, this.shown, { describeAll: opts.describeAll })]
  }

  /** What the model reads for a change set. `bare`: keys whose header the caller already printed. */
  render(cs: ChangeSet, opts: { bare?: string } = {}): string {
    const lines: string[] = []
    for (const c of cs.changes) {
      const bare = opts.bare === c.key
      if (c.closed) {
        lines.push(`[${this.label(c.key)}] closed.${c.gone.length ? ` Now unavailable: ${c.gone.join(', ')}.` : ''}`)
        continue
      }
      const title = (c.opened || c.retitled) && !bare ? c.title : undefined
      const setChanged = c.opened || c.appeared.length > 0 || c.redefined.length > 0 || c.gone.length > 0
      if (setChanged) lines.push(...this.toolBlock(c.key, c.now, { headed: !bare, title }))
      else if (title) lines.push(`[${this.label(c.key)}] ${title}`)
      if (c.gone.length) lines.push(`now unavailable: ${c.gone.join(', ')}`)
      if (c.opened && !bare) {
        const close = this.closeHint(c.key)
        if (close) lines.push(`${close} closes it.`)
      }
    }
    for (const s of cs.suggest) lines.push(this.renderSuggestion(s))
    lines.push(...cs.notes)
    return lines.join('\n')
  }

  renderSuggestion(s: Suggestion): string {
    const what = `${s.toolset}${s.instance ? `:${s.instance}` : ''}`
    const how = s.action === 'open' ? this.openHint(s.toolset, s.instance) : this.closeHint(keyOf(s.toolset, s.instance))
    return `${this.server} suggests ${s.action === 'open' ? 'opening' : 'closing'} ${what}${s.reason ? `: ${s.reason}` : ''} — ${how} if you want to (nothing was done).`
  }

  /** RFC §8.3 reminder: what is open, its current tools (described), how to call and close. Null when nothing is open. */
  reminder(): string | null {
    const v = this.view()
    if (!v.size) return null
    const lines: string[] = []
    for (const [key, e] of v) {
      lines.push(...this.toolBlock(key, [...e.tools.values()], { describeAll: true, title: e.title }))
      const close = this.closeHint(key)
      if (close) lines.push(`  ${close} closes it.`)
    }
    return lines.join('\n')
  }

  /** look {server}: what is open (with tools), what can be opened, and — in surface mode — the static tools reached through act. */
  catalog(): string {
    const lines: string[] = []
    const intro = this.surface ? `${this.server} — ${[this.surface.title, this.surface.summary].filter(Boolean).join(': ')} (everything through open/act/look/close)` : `${this.server}`
    lines.push(intro)
    const v = this.view()
    if (v.size) {
      for (const [key, e] of v) {
        lines.push(...this.toolBlock(key, [...e.tools.values()], { describeAll: true, title: e.title }).map(l => `  ${l}`))
        const close = this.closeHint(key)
        if (close) lines.push(`    ${close} closes it.`)
      }
    } else lines.push('  nothing open')
    const openable: string[] = []
    for (const [name, d] of Object.entries(this.declared)) {
      if (!d.instances && this.isOpen(name)) continue
      openable.push(
        `  ${name}${d.title ? ` — ${d.title}` : ''}${d.summary ? `: ${d.summary}` : ''}` +
          (d.instances ? ' (several can be open at once; name each with instance)' : '') +
          (d.options ? ` · options ${objectSignature(d.options)}` : ''),
      )
    }
    for (const g of this.undeclaredGroups) {
      if (this.groups.has(g)) continue
      const names = this.allTools.filter(t => this.toolsetOf(t.name) === g).map(t => t.name)
      openable.push(`  ${g}: ${names.join(', ')}`)
    }
    if (openable.length) lines.push(`can open — open {server:"${this.server}", toolset, instance?, options?}:`, ...openable)
    if (this.surface) {
      const statics = this.allTools.filter(t => this.presenceOf(t.name) === 'static')
      if (statics.length) lines.push(`tools — act {server:"${this.server}", tool, args}:`, ...statics.map(t => `  ${signature(t)}`))
    }
    return lines.join('\n')
  }
}
