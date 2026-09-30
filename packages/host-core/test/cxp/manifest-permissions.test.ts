/**
 * CXP §10.1–10.2: since 1.2 the manifest directory holds every local peer's
 * token, and presenting a token proves file access only if other users
 * cannot read it. So a peer creates each directory it creates on the
 * manifest path owner-only (`0700`), and writes the manifest owner-only
 * (`0600`) rather than relying on a directory above it. A Linux home that is
 * `0755` is the case this closes: there the default modes let every local
 * user read every peer's token.
 *
 * Every case in crux_cxp's `manifest_permissions_test.dart` is here, so the
 * two implementations are held to one statement of the rule, plus two that
 * pin what is this port's own: the exclusive create that refuses a planted
 * link, and the modes Node's `mkdir` and `open` take through the umask. The
 * mode cases run on POSIX only: Windows has an access-control list, not a
 * mode, and the per-user profile's list is what keeps `%APPDATA%` private.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerIdentity } from '../../src/cxp/identity';
import type * as AtomicWrite from '../../src/cxp/atomic-write';
import { CxpDiscovery } from '../../src/cxp/discovery';
import { CxpManifestWriter } from '../../src/cxp/manifest-writer';
import { ensureCxpPrivateDirectory, writeJsonPrivateAtomic } from '../../src/cxp/private-files';
import { pollUntil } from './harness';

/**
 * Pins the scratch file's name when set, so a test can plant something at
 * it first; otherwise every write gets a fresh name, as in production.
 */
const scratchSeam = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('../../src/cxp/atomic-write', async (importOriginal) => {
  const real = await importOriginal<typeof AtomicWrite>();
  return {
    ...real,
    atomicTempPath: (filePath: string) => scratchSeam.path ?? real.atomicTempPath(filePath),
  };
});

const IDENTITY: PeerIdentity = {
  peerId: 'vscode-perm-1',
  productName: 'VSCode',
  productVersion: '0.0.0',
  capabilities: [],
};

const posixOnly = process.platform === 'win32';

/** The permission bits of [p], as three octal digits. */
function modeOf(p: string): string {
  return (statSync(p).mode & 0o777).toString(8).padStart(3, '0');
}

