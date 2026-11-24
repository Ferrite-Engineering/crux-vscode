/**
 * Registers a product's MCP server with the editor.
 *
 * Two routes, one decision each:
 *
 * - **The editor has the MCP server definition provider API** (VSCode 1.101
 *   and later): a provider hands the editor one stdio definition per
 *   workspace folder, `<product> mcp --root <folder>`, and the editor
 *   decides when to start it and asks the person to trust it first.
 * - **It does not** (older VSCode, or a fork without the API): nothing is
 *   registered, and the copy command puts the configuration snippet on the
 *   clipboard for the host's own MCP settings. The command exists in both
 *   cases, so a person can always take the snippet elsewhere.
 *
 * Nothing here starts the server or reads its output. Nothing here is a
 * model call either: the server is a plain stdio program.
 */
import type { Disposable } from '../cxp/emitter';
import { locateMcpBinary, type LocateMcpDeps, type McpBinaryResolution } from './locate';
import { mcpProductInfo, type McpProduct, type McpProductInfo } from './products';
import { mcpConfigCopiedMessage, mcpConfigCopiedWithoutProgramMessage } from './strings';

/** One stdio server a provider hands to the editor. */
export interface McpStdioDefinitionData {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Lets the editor re-resolve a cached definition after an update. */
  readonly version: string | undefined;
}

export interface McpSettings {
  readonly enabled: boolean;
  /** Trimmed; empty means unset. */
  readonly executable: string;
}

export interface McpWorkspaceFolder {
  readonly name: string;
  /** The folder's file-system path. */
  readonly path: string;
}

/** What the registration needs from the editor. The VSCode adapter is `vscode-host.ts`. */
export interface McpHost {
  /**
   * Registers a definition provider under [id]. Absent when the running
   * editor has no such API (older VSCode, a fork).
   */
  readonly registerDefinitionProvider:
    | ((
        id: string,
        provider: {
          readonly provide: () => readonly McpStdioDefinitionData[];
          readonly onDidChange: (listener: () => void) => Disposable;
        },
      ) => Disposable)
    | undefined;
  readonly registerCommand: (id: string, run: () => Promise<void>) => Disposable;
  readonly readSettings: (product: McpProductInfo) => McpSettings;
  readonly isWorkspaceTrusted: () => boolean;
  readonly workspaceFolders: () => readonly McpWorkspaceFolder[];
  /** Fires when settings, workspace folders or workspace trust change. */
  readonly onDidChangeInputs: (listener: () => void) => Disposable;
  readonly copyToClipboard: (text: string) => Promise<void>;
  readonly showInformation: (message: string) => void;
  readonly locateDeps: LocateMcpDeps;
}

export interface RegisterProductMcpOptions {
  readonly host: McpHost;
  readonly product: McpProduct;
  /** The extension's version. */
  readonly version: string | undefined;
  readonly log: (line: string) => void;
}

/**
 * The definitions to offer now: none when registration is off, when the
 * workspace is not trusted (the executable setting could then name a program
 * the folder chose), when no folder is open (there is no root to confine the
 * server to), or when the program cannot be found.
 */
export function mcpDefinitionsFor(
  options: RegisterProductMcpOptions,
): readonly McpStdioDefinitionData[] {
  const { host, log } = options;
  const info = mcpProductInfo(options.product);
  const settings = host.readSettings(info);
  if (!settings.enabled) return [];
  if (!host.isWorkspaceTrusted()) return [];
  const folders = host.workspaceFolders();
  if (folders.length === 0) return [];
  const resolution = locateMcpBinary(info, settings.executable, host.locateDeps);
  if (resolution.kind !== 'found') {
    log(
      resolution.kind === 'setting-missing'
        ? `mcp: edacrux.${info.executableKey} names a program that does not exist: ${resolution.path}`
        : `mcp: no ${info.label} command-line program found; the MCP server is not registered`,
    );
    return [];
  }
  return folders.map((folder) => ({
    label: folders.length === 1 ? info.label : `${info.label} (${folder.name})`,
    command: resolution.path,
    args: ['mcp', '--root', folder.path],
    version: options.version,
  }));
}

/**
 * The configuration snippet for hosts whose MCP settings are edited by hand.
 *
 * `mcpServers` is the shape forks of VSCode read; VSCode's own `mcp.json`
 * uses `servers`, but VSCode does not need the snippet. A folder is named
 * by its path; with none open the host's own `${workspaceFolder}` stands in.
 */
export function mcpConfigSnippet(
  info: McpProductInfo,
  resolution: McpBinaryResolution,
  folders: readonly McpWorkspaceFolder[],
): string {
  const command = resolution.kind === 'found' ? resolution.path : info.product;
  const root = folders[0]?.path ?? '${workspaceFolder}';
  return `${JSON.stringify(
    { mcpServers: { [info.product]: { command, args: ['mcp', '--root', root] } } },
    null,
    2,
  )}\n`;
}

/** Registers the provider (where the API exists) and the copy command. */
export function registerProductMcpServer(options: RegisterProductMcpOptions): Disposable {
  const { host, log } = options;
  const info = mcpProductInfo(options.product);
  const disposables: Disposable[] = [];

  if (host.registerDefinitionProvider === undefined) {
    log('mcp: this editor has no MCP server definition provider API; use the copy command');
  } else {
    const listeners = new Set<() => void>();
    disposables.push(
      host.onDidChangeInputs(() => {
        for (const listener of [...listeners]) listener();
      }),
    );
    try {
      disposables.push(
        host.registerDefinitionProvider(info.providerId, {
          provide: () => mcpDefinitionsFor(options),
          onDidChange: (listener) => {
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        }),
      );
    } catch (error) {
      // A fork that exposes the namespace but not the registration must not
      // cost the extension its activation.
      log(`mcp: registration failed (${String(error)}); use the copy command`);
    }
  }

  disposables.push(
    host.registerCommand(info.copyCommandId, async () => {
      const settings = host.readSettings(info);
      const resolution = locateMcpBinary(info, settings.executable, host.locateDeps);
      await host.copyToClipboard(
        mcpConfigSnippet(info, resolution, host.workspaceFolders()),
      );
      host.showInformation(
        resolution.kind === 'found'
          ? mcpConfigCopiedMessage(info.label)
          : mcpConfigCopiedWithoutProgramMessage(info.label, `edacrux.${info.executableKey}`),
      );
    }),
  );

  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
