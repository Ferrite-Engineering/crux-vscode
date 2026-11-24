/**
 * `wavecrux://open?file=<path>&signal=<name>&t=<time>`: the parser.
 *
 * The port of WaveCrux's `lib/services/links/wavecrux_link.dart`: the same
 * keys, bounds, time grammar and refusals, over host-core's shared link
 * grammar. No `vscode` import and no filesystem.
 */
import { links } from '@crux-vscode/host-core';

/** The URL scheme the WaveCrux desktop app registers. */
export const WAVECRUX_LINK_SCHEME = 'wavecrux';

/** The longest decoded `t` value accepted. */
export const WAVECRUX_LINK_MAX_TIME_LENGTH = 48;

/** The waveform formats a link may open. As the desktop app: no FSDB (it runs a converter), no session, pack or manifest. */
export const WAVECRUX_LINK_EXTENSIONS: ReadonlySet<string> = new Set(['.vcd', '.fst', '.ghw', '.lxt', '.lxt2']);

/** Why a WaveCrux link was refused. */
export type WaveCruxLinkRefusal =
  | links.CruxLinkGrammarRefusal
  /** A `t` that is not a non-negative number with a known unit, or a unit-less value that is not whole ticks. */
  | 'bad-time';

/** A parsed link. */
export interface WaveCruxLink {
  /** The local path, exactly as decoded. Not yet checked against the filesystem. */
  readonly file: string;
  /** The hierarchical signal name to add and select, if any. */
  readonly signal?: string;
  /**
   * Where to put the primary cursor, if anywhere: the `t` value exactly as
   * the link wrote it. It crosses to the waveform panel as CXP's `time`
   * (`request_highlight`, specification §9.3.3), whose grammar is this one.
   */
  readonly time?: string;
  /** The same instant in whole picoseconds, when it is one. */
  readonly timePs?: number;
}

const GRAMMAR: links.CruxLinkGrammar = {
  scheme: WAVECRUX_LINK_SCHEME,
  keys: {
    file: links.CRUX_LINK_MAX_FILE_LENGTH,
    signal: links.CRUX_LINK_MAX_NAME_LENGTH,
    t: WAVECRUX_LINK_MAX_TIME_LENGTH,
  },
};

/** The `t` grammar: digits, an optional fraction, an optional unit. */
const TIME_PATTERN = /^([0-9]{1,24})(?:\.([0-9]{1,24}))?(fs|ps|ns|us|µs|μs|ms|s)?$/u;

const UNIT_EXPONENT: Readonly<Record<string, number>> = {
  fs: -15,
  ps: -12,
  ns: -9,
  us: -6,
  'µs': -6,
  'μs': -6,
  ms: -3,
  s: 0,
};

/** A parsed `t`: digits × 10^exponent seconds, or whole ticks. */
export type WaveCruxLinkTime =
  | { readonly ticks: bigint }
  | { readonly mantissa: bigint; readonly exponent: number };

/**
 * Parses a link's `t` value, or returns `undefined` when it is not one.
 *
 * `1500ns`, `1.5us` and `2s` are times; `µs` and `μs` are accepted beside
 * `us`. A value with no unit is a whole number of ticks in the file's own
 * timescale; a fraction with no unit is refused, because a fraction of a tick
 * names no instant. Negative values are refused.
 */
export function parseWaveCruxLinkTime(value: string): WaveCruxLinkTime | undefined {
  if (value.length > WAVECRUX_LINK_MAX_TIME_LENGTH) return undefined;
  const match = TIME_PATTERN.exec(value);
  if (match === null) return undefined;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const unit = match[3];
  if (unit === undefined) {
    if (fraction.length > 0) return undefined;
    return { ticks: BigInt(whole) };
  }
  return { mantissa: BigInt(`${whole}${fraction}`), exponent: (UNIT_EXPONENT[unit] ?? 0) - fraction.length };
}

/**
 * The picoseconds a time with a unit names, when that is a whole number a
 * JSON number holds exactly; otherwise `undefined` (ticks, a sub-picosecond
 * remainder, or past 2^53).
 *
 * Carried as `crux.time_ps` beside `time`, for a waveform panel that reads only
 * the older key; where both are read, `time` wins (CXP §9.3.3), and the two
 * name the same instant whenever this is defined.
 */
export function wholePicoseconds(time: WaveCruxLinkTime): number | undefined {
  if ('ticks' in time) return undefined;
  const shift = time.exponent + 12;
  let ps: bigint;
  if (shift >= 0) {
    ps = time.mantissa * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (time.mantissa % divisor !== 0n) return undefined;
    ps = time.mantissa / divisor;
  }
  return ps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ps) : undefined;
}

/**
 * Whether the file a link names may be opened, and which file that is once
 * symbolic links resolve: host-core's `vetLinkTarget` with
 * [WAVECRUX_LINK_EXTENSIONS]. [options] exist for tests.
 */
export function vetWaveCruxLinkTarget(
  file: string,
  options: Omit<links.LinkTargetOptions, 'extensions'> = {},
): Promise<links.LinkTargetResult> {
  return links.vetLinkTarget(file, { ...options, extensions: WAVECRUX_LINK_EXTENSIONS });
}

/** Parses [raw], a link in the desktop form, strictly. Never throws, never touches the filesystem. */
export function parseWaveCruxLink(
  raw: string,
): { readonly ok: true; readonly link: WaveCruxLink } | { readonly ok: false; readonly refusal: WaveCruxLinkRefusal } {
  const query = links.parseCruxLinkQuery(raw, GRAMMAR);
  if (!query.ok) return query;
  const file = query.values.get('file') ?? '';
  const signal = query.values.get('signal');
  const rawTime = query.values.get('t');
  let timePs: number | undefined;
  if (rawTime !== undefined) {
    const time = parseWaveCruxLinkTime(rawTime);
    if (time === undefined) return { ok: false, refusal: 'bad-time' };
    timePs = wholePicoseconds(time);
  }
  return {
    ok: true,
    link: {
      file,
      ...(signal !== undefined ? { signal } : {}),
      ...(rawTime !== undefined ? { time: rawTime } : {}),
      ...(timePs !== undefined ? { timePs } : {}),
    },
  };
}
