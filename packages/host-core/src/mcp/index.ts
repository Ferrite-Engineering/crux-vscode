/**
 * Registers each product's MCP server (`<product> mcp --root <folder>`) with
 * the editor, or hands the person the configuration snippet where the editor
 * has no registration API.
 */
export { MCP_PRODUCTS, mcpProductInfo, type McpProduct, type McpProductInfo } from './products';
export { locateMcpBinary, type LocateMcpDeps, type McpBinaryResolution } from './locate';
export {
  mcpConfigSnippet,
  mcpDefinitionsFor,
  registerProductMcpServer,
  type McpHost,
  type McpSettings,
  type McpStdioDefinitionData,
  type McpWorkspaceFolder,
  type RegisterProductMcpOptions,
} from './register';
export { registerMcpForExtension, vscodeMcpHost } from './vscode-host';
