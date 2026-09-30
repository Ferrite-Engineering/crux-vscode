import { describe, expect, it } from 'vitest';
import { resolveWaiverFile } from '../../src/waivers/location';

function resolve(
  filePath: string,
  workspaceFolders: readonly string[],
  waiverDirs: readonly string[] = [],
  projectDirs: readonly string[] = [],
): string | undefined {
  return resolveWaiverFile({
    filePath,
    workspaceFolders,
    lookup: {
      hasWaiverFile: (directory) => waiverDirs.includes(directory),
      hasProjectFile: (directory) => projectDirs.includes(directory),
    },
  });
}

describe('resolveWaiverFile', () => {
  it('falls back to the workspace folder root', () => {
    expect(resolve('/work/design/rtl/cpu.sv', ['/work/design'])).toBe(
      '/work/design/.lintcrux-waivers.json',
    );
  });

  it('prefers a directory that already has a waiver file', () => {
    expect(
      resolve('/work/design/ip/fifo/rtl/fifo.sv', ['/work/design'], ['/work/design/ip/fifo']),
    ).toBe('/work/design/ip/fifo/.lintcrux-waivers.json');
  });

  it('uses a `*.lintcrux` project directory when there is no waiver file yet', () => {
    expect(resolve('/work/design/ip/fifo/rtl/fifo.sv', ['/work/design'], [], ['/work/design/ip'])).toBe(
      '/work/design/ip/.lintcrux-waivers.json',
    );
  });

  it('stops the walk at the workspace folder, never above it', () => {
    // `/work` has a project file but is outside the opened folder: a
    // waiver written there is one the user will not find or commit.
    expect(resolve('/work/design/rtl/cpu.sv', ['/work/design'], [], ['/work'])).toBe(
      '/work/design/.lintcrux-waivers.json',
    );
  });

  it('checks the file’s own directory first', () => {
    expect(resolve('/work/design/rtl/cpu.sv', ['/work/design'], ['/work/design/rtl'])).toBe(
      '/work/design/rtl/.lintcrux-waivers.json',
    );
  });

  it('returns undefined for a file outside every workspace folder', () => {
    expect(resolve('/elsewhere/lib/fifo.sv', ['/work/design'])).toBeUndefined();
  });

  it('returns undefined when no folder is open at all', () => {
    expect(resolve('/work/design/rtl/cpu.sv', [])).toBeUndefined();
  });

  it('picks the most specific folder in a multi-root workspace', () => {
    expect(resolve('/work/design/ip/fifo.sv', ['/work', '/work/design/ip'])).toBe(
      '/work/design/ip/.lintcrux-waivers.json',
    );
  });

  it('handles a file sitting directly in the folder root', () => {
    expect(resolve('/work/design/cpu.sv', ['/work/design'])).toBe(
      '/work/design/.lintcrux-waivers.json',
    );
  });
});
