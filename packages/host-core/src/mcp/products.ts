/**
 * The four products' MCP servers, as far as a VSCode window needs to know
 * them: the headless binaries that serve `<product> mcp`, and the setting
 * keys that govern the registration.
 */

/** The products that ship an `mcp` command. */
export const MCP_PRODUCTS = ['wavecrux', 'netcrux', 'lintcrux', 'simcrux'] as const;
export type McpProduct = (typeof MCP_PRODUCTS)[number];

/** Static facts about one product's server. */
export interface McpProductInfo {
  readonly product: McpProduct;
  /** Display name, also the server's label in VSCode's MCP list. */
  readonly label: string;
  /** The short settings namespace: `edacrux.<short>.mcp.enabled`. */
  readonly short: 'wave' | 'net' | 'lint' | 'sim';
  /**
   * Executable base names, Pro first. The Pro CLI ships under the
   * `dart build cli` target name (`<product>_pro`); contracts section 2.1
   * also writes the hyphenated spelling, so both are accepted. The open
   * core's headless binary is the plain product name.
   */
  readonly executableNames: readonly string[];
  /** The `contributes.mcpServerDefinitionProviders` id. */
  readonly providerId: string;
  /** The command that copies the configuration snippet. */
  readonly copyCommandId: string;
  /** Setting key, relative to the `edacrux` section, that turns registration off. */
  readonly enabledKey: string;
  /** Setting key, relative to the `edacrux` section, that names the binary. */
  readonly executableKey: string;
}

function info(
  product: McpProduct,
  label: string,
  short: McpProductInfo['short'],
  executableKey: string,
): McpProductInfo {
  return {
    product,
    label,
    short,
    executableNames: [`${product}_pro`, `${product}-pro`, product],
    providerId: `${product}.mcp`,
    copyCommandId: `${product}.copyMcpConfig`,
    enabledKey: `${short}.mcp.enabled`,
    executableKey,
  };
}

const TABLE: Readonly<Record<McpProduct, McpProductInfo>> = {
  wavecrux: info('wavecrux', 'WaveCrux', 'wave', 'wave.executable'),
  netcrux: info('netcrux', 'NetCrux', 'net', 'net.executable'),
  lintcrux: info('lintcrux', 'LintCrux', 'lint', 'lint.executable'),
  // SimCrux already has this setting for its tasks; one binary, one setting.
  simcrux: info('simcrux', 'SimCrux', 'sim', 'sim.executable'),
};

export function mcpProductInfo(product: McpProduct): McpProductInfo {
  return TABLE[product];
}
