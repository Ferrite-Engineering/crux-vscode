/**
 * `isCxpLoopbackHost` — the host rule every dial is held to.
 *
 * The vectors are crux_cxp's own (`test/conformance/dial_containment_test.dart`,
 * "isCxpLoopbackHost"), so the two implementations accept and refuse the same
 * hosts. `dart-interop.test.ts` runs a wider corpus through BOTH rules and
 * requires identical answers.
 */
import { describe, expect, it } from 'vitest';
import { cxpLoopbackDialAddress, isCxpLoopbackHost } from '../../src/cxp/loopback';

describe('isCxpLoopbackHost', () => {
  it('accepts the loopback literals and the name localhost', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      '::1',
      '[::1]',
      'localhost',
      'LOCALHOST',
      ' 127.0.0.1 ',
    ]) {
      expect(isCxpLoopbackHost(host), host).toBe(true);
    }
  });

  it('refuses everything routable, unparseable, or empty', () => {
    for (const host of [
      '192.0.2.1', // TEST-NET-1: documentation range, never routed.
      '10.0.0.5',
      '0.0.0.0',
      '::',
      '2001:db8::1',
      'example.com',
      'localhost.attacker.example',
      '127.0.0.1.attacker.example',
      '',
      ' ',
    ]) {
      expect(isCxpLoopbackHost(host), `"${host}"`).toBe(false);
    }
  });

  it('refuses an IPv4-mapped loopback, as crux_cxp does — only ::1 is IPv6 loopback', () => {
    expect(isCxpLoopbackHost('::ffff:127.0.0.1')).toBe(false);
  });

  it('refuses the non-canonical IPv4 spellings a resolver may reinterpret', () => {
    // Node's `net.isIP` rejects every one of these, so a dialler would hand
    // them to `getaddrinfo`, whose numeric parsing is the platform C
    // library's: `inet_aton` reads a leading `0` as octal and accepts short
    // and single-number forms. A rule that accepted them would be checking
    // one address and, on some platforms, connecting to another.
    for (const host of ['127.1', '0127.0.0.1', '127.000.000.001', '0x7f.0.0.1', '2130706433']) {
      expect(isCxpLoopbackHost(host), host).toBe(false);
    }
  });

  it('refuses a zone-scoped loopback, since the C library interprets the zone', () => {
    for (const host of ['::1%lo0', '::1%', '[::1%lo0]']) {
      expect(isCxpLoopbackHost(host), host).toBe(false);
    }
  });

  it('admits square brackets around an IPv6 literal and nothing else (CXP §10.5)', () => {
    // As crux_cxp does since it closed the set: brackets are how a URL writes
    // an IPv6 literal, and an IPv4 literal or a name inside them is no host.
    for (const host of ['[::1]', '[0:0:0:0:0:0:0:1]', ' [::1] ']) {
      expect(isCxpLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['[127.0.0.1]', '[127.0.0.2]', '[localhost]', '[::ffff:127.0.0.1]', '[]', '[::1', '::1]']) {
      expect(isCxpLoopbackHost(host), host).toBe(false);
    }
  });

  it('trims as Dart trims, NEL included, and dials the literal it checked', () => {
    const nel = String.fromCharCode(0x85);
    expect(cxpLoopbackDialAddress(`${nel}127.0.0.1 `)).toBe('127.0.0.1');
    expect(cxpLoopbackDialAddress('[::1]')).toBe('::1');
    expect(cxpLoopbackDialAddress('[127.0.0.1]')).toBeUndefined();
    expect(cxpLoopbackDialAddress(' LocalHost ')).toBe('localhost');
    expect(cxpLoopbackDialAddress('192.0.2.1')).toBeUndefined();
  });
});
