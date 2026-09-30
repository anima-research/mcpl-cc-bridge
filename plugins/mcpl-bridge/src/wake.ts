/**
 * Wake gate: decides whether a delivery from a bridged server starts a Claude
 * Code turn now, or is held and folded into the next wake as context.
 *
 * Routes on the §16 chat:* tags the host has already closed over (expandTags).
 * Tags are never authority — admission (grant, registered channel) happens
 * before this gate sees a delivery; the gate only decides *timing*. A held
 * delivery is late, not lost: it rides into the next wake for its server as a
 * <held> block, and into the next user turn via the UserPromptSubmit hook.
 *
 * A rule is an AND-set of tags. Evaluation: `wake` rules, then `hold` rules,
 * then the default (wake). An event carrying none of the tags a rule names can
 * not match it, so events outside the chat domain (a heartbeat's own tags, a
 * bare push) keep waking under every policy unless a rule names their tags.
 */
import type { IncomingDelivery } from './mcpl-host'

export type WakeRule = string[]
export type WakePolicy = {
  /** Any rule matching → wake now (checked first). */
  wake?: WakeRule[]
  /** Any rule matching → hold for the next wake. */
  hold?: WakeRule[]
  /** Max held deliveries per server; oldest evicted past this (default 50). */
  holdCap?: number
}
export type WakeConfig = 'all' | 'chat' | WakePolicy

/**
 * Loop-break preset, the discord-mcpl doctrine expressed in tags: DMs wake; a
 * bot addressing the bot (reply or mention) is held, so two agents can't
 * ping-pong each other awake; ambient traffic on an open channel accrues. A
 * mention or reply with no chat:from-* tag at all still wakes — producers that
 * don't tag author kind are outside this rule's reach.
 */
export const CHAT_PRESET: WakePolicy = {
  wake: [['chat:dm']],
  hold: [['chat:from-bot', 'chat:reply'], ['chat:from-bot', 'chat:mention'], ['chat:ambient']],
}

export function resolveWakePolicy(cfg: WakeConfig | undefined): WakePolicy | null {
  if (cfg == null || cfg === 'all') return null
  if (cfg === 'chat') return CHAT_PRESET
  return cfg
}

export type HeldDelivery = {
  delivery: IncomingDelivery
  heldAt: string
  /** Held because it fired mid-turn, not because policy chose to: the harness
   *  drops channel notifications that land inside a live turn, so the copy in
   *  this ledger is (probably) the only one. Marked in the render, and the
   *  gate reports wakePending so the turn boundary re-fires. */
  deferredWake?: true
}

const DEFAULT_HOLD_CAP = 50

export class WakeGate {
  private readonly policy: WakePolicy | null
  private readonly cap: number
  private held: HeldDelivery[] = []
  /** Entries evicted past the cap since the last flush — reported, not hidden. */
  private evicted = 0

  constructor(cfg: WakeConfig | undefined) {
    this.policy = resolveWakePolicy(cfg)
    this.cap = Math.max(1, this.policy?.holdCap ?? DEFAULT_HOLD_CAP)
  }

  get heldCount(): number {
    return this.held.length
  }

  /** True while the ledger holds a delivery that WANTED to wake but fired
   *  during a live turn; cleared by the flush that delivers it. */
  get wakePending(): boolean {
    return this._wakePending
  }
  private _wakePending = false

  /** Inference requests are never held: a server is blocked on the answer. */
  decide(d: IncomingDelivery): 'wake' | 'hold' {
    if (!this.policy) return 'wake'
    if (d.kind === 'inference-request') return 'wake'
    const tags = new Set((d.meta.tags ?? '').split(' ').filter(Boolean))
    const matches = (rule: WakeRule) => rule.length > 0 && rule.every(t => tags.has(t))
    if ((this.policy.wake ?? []).some(matches)) return 'wake'
    if ((this.policy.hold ?? []).some(matches)) return 'hold'
    return 'wake'
  }

  hold(d: IncomingDelivery): void {
    this.held.push({ delivery: d, heldAt: new Date().toISOString() })
    while (this.held.length > this.cap) {
      this.held.shift()
      this.evicted++
    }
  }

  /** Mirror a wake that fired while a turn was live. The notification still
   *  goes out (forward-compat, and it costs nothing), but the harness is
   *  known to drop mid-turn channel pushes (2026-09-22, 2026-09-29), so this
   *  ledger copy is what actually survives to the turn boundary. */
  deferWake(d: IncomingDelivery): void {
    this.held.push({ delivery: d, heldAt: new Date().toISOString(), deferredWake: true })
    while (this.held.length > this.cap) {
      this.held.shift()
      this.evicted++
    }
    this._wakePending = true
  }

  /** Drain everything held into one context block; empty string when nothing is held. */
  flush(server: string): string {
    this._wakePending = false
    if (!this.held.length && !this.evicted) return ''
    const lines = this.held.map(renderHeldLine)
    const attrs = [`server="${server}"`, `count="${this.held.length}"`]
    if (this.evicted) attrs.push(`evicted="${this.evicted}"`)
    this.held = []
    this.evicted = 0
    return [`<held ${attrs.join(' ')}>`, ...lines, '</held>'].join('\n')
  }
}

function renderHeldLine(h: HeldDelivery): string {
  const m = h.delivery.meta
  const stamp = [m.ts || h.heldAt, m.message_id ? `id=${m.message_id}` : ''].filter(Boolean).join(' ')
  const where = m.channel_id ? ` ${m.channel_id}` : ''
  const who = m.author ? ` ${m.author}:` : ''
  const text = h.delivery.text.replace(/\s+/g, ' ').trim()
  const body = text.length > 300 ? `${text.slice(0, 297)}...` : text
  const tags = m.tags ? ` [${m.tags}]` : ''
  const deferred = h.deferredWake ? ' (wake fired mid-turn; this is likely the only copy you get)' : ''
  return `- [${stamp}]${where}${who} ${body}${tags}${deferred}`
}
