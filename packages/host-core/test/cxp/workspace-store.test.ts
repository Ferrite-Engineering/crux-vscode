/**
 * The shared workspace store: a port of `crux_cxp`'s `CxpWorkspaceStore`, so
 * these tests assert the *document on disk* and the resolution order rather
 * than the TypeScript API around them. Both are the shared contract — the
 * file is read by four Dart products, and a resolution order that differs
 * from theirs would send a peer to a different artifact for the same design.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cxpDesignIdForPath } from '../../src/cxp/design-id';
import {
  CXP_WORKSPACE_DEFAULT_TTL_MS,
  CxpWorkspaceStore,
  sharedCxpWorkspaceDirectory,
  type WorkspaceArtifact,
} from '../../src/cxp/workspace-store';

let root: string;
let workspaceDirectory: string;
let now = 1_800_000_000_000;

/** Every artifact path in these tests exists unless a case says otherwise. */
function newStore(overrides: { readonly exists?: (p: string) => Promise<boolean> } = {}) {
  return new CxpWorkspaceStore({
    workspaceDirectory,
    now: () => now,
    exists: overrides.exists ?? (() => Promise.resolve(true)),
  });
}

/** The record file for a design id the test knows is valid. */
function recordOf(store: CxpWorkspaceStore, designId: string): string {
  const file = store.fileFor(designId);
  if (file === undefined) throw new Error(`"${designId}" does not name a record file`);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'crux-ws-store-'));
  workspaceDirectory = path.join(root, 'workspace');
  now = 1_800_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CxpWorkspaceStore — the document', () => {
  it('writes the shape the Dart producers read', async () => {
    const store = newStore();
    await store.upsertArtifact({
      designId: 'a1b2c3d4e5f60718',
      kind: 'waveform',
      path: '/abs/cdc_capture.vcd',
      producer: 'vscode',
      topModule: 'tb_cdc_capture',
      basename: 'cdc_capture.vcd',
    });

    const document: unknown = JSON.parse(
      readFileSync(path.join(workspaceDirectory, 'a1b2c3d4e5f60718.json'), 'utf8'),
    );
    expect(document).toEqual({
      design_id: 'a1b2c3d4e5f60718',
      artifacts: [
        {
          kind: 'waveform',
          path: '/abs/cdc_capture.vcd',
          producer: 'vscode',
          ts: now,
          top_module: 'tb_cdc_capture',
          basename: 'cdc_capture.vcd',
        },
      ],
    });
  });

  it('is named <design_id>.json, which is why the id has to be filesystem-safe', () => {
    const store = newStore();
    expect(store.fileFor('a1b2c3d4e5f60718')).toBe(
      path.join(workspaceDirectory, 'a1b2c3d4e5f60718.json'),
    );
  });

  it('refreshes an existing (path, kind) entry rather than appending a duplicate', async () => {
    const store = newStore();
    await store.upsertArtifact({
      designId: 'd1',
      kind: 'waveform',
      path: '/abs/a.vcd',
      producer: 'vscode',
    });
    now += 60_000;
    const after = await store.upsertArtifact({
      designId: 'd1',
      kind: 'waveform',
      path: '/abs/a.vcd',
      producer: 'simcrux',
      topModule: 'tb',
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ producer: 'simcrux', topModule: 'tb', ts: now });
  });

  it('keeps artifacts of different kinds at the same path apart', async () => {
    const store = newStore();
    await store.upsertArtifact({ designId: 'd1', kind: 'source', path: '/p', producer: 'vscode' });
    const after = await store.upsertArtifact({
      designId: 'd1',
      kind: 'waveform',
      path: '/p',
      producer: 'vscode',
    });
    expect(after).toHaveLength(2);
  });

  it('reads an unknown design, a corrupt document and a foreign shape as empty', async () => {
    const store = newStore();
    expect(await store.readArtifacts('never-written')).toEqual([]);

    await store.upsertArtifact({ designId: 'd1', kind: 'source', path: '/p', producer: 'vscode' });
    writeFileSync(recordOf(store, 'd1'), '{ this is not json', 'utf8');
    expect(await store.readArtifacts('d1')).toEqual([]);

    writeFileSync(recordOf(store, 'd1'), JSON.stringify({ artifacts: 'nope' }), 'utf8');
    expect(await store.readArtifacts('d1')).toEqual([]);
  });

  it('skips a malformed row and keeps the rows beside it', async () => {
    // The document is written by four other products and by builds newer
    // than this one. Refusing the whole design because one row is odd would
    // lose the rows that are fine.
    const store = newStore();
    await store.upsertArtifact({ designId: 'd1', kind: 'source', path: '/p', producer: 'vscode' });
    const document = JSON.parse(readFileSync(recordOf(store, 'd1'), 'utf8')) as {
      artifacts: unknown[];
    };
    document.artifacts.unshift({ kind: 'waveform' });
    writeFileSync(recordOf(store, 'd1'), JSON.stringify(document), 'utf8');
    expect(await store.readArtifacts('d1')).toHaveLength(1);
  });
});

