/**
 * The rule a link's path is held to before the filesystem is asked anything.
 *
 * This is `crux_cxp`'s `CxpPathContainment` with no roots (the CXP receive
 * floor), the rule both desktop products apply to a link's file
 * (`kWaveCruxLinkContainment`, `kNetCruxLinkContainment`). It is the
 * TypeScript port of that one rule, not a second rule: the reasons are its
 * reasons word for word, and `test/cxp/dart-interop.test.ts` runs the shared
 * corpus through both and requires the same answers.
 *
 * Why the floor and not the workspace folders: a link exists to open a file
 * the editor has not opened yet, so a rooted rule would refuse what the
 * feature is for. What a CXP peer proves with its token, a link cannot prove
 * at all, so a file not opened before is confirmed by the user instead.
 */

/** White space as Dart's `String.trim` sees it, so "padded" means the same thing. */
function isDartWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isBlank(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (!isDartWhitespace(path.charCodeAt(i))) return false;
  }
  return true;
}

function isPadded(path: string): boolean {
  return isDartWhitespace(path.charCodeAt(0)) || isDartWhitespace(path.charCodeAt(path.length - 1));
}

/**
 * Whether [path] is absolute and not root-relative on the host, as Dart's
 * `package:path` reads it: on POSIX it begins with `/`; on Windows it is a
 * drive and a separator (`C:\`, `C:/`) or begins with two separators (which
 * the network rule below then refuses).
 */
function isHostAbsolute(path: string, windows: boolean): boolean {
  if (!windows) return path.startsWith('/');
  // `\\server\share` is absolute (and refused below as a network path); a
  // path that begins with any other separator is root-relative on Windows.
  if (path.charCodeAt(0) === 0x5c && path.charCodeAt(1) === 0x5c) return true;
  return isDriveRoot(path);
}

function isSeparator(code: number): boolean {
  return code === 0x5c || code === 0x2f;
}

function isDriveRoot(path: string): boolean {
  if (path.length < 3) return false;
  const letter = path.charCodeAt(0) | 0x20;
  return letter >= 0x61 && letter <= 0x7a && path.charCodeAt(1) === 0x3a && isSeparator(path.charCodeAt(2));
}

/**
 * Null when [path] may be opened as far as its spelling goes; otherwise why
 * not, in `CxpPathContainment`'s words. [windows] defaults to the host.
 *
 * On Windows a `\\server\share`, `\\?\` or `\\.\` path is refused on its
 * spelling: judging it would open an SMB connection to a server the link
 * chose.
 */
export function refuseLinkPath(
  path: string,
  options: { readonly windows?: boolean } = {},
): string | undefined {
  const windows = options.windows ?? process.platform === 'win32';
  if (isBlank(path)) return 'file_path is empty';
  if (path.includes('\u0000')) return 'file_path contains a NUL character';
  if (isPadded(path)) return 'file_path begins or ends with white space';
  if (!isHostAbsolute(path, windows)) return 'file_path must be an absolute path';
  if (windows && path.startsWith('\\\\')) return 'file_path is a network or device path';
  return undefined;
}

/**
 * Whether [path] is absolute as written, on any host: `/…`, `\\…`, `C:\…` or
 * `C:/…`. A link made on one host is read on another, so this never asks the
 * reading host. The rule NetCrux's parser and `crux_mcp`'s link builder hold a
 * link's `file` to (`isAbsolutePathText`).
 */
export function isAbsolutePathText(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\\\')) return true;
  return isDriveRoot(path);
}

/** Windows device names, which open a device whatever the extension after them. */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Whether [path], a Windows path, names an alternate data stream
 * (`dump.vcd:x`) or a device (`NUL.vcd`). Judged on the spelling, as the
 * desktop products do.
 */
export function isWindowsDeviceOrStream(path: string): boolean {
  // A drive-letter path has its one legitimate colon at index 1.
  const afterDrive = path.length > 2 ? path.slice(2) : '';
  if (afterDrive.includes(':')) return true;
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const withoutExtension = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  const stem = (withoutExtension.split('.')[0] ?? '').trimEnd();
  return WINDOWS_DEVICE_NAMES.has(stem);
}
