/**
 * MCPL method parameter and result types (SPEC 0.5.0-draft).
 *
 * Property names use camelCase matching the JSON wire format.
 */

import type { ContentBlock } from './types.js';
import type { TagOntology } from './tags.js';
import type { CapabilityPath, CapabilityPattern, McplManifest } from './capabilities.js';

// ── Feature Sets (Section 6) ──

/**
 * A feature set declaration (SPEC §6.2, App. B.2). Keyed by name in the
 * manifest's `featureSets` object — the name is the key, not a member.
 *
 * `description` and `uses` are both required. A declaration whose `uses` is
 * absent, empty, or contains a value outside the §6.2 vocabulary is **invalid**
 * and the host disables it with reason `invalid_uses` (§6.4, §6.6).
 */
export interface FeatureSetDeclaration {
  description: string;
  uses: CapabilityPath[];
  /**
   * Rollback support for this feature set (§8.1). Not a capability path and
   * not part of the grant. §8 State Management is out of scope for 0.5.0.
   */
  rollback?: boolean;
  /** Optional, open-world tag ontology the events of this feature set may carry
   *  (MCPL RFC-001 §5 / SPEC §16). A hint catalog — hosts MUST tolerate undeclared tags. */
  tagOntology?: TagOntology;
}

/**
 * featureSets/update (Host → Server, Notification **or** Request — §6.7).
 *
 * Hosts MUST send it as a Request for any change to the effective grant,
 * including initial policy (§5.3). A Notification cannot establish a ready
 * state and is valid only for purely descriptive metadata.
 */
export interface FeatureSetsUpdateParams {
  enabled?: string[];
  disabled?: string[];
  /**
   * The sole normative allowlist (§5.4). Every capability path not present is
   * denied; absence is the denial and there is no unspecified state. Entries
   * are {@link CapabilityPattern}s: exact paths or `*` wildcards such as
   * `channels.*` are both legal grant forms.
   */
  effectiveCapabilities?: CapabilityPattern[];
  /**
   * Derived diagnostic data only (§5.4). MAY be omitted and MUST NOT
   * participate in any authorization decision. A path appearing in both this
   * and `effectiveCapabilities` makes the message malformed and the receiving
   * side MUST fail closed. Entries are {@link CapabilityPattern}s, like
   * `effectiveCapabilities`.
   */
  deniedCapabilities?: CapabilityPattern[];
}

/** One degraded feature in a `featureSets/update` receipt (§6.7). */
export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities: CapabilityPath[];
  effect: string;
}

/**
 * The `featureSets/update` response is a **degradation receipt**, not an
 * acknowledgement (§6.7). It reports what the server *will do*; it does not
 * assert what the server is *entitled to*, and a host MUST NOT widen any grant
 * in response to one.
 */
export type FeatureSetsUpdateResult = FeatureSetsUpdateAccepted | FeatureSetsUpdateRefused;

export interface FeatureSetsUpdateAccepted {
  accepted: true;
  /** SPEC §6.7 attests only `"degraded"`; the enumeration is not otherwise closed. */
  mode?: string;
  unavailableFeatures?: UnavailableFeature[];
  notes?: string[];
}

export interface FeatureSetsUpdateRefused {
  accepted: false;
  /**
   * The consequence the server names for itself. `accepted: false` does not
   * mean close the transport — §3.2 defines the weaker outcome. The host MAY
   * close regardless.
   */
  fallback: 'mcp-only' | 'close';
  missingCapabilities?: CapabilityPath[];
  reason?: string;
}

// ── State Management (Section 8) ──
//
// Out of scope for 0.5.0 (anima-research/mcpl-core-ts#4 item 7). The
// `state/*` and `branches/*` families below have partial or no spec basis and
// are carried unchanged pending a separate decision.

/** state/rollback (Host → Server, Request) */
export interface StateRollbackParams {
  featureSet: string;
  checkpoint: string;
}

export interface StateRollbackResult {
  checkpoint: string;
  success: boolean;
  reason?: string;
  /** Full state at the rolled-back checkpoint (for host-managed state). */
  data?: unknown;
}

/** state/update (Server → Host, Request) — no spec basis; see #4 item 7. */
export interface StateUpdateParams {
  featureSet: string;
  checkpoint: string;
  parent: string | null;
  /** Full state (mutually exclusive with patch). Both absent = opaque checkpoint. */
  data?: unknown;
  /** JSON Patch delta from parent (mutually exclusive with data). */
  patch?: JsonPatchOperation[];
}

export interface StateUpdateResult {
  accepted: boolean;
  reason?: string;
}

