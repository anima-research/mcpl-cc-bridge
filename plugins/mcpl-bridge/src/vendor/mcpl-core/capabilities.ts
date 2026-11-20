/**
 * MCPL capability advertisement and grant types (SPEC 0.5.0-draft §5, §6).
 *
 * MCPL extensions ride on MCP's `initialize` handshake under
 * `capabilities.experimental.mcpl`. That object — flat, with capability members
 * at the top level and `featureSets` among them — is the server's **manifest**
 * (§17.1). There is no nested `capabilities` wrapper.
 *
 * Two vocabularies live here and must not be confused:
 *
 *  - The **advertisement** (§5.1) is a recursive tree. A boolean `true` at any
 *    level is shorthand for "every leaf beneath this node"; `false` or absence
 *    means none.
 *  - The **capability paths** (§6.2 / App. B.2) are the closed, dot-separated
 *    vocabulary that `uses` and `effectiveCapabilities` draw on.
 *
 * `effectiveCapabilities` is the sole normative allowlist (§5.4): every path not
 * present is denied. Nothing here is a deny-list and nothing here defaults to
 * allow.
 */

import type { FeatureSetDeclaration, FeatureSetsUpdateParams } from './methods.js';

// ── Capability paths (SPEC §6.2 / App. B.2) ──

/**
 * The complete, closed capability-path vocabulary. This list is normative: a
 * value outside it is not a capability path, and code MUST NOT invent,
 * abbreviate, or derive others.
 */
export const CAPABILITY_PATHS = [
  'pushEvents',
  'tools',
  'modelInfo',
  'inferenceRequest',
  'inferenceRequest.streaming',
  'inferenceLifecycle',

  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.system',
  'contextHooks.beforeInference.inject.beforeUser',
  'contextHooks.beforeInference.inject.afterUser',

  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
  'channels.acknowledge',
  'channels.typing',
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

const CAPABILITY_PATH_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_PATHS);

/** Type guard for the closed §6.2 vocabulary. */
export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && CAPABILITY_PATH_SET.has(value);
}

/**
 * A grant entry (SPEC §5.4): an exact capability path **or** a pattern with
 * `*` wildcards, such as `channels.*` (`*` matches exactly one segment; see
 * {@link capabilityPatternMatches}). Deliberately a plain string rather than a
 * union over {@link CapabilityPath}: the pattern language is open where the
 * path vocabulary is closed, and typing grant carriers as `CapabilityPath[]`
 * rejects legal wildcard grants. `FeatureSetDeclaration.uses`, by contrast,
 * stays closed to exact `CapabilityPath`s — a declaration names what it needs,
 * never a pattern.
 */
export type CapabilityPattern = string;

// ── The advertisement tree, derived from the path vocabulary ──

interface CapabilityNode {
  /** Full dotted path of this node ('' for the root). */
  path: string;
  /** True when this exact path is itself a member of the §6.2 vocabulary. */
  isPath: boolean;
  children: Map<string, CapabilityNode>;
}

