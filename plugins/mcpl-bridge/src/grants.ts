/**
 * Grant computation and inbound-method enforcement (SPEC §5.4, §6.2).
 *
 * effectiveCapabilities = advertised ∩ operator policy. Absence is denial.
 * The exact-depth `*` rule comes from mcpl-core's capabilityPatternMatches —
 * the canonical implementation the spec pinned after two libraries diverged.
 */
import {
  CHANNEL_METHOD_CAPABILITIES,
  capabilityPatternMatches,
  type CapabilityPath,
} from './vendor/mcpl-core/index.js'

/**
 * Paths a wildcard never grants: the operator must name them exactly.
 * `access.token` (MCPL RFC-015 §4.1) lets a server act as the agent toward
 * any audience the agent can reach — "denied by default … MUST NOT include it
 * in an effective grant unless the operator has granted it to that server
 * explicitly". `access.*` or `*.*` written for something else must not hand
 * it out on the side.
 */
export const EXPLICIT_ONLY_PATHS: ReadonlySet<string> = new Set(['access.token'])

export function computeGrant(advertised: ReadonlySet<CapabilityPath>, policy: readonly string[]): CapabilityPath[] {
  return [...advertised].filter(p =>
    EXPLICIT_ONLY_PATHS.has(p) ? policy.includes(p) : policy.some(pat => capabilityPatternMatches(pat, p)),
  )
}

/**
 * Explicit-only paths the server advertised that a wildcard in the policy
 * would have matched, but that the policy does not name — granted nothing;
 * worth a warning so the operator knows why (RFC-015 §4.1: hosts SHOULD warn
 * when a wildcard is the only thing that would grant it).
 */
export function wildcardOnlyMatches(advertised: ReadonlySet<CapabilityPath>, policy: readonly string[]): string[] {
  return [...advertised].filter(
    p => EXPLICIT_ONLY_PATHS.has(p) && !policy.includes(p) && policy.some(pat => capabilityPatternMatches(pat, p)),
  )
}

export function granted(grant: readonly string[], path: string): boolean {
  return grant.some(pat => capabilityPatternMatches(pat, path))
}

/** Server → Host methods and the capability that admits them. null = ungated. */
const NON_CHANNEL_METHOD_CAPS: Record<string, string | null> = {
  'push/event': 'pushEvents',
  'inference/request': 'inferenceRequest',
  'model/info': 'modelInfo',
  'access/token': 'access.token', // RFC-015 §4.2: authorized by the grant alone, no featureSet
  'mcpl/manifestChanged': null, // deliberately ungated (§17.3)
  'notifications/tools/list_changed': null,
  // RFC-014 §6.1: hints confer nothing and add no uses path. Applying one is
  // ungated; delivering its notification into the conversation needs pushEvents.
  'tools/hints': null,
}

/**
 * Returns the capability required for an inbound method, null when the
 * method is ungated, or undefined when the method is unknown/unsupported.
 */
export function methodCapability(methodName: string): string | null | undefined {
  if (methodName in NON_CHANNEL_METHOD_CAPS) return NON_CHANNEL_METHOD_CAPS[methodName]
  if (methodName in CHANNEL_METHOD_CAPABILITIES) return CHANNEL_METHOD_CAPABILITIES[methodName]
  return undefined
}

/** §16 normative tag closure — applied by the host, never trusted from the producer. */
export function expandTags(tags: readonly string[] | undefined): string[] {
  const set = new Set(tags ?? [])
  if (set.has('chat:mention') || set.has('chat:reply')) set.add('chat:addressed')
  if (set.has('chat:dm')) {
    set.add('chat:addressed')
    set.add('chat:private')
  }
  if (set.has('chat:addressed')) set.delete('chat:ambient')
  // Host rule (not §16): a reaction, edit or delete is channel traffic like
  // any message — ambient unless the producer itself marked it addressed —
  // so a policy that holds ambient holds these too instead of waking on them
  // for matching no rule. A policy can still single some out to wake, e.g.
  // ["chat:reaction", "chat:to-self"] for reactions to the agent's own
  // messages (once the producer tags them chat:to-self).
  if (!set.has('chat:addressed') && ['chat:reaction', 'chat:reaction-remove', 'chat:edited', 'chat:deleted'].some(t => set.has(t))) {
    set.add('chat:ambient')
  }
  return [...set]
}

export const ERR = {
  FEATURE_SET_NOT_ENABLED: -32001,
  CAPABILITY_DENIED: -32002,
  /** RFC-015 §3.3: no identity to mint from, or the identity provider refused. */
  ACCESS_REFUSED: -32040,
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
} as const