/** state/get (Server → Host, Request) — no spec basis; see #4 item 7. */
export interface StateGetParams {
  featureSet: string;
}

export interface StateGetResult {
  checkpoint: string | null;
  data: unknown;
}

/** State checkpoint metadata (Section 8.2) */
export interface StateCheckpoint {
  id: string;
  featureSet: string;
  timestamp: string;
  parent?: string;
  label?: string;
}

/** JSON Patch operation (RFC 6902). */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

/** State included in tool results. */
export interface HostManagedState {
  checkpoint: string;
  patch?: JsonPatchOperation[];
}

// ── Push Events (Section 9) ──

/** push/event (Server → Host, Request) */
export interface PushEventParams {
  featureSet: string;
  eventId: string;
  timestamp: string;
  origin?: unknown;
  /** Semantic classification the host may route on (SPEC §16 / RFC-001). Namespaced,
   *  multi-valued, e.g. ["chat:mention","chat:from-human","discord:role-mention"].
   *  Tags are never authority (§16.6): admission precedes tags. */
  tags?: string[];
  payload: PushEventPayload;
}

export interface PushEventPayload {
  content: ContentBlock[];
}

export interface PushEventResult {
  accepted: boolean;
  inferenceId?: string;
  reason?: string;
}

// ── Context Hooks (Section 10) ──

export interface ModelInfo {
  id: string;
  vendor: string;
  contextWindow: number;
  capabilities: string[];
}

/**
 * Channel context a host MAY include on `context/beforeInference` (SPEC §14.4).
 * The host controls whether to include this field.
 */
export interface BeforeInferenceChannelContext {
  incoming?: { channelId: string; messageId?: string; threadId?: string };
  defaultOutgoing?: { channelId: string };
  candidates?: string[];
}

/** context/beforeInference (Host → Server, Request) */
export interface ContextBeforeInferenceParams {
  inferenceId: string;
  conversationId: string;
  turnIndex: number;
  /**
   * User input. `null` for continued generation, **and `null` whenever
   * `contextHooks.beforeInference.observe` is not granted** (§10.1). The host
   * still invokes the hook for an inject-only server: the hook is how
   * injection happens.
   */
  userMessage?: string | null;
  model: ModelInfo;
  /** SPEC §14.4 — this field belongs to `context/beforeInference`. */
  channels?: BeforeInferenceChannelContext;
}

export interface ContextInjection {
  namespace: string;
  position: ContextInjectionPosition;
  content: string | ContentBlock[];
  metadata?: unknown;
}

export type ContextInjectionPosition = 'system' | 'beforeUser' | 'afterUser';

export interface ContextBeforeInferenceResult {
  /**
   * Server-supplied and NOT an authorization input (§5.4, §6.5). Each returned
   * injection is authorized independently by its typed `position` against the
   * grant current at response-receipt (§10.8).
   */
  featureSet: string;
  contextInjections: ContextInjection[];
}

/**
 * inference/lifecycle (Host → Server, Notification) — SPEC §10.5. Gated on
 * `inferenceLifecycle`. Replaces `context/afterInference`, which is removed in
 * 0.5.0 along with `modifiedResponse` and the blocking hook form.
 *
 * **Metadata only.** It MUST NOT carry message content — no `userMessage`, no
 * `assistantMessage`, no injected context, no tool arguments or results. Those
 * fields do not exist.
 *
 * **Best-effort.** This is an unacknowledged Notification. A host attempts
 * exactly one terminal phase per emitted `started` on every exit path it
 * controls, but a host that loses control MAY never send it. There is no
 * outbox, replay, acknowledgement, or event identity. Consumers MUST dedupe
 * terminals by `inferenceId` and MUST retain a safety timeout for any state
 * machine gated on turn completion.
 */
export interface InferenceLifecycleParams {
  inferenceId: string;
  conversationId: string;
  turnIndex: number;
  phase: InferenceLifecyclePhase;
  /** OPTIONAL; only if `modelInfo` is granted. */
  model?: ModelInfo;
  /** OPTIONAL; `completed` only. */
  usage?: InferenceUsage;
}

export type InferenceLifecyclePhase = 'started' | 'completed' | 'aborted' | 'failed';

export const INFERENCE_LIFECYCLE_TERMINAL_PHASES: readonly InferenceLifecyclePhase[] = [
  'completed',
  'aborted',
  'failed',
];

export function isTerminalLifecyclePhase(phase: string): phase is 'completed' | 'aborted' | 'failed' {
  return (INFERENCE_LIFECYCLE_TERMINAL_PHASES as readonly string[]).includes(phase);
}

