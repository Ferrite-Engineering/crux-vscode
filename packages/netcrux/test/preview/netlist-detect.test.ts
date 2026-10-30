import { describe, expect, it } from 'vitest';
import { looksLikeYosysNetlist } from '../../src/preview/netlist-detect';

const yosys = `{
  "creator": "Yosys 0.40 (git sha1 abc)",
  "modules": {
    "top": {
      "attributes": { "top": "00000000000000000000000000000001", "src": "top.v:1.1-9.10" },
      "ports": { "clk": { "direction": "input", "bits": [ 2 ] } },
      "cells": {},
      "netnames": {}
    }
  }
}`;

describe('looksLikeYosysNetlist', () => {
  it('accepts what write_json writes', () => {
    expect(looksLikeYosysNetlist(yosys)).toBe(true);
  });

  it('accepts a netlist after a byte-order mark', () => {
    expect(looksLikeYosysNetlist(`\ufeff${yosys}`)).toBe(true);
  });

  it('accepts a compact netlist with no creator', () => {
    expect(looksLikeYosysNetlist('{"modules":{"m":{"cells":{"c":{"type":"$and"}}}}}')).toBe(true);
  });

  it('accepts an empty design from Yosys', () => {
    expect(looksLikeYosysNetlist('{ "creator": "Yosys 0.40", "modules": { } }')).toBe(true);
  });

  it('accepts the start of a netlist whose first module members lie past the window', () => {
    const head = `{ "creator": "Yosys 0.40", "modules": { "big": { "attributes": { "src": "${'a'.repeat(5000)}" `;
    expect(looksLikeYosysNetlist(head)).toBe(true);
  });

  it('refuses ordinary JSON', () => {
    for (const text of [
      '{"name":"app","version":"1.0.0","dependencies":{}}',
      '{"compilerOptions":{"strict":true}}',
      '[1,2,3]',
      '{"modules":["a","b"]}',
      '{"modules":{"a":1}}',
      '{"creator":"someone","modules":{"a":{"x":1}}}',
      '"just a string"',
      '',
      'not json at all',
    ]) {
      expect(looksLikeYosysNetlist(text), text).toBe(false);
    }
  });

  it('refuses another tool whose JSON merely has a modules key', () => {
    expect(looksLikeYosysNetlist('{"modules":{"webpack":{"version":"5"}}}')).toBe(false);
  });
});