function buildCapabilityTree(paths: readonly string[]): CapabilityNode {
  const root: CapabilityNode = { path: '', isPath: false, children: new Map() };
  for (const p of paths) {
    let node = root;
    const segments = p.split('.');
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      let child = node.children.get(seg);
      if (!child) {
        child = {
          path: segments.slice(0, i + 1).join('.'),
          isPath: false,
          children: new Map(),
        };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.isPath = true;
  }
  return root;
}

/**
 * Capability paths that are **never advertised inside `experimental.mcpl`**
 * (SPEC §5.1). `tools` refers to standard MCP `tools/call`, which MCP itself
 * advertises at the OUTER `capabilities.tools` member of `initialize` — the
 * experimental manifest cannot self-advertise it, and a nested `tools: true`
 * is an unrecognised member like any other. The path remains a full member of
 * the §6.2 grant vocabulary; only the advertisement source is restricted.
 * (Mirrors `PATHS_NOT_ADVERTISED_IN_MCPL` in the Rust twin.)
 */
export const PATHS_NOT_ADVERTISED_IN_MCPL: readonly CapabilityPath[] = ['tools'];

/**
 * The advertisement tree. It is *derived* from {@link CAPABILITY_PATHS} rather
 * than hardcoded, because §5.4 requires a generic recursive walk — "a hardcoded
 * set of nestable keys is non-conforming, since the vocabulary is depth 3 and
 * will grow". Paths in {@link PATHS_NOT_ADVERTISED_IN_MCPL} are excluded: they
 * are sourced from the outer `initialize` capabilities, never from the
 * experimental manifest.
 */
const CAPABILITY_TREE = buildCapabilityTree(
  CAPABILITY_PATHS.filter((p) => !PATHS_NOT_ADVERTISED_IN_MCPL.includes(p)),
);

function collectSubtree(node: CapabilityNode, out: Set<CapabilityPath>): void {
  if (node.isPath) out.add(node.path as CapabilityPath);
  for (const child of node.children.values()) collectSubtree(child, out);
}

// ── Advertisement shapes (SPEC §5.1) ──

/**
 * A recursive advertisement value. `true` grants every leaf beneath the node,
 * `false`/absence grants none, and an object descends. Members not present in
 * the §6.2 vocabulary are ignored — absence of a recognised capability is
 * denial, and an unrecognised member cannot create one.
 */
export type CapabilityAdvertisement = boolean | { [member: string]: CapabilityAdvertisement | undefined };

export interface InferenceRequestCap {
  streaming?: boolean;
}

export interface ContextInjectCap {
  system?: boolean;
  beforeUser?: boolean;
  afterUser?: boolean;
}

export interface BeforeInferenceCap {
  observe?: boolean;
  inject?: boolean | ContextInjectCap;
}

export interface ContextHooksCap {
  beforeInference?: boolean | BeforeInferenceCap;
}

/** Channel sub-capabilities (SPEC §14.1). */
export interface ChannelsCap {
  register?: boolean;
  lifecycle?: boolean;
  publish?: boolean;
  incoming?: boolean;
  streaming?: boolean;
  acknowledge?: boolean;
  typing?: boolean;
}

/**
 * The `experimental.mcpl` object — the server's manifest (§5.1, §17.1).
 *
 * Servers key `featureSets` by name (§6.1). Hosts mirror the shape and may
 * advertise `featureSets: true` (§5.2).
 */
export interface McplCapabilities {
  version: string;
  /**
   * Canonical content digest (§17.2). Present only on implementations that
   * support manifest changes; see `src/manifest.ts`. Never hand-maintained,
   * never derived from a package version.
   */
  revision?: string;

  pushEvents?: boolean;
  /**
   * Carried for shape-compatibility only. `tools` is a standard MCP capability
   * advertised at the outer `capabilities.tools`; a nested `tools` member here
   * advertises **nothing** ({@link PATHS_NOT_ADVERTISED_IN_MCPL}). It is still
   * manifest content for the digest (§17.2).
   */
  tools?: boolean;
  modelInfo?: boolean;
  inferenceRequest?: boolean | InferenceRequestCap;
  inferenceLifecycle?: boolean;
  contextHooks?: boolean | ContextHooksCap;
  channels?: boolean | ChannelsCap;

  featureSets?: Record<string, FeatureSetDeclaration> | boolean;

  /**
   * Feature-set-level rollback support (§8.1) is declared per feature set. This
   * connection-level flag has no capability path in §6.2 and therefore confers
   * no authority: {@link advertisedCapabilities} ignores it. Retained because
   * §8 State Management is still in the specification and is out of scope for
   * 0.5.0 (see anima-research/mcpl-core-ts#4 item 7).
   */
  rollback?: boolean;
}

/**
 * The same object viewed as a manifest (§17.1) rather than as a handshake
 * field. Widened with an index signature because servers and hosts MUST
 * tolerate unknown members, and the canonical digest (§17.2) covers whatever is
 * actually there — not just what this library happens to type.
 */
export type McplManifest = McplCapabilities & { [member: string]: unknown };

export interface ExperimentalCapabilities {
  mcpl?: McplCapabilities;
}

export interface InitializeCapabilities {
  experimental?: ExperimentalCapabilities;
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  roots?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
}

export interface McplInitializeParams {
  protocolVersion: string;
  capabilities: InitializeCapabilities;
  clientInfo: ImplementationInfo;
}

export interface McplInitializeResult {
  protocolVersion: string;
  capabilities: InitializeCapabilities;
  serverInfo: ImplementationInfo;
}

export interface ImplementationInfo {
  name: string;
  version: string;
}

// ── Recursive advertisement walk (SPEC §5.1, §5.4) ──

function walkAdvertisement(node: CapabilityNode, value: unknown, out: Set<CapabilityPath>): void {
  if (value === true) {
    collectSubtree(node, out);
    return;
  }
  if (value === null || value === undefined || value === false) return;
  if (typeof value !== 'object') return; // Not a recognised advertisement form: deny.

  // An object at a node that is itself a path advertises that path, then descends.
  if (node.isPath) out.add(node.path as CapabilityPath);

  for (const [member, child] of node.children) {
    if (!Object.prototype.hasOwnProperty.call(value, member)) continue;
    walkAdvertisement(child, (value as Record<string, unknown>)[member], out);
  }
  // Members of `value` that are not in the vocabulary are ignored: an
  // unrecognised name cannot mint a capability.
}

/**
 * Expand a server's or host's `experimental.mcpl` advertisement into the set of
 * capability paths it claims (SPEC §5.1).
 *
 * This is a generic recursive walk over the vocabulary tree, so it keeps
 * working as the vocabulary deepens. It reports what was **advertised** — an
 * input to the host's grant computation, never an authorization (§5.4).
 *
 * `tools` is never in the result: §5.1 sources it only from the outer standard
 * MCP `capabilities.tools`, which this function does not see — use
 * {@link advertisedCapabilitiesFromInitialize} for the full picture.
 */
export function advertisedCapabilities(mcpl: McplCapabilities | undefined | null): Set<CapabilityPath> {
  const out = new Set<CapabilityPath>();
  if (!mcpl || typeof mcpl !== 'object') return out;
  walkAdvertisement(CAPABILITY_TREE, mcpl, out);
  return out;
}

/**
 * Expand an entire `initialize` capabilities object.
 *
 * The `tools` capability path (§6.2) refers to MCP `tools/call`, which MCP
 * advertises at the outer `capabilities.tools` — its **only** source (§5.1).
 * A `tools` member nested inside `experimental.mcpl` is ignored
 * ({@link PATHS_NOT_ADVERTISED_IN_MCPL}): the experimental manifest cannot
 * self-advertise a standard MCP capability.
 */
export function advertisedCapabilitiesFromInitialize(
  caps: InitializeCapabilities | undefined | null,
): Set<CapabilityPath> {
  const out = advertisedCapabilities(caps?.experimental?.mcpl);
  if (caps && caps.tools !== undefined && caps.tools !== null) out.add('tools');
  return out;
}

// ── Grant matching (SPEC §5.4) ──

/**
 * Match a capability path against a grant entry. Matching is over full
 * dot-separated paths with `*` wildcards. **`*` matches exactly one path
 * segment, and segment counts MUST be equal** (SPEC §5.4, pinned 2026-08-02):
 * `channels.*` covers `channels.publish` but NOT `channels.publish.anything`;
 * `contextHooks.*` grants **none** of the depth-4 injection leaves; a bare `*`
 * matches only depth-1 paths. A trailing `*` is NOT a subtree match and there
 * is no multi-segment wildcard — that is the deny-safe reading: a mistaken
 * narrow pattern can only under-grant, which the host observes and corrects,
 * while a suffix wildcard silently widens the grant class §5.4 exists to
 * narrow.
 */
export function capabilityPatternMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const pat = pattern.split('.');
  const seg = path.split('.');
  if (pat.length !== seg.length) return false;
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p !== '*' && p !== seg[i]) return false;
  }
  return true;
}