// ── Server-Initiated Inference (Section 11) ──

export interface InferenceUsage {
  inputTokens: number;
  outputTokens: number;
}

/** inference/request (Server → Host, Request) */
export interface InferenceRequestParams {
  featureSet: string;
  conversationId?: string;
  stream?: boolean;
  messages: InferenceMessage[];
  preferences?: InferencePreferences;
}

export interface InferenceMessage {
  role: string;
  content: string;
}

export interface InferencePreferences {
  maxTokens?: number;
  temperature?: number;
}

export interface InferenceRequestResult {
  content: string;
  model: string;
  finishReason: string;
  usage: InferenceUsage;
}

/** inference/chunk (Host → Server, Notification) */
export interface InferenceChunkParams {
  requestId: number;
  index: number;
  delta: string;
}

// ── Model Information (Section 12) ──

export type ModelInfoResult = ModelInfo;

// ── Channels (Section 14) ──

export interface ChannelDescriptor {
  id: string;
  type: string;
  label: string;
  direction: ChannelDirection;
  address?: unknown;
  metadata?: unknown;
  /**
   * Server-supplied initial lifecycle preference. Hosts should consult this
   * only when they have no persisted desired state for the channel. It is
   * primarily a migration/bootstrap affordance; subsequent open/close intent
   * belongs to the host's durable channel state.
   */
  initiallyOpen?: boolean;
  /** Optional channel capabilities understood by generic hosts. */
  capabilities?: ChannelCapabilities;
}

export type ChannelDirection = 'outbound' | 'inbound' | 'bidirectional';

export interface ChannelCapabilities {
  history?: {
    maxMessages?: number;
    supportsBeforeMessage?: boolean;
    supportsSinceLastSeen?: boolean;
  };
  acknowledgment?: {
    /** Surface representation, e.g. `reaction` or `read-receipt`. */
    kind?: string;
    /** Whether the caller may request a concrete surface value such as an emoji. */
    supportsValue?: boolean;
  };
}

export interface ChannelHistoryRequest {
  /** Number of messages preceding the anchor to return. Zero means none. */
  limit: number;
  /** Message that prompted the open decision. Excluded from returned history. */
  beforeMessageId?: string;
  /** Ask the server to use its last-delivered cursor when supported. */
  sinceLastSeen?: boolean;
}

/** channels/register (Server → Host, Request) — requires `channels.register`. */
export interface ChannelsRegisterParams {
  channels: ChannelDescriptor[];
}

/**
 * Itemized result for `channels/register` and the Request form of
 * `channels/changed` (SPEC §14.5). One entry per submitted descriptor: the host
 * MUST authorize each descriptor independently, so whole-request acceptance is
 * not expressible.
 */
export interface ChannelDescriptorResult {
  id: string;
  accepted: boolean;
  reason?: string;
}

export interface ChannelsRegisterResult {
  results: ChannelDescriptorResult[];
}

/**
 * channels/changed (Server → Host) — dual-mode (SPEC §14.5). A host whose
 * policy can reject descriptors MUST require the Request form; a server MUST
 * use it when signalled.
 */
export interface ChannelsChangedParams {
  added?: ChannelDescriptor[];
  removed?: string[];
  updated?: ChannelDescriptor[];
}

export type ChannelsChangedResult = ChannelsRegisterResult;

/** channels/list (Either direction, Request) — requires `channels.register`. */
export interface ChannelsListParams {
  [k: string]: never;
}

export interface ChannelsListResult {
  channels: ChannelDescriptor[];
}

/** channels/open (Host → Server, Request) — requires `channels.lifecycle`. */
export interface ChannelsOpenParams {
  /** Exact registered channel id. Preferred over type/address matching. */
  channelId?: string;
  type: string;
  address: unknown;
  metadata?: unknown;
  /** Optional history to return atomically with the open operation. */
  history?: ChannelHistoryRequest;
}

export interface ChannelsOpenResult {
  channel: ChannelDescriptor;
  /** Requested history, oldest first. */
  history?: IncomingChannelMessage[];
  /** True when the server capped or otherwise truncated the requested history. */
  historyTruncated?: boolean;
}

/** channels/close (Host → Server, Request) — requires `channels.lifecycle`. */
export interface ChannelsCloseParams {
  channelId: string;
}

export interface ChannelsCloseResult {
  closed: boolean;
}

