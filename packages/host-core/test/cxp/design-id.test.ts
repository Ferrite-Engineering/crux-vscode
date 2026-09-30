/**
 * Unit tests for the `design_id` derivation, covering the one thing
 * `design-id-conformance.test.ts` structurally cannot: the **Windows** path
 * rules, from a macOS or Linux run.
 *
 * The conformance suite runs both implementations on the machine it is
 * running on, so on this repo's development machines and its CI it never
 * exercises `p.canonicalize`'s Windows behaviour — separator rewriting and
 * case folding — even though the extension ships to Windows and a token that
 * differs there breaks the join for those users. [DesignIdEnvironment] exists
 * for exactly this: the lexical branch is pure, so it can be driven with the
 * `win32` path flavour anywhere.
 *
 * The expected tokens below were produced by the Dart implementation's own
 * dependencies rather than by hand — `package:path`'s `windows` context
 * driven through the same four steps, then `sha256`:
 *
 * ```dart
 * final canonical = p.windows.canonicalize(p.windows.dirname(p.windows.normalize(input)));
 * sha256.convert(utf8.encode(canonical)).toString().substring(0, 16);
 * ```
 *
 * run under `dart run --packages=<crux-shared>/.dart_tool/package_config.json`.
 * That models the lexical branch, which is the branch that runs whenever the
 * containing directory does not exist — and it is `package:path` itself, not
 * a description of it.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CXP_DESIGN_ID_PATTERN,
  cxpDesignDirectoryForPath,
  cxpDesignIdForPath,
  type DesignIdEnvironment,
} from '../../src/cxp/design-id';

/** A Windows machine on which nothing exists — the pure lexical branch. */
const windowsNothingExists: DesignIdEnvironment = {
  isDirectory: () => false,
  realpath: () => {
    throw new Error('ENOENT');
  },
  path: path.win32,
  cwd: () => 'C:\\work',
  foldsCase: true,
};

/** A POSIX machine on which nothing exists. */
const posixNothingExists: DesignIdEnvironment = {
  isDirectory: () => false,
  realpath: () => {
    throw new Error('ENOENT');
  },
  path: path.posix,
  cwd: () => '/work',
  foldsCase: false,
};

describe('cxpDesignIdForPath — the Windows path style', () => {
  it('lowercases, because package:path canonicalizes Windows paths case-insensitively', () => {
    expect(cxpDesignIdForPath('C:\\crux-conformance-nonexistent\\design\\top.v', windowsNothingExists)).toBe(
      'f4cee5b0e3a7dae5',
    );
    // Same design, shouted. On Windows these two ARE the same directory, and
    // the reference implementation folds the case to say so.
    expect(cxpDesignIdForPath('C:\\CRUX-Conformance-Nonexistent\\DESIGN\\top.v', windowsNothingExists)).toBe(
      'f4cee5b0e3a7dae5',
    );
  });

  it('accepts forward slashes and doubled separators as the same path', () => {
    expect(cxpDesignIdForPath('C:/crux-conformance-nonexistent/design/top.v', windowsNothingExists)).toBe(
      'f4cee5b0e3a7dae5',
    );
    expect(
      cxpDesignIdForPath('C:\\crux-conformance-nonexistent\\design\\\\top.v', windowsNothingExists),
    ).toBe('f4cee5b0e3a7dae5');
  });

  it('strips a trailing separator before taking the containing directory', () => {
    // `…\design\` is `…\design`, which — not existing — resolves to its
    // parent. The token is the parent's, and it differs from the file case
    // above precisely because a missing directory cannot be recognised.
    expect(cxpDesignIdForPath('C:\\crux-conformance-nonexistent\\design\\', windowsNothingExists)).toBe(
      'c7783a726996b04b',
    );
  });

  it('canonicalizes to a lowercase backslash path', () => {
    expect(
      cxpDesignDirectoryForPath('C:/CRUX-Conformance-Nonexistent/Design/top.v', windowsNothingExists),
    ).toBe('c:\\crux-conformance-nonexistent\\design');
  });

  it('keeps a drive root whole', () => {
    expect(cxpDesignDirectoryForPath('C:\\top.v', windowsNothingExists)).toBe('c:\\');
  });

  it('resolves a relative path against the working directory', () => {
    expect(cxpDesignDirectoryForPath('design\\top.v', windowsNothingExists)).toBe(
      'c:\\work\\design',
    );
  });
});

describe('cxpDesignIdForPath — POSIX does not fold case', () => {
  it('treats two spellings of a folder as two designs', () => {
    // The trap: macOS volumes are usually case-insensitive, but package:path
    // uses the POSIX style there and does not fold. Folding here "because
    // the filesystem is case-insensitive" would merge two designs the
    // reference implementation keeps apart.
    const lower = cxpDesignIdForPath('/nowhere/design/alu.sv', posixNothingExists);
    const upper = cxpDesignIdForPath('/nowhere/DESIGN/alu.sv', posixNothingExists);
    expect(lower).not.toBe(upper);
  });

  it('keeps the filesystem root whole', () => {
    expect(cxpDesignDirectoryForPath('/top.v', posixNothingExists)).toBe('/');
  });

  it('resolves a relative path against the working directory', () => {
    expect(cxpDesignDirectoryForPath('design/top.v', posixNothingExists)).toBe('/work/design');
    expect(cxpDesignDirectoryForPath('', posixNothingExists)).toBe('/work');
  });
});

describe('cxpDesignIdForPath — the filesystem branch', () => {
  it('prefers the realpath of a directory that exists', () => {
    const environment: DesignIdEnvironment = {
      isDirectory: (candidate) => candidate === '/links/design',
      realpath: (candidate) =>
        candidate === '/links/design' ? '/real/design' : (() => { throw new Error('ENOENT'); })(),
      path: path.posix,
      cwd: () => '/work',
      foldsCase: false,
    };
    expect(cxpDesignDirectoryForPath('/links/design', environment)).toBe('/real/design');
    // A trailing separator must not stop the directory being recognised.
    expect(cxpDesignDirectoryForPath('/links/design/', environment)).toBe('/real/design');
  });

  it('falls back to the lexical form for a directory that does not exist', () => {
    const environment: DesignIdEnvironment = {
      isDirectory: () => false,
      realpath: () => {
        throw new Error('ENOENT');
      },
      path: path.posix,
      cwd: () => '/work',
      foldsCase: false,
    };
    // Note which value is canonicalized: the *directory*, never the input.
    expect(cxpDesignDirectoryForPath('/gone/design/dump.vcd', environment)).toBe('/gone/design');
  });

  it('always produces the documented token shape', () => {
    expect(cxpDesignIdForPath('/nowhere/design/top.v', posixNothingExists)).toMatch(
      CXP_DESIGN_ID_PATTERN,
    );
  });
});
