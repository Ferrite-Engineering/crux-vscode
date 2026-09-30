import { asString, isJsonObject, type JsonObject, type JsonValue } from './json';

/**
 * A **semantic stream coordinate** — CXP §9.9.
 *
 * An `ElementId` names a design object. It cannot name *one element of a
 * decoded stream*: the 4,132nd retired instruction, transaction #17, frame
 * #900. This does, with three fields and no domain vocabulary.
 *
 * Everything else the sender knows — program counter, opcode, timestamp —
 * travels in [attributes] and is **never identity**. A receiver MUST be
 * able to resolve the coordinate from the triple alone; attributes exist
 * so it can display or cross-check what it found, not so it can find it.
 */
export interface CxpStreamCoordinate {
  /**
   * Which decoded stream this indexes, **and the index space
   * [sequenceIndex] counts in**. An open vocabulary: a receiver that does
   * not implement a stream id ignores the coordinate and honours the rest
   * of the message.
   */
  readonly streamId: string;
  /** The element's position within the stream. Non-negative. */
  readonly sequenceIndex: number;
  /** Lane / channel discriminator — hart, port, virtual channel. */
  readonly subId?: string;
  /** Advisory context. Never required to resolve the coordinate. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** Stream id of the RISC-V RVFI retired-instruction stream (CXP §9.9.2). */
export const RISCV_RVFI_RETIRE_STREAM_ID = 'riscv.rvfi.retire';

/** Stream id of a bounded-proof counterexample trace's step sequence. */
export const RISCV_FORMAL_TRACE_STEP_STREAM_ID = 'riscv.formal.trace_step';

/**
 * Decode a coordinate, or return `undefined` when [json] is not one this
 * peer can act on.
 *
 * **Never throws.** Every malformed shape — a missing `stream_id`, a
 * missing, fractional or negative `sequence_index` — yields `undefined`,
 * matching `CxpStreamCoordinate.tryFromJson`. The coordinate is an
 * optional payload field and §6.1 obliges a receiver to ignore what it
 * does not understand and keep serving the connection; rejecting a whole
 * `notify_selection` because its coordinate was malformed would fail worse
 * than landing at the top of the right artifact.
 *
 * An integral double (`4132.0`) is an index; a fractional one is not an
 * index at all.
 */
export function decodeStreamCoordinate(
  json: JsonValue | undefined,
): CxpStreamCoordinate | undefined {
  if (!isJsonObject(json)) return undefined;
  const streamId = asString(json['stream_id']);
  if (streamId === undefined || streamId.length === 0) return undefined;
  const rawIndex = json['sequence_index'];
  if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0) {
    return undefined;
  }
  const subId = asString(json['sub_id']);
  const rawAttributes = json['attributes'];
  const attributes: Record<string, string> = {};
  if (isJsonObject(rawAttributes)) {
    for (const [key, value] of Object.entries(rawAttributes)) {
      if (typeof value === 'string') attributes[key] = value;
    }
  }
  return {
    streamId,
    sequenceIndex: rawIndex,
    ...(subId !== undefined && subId.length > 0 ? { subId } : {}),
    attributes,
  };
}

/** Encode a coordinate. Optional fields are omitted rather than sent null. */
export function encodeStreamCoordinate(coordinate: CxpStreamCoordinate): JsonObject {
  return {
    stream_id: coordinate.streamId,
    sequence_index: coordinate.sequenceIndex,
    ...(coordinate.subId !== undefined ? { sub_id: coordinate.subId } : {}),
    ...(Object.keys(coordinate.attributes).length > 0
      ? { attributes: { ...coordinate.attributes } }
      : {}),
  };
}

/** Value equality for two coordinates. */
export function streamCoordinateEquals(
  a: CxpStreamCoordinate | undefined,
  b: CxpStreamCoordinate | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a.attributes);
  return (
    a.streamId === b.streamId &&
    a.sequenceIndex === b.sequenceIndex &&
    a.subId === b.subId &&
    aKeys.length === Object.keys(b.attributes).length &&
    aKeys.every((k) => a.attributes[k] === b.attributes[k])
  );
}
