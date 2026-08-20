/**
 * Server manifest changes — SPEC 0.5.0-draft §17 / RFC-003.
 *
 * The **manifest** is the complete `experimental.mcpl` object a server presents
 * at `initialize` (§5.1): flat, capability members at the top level, with
 * `featureSets` as one member among them. There is no nested `capabilities`
 * wrapper — an earlier RFC-003 draft invented one and it was wrong.
 *
 * This module carries the server side:
 *
 *  - {@link manifestDigest} — the normative canonical content digest (§17.2).
 *  - {@link changedDomains} — which of `capabilities | featureSets | tagOntology` moved.
 *  - {@link ManifestTracker} — `setManifest(next)` plus a batch API, per-connection
 *    announcement, and a snapshot to answer `mcpl/manifest` from.
 *
 * What this module deliberately does **not** do: generate resident-facing prose
 * or policy conclusions. The change-impact vocabulary is host-derived
 * (RFC-003 §12) precisely so that what a resident is told about a change is not
 * authored by the party that made it. Nothing here decides anything about a
 * grant; the host validates, diffs, and applies §6.7's existing consequences.
 */

import { createHash } from 'node:crypto';

import type { McplManifest } from './capabilities.js';
import type { ChangeDomain, ManifestChangedParams } from './methods.js';
import { CHANGE_DOMAINS, method } from './methods.js';

// ── RFC 8785 (JCS) canonicalization ──

/**
 * Serialize a JSON value per RFC 8785 (JSON Canonicalization Scheme).
 *
 * Object members are sorted by UTF-16 code units, which is exactly what
 * JavaScript's default string comparison does. Numbers use ECMAScript
 * `Number::toString`, which is what `JSON.stringify` emits. Strings use the
 * JSON escaping `JSON.stringify` produces, which since ES2019 is well-formed.
 *
 * Array **order is not touched here** — set semantics are applied beforehand by
 * {@link normalizeManifestForDigest}, because JCS fixes member order but not
 * array order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize a non-finite number (RFC 8785 has no representation)');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError('Cannot canonicalize `undefined`');
    default:
      break;
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeJson(v === undefined ? null : v)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  // RFC 8785: sort member names by UTF-16 code units — JS default string order.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k])).join(',') + '}';
}

// ── Identifier charset (§17.2) ──

/**
 * Failure codes a digest computation can raise. These are the codes the frozen
 * conformance vectors name (`conformance/manifest-digest-vectors.json`,
 * `errorCodes`).
 */
export type ManifestDigestErrorCode = 'identifier_charset' | 'manifest_not_object';

/**
 * The digest function refuses rather than hashing a manifest it cannot hash
 * interoperably.
 *
 * This is **not** SPEC §6.4's `invalid_uses`, and the difference matters:
 * `invalid_uses` disables one feature set while the manifest still gets a
 * revision, whereas a charset violation means no revision can be computed at
 * all. §17.2 states the ASCII MUST without naming an actor or a failure; the
 * fail-closed reading is that the digester enforces it, because the moment a
 * non-ASCII string reaches a set-valued array the UTF-8/UTF-16 ordering
 * divergence the ASCII rule exists to prevent becomes reachable — and then two
 * conforming libraries can disagree about the same manifest.
 */
export class ManifestDigestError extends Error {
  readonly code: ManifestDigestErrorCode;
  /** Where in the manifest, for diagnostics only. Not part of any contract. */
  readonly path: string;
  readonly value: unknown;

  constructor(code: ManifestDigestErrorCode, path: string, value: unknown) {
    super(`${code}: ${path} = ${JSON.stringify(value)}`);
    this.name = 'ManifestDigestError';
    this.code = code;
    this.path = path;
    this.value = value;
  }
}

/** `[A-Za-z0-9._:*-]`, non-empty, anchored (§17.2). */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:*-]+$/;

export function isManifestIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function requireIdentifier(value: unknown, path: string): void {
  if (!isManifestIdentifier(value)) throw new ManifestDigestError('identifier_charset', path, value);
}

