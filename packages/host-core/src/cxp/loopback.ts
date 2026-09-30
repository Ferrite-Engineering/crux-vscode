import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * The host rule every CXP dial is held to — `isCxpLoopbackHost` in crux_cxp.
 *
 * CXP is a same-machine protocol (§1.1, §4.1): a peer MUST NOT listen on a
 * routable interface by default, and the manifest that advertises a peer is a
 * file any process running as the user can write. A dialler that honoured
 * whatever `host` a manifest carried would subscribe to, and stream selection
 * gossip to, any address one 200-byte JSON file named — and hand it a
 * full-duplex link into this window's dispatch stream. So nothing here dials
 * anything outside CXP §10.5's loopback set, and the refusal happens before a
 * socket exists.
 *
 * ### The set, and how it matches crux_cxp
 *
 * §10.5 closes the set, so that no implementation defers to a platform's
 * address parser: what a C library reads as loopback differs between
 * platforms (macOS reads `0127.0.0.1`, `127.000.000.001`, `::00001` and
 * `::1%lo0` as loopback), and a rule that asked one could not be reproduced by
 * another implementation or pinned by a test. crux_cxp implements the set in
 * pure Dart (`cxpLoopbackDialAddress` in `cxp_peer_connector.dart`). After
 * white space around the value is ignored, by Dart's `String.trim`, a host is
 * in it only if it is:
 *
 * - `localhost`, in any ASCII case;
 * - an IPv4 address in `127.0.0.0/8` in RFC 3986's dotted-decimal form, with
 *   no leading zeros; or
 * - `::1`, in any form RFC 3986's `IPv6address` admits, optionally in square
 *   brackets, with no zone identifier.
 *
 * Brackets delimit an IPv6 literal and nothing else: `[127.0.0.1]` and
 * `[localhost]` are refused, as is an IPv4-mapped `::ffff:127.0.0.1`.
 *
 * This port reads the literals with Node's `net.isIPv4` / `net.isIPv6`, which
 * accept the RFC 3986 forms and none of the platform spellings above, and it
 * refuses a zone id explicitly. The interop test runs a shared corpus through
 * both implementations and requires the same answer for every host.
 *
 * The closed set also closes a gap in Node: a string `net.isIP` rejects is
 * handed to `getaddrinfo`, whose numeric parsing is the C library's to decide
 * (inet_aton reads a leading `0` as octal). A rule that accepted `0127.0.0.1`
 * would be checking one address and, on some platforms, connecting to
 * another. [cxpLoopbackDialAddress] returns the checked literal itself,
 * unbracketed, which is what the diallers connect to.
 */

/**
 * The code units Dart's `String.trim` removes: Unicode White_Space plus the
 * BOM. JavaScript's `trim` differs by one — it keeps NEL (U+0085) — so the
 * set is spelled out rather than borrowed.
 */
const DART_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000, 0xfeff,
]);

function dartTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && DART_WHITESPACE.has(value.charCodeAt(start))) start += 1;
  while (end > start && DART_WHITESPACE.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * `::1` and nothing else. A list with no IPv4 rule, so an IPv4-mapped address
 * (`::ffff:127.0.0.1`) is NOT loopback here — crux_cxp's `isLoopback` for an
 * IPv6 address tests `::1` alone, and `BlockList` would otherwise match the
 * mapped form against IPv4 rules.
 */
const IPV6_LOOPBACK = new BlockList();
IPV6_LOOPBACK.addAddress('::1', 'ipv6');

/**
 * The address to dial for [host] when it is loopback, or `undefined` when it
 * is not and must be refused.
 *
 * Trimmed (by Dart's rule), unbracketed, and — for a literal — exactly the
 * string that passed the check, so what a dialler connects to is what was
 * checked, never a respelling a resolver might read differently.
 */
export function cxpLoopbackDialAddress(host: string): string | undefined {
  const trimmed = dartTrim(host);
  if (trimmed.length === 0) return undefined;
  if (trimmed.toLowerCase() === 'localhost') return 'localhost';
  // Brackets delimit an IPv6 literal, as in a URL, and nothing else: the
  // inside must be `::1` itself, so `[127.0.0.1]` is refused.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return ipv6LoopbackLiteral(trimmed.slice(1, -1));
  }
  if (isIPv4(trimmed)) {
    // `isIPv4` accepts only canonical dotted decimal, so the first octet is
    // exactly the text before the first dot.
    return trimmed.startsWith('127.') ? trimmed : undefined;
  }
  return ipv6LoopbackLiteral(trimmed);
}

/** [literal] when it is an IPv6 literal naming `::1`, with no zone id. */
function ipv6LoopbackLiteral(literal: string): string | undefined {
  if (!isIPv6(literal) || literal.includes('%')) return undefined;
  return IPV6_LOOPBACK.check(literal, 'ipv6') ? literal : undefined;
}

/** Whether [host] names this machine's loopback interface. See the module docs. */
export function isCxpLoopbackHost(host: string): boolean {
  return cxpLoopbackDialAddress(host) !== undefined;
}

/**
 * The reason recorded on every refused dial — crux_cxp's text, verbatim,
 * since the two surface side by side in the products' unreachable-peer rows.
 */
export const CXP_NON_LOOPBACK_REFUSAL_REASON =
  'manifest advertises a non-loopback host; CXP peers are same-machine only';
