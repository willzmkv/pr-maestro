import { callMcpTool } from './mcp_stdio.js';

const REA_MCP_CMD = process.env.REA_MCP_CMD || 'rea-mcp';
const REA_TIMEOUT_MS = parseInt(process.env.REA_TIMEOUT_MS || '120000', 10);

/**
 * Calls REA MCP server via stdio MCP protocol.
 * @param {string} toolName
 * @param {object} toolArgs
 * @returns {Promise<string|null>} Raw text content from MCP response, or null
 */
async function callReaMCP(toolName, toolArgs) {
  return callMcpTool({
    command: REA_MCP_CMD,
    args: [],
    toolName,
    toolArgs,
    timeoutMs: REA_TIMEOUT_MS,
  });
}

/**
 * Analyzes a binary file using REA MCP (Ghidra-based static analysis).
 * @param {string} binaryPath - Absolute path to binary sample file
 * @returns {Promise<string|null>} Analysis text or null if REA unavailable
 */
export async function analyzeBinary(binaryPath) {
  return callReaMCP('rea_analyze_binary', { binary_path: binaryPath });
}
