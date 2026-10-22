import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editor, type desktopDetect } from '@crux-vscode/host-core';
import {
  isNetCruxDesignFile,
  isNetCruxProjectFile,
  NETCRUX_ARTIFACT_KIND,
  NETCRUX_DESIGN_EXTENSIONS,
  NETCRUX_DESIGN_GLOB,
  NETCRUX_PROJECT_ARTIFACT_KIND,
  NETCRUX_PROJECT_EXTENSIONS,
  NETCRUX_PROJECT_GLOB,
  NETCRUX_SOURCE_ARTIFACT_KIND,
  noNetCruxDesignMessage,
  openDesignInNetCrux,
  pickNetCruxDesignFile,
  pickNetCruxHandoffTarget,
  pickNetCruxProjectFile,
  type NetCruxHandoffSources,
  type NetCruxHandoffTarget,
} from '../src/handoff';

const opened: desktopDetect.ArtifactHandoffOutcome = {
  kind: 'opened-in-peer',
  designId: 'a1b2c3d4e5f60718',
  path: '/ws/rtl/top.sv',
};

/** Files a NetCrux workspace holds that are not HDL NetCrux can load as `source`. */
const NOT_A_DESIGN = [
  '/ws/debug.netcrux', // a per-tab session export
  '/ws/cpu.netcrux-project', // a project: sent as `project`, never as HDL
  '/ws/cpu.crux-project', // the suite manifest, likewise
  '/ws/.crux-project',
  '/ws/rtl/defs.vh', // headers: included text, not a design
  '/ws/rtl/pkg.svh',
  '/ws/build/netlist.json',
  '/ws/README.md',
];

describe('openDesignInNetCrux', () => {
  it('hands the target to the desktop peer as the kind it was picked as', async () => {
    const handedOff: [string, string][] = [];
    const target: NetCruxHandoffTarget = { kind: 'project', path: '/ws/cpu.netcrux-project' };
    const outcome = await openDesignInNetCrux({
      target: () => Promise.resolve(target),
      handOff: (kind, fsPath) => {
        handedOff.push([kind, fsPath]);
        return Promise.resolve(opened);
      },
      showMessage: () => undefined,
    });

    expect(outcome).toEqual({
      kind: 'handed-off',
      artifactKind: 'project',
      designFile: '/ws/cpu.netcrux-project',
      handoff: opened,
    });
    expect(handedOff).toEqual([['project', '/ws/cpu.netcrux-project']]);
  });

  it('reports the handoff’s own outcome rather than flattening it', async () => {
    // "the app opened it" and "the OS opened it with whatever owns the
    // extension" are different events; a caller that could not tell them
    // apart would log the same line for both.
    const fellBack: desktopDetect.ArtifactHandoffOutcome = {
      kind: 'launched-externally',
      path: '/ws/rtl/top.sv',
      why: 'no-answer',
    };
    const outcome = await openDesignInNetCrux({
      target: () => Promise.resolve({ kind: 'source', path: '/ws/rtl/top.sv' }),
      handOff: () => Promise.resolve(fellBack),
      showMessage: () => undefined,
    });

    expect(outcome).toMatchObject({ kind: 'handed-off', artifactKind: 'source', handoff: fellBack });
  });

  it('explains rather than failing silently when there is nothing to hand over', async () => {
    const shown: string[] = [];
    const handedOff: string[] = [];
    const outcome = await openDesignInNetCrux({
      target: () => Promise.resolve(undefined),
      handOff: (_kind, fsPath) => {
        handedOff.push(fsPath);
        return Promise.resolve(opened);
      },
      showMessage: (message) => {
        shown.push(message);
      },
    });

    expect(outcome).toEqual({ kind: 'no-design' });
    expect(handedOff).toEqual([]);
    expect(shown).toEqual([noNetCruxDesignMessage()]);
  });
});

