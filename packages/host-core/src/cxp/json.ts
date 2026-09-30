/**
 * The JSON value model CXP payloads are expressed in.
 *
 * CXP is newline-delimited JSON, so every value that crosses the socket is
 * one of these. Modelling it explicitly (rather than `any` or `unknown`)
 * is what lets the decoders be exhaustive under `strict` without a cast at
 * every field access — and `noUncheckedIndexedAccess` makes indexing a
 * [JsonObject] yield `JsonValue | undefined`, which is exactly the
 * "field may be absent" the wire format has.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object — the shape of every CXP envelope and payload. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Whether [value] is a JSON object: not null, not an array.
 *
 * Mirrors Dart's `value is Map<String, Object?>` test in `fromJson`. An
 * array is deliberately not an object here — `CxpEnvelope.fromJson`
 * rejects a list-valued `payload` the same way.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * [value] as a JSON array, or `undefined` when it is not one.
 *
 * Decoders that tolerate a missing list (Dart's `elementIdListFromJson`,
 * `PeerIdentity.capabilities`) use this and fall back to empty rather than
 * throwing.
 */
export function asJsonArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** [value] as a string, or `undefined` when it is not one. */
export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * [value] as an integer, or `undefined` when it is not an integral number.
 *
 * JSON has one number type; Dart distinguishes `int` from `double`, so
 * `{"line": 42.0}` is an `int` failure there and an integer here. That
 * difference is a language artifact, not a protocol one — and crux_cxp
 * itself already accepts an integral double for `sequence_index`
 * (`CxpStreamCoordinate.tryFromJson`), so integral-number acceptance is
 * the behaviour the reference implementation reaches for when it has the
 * choice.
 */
export function asInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** [value] as a JSON object, or `undefined` when it is not one. */
export function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}
