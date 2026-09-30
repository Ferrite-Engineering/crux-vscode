import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CxpDiscoveryUnavailableError,
  sharedCxpManifestDirectory,
} from '../../src/cxp/manifest-directory';

describe('sharedCxpManifestDirectory', () => {
  it('resolves the macOS location under the user application-support root', () => {
    for (const platform of ['darwin', 'macos']) {
      expect(sharedCxpManifestDirectory({ platform, env: { HOME: '/Users/dev' } })).toBe(
        join('/Users/dev', 'Library', 'Application Support', 'crux', 'cxp', 'peers'),
      );
    }
  });

  it('resolves the Windows location under %APPDATA%', () => {
    for (const platform of ['win32', 'windows']) {
      expect(
        sharedCxpManifestDirectory({ platform, env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' } }),
      ).toBe(join('C:\\Users\\dev\\AppData\\Roaming', 'crux', 'cxp', 'peers'));
    }
  });

  it('honours XDG_DATA_HOME on POSIX', () => {
    expect(
      sharedCxpManifestDirectory({
        platform: 'linux',
        env: { HOME: '/home/dev', XDG_DATA_HOME: '/home/dev/.share' },
      }),
    ).toBe(join('/home/dev/.share', 'crux', 'cxp', 'peers'));
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset or empty', () => {
    const expected = join('/home/dev', '.local', 'share', 'crux', 'cxp', 'peers');
    expect(sharedCxpManifestDirectory({ platform: 'linux', env: { HOME: '/home/dev' } })).toBe(
      expected,
    );
    expect(
      sharedCxpManifestDirectory({
        platform: 'linux',
        env: { HOME: '/home/dev', XDG_DATA_HOME: '' },
      }),
    ).toBe(expected);
  });

  it('uses the POSIX rule for an unknown platform', () => {
    expect(sharedCxpManifestDirectory({ platform: 'freebsd', env: { HOME: '/home/dev' } })).toBe(
      join('/home/dev', '.local', 'share', 'crux', 'cxp', 'peers'),
    );
  });

  it('never resolves into an app-private container', () => {
    // The whole point of §10.1: one suite-wide directory. If a future
    // edit reached for a per-extension storage path, the tail would stop
    // being exactly crux/cxp/peers and every peer would publish where no
    // other peer looks.
    const path = sharedCxpManifestDirectory({ platform: 'darwin', env: { HOME: '/Users/dev' } });
    expect(path.endsWith(join('crux', 'cxp', 'peers'))).toBe(true);
    expect(path).not.toContain('ferrite-engineering');
    expect(path).not.toContain('vscode');
  });

  it('reports discovery-unavailable rather than crashing when HOME is missing', () => {
    expect(() => sharedCxpManifestDirectory({ platform: 'darwin', env: {} })).toThrow(
      CxpDiscoveryUnavailableError,
    );
    expect(() => sharedCxpManifestDirectory({ platform: 'linux', env: {} })).toThrow(
      CxpDiscoveryUnavailableError,
    );
    expect(() => sharedCxpManifestDirectory({ platform: 'darwin', env: { HOME: '' } })).toThrow(
      CxpDiscoveryUnavailableError,
    );
  });

  it('reports discovery-unavailable when %APPDATA% is missing', () => {
    expect(() => sharedCxpManifestDirectory({ platform: 'win32', env: {} })).toThrow(
      /APPDATA/,
    );
  });
});
