import { callMcpTool } from './mcp_stdio.js';
import { buildDiagnosisPrompt } from '../prompts/build_diagnosis.js';
import { platformIdentifyPrompt } from '../prompts/platform_identify.js';

const MAESTRO_MCP_PATH = process.env.MAESTRO_MCP_PATH
  || '/usr/local/lib/maestro-mcp/server.py';

// Interpreter for server.py — point at a venv python if fastmcp lives there.
const MAESTRO_PYTHON = process.env.MAESTRO_PYTHON || 'python3';

const MAESTRO_TIMEOUT_MS = parseInt(process.env.MAESTRO_TIMEOUT_MS || '30000', 10);

/**
 * Parses the first JSON object out of `text`: either the whole string, or the
 * outermost `{...}` span (LLMs often wrap JSON in prose or ``` fences).
 * @param {unknown} text
 * @returns {object|null}
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const candidates = [text.trim()];
  const match = text.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The real `maestro_consult` tool returns an envelope
 * `{ ok, content, provider, model, ... }` where `content` is the consulted
 * LLM's raw stdout. A bare answer object (no envelope) is accepted as-is.
 * @param {string|null} text - Text content of the MCP tool result
 * @returns {object|null}
 */
function unwrapConsultResult(text) {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  if (typeof parsed.ok === 'boolean') {
    return parsed.ok ? extractJsonObject(parsed.content) : null;
  }
  return parsed;
}

/**
 * Calls Maestro MCP server via stdio MCP protocol.
 * @param {string} toolName - MCP tool name to call
 * @param {object} toolArgs - Arguments for the tool
 * @returns {Promise<object|null>} Parsed answer object or null on failure
 */
async function callMaestroMCP(toolName, toolArgs) {
  const text = await callMcpTool({
    command: MAESTRO_PYTHON,
    args: [MAESTRO_MCP_PATH],
    toolName,
    toolArgs,
    timeoutMs: MAESTRO_TIMEOUT_MS,
  });
  return unwrapConsultResult(text);
}

/**
 * Diagnoses a build failure using Maestro MCP (Claude + Codex + Gemini).
 * @param {{ game_id: string, stderr: string, build_log_path: string }} context
 * @returns {Promise<{ diagnosis: string, patch: object|null, confidence: number }|null>}
 */
export async function diagnoseBuild(context) {
  const prompt = buildDiagnosisPrompt(context);
  const result = await callMaestroMCP('maestro_consult', {
    prompt,
    provider: 'claude',
  });
  return typeof result?.diagnosis === 'string' ? result : null;
}

/**
 * Identifies an unknown platform using Maestro MCP.
 * @param {{ device: string, binary_sample_path: string, rea_analysis?: string }} context
 * @returns {Promise<{ platform: string, confidence: number, reasoning: string }|null>}
 */
export async function identifyPlatform(context) {
  const prompt = platformIdentifyPrompt(context);
  const result = await callMaestroMCP('maestro_consult', {
    prompt,
    provider: 'claude',
  });
  return typeof result?.platform === 'string' ? result : null;
}
