/**
 * Channel labels — the display form IS the address form.
 *
 * Every place the bridge prints a channel (mcpl_channels, mcpl_status, the
 * `channel="…"` attribute on delivered messages) prints its DISPLAY label, and
 * every place a channel is named (mcpl_send / mcpl_open / mcpl_close) resolves
 * against the same display labels. Two rules keep that safe:
 *
 *  1. Ambiguity is an error. A reference resolves when exactly one channel
 *     answers to it — by display label, by display label minus a trailing
 *     ` (qualifier)`, or by id. Two or more is an error naming each match; no
 *     form ever wins over another, because a "best guess" is a silent
 *     wrong-room delivery.
 *  2. Labels are disambiguated actively, so (1) never strands a channel. A
 *     server's label is used as-is unless the reference it prints would also
 *     answer for another channel — an exact duplicate, a bare label beside a
 *     qualified sibling (`general` / `general (Guild)`), a label equal to
 *     another channel's id. Each such channel is shown with its id appended
 *     (`general (discord:1234)`), which no other channel answers to. A
 *     label that begins with `id:` is shown with a leading `#` so it never
 *     reads as the id escape.
 *
 * `id:<id>` is the escape: it means the id and nothing else.
 *
 * Display labels are recomputed whenever the registered set changes, so a
 * label can gain a qualifier when a look-alike registers. A reference printed
 * before then either still resolves to its channel or is an ambiguity error
 * listing the current forms — never a delivery to the other room.
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

/** What the server called it; a missing or non-string label falls back to the id. */
export function baseLabel(d: ChannelDescriptor): string {
  const l = typeof (d as { label?: unknown }).label === 'string' ? d.label.trim() : ''
  return l || d.id
}

export type LabelView = {
  /** channel id → display label */
  labels: Map<string, string>
  /** normalized display label → ids */
  full: Map<string, Set<string>>
  /** normalized display label minus its trailing qualifier → ids */
  unq: Map<string, Set<string>>
}

function indexLabels(labels: Map<string, string>): LabelView {
  const full = new Map<string, Set<string>>()
  const unq = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, id: string) => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set()))
    s.add(id)
  }
  for (const [id, l] of labels) {
    add(full, norm(l), id)
    add(unq, unqualified(l), id)
  }
  return { labels, full, unq }
}

/** Every channel an (unprefixed) reference could mean: by label, by label minus qualifier, or by id. */
function candidates(ref: string, view: LabelView, channels: ReadonlyMap<string, unknown>): Set<string> {
  const raw = ref.trim()
  const want = norm(raw)
  const out = new Set<string>()
  for (const id of view.full.get(want) ?? []) out.add(id)
  for (const id of view.unq.get(want) ?? []) out.add(id)
  if (channels.has(raw)) out.add(raw)
  return out
}

/** Display labels for the registered set: each one resolves to its own channel and nothing else. */
export function buildLabelView(channels: ReadonlyMap<string, ChannelDescriptor>): LabelView {
  const labels = new Map<string, string>()
  for (const [id, d] of channels) {
    const l = baseLabel(d)
    labels.set(id, l.startsWith('id:') ? `#${l}` : l)
  }
  // One round settles every realistic case (ids are unique, so "label (id)"
  // collides with nothing); the cap only bounds pathological label/id mixes.
  for (let round = 0; round < 4; round++) {
    const view = indexLabels(labels)
    const clashing = [...labels].filter(([id, l]) => {
      const c = candidates(l, view, channels)
      return c.size !== 1 || !c.has(id)
    })
    if (!clashing.length) return view
    for (const [id, l] of clashing) labels.set(id, `${l} (${id})`)
  }
  return indexLabels(labels)
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
  const c = [...candidates(raw, view, channels)]
  if (c.length === 1) return c[0]
  if (c.length === 0) {
    throw new ChannelRefError(`${serverId}: unknown channel "${ref}" (${channels.size} registered — use mcpl_channels to list labels and ids)`, 'unknown')
  }
  const options = c.map(id => `"${view.labels.get(id) ?? id}" (id ${id})`).join(', ')
  throw new ChannelRefError(`${serverId}: "${ref}" is ambiguous — ${c.length} channels answer to it. Re-send with one of: ${options}`, 'ambiguous')
}