/** Root members that are not capabilities and so are not capability paths (§17.1). */
const NON_CAPABILITY_ROOT_MEMBERS = new Set(['version', 'revision', 'featureSets']);

/**
 * Capability member names are path segments at **every** depth: §5.1 says the
 * advertisement mirrors the capability paths, and §5.4 calls a hardcoded set of
 * nestable keys non-conforming. So `contextHooks.beforeInference.inject.<name>`
 * is validated exactly as `pushEvents` is.
 *
 * Arrays are not descended into: an array element is not a path segment, and
 * §17.2 does not define one. See the PR notes.
 */
function validateCapabilityMembers(node: unknown, prefix: string): void {
  if (!isPlainObject(node)) return;
  for (const [name, child] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${name}` : name;
    requireIdentifier(name, path);
    validateCapabilityMembers(child, path);
  }
}

function validateIdentifierArray(value: unknown, path: string, setValued: boolean): void {
  if (!Array.isArray(value)) return;
  // §17.2 totality, second corollary (adjudicated 2026-08-03): a set-declared
  // array containing ANY non-string member is non-conforming input and is
  // hashed VERBATIM — no sort, no dedupe, and no identifier check. The
  // identifier refusal exists solely to keep the UTF-8/UTF-16 sort divergence
  // unreachable, and an array that will never be sorted cannot diverge.
  // (`set_member_not_string` was an earlier draft's refusal; review struck it.)
  if (setValued && !value.every((entry) => typeof entry === 'string')) return;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    requireIdentifier(entry, `${path}[]`);
  }
}

function validateTagOntology(ontology: unknown, prefix: string): void {
  if (!isPlainObject(ontology)) return;

  validateIdentifierArray(ontology.coreTags, `${prefix}.coreTags`, true);

  if (isPlainObject(ontology.tags)) {
    for (const [tag, descriptor] of Object.entries(ontology.tags)) {
      requireIdentifier(tag, `${prefix}.tags.${tag}`);
      if (!isPlainObject(descriptor)) continue;
      validateIdentifierArray(descriptor.implies, `${prefix}.tags.${tag}.implies`, true);
      if (descriptor.facet !== undefined) {
        requireIdentifier(descriptor.facet, `${prefix}.tags.${tag}.facet`);
      }
    }
  }

  if (isPlainObject(ontology.keyed)) {
    for (const [key, descriptor] of Object.entries(ontology.keyed)) {
      requireIdentifier(key, `${prefix}.keyed.${key}`);
      if (!isPlainObject(descriptor)) continue;
      // `values` is a LIST — order is meaningful (§17.2) — but its entries are
      // still identifiers.
      validateIdentifierArray(descriptor.values, `${prefix}.keyed.${key}.values`, false);
    }
  }

  if (Array.isArray(ontology.suggestedTreatment)) {
    ontology.suggestedTreatment.forEach((rule, i) => {
      if (!isPlainObject(rule)) return;
      for (const matcher of ['tagsAny', 'tagsAll', 'tagsNone'] as const) {
        validateIdentifierArray(rule[matcher], `${prefix}.suggestedTreatment[${i}].${matcher}`, false);
      }
    });
  }
}

/**
 * Enforce §17.2's identifier charset over every position that holds a capability
 * path or a tag identifier. Descriptions (`description`, `desc`) are free text
 * and are deliberately not checked.
 *
 * Throws {@link ManifestDigestError}; returns nothing on success.
 */
export function validateManifestIdentifiers(manifest: unknown): void {
  if (!isPlainObject(manifest)) {
    throw new ManifestDigestError('manifest_not_object', '', manifest);
  }

  for (const [name, value] of Object.entries(manifest)) {
    if (NON_CAPABILITY_ROOT_MEMBERS.has(name)) continue;
    requireIdentifier(name, name);
    validateCapabilityMembers(value, name);
  }

  const featureSets = manifest.featureSets;
  if (!isPlainObject(featureSets)) return; // `true` (host mirror, §5.2) or absent.

  for (const [name, decl] of Object.entries(featureSets)) {
    requireIdentifier(name, `featureSets.${name}`);
    if (!isPlainObject(decl)) continue;
    validateIdentifierArray(decl.uses, `featureSets.${name}.uses`, true);
    validateTagOntology(decl.tagOntology, `featureSets.${name}.tagOntology`);
  }
}

// ── Set-semantic arrays (§17.2) ──

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function compareUtf8(a: string, b: string): number {
  const x = utf8(a);
  const y = utf8(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/**
 * Apply set semantics to an array: duplicates removed, sorted by **UTF-8 byte
 * sequence** ascending (§17.2).
 *
 * Not "code point order" and not a language's default string comparison:
 * JavaScript compares UTF-16 code units and Rust compares UTF-8 bytes, and the
 * two disagree above U+FFFF. Capability paths and tag identifiers are ASCII
 * (`[A-Za-z0-9._:*-]`), where the orders coincide; the UTF-8 rule governs
 * anything else.
 *
 * The digest path never hands this function a non-string member: a
 * set-declared array containing any non-string is hashed **verbatim** (§17.2
 * totality, adjudicated 2026-08-03; see {@link normalizeSetArray}). For direct
 * callers the function stays total anyway, ordering non-string members after
 * all strings by their canonical JSON bytes.
 */
export function sortSetArray(values: readonly unknown[]): unknown[] {
  const strings: string[] = [];
  const others: unknown[] = [];
  const seenStrings = new Set<string>();
  const seenOthers = new Set<string>();

  for (const v of values) {
    if (typeof v === 'string') {
      if (!seenStrings.has(v)) {
        seenStrings.add(v);
        strings.push(v);
      }
    } else {
      const key = canonicalizeJson(v === undefined ? null : v);
      if (!seenOthers.has(key)) {
        seenOthers.add(key);
        others.push(v);
      }
    }
  }

  strings.sort(compareUtf8);
  others.sort((a, b) => compareUtf8(canonicalizeJson(a), canonicalizeJson(b)));
  return [...strings, ...others];
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = cloneJson(v);
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Apply §17.2 set semantics to a set-declared position when — and only when —
 * the value is an all-string array. Anything else (wrong-typed value, or an
 * array with any non-string member) is returned untouched for JCS: the digest
 * is TOTAL, and non-conforming input is hashed verbatim rather than sorted,
 * deduped, or refused (adjudicated 2026-08-03). Validation (§6.4
 * `invalid_uses`) is where such input fails; the digest's job is to give two
 * libraries the same answer for the same bytes.
 */
function normalizeSetArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (!value.every((v) => typeof v === 'string')) return value;
  return sortSetArray(value);
}

function normalizeTagOntologyInPlace(ontology: unknown): void {
  if (!isPlainObject(ontology)) return;

  if (Array.isArray(ontology.coreTags)) {
    ontology.coreTags = normalizeSetArray(ontology.coreTags);
  }
  if (isPlainObject(ontology.tags)) {
    for (const descriptor of Object.values(ontology.tags)) {
      if (isPlainObject(descriptor) && Array.isArray(descriptor.implies)) {
        descriptor.implies = normalizeSetArray(descriptor.implies);
      }
    }
  }
  // `keyed.*.values` is a LIST — order is meaningful and preserved (§17.2).
  // Every other array is a list too, and its order is part of the manifest.
}

function normalizeFeatureSetsInPlace(featureSets: unknown): void {
  if (!isPlainObject(featureSets)) return;
  for (const decl of Object.values(featureSets)) {
    if (!isPlainObject(decl)) continue;
    if (Array.isArray(decl.uses)) decl.uses = normalizeSetArray(decl.uses);
    normalizeTagOntologyInPlace(decl.tagOntology);
  }
}

/**
 * The manifest as the digest sees it (§17.2): a deep copy with `revision`
 * removed — so the digest never covers itself — and set-semantic arrays
 * normalized. Nothing else is stripped; `version` is included, and `false` and
 * `null` members are content, not absence.
 *
 * `revision` is removed from the **root object only**. A nested member of that
 * name is ordinary content and is hashed.
 *
 * Throws {@link ManifestDigestError} when an identifier violates §17.2's
 * charset, rather than producing a revision two libraries could disagree about.
 */
export function normalizeManifestForDigest(manifest: McplManifest | Record<string, unknown>): Record<string, unknown> {
  validateManifestIdentifiers(manifest);
  const out = cloneJson(manifest as Record<string, unknown>);
  delete out.revision;
  normalizeFeatureSetsInPlace(out.featureSets);
  return out;
}

/** The exact canonical bytes hashed by {@link manifestDigest}, as a string. */
export function manifestCanonicalString(manifest: McplManifest | Record<string, unknown>): string {
  return canonicalizeJson(normalizeManifestForDigest(manifest));
}

/**
 * The canonical content digest (§17.2 / RFC-003 §3.1):
 *
 * ```
 * revision = "sha256:" + base64url_unpadded( SHA-256( JCS( manifest_without_revision ) ) )
 * ```
 *
 * Never hand-maintained, never tied to a package version, stable across
 * process restarts.
 */
export function manifestDigest(manifest: McplManifest | Record<string, unknown>): string {
  const canonical = manifestCanonicalString(manifest);
  return 'sha256:' + createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('base64url');
}

const REVISION_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

/** Shape check against App. B.3. Equality is the only defined operation on a revision (§17.1). */
export function isManifestRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value);
}

/** Return a copy of `manifest` carrying its own canonical digest as `revision`. */
export function withRevision<T extends McplManifest>(manifest: T): T {
  const normalized = cloneJson(manifest as Record<string, unknown>);
  delete normalized.revision;
  const revision = manifestDigest(normalized);
  return { ...(normalized as Record<string, unknown>), revision } as T;
}

// ── Domain diffing (§17.1) ──

/**
 * Projections carry **presence separately from value** (§17.3): an absent
 * `featureSets` member and an explicit `featureSets: null` are different
 * manifests — appearance/disappearance IS a change — and `null` is never the
 * sentinel for absence. The wrapper below is what gets canonicalized and
 * compared, so `{present: false}` can never collide with any present value.
 */
type DomainProjection = { present: false } | { present: true; value: unknown };

const ABSENT: DomainProjection = { present: false };

function hasMember(manifest: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(manifest, name);
}

function capabilitiesProjection(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'version' || k === 'revision' || k === 'featureSets') continue;
    out[k] = v;
  }
  return out;
}

function featureSetsProjection(manifest: Record<string, unknown>): DomainProjection {
  if (!hasMember(manifest, 'featureSets')) return ABSENT;
  const fs = manifest.featureSets;
  if (!isPlainObject(fs)) return { present: true, value: fs === undefined ? null : fs };
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(fs)) {
    if (!isPlainObject(decl)) {
      out[name] = decl;
      continue;
    }
    const copy: Record<string, unknown> = { ...decl };
    delete copy.tagOntology;
    out[name] = copy;
  }
  return { present: true, value: out };
}

function tagOntologyProjection(manifest: Record<string, unknown>): DomainProjection {
  if (!hasMember(manifest, 'featureSets')) return ABSENT;
  const fs = manifest.featureSets;
  // The carrier of every tagOntology appeared/disappeared with `featureSets`
  // itself, so its presence tracks the member's — a non-object `featureSets`
  // simply carries no ontologies.
  if (!isPlainObject(fs)) return { present: true, value: null };
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(fs)) {
    if (isPlainObject(decl) && decl.tagOntology !== undefined) out[name] = decl.tagOntology;
  }
  return { present: true, value: out };
}

/**
 * Which of the three domains differ between two manifests (§17.1).
 *
 * | Domain | Members |
 * |---|---|
 * | `capabilities` | every member other than `version`, `revision`, and `featureSets` |
 * | `featureSets` | the `featureSets` member, excluding any `tagOntology` within it |
 * | `tagOntology` | the `tagOntology` of any feature set |
 *
 * `version` and `revision` are not a domain, so a manifest whose only change is
 * `version` yields an empty result.
 *
 * Appearance and disappearance are changes (§17.3): `featureSets` moving
 * between absent and present — even present as an explicit `null` — names
 * `featureSets` and `tagOntology`, because the member (and the carrier of any
 * ontology) appeared. Absence is tracked as presence, never as a `null`
 * sentinel a manifest could legally contain.
 */
export function changedDomains(
  previous: McplManifest | Record<string, unknown> | null | undefined,
  next: McplManifest | Record<string, unknown>,
): ChangeDomain[] {
  if (!previous) return [...CHANGE_DOMAINS];

  const a = normalizeManifestForDigest(previous);
  const b = normalizeManifestForDigest(next);
  const domains: ChangeDomain[] = [];

  if (canonicalizeJson(capabilitiesProjection(a)) !== canonicalizeJson(capabilitiesProjection(b))) {
    domains.push('capabilities');
  }
  if (canonicalizeJson(featureSetsProjection(a)) !== canonicalizeJson(featureSetsProjection(b))) {
    domains.push('featureSets');
  }
  if (canonicalizeJson(tagOntologyProjection(a)) !== canonicalizeJson(tagOntologyProjection(b))) {
    domains.push('tagOntology');
  }
  return domains;
}

// ── ManifestTracker ──

/** Anything that can emit a JSON-RPC notification. `McplConnection` satisfies it. */
export interface ManifestNotifier {
  sendNotification(method: string, params?: unknown): void;
}

export interface AttachOptions {
  /**
   * The revision this connection was last told about — seed it from the
   * `initialize` handshake. Otherwise a fresh connection starts empty and fires
   * a redundant announcement immediately after initialize, which already
   * carried the manifest (RFC-003 §12).
   *
   * Defaults to the tracker's current revision. If the value does not match a
   * manifest this tracker knows, the connection is treated as having an unknown
   * baseline and the next announcement names all three domains — over-naming is
   * safe, since a host that acts on the hint MUST fetch and diff anyway (§17.3).
   */
  announcedRevision?: string;
}

export interface ManifestChange {
  /** Did the canonical digest move? */
  changed: boolean;
  revision: string;
  previousRevision: string;
  /** Domains that differ between the previous and the new manifest. */
  domains: ChangeDomain[];
  /** How many attached connections were sent `mcpl/manifestChanged`. */
  announcedTo: number;
  /** True when the change was folded into an open transaction rather than installed. */
  pending: boolean;
}

interface TrackedConnection {
  notifier: ManifestNotifier;
  /** Manifest snapshot this connection was last told about; null when unknown. */
  lastAnnounced: Record<string, unknown> | null;
  lastAnnouncedRevision: string | null;
}

/**
 * Tracks a server's manifest so a server never hand-authors an announcement: it
 * calls {@link ManifestTracker.setManifest} (or edits inside
 * {@link ManifestTracker.transaction}) and everything else follows —
 * canonicalize, digest, diff to derive changed domains, install atomically,
 * emit per connection, and answer `mcpl/manifest` from the same snapshot.
 *
 * The tracker records **what it announced to each host**. That is a different
 * fact from what a host fetched, validated, negotiated, and delivered, which
 * the host tracks; a server's announcement log is not evidence the host acted
 * on it (RFC-003 §12).
 */
export class ManifestTracker {
  private current: Record<string, unknown>;
  private currentRevision: string;
  private connections = new Map<ManifestNotifier, TrackedConnection>();
  private txDepth = 0;
  private txDraft: Record<string, unknown> | null = null;

  constructor(initial: McplManifest) {
    this.current = normalizeManifestForDigest(initial);
    this.currentRevision = manifestDigest(this.current);
  }

  /** The current canonical content digest. */
  get revision(): string {
    return this.currentRevision;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * The current manifest including its `revision`, as `initialize` and
   * `mcpl/manifest` present it. A fresh copy each call, so a caller cannot
   * mutate the tracker's state by accident.
   */
  snapshot(): McplManifest {
    return { ...cloneJson(this.current), revision: this.currentRevision } as McplManifest;
  }

  /**
   * Answer an `mcpl/manifest` request (§17.4) — the complete current manifest,
   * from the same canonical snapshot the digest and announcements came from.
   * Never a delta.
   */
  handleManifestRequest(): McplManifest {
    return this.snapshot();
  }

  /**
   * Install a new manifest atomically and announce it.
   *
   * Inside a {@link transaction} this replaces the draft instead, so N related
   * edits produce one announcement rather than N intermediate manifests.
   */
  setManifest(next: McplManifest): ManifestChange {
    const normalized = normalizeManifestForDigest(next);

    if (this.txDepth > 0) {
      this.txDraft = normalized;
      return {
        changed: false,
        revision: this.currentRevision,
        previousRevision: this.currentRevision,
        domains: [],
        announcedTo: 0,
        pending: true,
      };
    }

    const revision = manifestDigest(normalized);
    const previousRevision = this.currentRevision;
    if (revision === previousRevision) {
      return { changed: false, revision, previousRevision, domains: [], announcedTo: 0, pending: false };
    }

    const previous = this.current;
    // Atomic install: both fields move together, before anything is emitted.
    this.current = normalized;
    this.currentRevision = revision;

    const domains = changedDomains(previous, normalized);
    const announcedTo = this.announce();

    return { changed: true, revision, previousRevision, domains, announcedTo, pending: false };
  }

  /**
   * Batch API. Mutate the draft (or call {@link setManifest} inside the
   * callback); one announcement is emitted on commit. Nested transactions join
   * the outer one. A throwing callback leaves the installed manifest untouched.
   */
  transaction(edit: (draft: McplManifest) => void | McplManifest): ManifestChange {
    if (this.txDepth > 0) {
      const result = edit(this.txDraft as McplManifest);
      if (result) this.txDraft = normalizeManifestForDigest(result);
      return {
        changed: false,
        revision: this.currentRevision,
        previousRevision: this.currentRevision,
        domains: [],
        announcedTo: 0,
        pending: true,
      };
    }

    this.txDepth = 1;
    this.txDraft = cloneJson(this.current);
    let draft: Record<string, unknown>;
    try {
      const result = edit(this.txDraft as McplManifest);
      draft = result ? normalizeManifestForDigest(result) : (this.txDraft as Record<string, unknown>);
    } finally {
      this.txDepth = 0;
      this.txDraft = null;
    }
    return this.setManifest(draft as McplManifest);
  }

  /**
   * Register a connection to receive `mcpl/manifestChanged`.
   *
   * Returns a detach function. Seed `announcedRevision` from the `initialize`
   * handshake; the default assumes the handshake carried the tracker's current
   * manifest.
   */
  attach(notifier: ManifestNotifier, options: AttachOptions = {}): () => void {
    const seeded = options.announcedRevision ?? this.currentRevision;
    const known = seeded === this.currentRevision;
    this.connections.set(notifier, {
      notifier,
      lastAnnounced: known ? this.current : null,
      lastAnnouncedRevision: known ? this.currentRevision : seeded,
    });
    return () => this.detach(notifier);
  }

  detach(notifier: ManifestNotifier): boolean {
    return this.connections.delete(notifier);
  }

  /**
   * Emit to every connection whose last-announced revision differs. Per-connection
   * domains are diffed against what *that* connection was last told, so a
   * connection that missed intermediate revisions is not under-informed.
   *
   * A revision change that touches no domain (only `version` can do that, since
   * every other non-`revision` member belongs to a domain) is recorded but not
   * announced: App. B.3 requires `domains` to be non-empty, and there is
   * nothing consequential to name.
   */
  private announce(): number {
    let count = 0;
    for (const tracked of this.connections.values()) {
      if (tracked.lastAnnouncedRevision === this.currentRevision) continue;

      const domains = tracked.lastAnnounced
        ? changedDomains(tracked.lastAnnounced, this.current)
        : [...CHANGE_DOMAINS];

      tracked.lastAnnounced = this.current;
      tracked.lastAnnouncedRevision = this.currentRevision;

      if (domains.length === 0) continue;

      const params: ManifestChangedParams = { revision: this.currentRevision, domains };
      tracked.notifier.sendNotification(method.MCPL_MANIFEST_CHANGED, params);
      count++;
    }
    return count;
  }
}
