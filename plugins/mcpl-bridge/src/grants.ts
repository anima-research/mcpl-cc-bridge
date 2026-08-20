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

export function computeGrant(advertised: ReadonlySet<CapabilityPath>, policy: readonly string[]): CapabilityPath[] {
  return [...advertised].filter(p => policy.some(pat => capabilityPatternMatches(pat, p)))
}

export function granted(grant: readonly string[], path: string): boolean {
  return grant.some(pat => capabilityPatternMatches(pat, path))
}

/** Server → Host methods and the capability that admits them. null = ungated. */
const NON_CHANNEL_METHOD_CAPS: Record<string, string | null> = {
  'push/event': 'pushEvents',
  'inference/request': 'inferenceRequest',
  'model/info': 'modelInfo',
  'mcpl/manifestChanged': null, // deliberately ungated (§17.3)
  'notifications/tools/list_changed': null,
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
  return [...set]
}

export const ERR = {
  FEATURE_SET_NOT_ENABLED: -32001,
  CAPABILITY_DENIED: -32002,
  METHOD_NOT_FOUND: -32601,
} as const
