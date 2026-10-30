import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNetlistSourcePath, type SourcePathDeps } from '../../src/preview/source-path';

/** A workspace of [files], found by base name the way `findFiles` would. */
function workspace(files: readonly string[]): SourcePathDeps {
  return {
    exists: (fsPath) => Promise.resolve(files.includes(fsPath)),
    findByBaseName: (baseName) =>
      Promise.resolve(files.filter((file) => path.basename(file) === baseName)),
  };
}

const context = { netlistDirectory: '/work/proj/build', workspaceFolders: ['/work/proj'] };

describe('resolveNetlistSourcePath', () => {
  it('takes an absolute path that exists as it is', async () => {
    const result = await resolveNetlistSourcePath(
      '/work/proj/rtl/top.v',
      context,
      workspace(['/work/proj/rtl/top.v']),
    );
    expect(result).toEqual({ kind: 'found', fsPath: '/work/proj/rtl/top.v' });
  });

  it('roots a relative path at the netlist folder first', async () => {
    const result = await resolveNetlistSourcePath(
      'rtl/top.v',
      context,
      workspace(['/work/proj/build/rtl/top.v', '/work/proj/rtl/top.v']),
    );
    expect(result).toEqual({ kind: 'found', fsPath: '/work/proj/build/rtl/top.v' });
  });

  it('then at each workspace folder', async () => {
    const result = await resolveNetlistSourcePath(
      './rtl/top.v',
      context,
      workspace(['/work/proj/rtl/top.v']),
    );
    expect(result).toEqual({ kind: 'found', fsPath: '/work/proj/rtl/top.v' });
  });

  it('matches a path from another machine by its tail', async () => {
    const result = await resolveNetlistSourcePath(
      '/home/ci/runner/work/proj/rtl/top.v',
      context,
      workspace(['/work/proj/rtl/top.v', '/work/proj/tb/top.v']),
    );
    expect(result).toEqual({ kind: 'found', fsPath: '/work/proj/rtl/top.v' });
  });

  it('reads a Windows path written with backslashes', async () => {
    const result = await resolveNetlistSourcePath(
      'C:\\ci\\proj\\rtl\\top.v',
      context,
      workspace(['/work/proj/rtl/top.v', '/work/proj/tb/top.v']),
    );
    expect(result).toEqual({ kind: 'found', fsPath: '/work/proj/rtl/top.v' });
  });

  it('asks the user when files match equally well', async () => {
    const result = await resolveNetlistSourcePath(
      '/elsewhere/top.v',
      context,
      workspace(['/work/proj/b/top.v', '/work/proj/a/top.v']),
    );
    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: ['/work/proj/a/top.v', '/work/proj/b/top.v'],
    });
  });

  it('reports a file the workspace does not hold', async () => {
    expect(await resolveNetlistSourcePath('/x/nope.v', context, workspace([]))).toEqual({
      kind: 'missing',
    });
  });

  it('refuses an empty name without looking', async () => {
    expect(await resolveNetlistSourcePath('   ', context, workspace(['/a.v']))).toEqual({
      kind: 'missing',
    });
  });
});