describe('manifest permissions (CXP §10.1–10.2)', () => {
  let tempDir: string;
  const cleanups: (() => void | Promise<void>)[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'crux-cxp-perm-'));
  });

  afterEach(async () => {
    scratchSeam.path = undefined;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(tempDir, { recursive: true, force: true });
  });

  const manifestIn = (dir: string): string => path.join(dir, `${IDENTITY.peerId}.json`);

  function writer(dir: string, heartbeatIntervalMs: number | null = null): CxpManifestWriter {
    const w = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs });
    cleanups.push(() => w.remove());
    return w;
  }

  it.skipIf(posixOnly)(
    'the writer creates each directory it creates owner-only, leaves the ones it found alone, and writes the manifest owner-only',
    async () => {
      const base = path.join(tempDir, 'share');
      mkdirSync(base);
      chmodSync(base, 0o755);
      const dir = path.join(base, 'crux', 'cxp', 'peers');

      const w = writer(dir);
      await w.write({ identity: IDENTITY, host: '127.0.0.1', port: 54322 });

      expect(modeOf(base), 'not created here').toBe('755');
      for (const created of [path.join(base, 'crux'), path.join(base, 'crux', 'cxp'), dir]) {
        expect(modeOf(created), created).toBe('700');
      }
      expect(modeOf(manifestIn(dir))).toBe('600');
      expect(
        readFileSync(manifestIn(dir), 'utf8'),
        'the file that is private is the one holding the token',
      ).toContain(w.authToken);
    },
  );

  it.skipIf(posixOnly)('an existing manifest directory with a looser mode is tightened', async () => {
    const dir = path.join(tempDir, 'peers');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    await writer(dir).write({ identity: IDENTITY, host: '127.0.0.1', port: 54322 });
    expect(modeOf(dir)).toBe('700');
    expect(modeOf(manifestIn(dir))).toBe('600');
  });

  it.skipIf(posixOnly)(
    'every heartbeat rewrite is owner-only too, and leaves no temporary file behind',
    async () => {
      const dir = path.join(tempDir, 'peers');
      const w = writer(dir, 20);
      await w.write({ identity: IDENTITY, host: '127.0.0.1', port: 54322 });
      const first = readFileSync(manifestIn(dir), 'utf8');
      await pollUntil(
        () => readFileSync(manifestIn(dir), 'utf8') !== first,
        'the heartbeat must rewrite the manifest',
      );
      expect(modeOf(manifestIn(dir))).toBe('600');
      await w.remove();
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it.skipIf(posixOnly)('discovery creates the directory owner-only as well', async () => {
    const dir = path.join(tempDir, 'fresh', 'peers');
    const discovery = new CxpDiscovery({ manifestDirectory: dir });
    cleanups.push(() => discovery.stop());
    await discovery.start();
    expect(modeOf(path.join(tempDir, 'fresh'))).toBe('700');
    expect(modeOf(dir)).toBe('700');
  });

  it.skipIf(posixOnly)('the scratch file is owner-only before the token is written into it', async () => {
    const dest = path.join(tempDir, 'm.json');
    const seen: string[] = [];
    await writeJsonPrivateAtomic(
      dest,
      { token: 'the-token' },
      {
        onBeforeWrite: (scratch) => {
          seen.push(`before write: ${modeOf(scratch)} ${JSON.stringify(readFileSync(scratch, 'utf8'))}`);
        },
        onBeforeRename: (scratch) => {
          const contents = readFileSync(scratch, 'utf8');
          seen.push(`before rename: ${modeOf(scratch)} ${contents.includes('the-token') ? 'token' : 'none'}`);
        },
      },
    );
    expect(seen).toEqual(['before write: 600 ""', 'before rename: 600 token']);
    expect(modeOf(dest)).toBe('600');
  });

  it.skipIf(posixOnly)(
    'a umask that strips the owner’s own bits still yields exactly 0700 and 0600',
    async () => {
      // `mkdir` and `open` take their mode through the umask, which only ever
      // removes bits: never wider than asked, but under a umask like 0277 a
      // 0500 directory the writer cannot create its manifest in, and a 0400
      // scratch file. The explicit chmods restore exactly the owner-only modes,
      // the file's before the token goes in.
      const previous = process.umask(0o277);
      try {
        const dir = path.join(tempDir, 'strict', 'peers');
        const seen: string[] = [];
        await ensureCxpPrivateDirectory(dir);
        await writeJsonPrivateAtomic(
          path.join(dir, 'm.json'),
          { token: 'the-token' },
          { onBeforeWrite: (scratch) => void seen.push(modeOf(scratch)) },
        );
        expect(modeOf(path.join(tempDir, 'strict'))).toBe('700');
        expect(modeOf(dir)).toBe('700');
        expect(seen, 'the scratch file’s mode before the token is written').toEqual(['600']);
        expect(modeOf(path.join(dir, 'm.json'))).toBe('600');
      } finally {
        process.umask(previous);
      }
    },
  );

  it('a failed write leaves the destination as it was, and no scratch file', async () => {
    const dest = path.join(tempDir, 'm.json');
    writeFileSync(dest, 'old');
    await expect(
      writeJsonPrivateAtomic(
        dest,
        { token: 'new' },
        {
          onBeforeRename: () => {
            throw new Error('interrupted');
          },
        },
      ),
    ).rejects.toThrow('interrupted');
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(readdirSync(tempDir)).toEqual(['m.json']);
  });

  it('a link planted where the scratch file goes is refused, never followed', async () => {
    // Were the scratch file opened without O_EXCL, a link planted at its
    // name would be followed and the token written wherever it points.
    const dest = path.join(tempDir, 'm.json');
    const target = path.join(tempDir, 'elsewhere.txt');
    writeFileSync(target, 'untouched');
    scratchSeam.path = `${dest}.planted.tmp`;
    symlinkSync(target, scratchSeam.path);
    await expect(writeJsonPrivateAtomic(dest, { token: 'the-token' })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(existsSync(dest)).toBe(false);
  });
});
