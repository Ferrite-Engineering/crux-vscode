import { describe, expect, it } from 'vitest';
import { isAbsolutePathText, isWindowsDeviceOrStream, refuseLinkPath } from '../../src/links/path-floor';

/**
 * Expected answers derived by hand from `CxpPathContainment.refuse` with no
 * roots (crux_cxp) and `package:path`'s POSIX and Windows styles; the Dart
 * original answers the same corpus in `test/cxp/dart-interop.test.ts`.
 */
describe('refuseLinkPath, the CXP receive floor with no roots', () => {
  it.each([
    ['/w/dump.vcd', undefined],
    ['/w/run 1/dump.vcd', undefined],
    ['', 'file_path is empty'],
    ['   ', 'file_path is empty'],
    ['/w/a\u0000.vcd', 'file_path contains a NUL character'],
    [' /w/a.vcd', 'file_path begins or ends with white space'],
    ['/w/a.vcd ', 'file_path begins or ends with white space'],
    ['/w/a.vcd\u00a0', 'file_path begins or ends with white space'],
    ['/w/a.vcd\u0085', 'file_path begins or ends with white space'],
    ['w/a.vcd', 'file_path must be an absolute path'],
    ['./a.vcd', 'file_path must be an absolute path'],
    ['C:\\w\\a.vcd', 'file_path must be an absolute path'],
    ['~/a.vcd', 'file_path must be an absolute path'],
  ])('POSIX %j', (path, reason) => {
    expect(refuseLinkPath(path, { windows: false })).toBe(reason);
  });

  it.each([
    ['C:\\w\\dump.vcd', undefined],
    ['c:/w/dump.vcd', undefined],
    ['C:w\\dump.vcd', 'file_path must be an absolute path'],
    ['\\w\\dump.vcd', 'file_path must be an absolute path'],
    ['/w/dump.vcd', 'file_path must be an absolute path'],
    ['//server/share/dump.vcd', 'file_path must be an absolute path'],
    ['\\\\server\\share\\dump.vcd', 'file_path is a network or device path'],
    ['\\\\?\\C:\\dump.vcd', 'file_path is a network or device path'],
    ['\\\\.\\PhysicalDrive0', 'file_path is a network or device path'],
    ['1:\\dump.vcd', 'file_path must be an absolute path'],
  ])('Windows %j', (path, reason) => {
    expect(refuseLinkPath(path, { windows: true })).toBe(reason);
  });
});

describe('isAbsolutePathText, judged on the text for any host', () => {
  it('matches the link builder', () => {
    expect(isAbsolutePathText('/a')).toBe(true);
    expect(isAbsolutePathText('\\\\srv\\share')).toBe(true);
    expect(isAbsolutePathText('C:\\a')).toBe(true);
    expect(isAbsolutePathText('d:/a')).toBe(true);
    expect(isAbsolutePathText('C:a')).toBe(false);
    expect(isAbsolutePathText('a/b')).toBe(false);
    expect(isAbsolutePathText('')).toBe(false);
  });
});

describe('isWindowsDeviceOrStream', () => {
  it.each([
    ['C:\\w\\dump.vcd', false],
    ['C:\\w\\dump.vcd:x', true],
    ['C:\\w\\NUL.vcd', true],
    ['C:\\w\\com1.tar.vcd', true],
    ['C:\\w\\aux .vcd', true],
    ['C:\\w\\console.vcd', false],
    ['C:\\w\\lpt10.vcd', false],
  ])('%j', (path, expected) => {
    expect(isWindowsDeviceOrStream(path)).toBe(expected);
  });
});