describe('CxpWorkspaceStore — pruning', () => {
  it('drops an entry whose file no longer exists, whatever its age', async () => {
    const store = newStore({ exists: (p) => Promise.resolve(p !== '/abs/gone.vcd') });
    await store.upsertArtifact({
      designId: 'd1',
      kind: 'waveform',
      path: '/abs/gone.vcd',
      producer: 'vscode',
    });
    // A path a receiver would open and then report as *its* failure is worse
    // than one it never learns about.
    expect(await store.readArtifacts('d1')).toEqual([]);
  });

  it('drops an entry older than the TTL', async () => {
    const store = newStore();
    await store.upsertArtifact({ designId: 'd1', kind: 'source', path: '/p', producer: 'vscode' });
    now += CXP_WORKSPACE_DEFAULT_TTL_MS + 1;
    expect(await store.readArtifacts('d1')).toEqual([]);
  });

  it('deletes the document rather than persisting an empty artifact list', async () => {
    const store = newStore({ exists: () => Promise.resolve(false) });
    await store.upsertArtifact({ designId: 'd1', kind: 'source', path: '/p', producer: 'vscode' });
    await store.pruneDesign('d1');
    expect(() => readFileSync(recordOf(store, 'd1'), 'utf8')).toThrow();
  });
});

describe('CxpWorkspaceStore — resolution order', () => {
  async function seed(store: CxpWorkspaceStore, artifacts: readonly Partial<WorkspaceArtifact>[]) {
    for (const artifact of artifacts) {
      await store.upsertArtifact({
        designId: 'd1',
        kind: artifact.kind ?? 'waveform',
        path: artifact.path ?? '/abs/a.vcd',
        producer: 'vscode',
        ...(artifact.topModule !== undefined ? { topModule: artifact.topModule } : {}),
        ...(artifact.ts !== undefined ? { ts: artifact.ts } : {}),
      });
    }
  }

  it('returns nothing for a design with no artifact of that kind', async () => {
    const store = newStore();
    await seed(store, [{ kind: 'waveform' }]);
    expect(await store.resolveArtifact('d1', 'source')).toBeUndefined();
    expect(await store.resolveArtifact('', 'waveform')).toBeUndefined();
  });

  it('returns the only artifact of the kind without consulting the hints', async () => {
    const store = newStore();
    await seed(store, [{ kind: 'waveform', path: '/abs/only.vcd', topModule: 'tb_a' }]);
    expect(
      (await store.resolveArtifact('d1', 'waveform', { topModule: 'something_else' }))?.path,
    ).toBe('/abs/only.vcd');
  });

  it('prefers a topModule match, then a basename match, then the newest', async () => {
    const store = newStore();
    await seed(store, [
      { path: '/abs/one.vcd', topModule: 'tb_one', ts: now - 3000 },
      { path: '/abs/two.vcd', topModule: 'tb_two', ts: now - 2000 },
      { path: '/abs/three.vcd', ts: now - 1000 },
    ]);
    expect((await store.resolveArtifact('d1', 'waveform', { topModule: 'tb_two' }))?.path).toBe(
      '/abs/two.vcd',
    );
    expect((await store.resolveArtifact('d1', 'waveform', { basename: 'one.vcd' }))?.path).toBe(
      '/abs/one.vcd',
    );
    // A basename hint given as a whole path still matches on the leaf.
    expect(
      (await store.resolveArtifact('d1', 'waveform', { basename: '/elsewhere/one.vcd' }))?.path,
    ).toBe('/abs/one.vcd');
    expect((await store.resolveArtifact('d1', 'waveform'))?.path).toBe('/abs/three.vcd');
  });
});

/**
 * A `design_id` is opaque on the wire and arrives from a peer on every
 * `request_open_artifact`. The one thing the store does with it is turn it
 * into a file name, and joining it onto the directory is unsafe: a `..`
 * segment walks out, and an absolute id names a file anywhere (crux_cxp
 * measured `/tmp/evil` becoming `/tmp/evil.json`). crux_cxp's
 * `workspace_store_test.dart` "design_id containment" group, case for case.
 *
 * The workspace here sits two levels below the temp root, so every hostile id
 * — even against a store that did not check — lands inside the root, where the
 * assertions can see it and `afterEach` removes it.
 */