describe('pickNetCruxDesignFile', () => {
  it('prefers the design file in the active editor, without searching', async () => {
    let searched = false;
    const picked = await pickNetCruxDesignFile('/ws/rtl/alu.v', () => {
      searched = true;
      return Promise.resolve('/ws/rtl/top.sv');
    });

    expect(picked).toBe('/ws/rtl/alu.v');
    expect(searched).toBe(false);
  });

  it.each(NOT_A_DESIGN)('passes over an active %s and searches the workspace', async (active) => {
    const picked = await pickNetCruxDesignFile(active, () => Promise.resolve('/ws/rtl/top.sv'));
    expect(picked).toBe('/ws/rtl/top.sv');
  });

  it('searches the workspace when no file is active', async () => {
    const picked = await pickNetCruxDesignFile(undefined, () => Promise.resolve('/ws/rtl/top.vhd'));
    expect(picked).toBe('/ws/rtl/top.vhd');
  });

  it('finds nothing when neither the editor nor the workspace has a design file', async () => {
    expect(await pickNetCruxDesignFile(undefined, () => Promise.resolve(undefined))).toBeUndefined();
  });

  it.each(NOT_A_DESIGN)('never hands over %s as HDL, even when the search returns it', async (found) => {
    // The defect the single-file path was rewritten for: the search found a
    // session file and it went to NetCrux as HDL.
    expect(await pickNetCruxDesignFile(undefined, () => Promise.resolve(found))).toBeUndefined();
  });
});

/** A resolver that admits only paths under `/ws/` and returns them unchanged. */
const insideWs = (fsPath: string): Promise<string | undefined> =>
  Promise.resolve(fsPath.startsWith('/ws/') ? fsPath : undefined);

function sources(overrides: Partial<NetCruxHandoffSources> = {}): NetCruxHandoffSources {
  return {
    activeFile: undefined,
    searchProjects: () => Promise.resolve([]),
    searchDesign: () => Promise.resolve(undefined),
    resolveInWorkspace: insideWs,
    ...overrides,
  };
}

describe('pickNetCruxHandoffTarget', () => {
  it('sends a project, not the active HDL file, when the workspace has a project file', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({
        activeFile: '/ws/rtl/alu.v',
        searchProjects: () => Promise.resolve(['/ws/cpu.netcrux-project']),
        searchDesign: () => Promise.resolve('/ws/rtl/top.sv'),
      }),
    );
    expect(target).toEqual({ kind: 'project', path: '/ws/cpu.netcrux-project' });
  });

  it('sends the project file in the active editor when it is one', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({
        activeFile: '/ws/soc/soc.crux-project',
        searchProjects: () => Promise.resolve(['/ws/cpu.netcrux-project']),
      }),
    );
    expect(target).toEqual({ kind: 'project', path: '/ws/soc/soc.crux-project' });
  });

  it('falls back to the single-file source when there is no project file', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({ activeFile: '/ws/rtl/alu.v', searchDesign: () => Promise.resolve('/ws/rtl/top.sv') }),
    );
    expect(target).toEqual({ kind: 'source', path: '/ws/rtl/alu.v' });
  });

  it('falls back to a searched source when no editor is active', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({ searchDesign: () => Promise.resolve('/ws/rtl/top.sv') }),
    );
    expect(target).toEqual({ kind: 'source', path: '/ws/rtl/top.sv' });
  });

  it('is undefined when the workspace has neither', async () => {
    expect(await pickNetCruxHandoffTarget(sources())).toBeUndefined();
  });

  it('never sends a project file outside the workspace; it falls back to source', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({
        activeFile: '/elsewhere/other.netcrux-project',
        searchProjects: () => Promise.resolve(['/elsewhere/cpu.crux-project']),
        searchDesign: () => Promise.resolve('/ws/rtl/top.sv'),
      }),
    );
    expect(target).toEqual({ kind: 'source', path: '/ws/rtl/top.sv' });
  });

  it('sends the path the containment check returned, not the one it was given', async () => {
    const target = await pickNetCruxHandoffTarget(
      sources({
        searchProjects: () => Promise.resolve(['/ws/link/cpu.netcrux-project']),
        resolveInWorkspace: () => Promise.resolve('/ws/real/cpu.netcrux-project'),
      }),
    );
    expect(target).toEqual({ kind: 'project', path: '/ws/real/cpu.netcrux-project' });
  });
});

