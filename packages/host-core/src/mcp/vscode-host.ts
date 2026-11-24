import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { McpProduct } from './products';
import {
  registerProductMcpServer,
  type McpHost,
  type McpStdioDefinitionData,
} from './register';
import { EDACRUX_CONFIGURATION_SECTION } from '../editor/settings';

/**
 * The MCP server definition API is newer than the `@types/vscode` this repo
 * builds against (1.90), and a fork may lack it, so it is described here and
 * reached through a runtime check rather than the typings.
 */
interface McpApiShape {
  readonly registerMcpServerDefinitionProvider?: (
    id: string,
    provider: {
      onDidChangeMcpServerDefinitions?: vscode.Event<void>;
      provideMcpServerDefinitions: () => unknown[];
    },
  ) => vscode.Disposable;
}

interface StdioDefinitionConstructor {
  new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string | number | null>,
    version?: string,
  ): unknown;
}

function readString(configuration: vscode.WorkspaceConfiguration, key: string): string {
  const value: unknown = configuration.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readEnabled(configuration: vscode.WorkspaceConfiguration, key: string): boolean {
  const value: unknown = configuration.get(key);
  return typeof value === 'boolean' ? value : true;
}

/**
 * What every product extension calls from `activate`: registers the
 * product's MCP server and the copy command, and ties both to the
 * extension's lifetime.
 */
export function registerMcpForExtension(
  context: vscode.ExtensionContext,
  product: McpProduct,
  log: (line: string) => void,
): void {
  const packageJson: unknown = context.extension.packageJSON;
  const version =
    typeof packageJson === 'object' && packageJson !== null
      ? (packageJson as { version?: string }).version
      : undefined;
  context.subscriptions.push(
    registerProductMcpServer({ host: vscodeMcpHost(), product, version, log }),
  );
}

/** The [McpHost] backed by the running editor. */
export function vscodeMcpHost(): McpHost {
  const lm = (vscode as unknown as { lm?: McpApiShape }).lm;
  const stdio = (vscode as unknown as { McpStdioServerDefinition?: StdioDefinitionConstructor })
    .McpStdioServerDefinition;
  const hasApi =
    typeof lm?.registerMcpServerDefinitionProvider === 'function' && typeof stdio === 'function';

  return {
    registerDefinitionProvider: hasApi
      ? (id, provider) => {
          const emitter = new vscode.EventEmitter<void>();
          const change = provider.onDidChange(() => emitter.fire());
          const registration = lm.registerMcpServerDefinitionProvider!(id, {
            onDidChangeMcpServerDefinitions: emitter.event,
            provideMcpServerDefinitions: () =>
              provider.provide().map(
                (definition: McpStdioDefinitionData) =>
                  new stdio(
                    definition.label,
                    definition.command,
                    [...definition.args],
                    undefined,
                    definition.version,
                  ),
              ),
          });
          return {
            dispose: () => {
              registration.dispose();
              change.dispose();
              emitter.dispose();
            },
          };
        }
      : undefined,
    registerCommand: (id, run) => vscode.commands.registerCommand(id, run),
    readSettings: (product) => {
      const configuration = vscode.workspace.getConfiguration(EDACRUX_CONFIGURATION_SECTION);
      return {
        enabled: readEnabled(configuration, product.enabledKey),
        executable: readString(configuration, product.executableKey),
      };
    },
    isWorkspaceTrusted: () => vscode.workspace.isTrusted === true,
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
    onDidChangeInputs: (listener) => {
      const subscriptions = [
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration(EDACRUX_CONFIGURATION_SECTION)) listener();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
        vscode.workspace.onDidGrantWorkspaceTrust(() => listener()),
      ];
      return {
        dispose: () => {
          for (const subscription of subscriptions) subscription.dispose();
        },
      };
    },
    copyToClipboard: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    showInformation: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    locateDeps: {
      platform: process.platform,
      env: process.env,
      home: homedir(),
      exists: existsSync,
      join: (...segments) => path.join(...segments),
      dirname: (file) => path.dirname(file),
      pathDelimiter: path.delimiter,
    },
  };
}
