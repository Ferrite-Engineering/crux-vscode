import { CxpFormatError } from './errors';
import { asString, isJsonObject, type JsonObject, type JsonValue } from './json';

/**
 * The element kinds this version of the protocol defines by name
 * (CXP §8.2).
 *
 * The vocabulary is **open**: this is the list of kinds we model, not the
 * list of kinds that may arrive. See [ElementId].
 */
export const KNOWN_ELEMENT_KINDS = [
  'signal',
  'scope',
  'instance',
  'net',
  'port',
  'marker',
  'rule',
  'test',
  'breakpoint',
  'source',
] as const;

/** One of the element kinds this build models. */
export type KnownElementKind = (typeof KNOWN_ELEMENT_KINDS)[number];

/**
 * An element kind as it appears on the wire.
 *
 * Deliberately `string`, not a union: a peer built against a later
 * revision — or a third-party tool with a vocabulary of its own — may put
 * a kind here that this build has never heard of, and CXP §6.1 requires
 * the reference to survive and round-trip **intact** rather than being
 * dropped or normalised. Narrow with [isKnownElementKind] where
 * exhaustiveness matters.
 */
export type ElementKind = string;

/** Whether [kind] is one of the kinds this build models. */
export function isKnownElementKind(kind: ElementKind): kind is KnownElementKind {
  return (KNOWN_ELEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Opaque, comparable identifier for a cross-tool referenceable element
 * (CXP §8.2).
 *
 * The [path] is canonical and opaque to the protocol: peers cooperating on
 * one design agree on a convention and match by string equality.
 */
export interface ElementId {
  /** What sort of object this is. Open vocabulary — see [ElementKind]. */
  readonly kind: ElementKind;
  /** Canonical hierarchical path identifying the element. */
  readonly path: string;
}

/**
 * Decode an [ElementId].
 *
 * An unrecognised `kind` is **not** an error — that is the whole point of
 * the vocabulary being open. An *empty* kind is, matching
 * `ElementId.fromJson`.
 *
 * @throws {CxpFormatError} on a missing/mistyped or empty `kind`, or a
 * missing/mistyped `path`.
 */
export function decodeElementId(json: JsonObject): ElementId {
  const kind = asString(json['kind']);
  if (kind === undefined) {
    throw new CxpFormatError('ElementId.fromJson: missing "kind"');
  }
  if (kind.length === 0) {
    throw new CxpFormatError('ElementId.fromJson: empty "kind"');
  }
  const path = asString(json['path']);
  if (path === undefined) {
    throw new CxpFormatError('ElementId.fromJson: missing "path"');
  }
  return { kind, path };
}

/** Encode an [ElementId] for a payload. */
export function encodeElementId(element: ElementId): JsonObject {
  return { kind: element.kind, path: element.path };
}

/** Value equality — two ids with the same kind and path are equal. */
export function elementIdEquals(a: ElementId, b: ElementId): boolean {
  return a.kind === b.kind && a.path === b.path;
}

/**
 * Decode a list of element references, skipping entries that are not
 * objects — `elementIdListFromJson` in crux_cxp.
 *
 * A non-list yields an empty list rather than throwing; the *caller*
 * decides whether empty is legal (`notify_selection` says it is not).
 */
export function decodeElementIdList(raw: JsonValue | undefined): ElementId[] {
  if (!Array.isArray(raw)) return [];
  const result: ElementId[] = [];
  for (const entry of raw) {
    if (isJsonObject(entry)) result.push(decodeElementId(entry));
  }
  return result;
}
