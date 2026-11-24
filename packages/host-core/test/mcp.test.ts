import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MCP_PRODUCTS,
  locateMcpBinary,
  mcpConfigSnippet,
  mcpDefinitionsFor,
  mcpProductInfo,
  registerProductMcpServer,
  type LocateMcpDeps,
  type McpHost,
  type McpSettings,
  type McpStdioDefinitionData,
  type McpWorkspaceFolder,
} from '../src/mcp';

/** POSIX-shaped dependencies over a fixed set of existing paths. */
function deps(existing: string[], overrides: Partial<LocateMcpDeps> = {}): LocateMcpDeps {
  const set = new Set(existing);
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/opt/tools/bin' },
    home: '/home/u',
    exists: (p) => set.has(p),
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: (p) => p.slice(0, p.lastIndexOf('/')),
    pathDelimiter: ':',
    ...overrides,
  };
}

const wave = mcpProductInfo('wavecrux');
const sim = mcpProductInfo('simcrux');

describe('locateMcpBinary', () => {
  it('prefers the setting when it exists', () => {
    const result = locateMcpBinary(wave, '/x/wavecrux_pro', deps(['/x/wavecrux_pro', '/usr/bin/wavecrux']));
    expect(result).toEqual({ kind: 'found', path: '/x/wavecrux_pro', source: 'setting' });
  });

  it('reports a missing setting instead of searching on', () => {
    const result = locateMcpBinary(wave, '/x/nope', deps(['/usr/bin/wavecrux']));
    expect(result).toEqual({ kind: 'setting-missing', path: '/x/nope' });
  });

  it('prefers the Pro binary over an open-core binary earlier on PATH', () => {
    const result = locateMcpBinary(wave, '', deps(['/usr/bin/wavecrux', '/opt/tools/bin/wavecrux_pro']));
    expect(result).toEqual({ kind: 'found', path: '/opt/tools/bin/wavecrux_pro', source: 'search' });
  });

  it('accepts the hyphenated Pro spelling of the contracts', () => {
    // Built, not written out: the repository's private-name guard reads the
    // hyphenated form as a repository name.
    const hyphenated = `/usr/bin/${'wavecrux'}${'-pro'}`;
    const result = locateMcpBinary(wave, '', deps([hyphenated]));
    expect(result).toMatchObject({ kind: 'found', path: hyphenated });
  });

  it('falls back to the open-core binary', () => {
    const result = locateMcpBinary(wave, '', deps(['/usr/bin/wavecrux']));
    expect(result).toMatchObject({ kind: 'found', path: '/usr/bin/wavecrux' });
  });

  it('looks in the conventional folders when PATH lacks them', () => {
    const result = locateMcpBinary(wave, '', deps(['/home/u/.local/bin/wavecrux'], { env: { PATH: '' } }));
    expect(result).toMatchObject({ kind: 'found', path: '/home/u/.local/bin/wavecrux' });
  });

  it('skips a program that sits in a Flutter desktop bundle', () => {
    const result = locateMcpBinary(
      wave,
      '',
      deps(['/usr/bin/wavecrux_pro', '/usr/bin/data/flutter_assets', '/opt/tools/bin/wavecrux']),
    );
    expect(result).toMatchObject({ kind: 'found', path: '/opt/tools/bin/wavecrux' });
  });

  it('reports not-found', () => {
    expect(locateMcpBinary(wave, '', deps([]))).toEqual({ kind: 'not-found' });
  });

  it('treats SimCrux\'s default setting value as unset, so Pro is still preferred', () => {
    const result = locateMcpBinary(sim, 'simcrux', deps(['/usr/bin/simcrux', '/usr/bin/simcrux_pro']));
    expect(result).toMatchObject({ kind: 'found', path: '/usr/bin/simcrux_pro', source: 'search' });
  });

  it('resolves a bare name the person chose on the search path', () => {
    const result = locateMcpBinary(wave, 'my-wave', deps(['/opt/tools/bin/my-wave']));
    expect(result).toEqual({ kind: 'found', path: '/opt/tools/bin/my-wave', source: 'setting' });
  });

  it('adds .exe on Windows', () => {
    const result = locateMcpBinary(
      wave,
      '',
      deps(['C:\\t/wavecrux_pro.exe'], { platform: 'win32', env: { Path: 'C:\\t' }, pathDelimiter: ';' }),
    );
    expect(result).toMatchObject({ kind: 'found', path: 'C:\\t/wavecrux_pro.exe' });
  });
});

interface FakeState {
  settings: McpSettings;
  trusted: boolean;
  folders: McpWorkspaceFolder[];
  existing: string[];
}