describe('pickNetCruxProjectFile', () => {
  it('chooses the project beside the active file, then the shallowest, deterministically', async () => {
    const found = [
      '/ws/a/b/deep.netcrux-project',
      '/ws/z.netcrux-project',
      '/ws/soc/soc.crux-project',
      '/ws/a.netcrux-project',
    ];
    expect(
      await pickNetCruxProjectFile('/ws/soc/rtl/x.v', () => Promise.resolve(found), insideWs),
    ).toBe('/ws/soc/soc.crux-project');
    expect(await pickNetCruxProjectFile(undefined, () => Promise.resolve(found), insideWs)).toBe(
      '/ws/a.netcrux-project',
    );
    expect(
      await pickNetCruxProjectFile(undefined, () => Promise.resolve([...found].reverse()), insideWs),
    ).toBe('/ws/a.netcrux-project');
  });

  it('skips a refused candidate and takes the next one inside the workspace', async () => {
    expect(
      await pickNetCruxProjectFile(
        undefined,
        () => Promise.resolve(['/out/a.netcrux-project', '/ws/deep/b.netcrux-project']),
        insideWs,
      ),
    ).toBe('/ws/deep/b.netcrux-project');
  });

  it.each(NOT_A_DESIGN.filter((file) => !isNetCruxProjectFile(file)))(
    'never offers %s as a project, even when the search returns it',
    async (found) => {
      expect(
        await pickNetCruxProjectFile(found, () => Promise.resolve([found]), insideWs),
      ).toBeUndefined();
    },
  );
});

describe('pickNetCruxProjectFile against the real workspace containment check', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function fixture(): Promise<{ workspace: string; outside: string }> {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'netcrux-handoff-')));
    roots.push(base);
    const workspace = path.join(base, 'ws');
    const outside = path.join(base, 'ws-secrets');
    await mkdir(path.join(workspace, 'cpu'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(workspace, 'cpu', 'cpu.netcrux-project'), '{}');
    await writeFile(path.join(outside, 'evil.netcrux-project'), '{}');
    return { workspace, outside };
  }

  function resolver(workspace: string): (fsPath: string) => Promise<string | undefined> {
    return async (fsPath) => {
      const resolved = await editor.resolveWorkspacePath(fsPath, { workspaceFolders: [workspace] });
      return resolved.ok ? resolved.fsPath : undefined;
    };
  }

  it('admits a project inside the workspace', async () => {
    const { workspace } = await fixture();
    const project = path.join(workspace, 'cpu', 'cpu.netcrux-project');
    expect(await pickNetCruxProjectFile(project, () => Promise.resolve([]), resolver(workspace))).toBe(
      project,
    );
  });

  it('refuses a project outside the workspace, including a sibling sharing its name prefix', async () => {
    const { workspace, outside } = await fixture();
    const evil = path.join(outside, 'evil.netcrux-project');
    expect(
      await pickNetCruxProjectFile(evil, () => Promise.resolve([evil]), resolver(workspace)),
    ).toBeUndefined();
  });

  it('refuses a `..` escape and a symlink out of the workspace', async () => {
    const { workspace, outside } = await fixture();
    const dotdot = path.join(workspace, 'cpu', '..', '..', 'ws-secrets', 'evil.netcrux-project');
    await symlink(outside, path.join(workspace, 'link'));
    const viaLink = path.join(workspace, 'link', 'evil.netcrux-project');
    for (const candidate of [dotdot, viaLink]) {
      expect(
        await pickNetCruxProjectFile(undefined, () => Promise.resolve([candidate]), resolver(workspace)),
      ).toBeUndefined();
    }
  });

  it('with no workspace folder open, refuses everything', async () => {
    const { workspace } = await fixture();
    const project = path.join(workspace, 'cpu', 'cpu.netcrux-project');
    const refuseAll = async (fsPath: string): Promise<string | undefined> => {
      const resolved = await editor.resolveWorkspacePath(fsPath, { workspaceFolders: [] });
      return resolved.ok ? resolved.fsPath : undefined;
    };
    expect(await pickNetCruxProjectFile(project, () => Promise.resolve([project]), refuseAll)).toBe(
      undefined,
    );
  });
});

/**
 * What NetCrux's `request_open_artifact` handler accepts, stated once here
 * and once in NetCrux's own `test/services/remote/cxp/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` (one HDL file) or `project` (a
 *    `.netcrux-project`, a `<design>.crux-project` or a `.f` filelist);
 *    anything else is refused;
 * 2. the path passes the floor: absolute, no NUL, and no surrounding white
 *    space, because the string checked is the string loaded;
 * 3. a `source` names a file NetCrux loads as HDL (Yosys reads Verilog,
 *    SystemVerilog or VHDL); a `project` names a file its project loader reads.
 *
 * The live half, this path published and sent by host-core's
 * `openArtifactInDesktop`, is `host-core/test/desktop-detect/project-handoff.test.ts`
 * (the exact wire payload) and `host-core/test/cxp/dart-interop.test.ts`.
 */
