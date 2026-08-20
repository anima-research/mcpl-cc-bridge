/**
 * Event tags + producer tag ontology (MCPL RFC-001).
 *
 * Tags are a multi-valued, namespaced, *discrete* classification on events
 * (`PushEventParams.tags`, `IncomingChannelMessage.tags`). Producers label what
 * an event is; consumers (hosts) decide how to treat it. A reserved `chat:*`
 * core gives cross-platform portability; per-producer namespaces carry the rest.
 */

/**
 * Recommended portable wake-treatment vocabulary (RFC-001 §6). The actual wake
 * behavior is host-defined; these names map onto a host's gate behaviors
 * (e.g. immediate→always, mute→skip, throttle→rate_limit, sample→passive_sample).
 */
export type TagBehavior =
  | 'immediate' // wake now
  | 'mute' // never wake (the event still enters context)
  | { debounce: number } // ms; wake once after a quiet window
  | { throttle: { perMs: number } } // at most one wake per window
  | { sample: { every: number } }; // wake every Nth match

/** An ordered treatment rule (first-match-wins). Matches on tag sets, composable
 *  with the structural axes a host already knows (source/scope/channel). */
export interface TreatmentRule {
  /** Match if ANY of these tags is present (glob allowed, e.g. `robotics:*`). */
  tagsAny?: string[];
  /** Match only if ALL of these tags are present. */
  tagsAll?: string[];
  /** Match only if NONE of these tags are present. */
  tagsNone?: string[];
  behavior: TagBehavior;
}

/** Descriptor for one producer-namespaced tag (RFC-001 §5.1). All optional. */
export interface TagDescriptor {
  /** Human/agent-readable description. */
  desc?: string;
  /** Group: addressing | sender | content | lifecycle | locus | producer-defined. */
  facet?: string;
  /** Tags this one entails (subsumption; drives implies-expansion, §6.1). */
  implies?: string[];
  /** Per-tag suggested behavior (shorthand for a one-tag rule). */
  defaultTreatment?: TagBehavior;
  stability?: 'stable' | 'experimental' | 'deprecated';
}

/** A `key=value` tag family with a suggested value domain (RFC-001 §5.1). */
export interface KeyedTagDescriptor {
  desc?: string;
  values?: string[];
  /** Ordering hint WITHIN this namespace only — never a cross-server scale. */
  ordered?: boolean;
}

/**
 * A producer's lightweight, open-world tag ontology (RFC-001 §5). A hint
 * catalog, NOT a closed schema — hosts MUST tolerate undeclared tags.
 */
export interface TagOntology {
  /** Reserved `chat:*` core tags this server emits (described by the spec, §4). */
  coreTags?: string[];
  /** Descriptors for this server's own-namespace tags. */
  tags?: Record<string, TagDescriptor>;
  /** `key=value` tag families. */
  keyed?: Record<string, KeyedTagDescriptor>;
  /** Suggested treatment rules, seeded BELOW the consumer's own (§6 precedence). */
  defaultTreatment?: TreatmentRule[];
  /** true ⇒ the server may emit further tags in its namespace(s) beyond these. */
  open?: boolean;
}

/** Reserved cross-platform messaging core vocabulary (RFC-001 §4). */
export const CHAT_TAGS = {
  addressed: 'chat:addressed',
  mention: 'chat:mention',
  reply: 'chat:reply',
  dm: 'chat:dm',
  ambient: 'chat:ambient',
  broadcast: 'chat:broadcast',
  toSelf: 'chat:to-self',
  fromHuman: 'chat:from-human',
  fromBot: 'chat:from-bot',
  fromSelf: 'chat:from-self',
  fromAgent: 'chat:from-agent',
  edited: 'chat:edited',
  deleted: 'chat:deleted',
  reaction: 'chat:reaction',
  reactionRemove: 'chat:reaction-remove',
  hasImage: 'chat:has-image',
  hasAudio: 'chat:has-audio',
  hasFile: 'chat:has-file',
  hasLink: 'chat:has-link',
  command: 'chat:command',
  private: 'chat:private',
  group: 'chat:group',
  thread: 'chat:thread',
} as const;

/**
 * Core subsumption defined by the spec (RFC-001 §4/§6.1): producers emit the
 * specific tag and hosts expand to these umbrellas. Merge with any per-server
 * `TagDescriptor.implies` to form the full implication map.
 */
export const CHAT_TAG_IMPLIES: Record<string, string[]> = {
  'chat:mention': ['chat:addressed'],
  'chat:reply': ['chat:addressed'],
  'chat:dm': ['chat:addressed'],
};

/**
 * Expand a tag set with its transitive `implies` closure (RFC-001 §6.1). Hosts
 * call this at the event boundary before gate matching, so producers may emit
 * only the most specific tag while consumer rules target umbrellas. Additive
 * (never removes tags); cycles are safe.
 *
 * @param tags    the event's emitted tags
 * @param implies merged implication map (e.g. `{...CHAT_TAG_IMPLIES, ...serverOntologyImplies}`)
 */
export function expandTags(tags: string[], implies: Record<string, string[]> = CHAT_TAG_IMPLIES): string[] {
  const out = new Set<string>();
  const stack = [...tags];
  while (stack.length) {
    const t = stack.pop()!;
    if (out.has(t)) continue;
    out.add(t);
    for (const u of implies[t] ?? []) if (!out.has(u)) stack.push(u);
  }
  return [...out];
}
