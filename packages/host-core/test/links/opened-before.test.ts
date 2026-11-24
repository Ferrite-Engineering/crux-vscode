import { describe, expect, it } from 'vitest';
import { findOpenedPath, linkPathKey } from '../../src/links/opened-before';

/** A filesystem where `/w/alias.vcd` is a link to `/data/Dump.vcd`. */
const realpath = (path: string): Promise<string> => {
  const table: Record<string, string> = { '/w/alias.vcd': '/data/Dump.vcd', '/data/Dump.vcd': '/data/Dump.vcd' };
  const target = table[path];
  return target === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(target);
};

describe('findOpenedPath', () => {
  it('finds the tab that is the same file through a symbolic link', async () => {
    expect(await findOpenedPath('/data/Dump.vcd', ['/w/other.vcd', '/w/alias.vcd'], { realpath, platform: 'linux' })).toBe(
      '/w/alias.vcd',
    );
  });

  it('folds case only where the filesystem does', async () => {
    expect(await findOpenedPath('/data/Dump.vcd', ['/data/dump.vcd'], { realpath, platform: 'linux' })).toBeUndefined();
    expect(await findOpenedPath('/data/Dump.vcd', ['/data/dump.vcd'], { realpath, platform: 'darwin' })).toBe(
      '/data/dump.vcd',
    );
  });

  it('finds nothing when no tab holds the file', async () => {
    expect(await findOpenedPath('/data/Dump.vcd', [], { realpath, platform: 'linux' })).toBeUndefined();
    expect(await findOpenedPath('/data/Dump.vcd', ['', '/w/x.vcd'], { realpath, platform: 'linux' })).toBeUndefined();
  });

  it('keys a path that cannot be resolved by its absolute spelling', async () => {
    expect(await linkPathKey('/nowhere/a/../b.vcd', { realpath, platform: 'linux' })).toBe('/nowhere/b.vcd');
  });
});