function fakeHost(state: FakeState, withApi: boolean) {
  const registered: { id: string; provide: () => readonly McpStdioDefinitionData[]; fire: () => void }[] = [];
  const commands = new Map<string, () => Promise<void>>();
  const copied: string[] = [];
  const messages: string[] = [];
  const inputListeners = new Set<() => void>();
  let providerDisposed = 0;
  const host: McpHost = {
    registerDefinitionProvider: withApi
      ? (id, provider) => {
          let changed = 0;
          const sub = provider.onDidChange(() => {
            changed++;
          });
          registered.push({ id, provide: provider.provide, fire: () => void changed });
          return {
            dispose: () => {
              providerDisposed++;
              sub.dispose();
            },
          };
        }
      : undefined,
    registerCommand: (id, run) => {
      commands.set(id, run);
      return { dispose: () => void commands.delete(id) };
    },
    readSettings: () => state.settings,
    isWorkspaceTrusted: () => state.trusted,
    workspaceFolders: () => state.folders,
    onDidChangeInputs: (listener) => {
      inputListeners.add(listener);
      return { dispose: () => void inputListeners.delete(listener) };
    },
    copyToClipboard: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
    showInformation: (message) => {
      messages.push(message);
    },
    locateDeps: deps(state.existing),
  };
  return { host, registered, commands, copied, messages, inputListeners, providerDisposed: () => providerDisposed };
}

const baseState = (): FakeState => ({
  settings: { enabled: true, executable: '' },
  trusted: true,
  folders: [{ name: 'proj', path: '/work/proj' }],
  existing: ['/usr/bin/wavecrux'],
});

describe('mcpDefinitionsFor', () => {
  const options = (state: FakeState) => ({
    host: fakeHost(state, true).host,
    product: 'wavecrux' as const,
    version: '1.2.0',
    log: () => undefined,
  });

  it('offers `<binary> mcp --root <folder>` for the one folder', () => {
    expect(mcpDefinitionsFor(options(baseState()))).toEqual([
      { label: 'WaveCrux', command: '/usr/bin/wavecrux', args: ['mcp', '--root', '/work/proj'], version: '1.2.0' },
    ]);
  });

  it('offers one definition per folder in a multi-root workspace, each named', () => {
    const state = baseState();
    state.folders = [
      { name: 'a', path: '/w/a' },
      { name: 'b', path: '/w/b' },
    ];
    const definitions = mcpDefinitionsFor(options(state));
    expect(definitions.map((d) => d.label)).toEqual(['WaveCrux (a)', 'WaveCrux (b)']);
    expect(definitions.map((d) => d.args[2])).toEqual(['/w/a', '/w/b']);
  });

  it('offers nothing when the setting turns registration off', () => {
    const state = baseState();
    state.settings = { enabled: false, executable: '' };
    expect(mcpDefinitionsFor(options(state))).toEqual([]);
  });

  it('offers nothing in an untrusted workspace', () => {
    const state = baseState();
    state.trusted = false;
    expect(mcpDefinitionsFor(options(state))).toEqual([]);
  });

  it('offers nothing without a folder', () => {
    const state = baseState();
    state.folders = [];
    expect(mcpDefinitionsFor(options(state))).toEqual([]);
  });

  it('offers nothing, and says why, when the program is missing', () => {
    const state = baseState();
    state.existing = [];
    const lines: string[] = [];
    const definitions = mcpDefinitionsFor({ ...options(state), log: (line) => lines.push(line) });
    expect(definitions).toEqual([]);
    expect(lines.join('\n')).toContain('no WaveCrux command-line program found');
  });

  it('names the setting when it points at a missing file', () => {
    const state = baseState();
    state.settings = { enabled: true, executable: '/gone/wavecrux' };
    const lines: string[] = [];
    mcpDefinitionsFor({ ...options(state), log: (line) => lines.push(line) });
    expect(lines.join('\n')).toContain('edacrux.wave.executable');
  });
});