describe('CxpWorkspaceStore — design_id containment', () => {
  let nestedWorkspace: string;
  let escapeAbsolute: string;

  beforeEach(() => {
    nestedWorkspace = path.join(root, 'nested', 'workspace');
    escapeAbsolute = path.join(root, 'escape-abs');
  });

  function containedStore(): CxpWorkspaceStore {
    return new CxpWorkspaceStore({
      workspaceDirectory: nestedWorkspace,
      now: () => now,
      exists: () => Promise.resolve(true),
    });
  }

  /** Ids that must never name a file outside the workspace directory. */
  function hostile(): string[] {
    return [
      '../escape-rel',
      '../../escape-rel2',
      'sub/../../escape-rel3',
      escapeAbsolute,
      '',
      `nul${String.fromCharCode(0)}byte`,
    ];
  }

  /** Every file and directory under [directory], relative to it. */
  function tree(directory: string): string[] {
    return readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort();
  }

  it('isValidDesignId refuses every escape and accepts real ids', () => {
    const store = containedStore();
    for (const id of hostile()) {
      expect(store.isValidDesignId(id), JSON.stringify(id)).toBe(false);
    }
    for (const id of [
      'd',
      cxpDesignIdForPath(root),
      'designs/cdc_capture', // one level down, as the store has always allowed
      '..hidden', // a leading dot pair is a name, not a parent reference
      'a..b',
    ]) {
      expect(store.isValidDesignId(id), JSON.stringify(id)).toBe(true);
    }
  });

  it('reads of a hostile id are empty', async () => {
    const store = containedStore();
    for (const id of hostile()) {
      expect(await store.readArtifacts(id), JSON.stringify(id)).toEqual([]);
      expect(await store.resolveArtifact(id, 'waveform'), JSON.stringify(id)).toBeUndefined();
    }
  });

  it('a hostile id reads nothing even when a file sits exactly where it points', async () => {
    // The read half of the escape: a document planted outside the workspace
    // must not be consulted just because a peer named a path to it. Node's
    // `path.join` keeps the directory in front of an absolute id where Dart's
    // `p.join` drops it, so here the `..` walk is the shape that reached a
    // planted file; the absolute one is refused all the same, as crux_cxp
    // refuses it.
    const planted = JSON.stringify({
      design_id: 'x',
      artifacts: [{ kind: 'waveform', path: '/planted.vcd', producer: 'evil', ts: now }],
    });
    writeFileSync(path.join(root, 'planted.json'), planted, 'utf8');
    writeFileSync(`${escapeAbsolute}.json`, planted, 'utf8');
    const store = containedStore();
    for (const id of ['../../planted', escapeAbsolute]) {
      expect(await store.readArtifacts(id), id).toEqual([]);
      expect(await store.resolveArtifact(id, 'waveform'), id).toBeUndefined();
    }
  });

  it('an upsert with a hostile id writes nothing anywhere', async () => {
    const artifact = path.join(root, 'w.vcd');
    writeFileSync(artifact, '', 'utf8');
    const store = containedStore();
    for (const id of hostile()) {
      const result = await store.upsertArtifact({
        designId: id,
        kind: 'waveform',
        path: artifact,
        producer: 'simcrux',
      });
      expect(result, JSON.stringify(id)).toEqual([]);
    }
    // Nothing escaped, and the store did not even create its workspace
    // directory, since it had nothing to write into it.
    expect(tree(root)).toEqual(['w.vcd']);
  });

  it('pruneDesign of a hostile id is a no-op', async () => {
    const store = containedStore();
    for (const id of hostile()) {
      expect(await store.pruneDesign(id), JSON.stringify(id)).toEqual([]);
    }
    expect(tree(root)).toEqual([]);
  });

  it('an id with a separator still keys a file one level down', async () => {
    const store = containedStore();
    await store.upsertArtifact({
      designId: 'designs/cdc_capture',
      kind: 'waveform',
      path: '/abs/cdc_capture.vcd',
      producer: 'simcrux',
    });
    expect(tree(root)).toContain(path.join('nested', 'workspace', 'designs', 'cdc_capture.json'));
    expect(await store.readArtifacts('designs/cdc_capture')).toHaveLength(1);
  });
});

describe('sharedCxpWorkspaceDirectory', () => {
  it('is the peers directory’s sibling under one per-user root', () => {
    const directory = sharedCxpWorkspaceDirectory({
      env: { HOME: '/Users/dev' },
      platform: 'darwin',
    });
    expect(directory).toBe('/Users/dev/Library/Application Support/crux/cxp/workspace');
  });

  it('follows the same platform rules as the peers directory', () => {
    expect(
      sharedCxpWorkspaceDirectory({ env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, platform: 'win32' }),
    ).toContain('workspace');
    expect(
      sharedCxpWorkspaceDirectory({ env: { XDG_DATA_HOME: '/x' }, platform: 'linux' }),
    ).toBe('/x/crux/cxp/workspace');
  });

  it('is unavailable, not wrong, when the application-data root cannot be resolved', () => {
    expect(() => sharedCxpWorkspaceDirectory({ env: {}, platform: 'linux' })).toThrow();
  });
});
