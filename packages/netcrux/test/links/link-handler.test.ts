/**
 * The NetCrux link handler end to end, short of the window: the rewrite, the
 * parser, the file check on a real filesystem, the open-tab check, the
 * confirmation and the open, composed as `links/register.ts` composes them.
 */
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { links } from '@crux-vscode/host-core';
import { parseNetCruxLink, vetNetCruxLinkTarget, type NetCruxLink } from '../../src/links/netcrux-link';

const EXTENSION = 'ferrite-engineering.netcrux';

interface Seen {
  readonly notices: links.CruxLinkNotice[];
  readonly confirmed: string[];
  readonly opened: Array<{ path: string; link: NetCruxLink }>;
}

function handler(
  options: {
    openTabs?: readonly string[];
    answer?: boolean;
    parse?: (raw: string) => ReturnType<typeof parseNetCruxLink>;
    vet?: (file: string) => Promise<links.LinkTargetResult>;
  } = {},
): { run: (text: string) => Promise<links.CruxLinkOutcome>; seen: Seen } {
  const seen: Seen = { notices: [], confirmed: [], opened: [] };
  const flow: links.CruxLinkFlow<NetCruxLink> = {
    parse: options.parse ?? ((raw) => parseNetCruxLink(raw)),
    vet: options.vet ?? ((file) => vetNetCruxLinkTarget(file)),
    openTabPath: (resolved) => links.findOpenedPath(resolved, options.openTabs ?? []),
    confirm: (resolved) => {
      seen.confirmed.push(resolved);
      return Promise.resolve(options.answer ?? true);
    },
    open: (opened, link) => {
      seen.opened.push({ path: opened, link });
      return Promise.resolve();
    },
    notify: (notice) => seen.notices.push(notice),
  };
  return {
    run: (text) => links.openCruxLink(links.desktopLinkFromText(text, 'netcrux', EXTENSION), flow),
    seen,
  };
}

const encode = links.encodeLinkValue;
const posix = process.platform !== 'win32';

describe.runIf(posix)('a NetCrux link', () => {
  let root = '';
  let source = '';
  let netlist = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'netcrux-link-')));
    source = path.join(root, 'top.sv');
    netlist = path.join(root, 'top.json');
    await writeFile(source, 'module top; endmodule\n');
    await writeFile(netlist, '{"modules":{}}');
    await writeFile(path.join(root, 'design.netcrux-project'), '{}');
    await writeFile(path.join(root, 'files.f'), 'top.sv\n');
    await writeFile(path.join(root, 'design.crux-project'), '{}');
    await writeFile(path.join(root, 'credentials'), 'secret');
    await symlink(path.join(root, 'credentials'), path.join(root, 'trap.v'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('opens a netlist or a source after asking, with its cell or net', async () => {
    const { run, seen } = handler();
    await run(`netcrux://open?file=${encode(netlist)}&cell=top.u_cpu.pc_reg`);
    await run(`vscode://${EXTENSION}/open?file=${encode(source)}&net=top.y`);
    expect(seen.confirmed).toEqual([netlist, source]);
    expect(seen.opened).toEqual([
      { path: netlist, link: { file: netlist, kind: 'cell', name: 'top.u_cpu.pc_reg' } },
      { path: source, link: { file: source, kind: 'net', name: 'top.y' } },
    ]);
  });

  it('opens nothing on Cancel, and asks nothing for a file open in a tab', async () => {
    const cancelled = handler({ answer: false });
    expect((await cancelled.run(`netcrux://open?file=${encode(source)}`)).kind).toBe('cancelled');
    expect(cancelled.seen.opened).toEqual([]);

    const open = handler({ openTabs: [source] });
    expect(await open.run(`netcrux://open?file=${encode(source)}`)).toEqual({
      kind: 'opened',
      path: source,
      confirmed: false,
    });
    expect(open.seen.confirmed).toEqual([]);
  });

  it.each<readonly [string, () => string, links.CruxLinkNotice]>([
    ['a relative path', () => 'netcrux://open?file=top.sv', { kind: 'path' }],
    ['a project, which carries Yosys commands', () => `netcrux://open?file=${encode(path.join(root, 'design.netcrux-project'))}`, { kind: 'wrong-kind', fileName: 'design.netcrux-project' }],
    ['a filelist, which names further files', () => `netcrux://open?file=${encode(path.join(root, 'files.f'))}`, { kind: 'wrong-kind', fileName: 'files.f' }],
    ['a suite manifest', () => `netcrux://open?file=${encode(path.join(root, 'design.crux-project'))}`, { kind: 'wrong-kind', fileName: 'design.crux-project' }],
    ['a source name that resolves to something else', () => `netcrux://open?file=${encode(path.join(root, 'trap.v'))}`, { kind: 'wrong-kind', fileName: 'trap.v' }],
    ['a missing file', () => `netcrux://open?file=${encode(path.join(root, 'gone.v'))}`, { kind: 'not-found', fileName: 'gone.v' }],
    ['both a cell and a net', () => `netcrux://open?file=${encode(source)}&cell=a&net=b`, { kind: 'invalid' }],
    ['a WaveCrux key', () => `netcrux://open?file=${encode(source)}&signal=a`, { kind: 'invalid' }],
  ])('refuses %s, says why, and opens nothing', async (_, link, notice) => {
    const { run, seen } = handler();
    expect((await run(link())).kind).toBe('refused');
    expect(seen.notices).toEqual([notice]);
    expect(seen.confirmed).toEqual([]);
    expect(seen.opened).toEqual([]);
  });

  /** The oracle: a link whose file is relative asks nothing and opens nothing. */
  async function relativePathProblems(options: Parameters<typeof handler>[0]): Promise<string[]> {
    const { run, seen } = handler(options);
    await run('netcrux://open?file=top.sv&cell=top.u');
    return [
      ...seen.confirmed.map((file) => `asked about ${file}`),
      ...seen.opened.map((entry) => `opened ${entry.path}`),
    ];
  }

  it('the shipped handler passes the relative-path oracle', async () => {
    expect(await relativePathProblems({})).toEqual([]);
  });

  it('mutation: a handler that opens a relative path fails the relative-path oracle', async () => {
    // Both absolute-path rules replaced by ones that accept any spelling (the
    // parser's and the file check's), on a filesystem where `top.sv` resolves
    // as it would against the directory the editor started in.
    const resolvesRelative: links.LinkTargetFs = {
      isFile: (file) => Promise.resolve(file === 'top.sv' || file === source),
      isFileNoFollow: (file) => Promise.resolve(file === source),
      realpath: (file) => Promise.resolve(file === 'top.sv' ? source : file),
    };
    const mutant = {
      parse: (raw: string) => parseNetCruxLink(raw, { isAbsolute: () => true }),
      vet: (file: string) => vetNetCruxLinkTarget(file, { fs: resolvesRelative, refusePath: () => undefined }),
    };
    expect(await relativePathProblems(mutant)).not.toEqual([]);
    // Either rule alone still refuses it.
    expect(await relativePathProblems({ vet: mutant.vet })).toEqual([]);
    expect(
      await relativePathProblems({ parse: mutant.parse, vet: (file) => vetNetCruxLinkTarget(file, { fs: resolvesRelative }) }),
    ).toEqual([]);
  });
});
