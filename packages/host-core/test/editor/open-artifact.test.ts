/**
 * Inbound `request_open_artifact`.
 *
 * The two properties worth the most here are the security one — a peer
 * cannot make the editor open a path outside the folders the user opened,
 * *including through the workspace manifest*, which is a user-writable file
 * — and the join one: the consumer reads `design_id` off the wire and never
 * re-derives it from the artifact.
 */
import { describe, expect, it } from 'vitest';
import { CxpMessageKind, type RequestOpenArtifact } from '../../src/cxp/messages';
import type { WorkspaceArtifact } from '../../src/cxp/workspace-store';
import { handleRequestOpenArtifact } from '../../src/editor/open-artifact';
import {
  reasonArtifactOpenFailed,
  reasonFileNotFound,
  reasonNoArtifactForDesign,
  reasonNoWorkspaceFolder,
  reasonOutsideWorkspace,
} from '../../src/editor/strings';
import { FakeEditorHost } from './harness';

const WORKSPACE = '/work/project';

/** An editor host over a workspace holding one design folder. */
function editor(): FakeEditorHost {
  return new FakeEditorHost([WORKSPACE], new Map());
}

/** Everything resolves to itself; nothing is a symlink. */
const realpath = (p: string): Promise<string> => Promise.resolve(p);

/** A workspace store that answers with [artifact] and records what it was asked. */
function store(artifact: WorkspaceArtifact | undefined) {
  const asked: { designId: string; kind: string }[] = [];
  return {
    asked,
    resolveArtifact: (designId: string, kind: string) => {
      asked.push({ designId, kind });
      return Promise.resolve(artifact);
    },
  };
}

function request(overrides: Partial<RequestOpenArtifact> = {}): RequestOpenArtifact {
  return {
    kind: CxpMessageKind.requestOpenArtifact,
    designId: 'a1b2c3d4e5f60718',
    artifactKind: 'waveform',
    ...overrides,
  };
}

function artifactAt(path: string): WorkspaceArtifact {
  return { kind: 'waveform', path, producer: 'simcrux', ts: 1 };
}

describe('handleRequestOpenArtifact — resolution', () => {
  it('prefers its own workspace resolution over the sender’s path hint', async () => {
    // The reference implementation's rule: the sender's absolute path may
    // not exist on this machine's layout, so it is a fallback, not a value
    // to trust.
    const host = editor();
    const workspace = store(artifactAt(`${WORKSPACE}/design/mine.vcd`));
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/theirs.vcd` }),
      { editor: host, workspace, realpath, platform: 'linux' },
    );
    expect(ack).toEqual({ honored: true });
    expect(host.artifacts.map((entry) => entry.fsPath)).toEqual([`${WORKSPACE}/design/mine.vcd`]);
  });

  it('looks the design up by the id ON THE WIRE, never one it derived', async () => {
    // The shared-workspace join requirement. A consumer that re-derived an id from the
    // artifact would key the file's own folder while the producer keyed the
    // design's input folder, and the two would never meet.
    const workspace = store(artifactAt(`${WORKSPACE}/design/a.vcd`));
    await handleRequestOpenArtifact(request({ designId: 'ffffffffffffffff' }), {
      editor: editor(),
      workspace,
      realpath,
      platform: 'linux',
    });
    expect(workspace.asked).toEqual([{ designId: 'ffffffffffffffff', kind: 'waveform' }]);
  });

  it('falls back to the path hint when the workspace has nothing recorded', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/theirs.vcd` }),
      { editor: host, workspace: store(undefined), realpath, platform: 'linux' },
    );
    expect(ack).toEqual({ honored: true });
    expect(host.artifacts[0]?.fsPath).toBe(`${WORKSPACE}/design/theirs.vcd`);
  });

  it('works with no workspace store at all — the hint is then the only candidate', async () => {
    // A machine with no resolvable application-data root has no store, and
    // that must not turn the handler off: a refusal there would look to the
    // sender exactly like "no such artifact".
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/theirs.vcd` }),
      { editor: host, realpath, platform: 'linux' },
    );
    expect(ack).toEqual({ honored: true });
  });

  it('survives a workspace store that throws', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/theirs.vcd` }),
      {
        editor: host,
        workspace: {
          resolveArtifact: () => Promise.reject(new Error('corrupt')),
        },
        realpath,
        platform: 'linux',
      },
    );
    expect(ack).toEqual({ honored: true });
  });

  it('refuses with a reason when there is no candidate at all', async () => {
    const ack = await handleRequestOpenArtifact(request(), {
      editor: editor(),
      workspace: store(undefined),
      realpath,
      platform: 'linux',
    });
    expect(ack).toEqual({ honored: false, reason: reasonNoArtifactForDesign() });
  });

  it('opens any artifact kind — an editor’s answer does not depend on what the sender calls it', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ artifactKind: 'schematic_hyperlattice', path: `${WORKSPACE}/x.txt` }),
      { editor: host, realpath, platform: 'linux' },
    );
    expect(ack).toEqual({ honored: true });
  });
});