describe('the contract with NetCrux’s handler', () => {
  /** NetCrux's floor for this route, restated: see the doc comment above. */
  function passesNetCruxFloor(fsPath: string): boolean {
    return (
      fsPath.trim().length > 0 &&
      !fsPath.includes(String.fromCharCode(0)) &&
      fsPath.trim() === fsPath &&
      path.isAbsolute(fsPath)
    );
  }

  it('names the two CXP §9.10.2 kinds, and keeps the single-file name it had', () => {
    expect(NETCRUX_SOURCE_ARTIFACT_KIND).toBe('source');
    expect(NETCRUX_PROJECT_ARTIFACT_KIND).toBe('project');
    expect(NETCRUX_ARTIFACT_KIND).toBe('source');
  });

  it('offers only file types NetCrux’s own source picker accepts, and no header', () => {
    // NetCrux's `FileOpenService.pickSourceFiles` allows v, sv, svh, vh, vhd, vhdl.
    const netCruxSourcePicker = ['.v', '.sv', '.svh', '.vh', '.vhd', '.vhdl'];
    for (const extension of NETCRUX_DESIGN_EXTENSIONS) {
      expect(netCruxSourcePicker).toContain(extension);
    }
    expect(NETCRUX_DESIGN_EXTENSIONS).not.toContain('.vh');
    expect(NETCRUX_DESIGN_EXTENSIONS).not.toContain('.svh');
  });

  it('offers as a project only the two forms NetCrux’s project loader reads by extension', () => {
    expect([...NETCRUX_PROJECT_EXTENSIONS].sort()).toEqual(['.crux-project', '.netcrux-project']);
  });

  it.each([
    ['design', NETCRUX_DESIGN_GLOB, NETCRUX_DESIGN_EXTENSIONS],
    ['project', NETCRUX_PROJECT_GLOB, NETCRUX_PROJECT_EXTENSIONS],
  ] as const)('searches with a %s glob that names exactly its extensions', (_name, glob, extensions) => {
    const braced = /^\*\*\/\*\.\{([^}]+)\}$/.exec(glob);
    expect(braced).not.toBeNull();
    const globbed = (braced?.[1] ?? '').split(',').map((extension) => `.${extension}`);
    expect([...globbed].sort()).toEqual([...extensions].sort());
  });

  it('recognises each kind of file whatever the case of its extension', () => {
    expect(isNetCruxDesignFile('/ws/RTL/TOP.SV')).toBe(true);
    expect(isNetCruxDesignFile('/ws/rtl/top.Vhdl')).toBe(true);
    expect(isNetCruxProjectFile('/ws/CPU.NetCrux-Project')).toBe(true);
    expect(isNetCruxProjectFile('/ws/cpu.crux-project')).toBe(true);
    expect(isNetCruxProjectFile('/ws/rtl/top.sv')).toBe(false);
    expect(isNetCruxProjectFile('/ws/debug.netcrux')).toBe(false);
  });

  it('whatever the editor or the workspace offers, what is picked satisfies all three', async () => {
    const offers: readonly (string | undefined)[] = [
      undefined,
      ...NOT_A_DESIGN,
      path.resolve('/ws/rtl/top.sv'),
      path.resolve('/ws/rtl/alu.v'),
      path.resolve('/ws/rtl/fsm.vhd'),
      path.resolve('/ws/rtl/fsm.vhdl'),
      path.resolve('/ws/cpu.netcrux-project'),
    ];
    const admitAll = (fsPath: string): Promise<string | undefined> => Promise.resolve(fsPath);
    for (const active of offers) {
      for (const found of offers) {
        const picked = await pickNetCruxHandoffTarget({
          activeFile: active,
          searchProjects: () => Promise.resolve(found === undefined ? [] : [found]),
          searchDesign: () => Promise.resolve(found),
          resolveInWorkspace: admitAll,
        });
        if (picked === undefined) continue;
        expect(passesNetCruxFloor(picked.path), picked.path).toBe(true);
        // The kind and the file agree: a project file is never `source`, HDL never `project`.
        if (picked.kind === 'project') {
          expect(isNetCruxProjectFile(picked.path), picked.path).toBe(true);
        } else {
          expect(isNetCruxDesignFile(picked.path), picked.path).toBe(true);
          expect(isNetCruxProjectFile(picked.path), picked.path).toBe(false);
        }
        expect(picked.path.endsWith('.netcrux')).toBe(false);
      }
    }
  });
});
