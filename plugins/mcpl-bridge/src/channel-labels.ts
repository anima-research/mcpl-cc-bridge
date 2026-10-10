/**
 * Channel labels — the display form IS the address form.
 *
 * Every place the bridge prints a channel (mcpl_channels, mcpl_status, the
 * `channel="…"` attribute on delivered messages) prints its DISPLAY label, and
 * every place a channel is named (mcpl_send / mcpl_open / mcpl_close) resolves
 * against the same display labels. Two rules keep that safe:
 *
 *  1. Ambiguity is an error. A reference resolves when exactly one channel
 *     answers to it. A channel answers to its server label, its display
 *     label, either minus a trailing ` (qualifier)`, every display label it
 *     was ever shown with, and its id. Two or more is an error naming each
 *     match; no form ever wins over another, because a "best guess" is a
 *     silent wrong-room delivery.
 *  2. Labels are disambiguated actively, so (1) never strands a channel. A
 *     server's label is shown as-is unless it would also answer for another
 *     channel — an exact duplicate, a bare label beside a qualified sibling
 *     (`general` / `general (Guild)`), a label equal to another channel's id.
 *     Such a channel is shown with its id appended (`general (discord:1234)`)
 *     and, if even that is taken (ids differing only in case, a look-alike
 *     label), as `id:<id>`. A label beginning with `id:` is shown with a
 *     leading `#` so it never reads as the escape.
 *
 * `id:<id>` is the escape: it means that exact id and nothing else.
 *
 * Display labels are recomputed whenever the registered set changes, so a
 * label can gain a qualifier when a look-alike registers. Because a channel
 * keeps answering to every form it was shown with, a reference printed before
 * then still names its channel — alone, or as an ambiguity error listing the
 * current forms. Never a delivery to the other room.
 */
import type { ChannelDescriptor } from './vendor/mcpl-core/index.js'

/** Map of registered channels that counts its own mutations, so derived views can be cached. */
export class ChannelRegistry extends Map<string, ChannelDescriptor> {
  version = 0
  override set(key: string, value: ChannelDescriptor): this {
    this.version++
    return super.set(key, value)
  }
  override delete(key: string): boolean {
    this.version++
    return super.delete(key)
  }
  override clear(): void {
    this.version++
    super.clear()
  }
}

export const norm = (s: string) => s.trim().replace(/^#/, '').toLowerCase()
/** A label minus one trailing ` (qualifier)`, normalized. */
export const unqualified = (label: string) => norm(label.replace(/\s*\([^()]*\)\s*$/, ''))

/**
 * What the server called it, as one printable line: control characters and
 * runs of whitespace collapse to a space (a label is printed inside list rows
 * and a channel="…" attribute). Missing, non-string or empty falls back to
 * the id.
 */
export function baseLabel(d: ChannelDescriptor): string {
  const raw = typeof (d as { label?: unknown }).label === 'string' ? d.label : ''
  const l = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return l || d.id
}

export type LabelView = {
  /** channel id → display label */
  labels: Map<string, string>
  /** normalized form → ids of the channels that answer to it */
  keys: Map<string, Set<string>>
}

/** Every channel an unprefixed reference could mean: by any form it answers to, or by exact id. */
function candidates(ref: string, keys: Map<string, Set<string>>, channels: ReadonlyMap<string, unknown>): Set<string> {
  const raw = ref.trim()
  const out = new Set(keys.get(norm(raw)) ?? [])
  if (channels.has(raw)) out.add(raw)
  return out
}

/**
 * Display labels for the registered set.
 *
 * A channel answers to: its server label and that label minus a qualifier,
 * its display label and that minus a qualifier, and — via `shown` — every
 * display label it was ever printed with. Keeping the old forms is what makes
 * a saved reference safe: when labels shift as channels come and go, a form
 * printed earlier still names its channel, so if it now also names another it
 * is an ambiguity error instead of a delivery to the other room.
 *
 * Each channel's display label escalates only as far as it must to answer for
 * that channel alone: the server label; else `label (id)`; else `id:<id>` —
 * the exact, case-sensitive escape, which always resolves to exactly one
 * channel (ids differing only in case can't be told apart by the
 * case-insensitive label match). A label beginning with `id:` is shown with a
 * leading `#` so it never reads as the escape.
 */
export function buildLabelView(channels: ReadonlyMap<string, ChannelDescriptor>, shown: ReadonlyMap<string, ReadonlySet<string>> = new Map()): LabelView {
  const ids = [...channels.keys()]
  const base = new Map(ids.map(id => [id, baseLabel(channels.get(id)!)] as const))
  const plain = (id: string) => {
    const b = base.get(id)!
    return b.startsWith('id:') ? `#${b}` : b
  }
  const stage = new Map(ids.map(id => [id, 0] as const))
  const labelAt = (id: string) => (stage.get(id) === 0 ? plain(id) : stage.get(id) === 1 ? `${plain(id)} (${id})` : `id:${id}`)

  // Each round escalates every channel whose label still answers for another;
  // stages only rise and stop at 2, so this ends within 2n+1 rounds.
  for (let round = 0; ; round++) {
    const labels = new Map(ids.map(id => [id, labelAt(id)] as const))
    const keys = new Map<string, Set<string>>()
    const add = (k: string, id: string) => {
      let set = keys.get(k)
      if (!set) keys.set(k, (set = new Set()))
      set.add(id)
    }
    for (const id of ids) {
      add(norm(base.get(id)!), id)
      add(unqualified(base.get(id)!), id)
      const l = labels.get(id)!
      if (!l.startsWith('id:')) {
        add(norm(l), id)
        add(unqualified(l), id)
      }
      for (const k of shown.get(id) ?? []) add(k, id)
    }
    const clashing = ids.filter(id => {
      if (stage.get(id) === 2) return false
      const c = candidates(labels.get(id)!, keys, channels)
      return c.size !== 1 || !c.has(id)
    })
    if (!clashing.length || round > 2 * ids.length) return { labels, keys }
    for (const id of clashing) stage.set(id, stage.get(id)! + 1)
  }
}

export class ChannelRefError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'unknown' | 'ambiguous',
  ) {
    super(message)
  }
}

/** Resolve a reference to a registered channel id (see the module comment for the rules). */
export function resolveChannelRef(ref: string, channels: ReadonlyMap<string, ChannelDescriptor>, view: LabelView, serverId: string): string {
  const raw = ref.trim()
  if (!raw) throw new ChannelRefError(`${serverId}: empty channel reference`, 'empty')
  if (raw.startsWith('id:')) {
    const id = raw.slice(3)
    if (channels.has(id)) return id
    throw new ChannelRefError(`${serverId}: unknown channel id "${id}" (${channels.size} registered — use mcpl_channels to list labels and ids)`, 'unknown')
  }
  const c = [...candidates(raw, view.keys, channels)]
  if (c.length === 1) return c[0]
  if (c.length === 0) {
    throw new ChannelRefError(`${serverId}: unknown channel "${ref}" (${channels.size} registered — use mcpl_channels to list labels and ids)`, 'unknown')
  }
  const options = c.map(id => `"${view.labels.get(id) ?? id}" (id ${id})`).join(', ')
  throw new ChannelRefError(`${serverId}: "${ref}" is ambiguous — ${c.length} channels answer to it. Re-send with one of: ${options}`, 'ambiguous')
}