describe('handleRequestOpenArtifact — containment (CXP §11)', () => {
  it('refuses a path hint outside every open folder', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(request({ path: '/etc/passwd' }), {
      editor: host,
      realpath,
      platform: 'linux',
    });
    expect(ack).toEqual({ honored: false, reason: reasonOutsideWorkspace() });
    expect(host.artifacts).toEqual([]);
  });

  it('refuses an escape recorded in the WORKSPACE MANIFEST, not only in the message', async () => {
    // The manifest is a user-writable file in a user-writable directory,
    // exactly like the peer manifests. "We resolved it ourselves" is not a
    // provenance claim, and this is the case a containment check applied
    // only to `path` would miss entirely.
    const host = editor();
    const ack = await handleRequestOpenArtifact(request(), {
      editor: host,
      workspace: store(artifactAt('/home/dev/.ssh/id_ed25519')),
      realpath,
      platform: 'linux',
    });
    expect(ack).toEqual({ honored: false, reason: reasonOutsideWorkspace() });
    expect(host.artifacts).toEqual([]);
  });

  it('follows the hint when the manifest entry is the one that escapes', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/theirs.vcd` }),
      {
        editor: host,
        workspace: store(artifactAt('/etc/shadow')),
        realpath,
        platform: 'linux',
      },
    );
    expect(ack).toEqual({ honored: true });
    expect(host.artifacts[0]?.fsPath).toBe(`${WORKSPACE}/design/theirs.vcd`);
  });

  it('resolves symlinks BEFORE the containment test, and opens the value it checked', async () => {
    const host = editor();
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/link.vcd` }),
      {
        editor: host,
        realpath: (p) =>
          Promise.resolve(p === `${WORKSPACE}/design/link.vcd` ? '/elsewhere/secret.vcd' : p),
        platform: 'linux',
      },
    );
    expect(ack).toEqual({ honored: false, reason: reasonOutsideWorkspace() });
  });

  it('refuses everything when no folder is open', async () => {
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/a.vcd` }),
      {
        editor: new FakeEditorHost([], new Map()),
        realpath,
        platform: 'linux',
      },
    );
    expect(ack).toEqual({ honored: false, reason: reasonNoWorkspaceFolder() });
  });

  it('distinguishes "inside the workspace but missing" from "outside"', async () => {
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/gone.vcd` }),
      {
        editor: editor(),
        // `realpath` rejecting is how a file that does not exist presents.
        realpath: (p) =>
          p === `${WORKSPACE}/design/gone.vcd`
            ? Promise.reject(new Error('ENOENT'))
            : Promise.resolve(p),
        platform: 'linux',
      },
    );
    expect(ack).toEqual({ honored: false, reason: reasonFileNotFound() });
  });

  it('never echoes the peer’s path or design id back in a refusal', async () => {
    const ack = await handleRequestOpenArtifact(
      request({ designId: 'deadbeefdeadbeef', path: '/etc/passwd' }),
      { editor: editor(), realpath, platform: 'linux' },
    );
    expect(ack.reason).not.toContain('/etc/passwd');
    expect(ack.reason).not.toContain('deadbeefdeadbeef');
  });
});

describe('handleRequestOpenArtifact — opening', () => {
  it('reports an editor that refuses the file rather than throwing', async () => {
    const host = editor();
    host.artifactOpenRejects = true;
    const ack = await handleRequestOpenArtifact(
      request({ path: `${WORKSPACE}/design/a.fst` }),
      { editor: host, realpath, platform: 'linux' },
    );
    expect(ack).toEqual({ honored: false, reason: reasonArtifactOpenFailed() });
  });

  it('lands the focus like `request_open_source` does, under the same setting', async () => {
    const host = editor();
    await handleRequestOpenArtifact(request({ path: `${WORKSPACE}/design/a.vcd` }), {
      editor: host,
      realpath,
      platform: 'linux',
      settings: { revealSelection: true, openSourceFocusesEditor: true, followWaveformSelection: false },
    });
    expect(host.artifacts[0]?.options).toEqual({ preserveFocus: false, preview: false });

    const quiet = editor();
    await handleRequestOpenArtifact(request({ path: `${WORKSPACE}/design/a.vcd` }), {
      editor: quiet,
      realpath,
      platform: 'linux',
      settings: { revealSelection: true, openSourceFocusesEditor: false, followWaveformSelection: false },
    });
    expect(quiet.artifacts[0]?.options).toEqual({ preserveFocus: true, preview: false });
  });
});