/**
 * Is `path` present in the effective grant?
 *
 * `effectiveCapabilities` is the sole normative allowlist (§5.4). Absence is
 * denial: this returns `false` for an empty, undefined or unrecognised grant,
 * and it never consults a deny-list. `deniedCapabilities` is diagnostic data
 * only and MUST NOT be passed here.
 */
export function capabilityGranted(
  effectiveCapabilities: readonly string[] | undefined | null,
  path: CapabilityPath | string,
): boolean {
  if (!effectiveCapabilities) return false;
  for (const entry of effectiveCapabilities) {
    if (typeof entry === 'string' && capabilityPatternMatches(entry, path)) return true;
  }
  return false;
}

/**
 * A policy message that lists a path in both `effectiveCapabilities` and
 * `deniedCapabilities` is malformed; §5.4 requires the receiving side to fail
 * closed and reject it. Returns the overlapping entries (empty when well-formed).
 */
export function conflictingCapabilityEntries(
  effectiveCapabilities: readonly string[] | undefined | null,
  deniedCapabilities: readonly string[] | undefined | null,
): string[] {
  if (!effectiveCapabilities || !deniedCapabilities) return [];
  const effective = new Set(effectiveCapabilities);
  return deniedCapabilities.filter((d) => effective.has(d));
}

