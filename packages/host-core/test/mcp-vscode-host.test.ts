import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The VSCode adapter, with the MCP API mocked. Two editors are simulated:
 * one with `vscode.lm.registerMcpServerDefinitionProvider` and
 * `McpStdioServerDefinition`, and one (a fork, or VSCode before 1.101)
 * with neither.
 */
const state = vi.hoisted(() => ({
  withApi: true,
  registrations: [] as { id: string; provider: { provideMcpServerDefinitions: () => unknown[] } }[],
  disposed: 0,
  commands: new Map<string, () => Promise<void>>(),
  clipboard: [] as string[],
  config: new Map<string, unknown>(),
  folders: [{ name: 'proj', uri: { scheme: 'file', fsPath: '/work/proj' } }],
  trusted: true,
}));

vi.mock('vscode', () => {
  class McpStdioServerDefinition {
    constructor(
      readonly label: string,
      readonly command: string,
      readonly args: string[],
      readonly env: unknown,
      readonly version: string | undefined,
    ) {}
  }
  class EventEmitter {
    readonly listeners: (() => void)[] = [];
    readonly event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(): void {
      this.listeners.forEach((l) => l());
    }
    dispose(): void {}
  }
  const noop = () => ({ dispose: () => undefined });
  const module = {
    l10n: { t: (m: string, ...a: unknown[]) => m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)])) },
    EventEmitter,
    get lm() {
      return state.withApi
        ? {
            registerMcpServerDefinitionProvider: (
              id: string,
              provider: { provideMcpServerDefinitions: () => unknown[] },
            ) => {
              state.registrations.push({ id, provider });
              return { dispose: () => void state.disposed++ };
            },
          }
        : {};
    },
    get McpStdioServerDefinition() {
      return state.withApi ? McpStdioServerDefinition : undefined;
    },
    commands: {
      registerCommand: (id: string, run: () => Promise<void>) => {
        state.commands.set(id, run);
        return { dispose: () => void state.commands.delete(id) };
      },
    },
    env: {
      clipboard: {
        writeText: (text: string) => {
          state.clipboard.push(text);
          return Promise.resolve();
        },
      },
    },
    window: { showInformationMessage: () => Promise.resolve(undefined) },
    workspace: {
      getConfiguration: () => ({ get: (key: string) => state.config.get(key) }),
      get isTrusted() {
        return state.trusted;
      },
      get workspaceFolders() {
        return state.folders;
      },
      onDidChangeConfiguration: noop,
      onDidChangeWorkspaceFolders: noop,
      onDidGrantWorkspaceTrust: noop,
    },
  };
  // Returned as is, not spread: the `lm` and `McpStdioServerDefinition`
  // getters must be read at use time so one file can simulate both editors.
  return module;
});

import { vscodeMcpHost } from '../src/mcp/vscode-host';
import { registerProductMcpServer } from '../src/mcp';

beforeEach(() => {
  state.withApi = true;
  state.registrations.length = 0;
  state.disposed = 0;
  state.commands.clear();
  state.clipboard.length = 0;
  state.config.clear();
  state.trusted = true;
});

describe('vscodeMcpHost', () => {
  it('reads the enabled flag (default on) and the trimmed executable', () => {
    const host = vscodeMcpHost();
    const info = { enabledKey: 'wave.mcp.enabled', executableKey: 'wave.executable' } as never;
    expect(host.readSettings(info)).toEqual({ enabled: true, executable: '' });
    state.config.set('wave.mcp.enabled', false);
    state.config.set('wave.executable', '  /x/wavecrux  ');
    expect(host.readSettings(info)).toEqual({ enabled: false, executable: '/x/wavecrux' });
  });

  it('hands the editor McpStdioServerDefinition objects', () => {
    const host = vscodeMcpHost();
    const registration = registerProductMcpServer({
      host: { ...host, locateDeps: { ...host.locateDeps, exists: (p) => p === '/bin/wavecrux', env: { PATH: '/bin' } } },
      product: 'wavecrux',
      version: '1.2.0',
      log: () => undefined,
    });
    expect(state.registrations.map((r) => r.id)).toEqual(['wavecrux.mcp']);
    const definitions = state.registrations[0]?.provider.provideMcpServerDefinitions() as {
      label: string;
      command: string;
      args: string[];
      version: string;
    }[];
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      label: 'WaveCrux',
      command: '/bin/wavecrux',
      args: ['mcp', '--root', '/work/proj'],
      version: '1.2.0',
    });
    registration.dispose();
    expect(state.disposed).toBe(1);
  });

  it('offers nothing in an untrusted workspace', () => {
    state.trusted = false;
    registerProductMcpServer({
      host: vscodeMcpHost(),
      product: 'wavecrux',
      version: undefined,
      log: () => undefined,
    });
    expect(state.registrations[0]?.provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it('has no provider registration in an editor without the API, but keeps the copy command', async () => {
    state.withApi = false;
    const host = vscodeMcpHost();
    expect(host.registerDefinitionProvider).toBeUndefined();
    registerProductMcpServer({ host, product: 'netcrux', version: undefined, log: () => undefined });
    expect(state.registrations).toEqual([]);
    await state.commands.get('netcrux.copyMcpConfig')?.();
    expect(state.clipboard).toHaveLength(1);
    expect(JSON.parse(state.clipboard[0] ?? '')).toHaveProperty('mcpServers.netcrux.args', [
      'mcp',
      '--root',
      '/work/proj',
    ]);
  });
});
