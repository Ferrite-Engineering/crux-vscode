/**
 * The token helpers — `cxp_auth_token.dart` in crux_cxp, case for case.
 *
 * The comparison table is the reference implementation's own
 * (`test/conformance/auth_token_test.dart`, "cxpAuthTokensMatch"), so the two
 * implementations accept and refuse exactly the same presented values.
 */
import { describe, expect, it } from 'vitest';
import {
  cxpAuthTokensMatch,
  cxpProcessAuthToken,
  generateCxpAuthToken,
} from '../../src/cxp/auth-token';

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

describe('the process token', () => {
  it('is 32 lowercase hex digits — 128 bits — and stable', () => {
    expect(cxpProcessAuthToken()).toMatch(TOKEN_SHAPE);
    expect(cxpProcessAuthToken()).toBe(cxpProcessAuthToken());
  });

  it('generateCxpAuthToken mints a fresh value each time', () => {
    const a = generateCxpAuthToken();
    const b = generateCxpAuthToken();
    expect(a).toMatch(TOKEN_SHAPE);
    expect(b).toMatch(TOKEN_SHAPE);
    expect(a).not.toBe(b);
    expect(a).not.toBe(cxpProcessAuthToken());
  });

  it('does not repeat across many draws', () => {
    // Not a randomness test — a guard against a constant, a counter, or a
    // seed that is reused per call.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCxpAuthToken());
    expect(seen.size).toBe(1000);
  });
});

describe('cxpAuthTokensMatch', () => {
  const token = 'abc123';

  it('matches only the identical string', () => {
    expect(cxpAuthTokensMatch(token, token)).toBe(true);
    expect(cxpAuthTokensMatch('abc124', token)).toBe(false);
    expect(cxpAuthTokensMatch('ABC123', token)).toBe(false);
  });

  it('never matches a missing or empty token', () => {
    expect(cxpAuthTokensMatch(undefined, token)).toBe(false);
    expect(cxpAuthTokensMatch('', token)).toBe(false);
  });

  it('refuses a prefix and an extension of the token', () => {
    expect(cxpAuthTokensMatch('abc12', token)).toBe(false);
    expect(cxpAuthTokensMatch('abc1234', token)).toBe(false);
  });

  it('compares code units, so distinct lone surrogates never collide', () => {
    // UTF-8 would encode both as U+FFFD and call them equal. A hex token
    // can never contain either, but the comparison must not depend on that.
    expect(cxpAuthTokensMatch('\ud800', '\udc00')).toBe(false);
    expect(cxpAuthTokensMatch('\ud800', '\ud800')).toBe(true);
  });

  it('accepts a real generated token and refuses a second one', () => {
    const real = generateCxpAuthToken();
    expect(cxpAuthTokensMatch(real, real)).toBe(true);
    expect(cxpAuthTokensMatch(generateCxpAuthToken(), real)).toBe(false);
  });
});