// ── featureSets/update → grant (SPEC §5.3, §6.7) ──

/**
 * A server's view of the host-issued grant, as established by
 * `featureSets/update` messages. This is the state {@link grantFromUpdate}
 * derives; nothing in it is server-authored.
 */
export interface CapabilityGrantState {
  /**
   * The effective grant entries (§5.4 allowlist; entries are
   * {@link CapabilityPattern}s and may carry `*` wildcards). Empty means
   * nothing is granted — absence is denial.
   */
  effectiveCapabilities: CapabilityPattern[];
  /**
   * Host selection of feature sets by name (§5.3). `null` when the host has
   * not constrained by name — capability derivation (§6.4) alone governs. When
   * present it is an allowlist: a declared feature set it does not name is
   * disabled with reason `not_selected`. Selection narrows; it never supplies
   * capabilities a set's `uses` lacks.
   */
  enabledFeatureSets: string[] | null;
  /** Feature sets the host disabled by name. `disabled` always subtracts. */
  disabledFeatureSets: string[];
  /**
   * True only via a well-formed grant-bearing **Request** (§6.7) — and §6.7's
   * ready state additionally requires that Request to be *answered*: the
   * caller must send the degradation receipt before acting on readiness. A
   * Notification never establishes it.
   */
  ready: boolean;
}

/** The pre-policy state: nothing granted, nothing selected, not ready. */
export function emptyGrantState(): CapabilityGrantState {
  return { effectiveCapabilities: [], enabledFeatureSets: null, disabledFeatureSets: [], ready: false };
}

export interface GrantFromUpdateResult {
  state: CapabilityGrantState;
  /**
   * True when a Request listed a path in both `effectiveCapabilities` and
   * `deniedCapabilities` (§5.4). The receiving side MUST fail closed: the
   * returned state grants nothing and is not ready, and the caller should
   * reject the Request rather than answer it with a receipt.
   */
  malformed: boolean;
  /** The overlapping entries behind `malformed` (diagnostic). */
  conflicts: string[];
  /**
   * Notification form only: grant-bearing fields that were present but
   * discarded per §6.7 (diagnostic). A widening carried by an unacknowledgeable
   * message is never honoured.
   */
  discarded: string[];
}

/**
 * The one message-to-grant step (§5.3, §6.7, pinned 2026-08-02): derive the
 * grant state that follows from a `featureSets/update` message.
 *
 * **Request form** is a full policy statement:
 *
 *  - Absent `effectiveCapabilities` is a **grant of nothing**, never "no
 *    change" — absence is denial (§5.4) and there is no unspecified state;
 *    treating it as no-alteration would leave a previous, wider grant standing.
 *  - Absent `enabled` constrains nothing (`enabledFeatureSets: null`); present
 *    `enabled` is an allowlist that can only narrow.
 *  - `disabled` always subtracts.
 *  - The result establishes ready **once the caller answers the Request**.
 *
 * **Notification form** never alters the grant except applying `disabled`
 * reductions — reductions are respected regardless of carrier — and never
 * establishes ready. Any other grant-bearing field it carries is discarded
 * with a diagnostic (`discarded`), because honouring a widening from an
 * unacknowledgeable message would have the server acting on a path the host
 * cannot know it accepted.
 */
export function grantFromUpdate(
  previous: CapabilityGrantState | null | undefined,
  params: FeatureSetsUpdateParams,
  form: 'request' | 'notification',
): GrantFromUpdateResult {
  const prev = previous ?? emptyGrantState();
  const conflicts = conflictingCapabilityEntries(params.effectiveCapabilities, params.deniedCapabilities);

  if (form === 'notification') {
    const discarded: string[] = [];
    for (const field of ['effectiveCapabilities', 'deniedCapabilities', 'enabled'] as const) {
      if (params[field] !== undefined) discarded.push(field);
    }
    const disabledFeatureSets = [...new Set([...prev.disabledFeatureSets, ...(params.disabled ?? [])])];
    return {
      state: {
        effectiveCapabilities: [...prev.effectiveCapabilities],
        enabledFeatureSets: prev.enabledFeatureSets ? [...prev.enabledFeatureSets] : null,
        disabledFeatureSets,
        ready: prev.ready,
      },
      malformed: false,
      conflicts,
      discarded,
    };
  }

  if (conflicts.length > 0) {
    // §5.4: malformed policy message — fail closed. Nothing granted, not
    // ready; previous reductions are kept because keeping them cannot widen.
    return {
      state: {
        effectiveCapabilities: [],
        enabledFeatureSets: prev.enabledFeatureSets ? [...prev.enabledFeatureSets] : null,
        disabledFeatureSets: [...prev.disabledFeatureSets],
        ready: false,
      },
      malformed: true,
      conflicts,
      discarded: [],
    };
  }

  return {
    state: {
      // Absence is denial: an absent allowlist grants NOTHING (§5.4).
      effectiveCapabilities: [...(params.effectiveCapabilities ?? [])],
      enabledFeatureSets: params.enabled !== undefined ? [...params.enabled] : null,
      disabledFeatureSets: [...(params.disabled ?? [])],
      ready: true,
    },
    malformed: false,
    conflicts: [],
    discarded: [],
  };
}