/** channels/acknowledge (Host → Server, Request) — requires `channels.acknowledge`. */
export interface ChannelsAcknowledgeParams {
  channelId: string;
  messageId: string;
  /** Surface-agnostic intent such as `seen-not-opening`. */
  intent: string;
  /** Optional surface-specific value, e.g. a Discord emoji. */
  value?: string;
}

export interface ChannelsAcknowledgeResult {
  acknowledged: boolean;
  /** Concrete representation posted by the server, if any. */
  representation?: string;
  reason?: string;
}

/**
 * channels/typing (Host → Server) — requires `channels.typing` (SPEC §14.1).
 * §14 promotes the method and its capability but does not specify a param
 * shape beyond the channel it targets, so only `channelId` is typed here.
 * See the PR notes: the rest is deliberately not invented.
 */
export interface ChannelsTypingParams {
  channelId: string;
}

/**
 * channels/outgoing/chunk (Host → Server, Notification) — requires
 * `channels.streaming`. Advisory only: the authoritative delivery remains
 * `channels/publish`, and a server MUST NOT deliver content to its surface in
 * response to this (§14.5).
 */
export interface ChannelsOutgoingChunkParams {
  inferenceId: string;
  conversationId: string;
  channelId: string;
  index: number;
  delta: string;
}

/**
 * channels/outgoing/complete (Host → Server, Notification) — requires
 * `channels.streaming`. Same opt-in and advisory semantics as the chunk
 * stream. **Delivery is never a side effect of a lifecycle event** (§14.5):
 * hosts SHOULD treat a server-side send triggered by this as a conformance
 * defect.
 */
export interface ChannelsOutgoingCompleteParams {
  inferenceId: string;
  conversationId: string;
  channelId: string;
  content: ContentBlock[];
}

/** channels/publish (Host → Server, Notification or Request) — requires `channels.publish`. */
export interface ChannelsPublishParams {
  conversationId: string;
  channelId: string;
  stream?: boolean;
  content: ContentBlock[];
}

export interface ChannelsPublishResult {
  delivered: boolean;
  messageId?: string;
}

/**
 * channels/incoming (Server → Host, Request) — requires `channels.incoming`,
 * which is deliberately distinct from any "observe" grant: this is server→host
 * content injection plus wake authority. Validated at receipt against the
 * current grant and the actually registered channel (§14.5).
 */
export interface ChannelsIncomingParams {
  messages: IncomingChannelMessage[];
}

export interface IncomingChannelMessage {
  channelId: string;
  messageId: string;
  threadId?: string;
  author: MessageAuthor;
  timestamp: string;
  content: ContentBlock[];
  metadata?: unknown;
  /** Semantic classification the host may route on (SPEC §16 / RFC-001). */
  tags?: string[];
}

export interface MessageAuthor {
  id: string;
  name: string;
}

export interface ChannelsIncomingResult {
  results: IncomingMessageResult[];
}

export interface IncomingMessageResult {
  messageId: string;
  accepted: boolean;
  conversationId?: string;
}

// ── Server Manifest Changes (Section 17 / RFC-003) ──

/** The three change domains that partition the manifest (§17.1). */
export type ChangeDomain = 'capabilities' | 'featureSets' | 'tagOntology';

export const CHANGE_DOMAINS: readonly ChangeDomain[] = ['capabilities', 'featureSets', 'tagOntology'];

/**
 * mcpl/manifestChanged (Server → Host, Notification) — SPEC §17.3.
 *
 * An opaque revision plus the set of changed domains. It carries **no
 * payload** — no diff, no list of what was added or removed, no policy
 * conclusion. No capability path gates it. A host MAY ignore it entirely, and a
 * host that acts on it MUST fetch `mcpl/manifest` before changing anything.
 */
export interface ManifestChangedParams {
  revision: string;
  /** Non-empty subset of `capabilities | featureSets | tagOntology`. */
  domains: ChangeDomain[];
}

/** mcpl/manifest (Host → Server, Request) — takes no params (§17.4). */
export interface ManifestParams {
  [k: string]: never;
}

/**
 * The result of `mcpl/manifest` is the `experimental.mcpl` object itself — the
 * same flat shape `initialize` carries, not a re-wrapped one, and never a
 * delta (§17.4). A server that does not implement the method MUST return an
 * error, not silence (§6.6).
 */
export type ManifestResult = McplManifest;

/**
 * Impact vocabulary for the host's change receipt (§17.6, App. B.4).
 *
 * Exported for hosts. **A server MUST NOT author these** — the vocabulary is
 * host-derived precisely so that what a resident is told about a change is not
 * written by the party that made it (RFC-003 §12).
 */
