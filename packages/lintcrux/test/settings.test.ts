import { describe, expect, it } from 'vitest';
import { DEFAULT_RESULTS_PATH, resolveResultsPaths } from '../src/settings';

describe('resolveResultsPaths', () => {
  it('resolves a relative path against every workspace folder', () => {
    expect(resolveResultsPaths(DEFAULT_RESULTS_PATH, ['/work/a', '/work/b'])).toEqual([
      '/work/a/lintcrux.sarif',
      '/work/b/lintcrux.sarif',
    ]);
  });

  it('names exactly one file for an absolute setting, whatever the workspace', () => {
    expect(resolveResultsPaths('/shared/ci/report.sarif', ['/work/a', '/work/b'])).toEqual([
      '/shared/ci/report.sarif',
    ]);
  });

  it('collapses duplicates', () => {
    expect(resolveResultsPaths('r.sarif', ['/work/a', '/work/a'])).toEqual(['/work/a/r.sarif']);
  });

  it('normalises the resolved path', () => {
    expect(resolveResultsPaths('./build/../lintcrux.sarif', ['/work/a'])).toEqual([
      '/work/a/lintcrux.sarif',
    ]);
  });

  it('resolves a subdirectory path', () => {
    expect(resolveResultsPaths('build/lint.json', ['/work/a'])).toEqual([
      '/work/a/build/lint.json',
    ]);
  });

  it('produces nothing when no folder is open and the path is relative', () => {
    expect(resolveResultsPaths(DEFAULT_RESULTS_PATH, [])).toEqual([]);
  });
});
