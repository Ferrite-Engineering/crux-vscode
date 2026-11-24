import * as vscode from 'vscode';

/**
 * User-facing strings of the MCP registration. The source string is the
 * bundle key, as everywhere in host-core.
 */

/** The configuration snippet is on the clipboard. */
export function mcpConfigCopiedMessage(label: string): string {
  return vscode.l10n.t(
    "The {0} MCP server configuration is on the clipboard. Paste it into this editor's MCP settings.",
    label,
  );
}

/** The snippet is on the clipboard, but it names a program that was not found. */
export function mcpConfigCopiedWithoutProgramMessage(label: string, setting: string): string {
  return vscode.l10n.t(
    'The {0} MCP server configuration is on the clipboard, but no {0} command-line program was found. Set {1} to its path, then copy again.',
    label,
    setting,
  );
}