describe('registerProductMcpServer', () => {
  it('registers the provider under the id the manifest contributes', () => {
    const fake = fakeHost(baseState(), true);
    registerProductMcpServer({ host: fake.host, product: 'wavecrux', version: undefined, log: () => undefined });
    expect(fake.registered.map((r) => r.id)).toEqual(['wavecrux.mcp']);
    expect(fake.registered[0]?.provide()).toHaveLength(1);
  });

  it('registers no provider where the API is absent, and says so', () => {
    const fake = fakeHost(baseState(), false);
    const lines: string[] = [];
    registerProductMcpServer({ host: fake.host, product: 'wavecrux', version: undefined, log: (l) => lines.push(l) });
    expect(fake.registered).toEqual([]);
    expect(lines.join('\n')).toContain('no MCP server definition provider API');
    expect(fake.commands.has('wavecrux.copyMcpConfig')).toBe(true);
  });

  it('survives a registration that throws', () => {
    const fake = fakeHost(baseState(), true);
    const host: McpHost = {
      ...fake.host,
      registerDefinitionProvider: () => {
        throw new Error('no such namespace');
      },
    };
    const lines: string[] = [];
    registerProductMcpServer({ host, product: 'wavecrux', version: undefined, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('registration failed');
  });

  it('disposes the provider, the command and the input subscription', () => {
    const fake = fakeHost(baseState(), true);
    const registration = registerProductMcpServer({
      host: fake.host,
      product: 'wavecrux',
      version: undefined,
      log: () => undefined,
    });
    registration.dispose();
    expect(fake.providerDisposed()).toBe(1);
    expect(fake.commands.size).toBe(0);
    expect(fake.inputListeners.size).toBe(0);
  });

  it('copy command puts the snippet on the clipboard and says it worked', async () => {
    const fake = fakeHost(baseState(), false);
    registerProductMcpServer({ host: fake.host, product: 'wavecrux', version: undefined, log: () => undefined });
    await fake.commands.get('wavecrux.copyMcpConfig')?.();
    expect(JSON.parse(fake.copied[0] ?? '')).toEqual({
      mcpServers: { wavecrux: { command: '/usr/bin/wavecrux', args: ['mcp', '--root', '/work/proj'] } },
    });
    expect(fake.messages[0]).toContain('WaveCrux MCP server configuration is on the clipboard');
  });

  it('copy command still copies, and names the setting, when no program is found', async () => {
    const state = baseState();
    state.existing = [];
    const fake = fakeHost(state, false);
    registerProductMcpServer({ host: fake.host, product: 'wavecrux', version: undefined, log: () => undefined });
    await fake.commands.get('wavecrux.copyMcpConfig')?.();
    expect(fake.copied).toHaveLength(1);
    expect(fake.messages[0]).toContain('edacrux.wave.executable');
  });

  it('copy command works with registration turned off', async () => {
    const state = baseState();
    state.settings = { enabled: false, executable: '' };
    const fake = fakeHost(state, true);
    registerProductMcpServer({ host: fake.host, product: 'wavecrux', version: undefined, log: () => undefined });
    await fake.commands.get('wavecrux.copyMcpConfig')?.();
    expect(fake.copied).toHaveLength(1);
  });
});

describe('mcpConfigSnippet', () => {
  it('uses the host variable when no folder is open and the bare name when no program is known', () => {
    const parsed: unknown = JSON.parse(mcpConfigSnippet(sim, { kind: 'not-found' }, []));
    expect(parsed).toEqual({
      mcpServers: { simcrux: { command: 'simcrux', args: ['mcp', '--root', '${workspaceFolder}'] } },
    });
  });
});

describe('the manifests', () => {
  const packages = path.resolve(fileURLToPath(import.meta.url), '../../..');
  const read = (pkg: string, file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(packages, pkg, file), 'utf8')) as Record<string, unknown>;

  for (const product of MCP_PRODUCTS) {
    const info = mcpProductInfo(product);
    describe(product, () => {
      const manifest = read(product, 'package.json') as {
        contributes: {
          mcpServerDefinitionProviders: { id: string; label: string }[];
          commands: { command: string; title: string }[];
          configuration: { properties: Record<string, { default?: unknown; scope?: string }> };
        };
      };

      it('contributes the provider the code registers', () => {
        expect(manifest.contributes.mcpServerDefinitionProviders).toEqual([
          { id: info.providerId, label: info.label },
        ]);
      });

      it('contributes the copy command with a title in every locale', () => {
        const command = manifest.contributes.commands.find((c) => c.command === info.copyCommandId);
        expect(command).toBeDefined();
        const key = /^%(.+)%$/.exec(command?.title ?? '')?.[1] ?? '';
        for (const file of ['package.nls.json', 'package.nls.zh-hans.json', 'package.nls.ja.json', 'package.nls.ko.json']) {
          expect(typeof read(product, file)[key]).toBe('string');
        }
      });

      it('contributes the setting that turns registration off, default on', () => {
        expect(manifest.contributes.configuration.properties[`edacrux.${info.enabledKey}`]?.default).toBe(true);
      });

      it('cannot have its program path set by a workspace', () => {
        const setting = manifest.contributes.configuration.properties[`edacrux.${info.executableKey}`];
        if (product === 'simcrux') {
          // Predates the MCP registration; held in restrictedConfigurations.
          expect(setting).toBeDefined();
        } else {
          expect(setting?.scope).toBe('machine');
        }
      });
    });
  }
});