export type ChangeImpact =
  | 'capability-revoked'
  | 'capability-expansion-pending'
  | 'feature-degraded'
  | 'feature-restored'
  | 'ontology-acceptance-invalidated'
  | 'ontology-reference-undeclared'
  | 'surface-changed';

export type ChangeDisposition = 'applied' | 'decision-needed' | 'informational';

// ── Method Name Constants ──

export const method = {
  INITIALIZE: 'initialize',
  FEATURE_SETS_UPDATE: 'featureSets/update',
  STATE_UPDATE: 'state/update',
  STATE_GET: 'state/get',
  STATE_ROLLBACK: 'state/rollback',
  PUSH_EVENT: 'push/event',
  CONTEXT_BEFORE_INFERENCE: 'context/beforeInference',
  INFERENCE_LIFECYCLE: 'inference/lifecycle',
  INFERENCE_REQUEST: 'inference/request',
  INFERENCE_CHUNK: 'inference/chunk',
  MODEL_INFO: 'model/info',
  CHANNELS_REGISTER: 'channels/register',
  CHANNELS_CHANGED: 'channels/changed',
  CHANNELS_LIST: 'channels/list',
  CHANNELS_OPEN: 'channels/open',
  CHANNELS_CLOSE: 'channels/close',
  CHANNELS_ACKNOWLEDGE: 'channels/acknowledge',
  CHANNELS_TYPING: 'channels/typing',
  CHANNELS_OUTGOING_CHUNK: 'channels/outgoing/chunk',
  CHANNELS_OUTGOING_COMPLETE: 'channels/outgoing/complete',
  CHANNELS_PUBLISH: 'channels/publish',
  CHANNELS_INCOMING: 'channels/incoming',
  MCPL_MANIFEST_CHANGED: 'mcpl/manifestChanged',
  MCPL_MANIFEST: 'mcpl/manifest',
  BRANCHES_LIST: 'branches/list',
  BRANCHES_CURRENT: 'branches/current',
  BRANCHES_CREATE: 'branches/create',
  BRANCHES_SWITCH: 'branches/switch',
  BRANCHES_DELETE: 'branches/delete',
  BRANCHES_CHANGED: 'branches/changed',
} as const;

/**
 * Method → required capability path (SPEC §14.1). Channel methods are
 * authorized by the connection grant keyed on method and channel id — **not**
 * by a `featureSet` field, which channel methods do not carry.
 *
 * `mcpl/manifestChanged` and `mcpl/manifest` are deliberately absent: no
 * capability path gates them (§17.3).
 */
export const CHANNEL_METHOD_CAPABILITIES: Readonly<Record<string, CapabilityPath>> = {
  'channels/register': 'channels.register',
  'channels/changed': 'channels.register',
  'channels/list': 'channels.register',
  'channels/open': 'channels.lifecycle',
  'channels/close': 'channels.lifecycle',
  'channels/publish': 'channels.publish',
  'channels/incoming': 'channels.incoming',
  'channels/outgoing/chunk': 'channels.streaming',
  'channels/outgoing/complete': 'channels.streaming',
  'channels/acknowledge': 'channels.acknowledge',
  'channels/typing': 'channels.typing',
};

// ── Branches (Section 15) ──
//
// Out of scope for 0.5.0 (#4 item 7): no spec basis, carried unchanged.

export interface BranchInfo {
  name: string;
  head: number;
  isCurrent: boolean;
  parent: string | null;
  branchPoint: number | null;
}

export interface BranchesListParams {
  featureSet: string;
}

export interface BranchesListResult {
  branches: BranchInfo[];
}

export interface BranchesCurrentParams {
  featureSet: string;
}

export interface BranchesCurrentResult {
  name: string;
  head: number;
}

export interface BranchesCreateParams {
  featureSet: string;
  name: string;
  from?: string;
  atCheckpoint?: string;
}

export interface BranchesCreateResult {
  accepted: boolean;
  name?: string;
  head?: number;
  reason?: string;
}

export interface BranchesSwitchParams {
  featureSet: string;
  name: string;
}

export interface BranchesSwitchResult {
  accepted: boolean;
  name?: string;
  head?: number;
  previous?: string;
  reason?: string;
}

export interface BranchesDeleteParams {
  featureSet: string;
  name: string;
}

export interface BranchesDeleteResult {
  accepted: boolean;
  name?: string;
  reason?: string;
}

export interface BranchesChangedParams {
  event: 'created' | 'switched' | 'deleted';
  branch: string;
  previous?: string;
  head?: number;
  parent?: string;
}
