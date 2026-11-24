import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vetLinkTarget, type LinkTargetFs } from '../../src/links/target';

const EXTENSIONS: ReadonlySet<string> = new Set(['.vcd', '.fst']);
const posix = process.platform !== 'win32';

describe.runIf(posix)('vetLinkTarget on the real filesystem', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'crux-link-target-')));
    await writeFile(path.join(root, 'dump.vcd'), '$enddefinitions $end\n');
    await writeFile(path.join(root, 'DUMP2.FST'), 'x');
    await writeFile(path.join(root, 'secret.key'), 'not a waveform');
    await mkdir(path.join(root, 'dir.vcd'));
    await symlink(path.join(root, 'dump.vcd'), path.join(root, 'alias.vcd'));
    await symlink(path.join(root, 'secret.key'), path.join(root, 'trap.vcd'));
    await symlink(path.join(root, 'dump.vcd'), path.join(root, 'alias.txt'));
    await symlink(path.join(root, 'missing.vcd'), path.join(root, 'dangling.vcd'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const vet = (file: string): ReturnType<typeof vetLinkTarget> => vetLinkTarget(file, { extensions: EXTENSIONS });

  it('accepts a waveform, in any case of its extension', async () => {
    expect(await vet(path.join(root, 'dump.vcd'))).toEqual({ ok: true, path: path.join(root, 'dump.vcd') });
    expect((await vet(path.join(root, 'DUMP2.FST'))).ok).toBe(true);
  });

  it('opens the file a symbolic link resolves to, never the link', async () => {
    expect(await vet(path.join(root, 'alias.vcd'))).toEqual({ ok: true, path: path.join(root, 'dump.vcd') });
  });

  it('refuses a waveform name that resolves to something else', async () => {
    expect(await vet(path.join(root, 'trap.vcd'))).toEqual({ ok: false, refusal: 'wrong-kind' });
  });

  it('refuses a name of the wrong kind even when it resolves to a waveform', async () => {
    expect(await vet(path.join(root, 'alias.txt'))).toEqual({ ok: false, refusal: 'wrong-kind' });
    expect(await vet(path.join(root, 'secret.key'))).toEqual({ ok: false, refusal: 'wrong-kind' });
  });

  it('refuses what is not there or not a regular file', async () => {
    expect(await vet(path.join(root, 'missing.vcd'))).toEqual({ ok: false, refusal: 'file-not-found' });
    expect(await vet(path.join(root, 'dangling.vcd'))).toEqual({ ok: false, refusal: 'file-not-found' });
    expect(await vet(path.join(root, 'dir.vcd'))).toEqual({ ok: false, refusal: 'file-not-found' });
  });

  it('refuses a relative, padded or NUL-carrying path before asking the filesystem', async () => {
    for (const file of ['dump.vcd', `${root}/dump.vcd `, `${root}/dump.vcd\u0000`, '']) {
      expect(await vet(file), JSON.stringify(file)).toEqual({ ok: false, refusal: 'path-refused' });
    }
  });
});

describe('vetLinkTarget on Windows spellings', () => {
  const asked: string[] = [];
  const fs: LinkTargetFs = {
    isFile: (file) => {
      asked.push(file);
      return Promise.resolve(true);
    },
    isFileNoFollow: () => Promise.resolve(true),
    realpath: (file) => Promise.resolve(file),
  };
  const vet = (file: string): ReturnType<typeof vetLinkTarget> =>
    vetLinkTarget(file, { extensions: EXTENSIONS, windows: true, fs });

  it('accepts a drive path', async () => {
    expect(await vet('C:\\w\\dump.vcd')).toEqual({ ok: true, path: 'C:\\w\\dump.vcd' });
  });

  it('refuses network, device and stream paths without asking the filesystem', async () => {
    asked.length = 0;
    for (const file of [
      '\\\\attacker\\share\\dump.vcd',
      '\\\\?\\C:\\dump.vcd',
      'C:\\w\\NUL.vcd',
      'C:\\w\\dump.vcd:hidden',
      'w\\dump.vcd',
    ]) {
      expect(await vet(file), file).toEqual({ ok: false, refusal: 'path-refused' });
    }
    expect(asked).toEqual([]);
  });
});