/**
 * Is a feature set selected by host policy (§5.3)? `disabled` always
 * subtracts; a present `enabled` allowlist must name the set (`not_selected`
 * otherwise); an absent one constrains nothing. Selection is necessary, not
 * sufficient — capability derivation (§6.4, {@link deriveFeatureSets}) still
 * governs availability.
 */
export function featureSetSelected(state: CapabilityGrantState, name: string): boolean {
  if (state.disabledFeatureSets.includes(name)) return false;
  if (state.enabledFeatureSets !== null && !state.enabledFeatureSets.includes(name)) return false;
  return true;
}

// ── `uses` validation (SPEC §6.2, §6.4) ──

export interface UsesValidation {
  valid: boolean;
  /** Populated only when invalid. The single reason §6.6 defines. */
  reason?: 'invalid_uses';
  /** Values outside the §6.2 vocabulary, for diagnostics. */
  unrecognized: string[];
}

/**
 * Validate a feature set's `uses` against the closed vocabulary, fail-closed
 * per §6.4: absent, empty, or containing an unrecognised value is **invalid**,
 * and the host disables the feature set with reason `invalid_uses`. The host
 * does not guess what it meant.
 */
export function validateUses(uses: unknown): UsesValidation {
  if (!Array.isArray(uses) || uses.length === 0) {
    return { valid: false, reason: 'invalid_uses', unrecognized: [] };
  }
  const unrecognized = uses.filter((u) => !isCapabilityPath(u)).map((u) => String(u));
  if (unrecognized.length > 0) return { valid: false, reason: 'invalid_uses', unrecognized };
  return { valid: true, unrecognized: [] };
}

/**
 * Derive feature-set availability from the capability grant (§6.4). A denied
 * capability disables every declared feature set whose `uses` requires it.
 *
 * This is derivation, not authorization: the grant already protects the
 * connection, and an incomplete `uses` never widens anything.
 */
export interface FeatureSetDerivation {
  enabled: string[];
  /** name → why it is unavailable. */
  disabled: Record<string, { reason: 'invalid_uses' | 'capability_denied'; missingCapabilities: string[] }>;
}

export function deriveFeatureSets(
  featureSets: Record<string, FeatureSetDeclaration> | undefined | null,
  effectiveCapabilities: readonly string[] | undefined | null,
): FeatureSetDerivation {
  const result: FeatureSetDerivation = { enabled: [], disabled: {} };
  if (!featureSets) return result;

  for (const [name, decl] of Object.entries(featureSets)) {
    const check = validateUses(decl?.uses);
    if (!check.valid) {
      result.disabled[name] = { reason: 'invalid_uses', missingCapabilities: check.unrecognized };
      continue;
    }
    const missing = (decl.uses as readonly string[]).filter((u) => !capabilityGranted(effectiveCapabilities, u));
    if (missing.length > 0) {
      result.disabled[name] = { reason: 'capability_denied', missingCapabilities: missing };
      continue;
    }
    result.enabled.push(name);
  }
  return result;
}

// ── Convenience predicates ──

export function hasInferenceRequest(caps: McplCapabilities): boolean {
  return advertisedCapabilities(caps).has('inferenceRequest');
}

export function hasInferenceStreaming(caps: McplCapabilities): boolean {
  return advertisedCapabilities(caps).has('inferenceRequest.streaming');
}

/** Extract MCPL capabilities from an initialize result/params, if present. */
export function extractMcpl(caps: InitializeCapabilities): McplCapabilities | undefined {
  return caps.experimental?.mcpl;
}
