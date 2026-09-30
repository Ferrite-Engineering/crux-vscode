import { describe, expect, it } from 'vitest';
import { locateNetCruxExecutable, type LocateNetCruxDeps } from '../../src/highlight/locate-desktop';

function deps(overrides: Partial<LocateNetCruxDeps> & { readonly existing: readonly string[] }): LocateNetCruxDeps {
  const existing = new Set(overrides.existing);
  return {
    exists: (p) => existing.has(p),
    platform: 'darwin',
    env: {},
    pathDelimiter: ':',
    join: (...segments) => segments.join('/'),
    ...overrides,
  };
}

describe('locateNetCruxExecutable — macOS', () => {
  it('finds "NetCrux Pro.app" — the released app’s actual bundle name', () => {
    const result = locateNetCruxExecutable(
      deps({ platform: 'darwin', existing: ['/Applications/NetCrux Pro.app'] }),
    );
    expect(result).toBe('/Applications/NetCrux Pro.app');
  });

  it('falls back to "NetCrux.app" when only the plain-branded name exists', () => {
    const result = locateNetCruxExecutable(
      deps({ platform: 'darwin', existing: ['/Applications/NetCrux.app'] }),
    );
    expect(result).toBe('/Applications/NetCrux.app');
  });

  it('prefers "NetCrux Pro.app" when both exist', () => {
    const result = locateNetCruxExecutable(
      deps({ platform: 'darwin', existing: ['/Applications/NetCrux.app', '/Applications/NetCrux Pro.app'] }),
    );
    expect(result).toBe('/Applications/NetCrux Pro.app');
  });

  it('returns undefined when neither is installed', () => {
    expect(locateNetCruxExecutable(deps({ platform: 'darwin', existing: [] }))).toBeUndefined();
  });
});

describe('locateNetCruxExecutable — Windows', () => {
  it('finds the per-user install under %LOCALAPPDATA%\\Programs', () => {
    const result = locateNetCruxExecutable(
      deps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:/Users/erin/AppData/Local' },
        join: (...segments) => segments.join('\\'),
        existing: ['C:/Users/erin/AppData/Local\\Programs\\NetCrux Pro\\netcrux_pro.exe'],
      }),
    );
    expect(result).toBe('C:/Users/erin/AppData/Local\\Programs\\NetCrux Pro\\netcrux_pro.exe');
  });

  it('falls back to %ProgramFiles% for an all-users install', () => {
    const result = locateNetCruxExecutable(
      deps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:/Users/erin/AppData/Local', ProgramFiles: 'C:/Program Files' },
        join: (...segments) => segments.join('\\'),
        existing: ['C:/Program Files\\NetCrux Pro\\netcrux_pro.exe'],
      }),
    );
    expect(result).toBe('C:/Program Files\\NetCrux Pro\\netcrux_pro.exe');
  });

  it('returns undefined when no root environment variable is set', () => {
    const result = locateNetCruxExecutable(deps({ platform: 'win32', env: {}, existing: [] }));
    expect(result).toBeUndefined();
  });
});

describe('locateNetCruxExecutable — Linux/POSIX', () => {
  it('finds the executable on $PATH', () => {
    const result = locateNetCruxExecutable(
      deps({
        platform: 'linux',
        env: { PATH: '/usr/bin:/home/erin/.local/bin' },
        existing: ['/home/erin/.local/bin/netcrux_pro'],
      }),
    );
    expect(result).toBe('/home/erin/.local/bin/netcrux_pro');
  });

  it('returns undefined when $PATH has nothing named netcrux[_pro]', () => {
    const result = locateNetCruxExecutable(
      deps({ platform: 'linux', env: { PATH: '/usr/bin:/bin' }, existing: [] }),
    );
    expect(result).toBeUndefined();
  });

  it('tolerates an unset $PATH', () => {
    const result = locateNetCruxExecutable(deps({ platform: 'linux', env: {}, existing: [] }));
    expect(result).toBeUndefined();
  });
});
