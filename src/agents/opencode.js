import { spawn } from 'child_process';
import { buildDiagnosisPrompt } from '../prompts/build_diagnosis.js';

const OPENCODE_CMD = process.env.OPENCODE_CMD || 'opencode';
const OPENCODE_TIMEOUT_MS = parseInt(process.env.OPENCODE_TIMEOUT_MS || '60000', 10);

/**
 * Runs `opencode run <prompt>` (non-interactive mode; the message is a
 * positional argument) and parses JSON from its stdout.
 * @param {string} prompt
 * @returns {Promise<object|null>}
 */
async function runOpencode(prompt) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(OPENCODE_CMD, ['run', prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    let rawOutput = '';
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    const timer = setTimeout(() => {
      if (!settled) {
        try { proc.kill(); } catch { /* already gone */ }
        finish(null);
      }
    }, OPENCODE_TIMEOUT_MS);

    proc.on('error', () => {
      // Spawn failure (e.g. opencode not installed).
      finish(null);
    });

    proc.stdout.on('data', (chunk) => {
      rawOutput += chunk.toString();
    });

    proc.stderr.on('data', () => {
      // Drain stderr so the pipe never fills up.
    });

    proc.on('close', (code) => {
      if (settled) return;

      if (code !== 0) {
        finish(null);
        return;
      }

      // Extract the outermost JSON object found in the output
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        finish(null);
        return;
      }

      try {
        finish(JSON.parse(jsonMatch[0]));
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Diagnoses a build failure using OpenCode (Groq/Ollama free models).
 * Used as fallback when Maestro MCP is unavailable.
 * @param {{ game_id: string, stderr: string, build_log_path: string }} context
 * @returns {Promise<{ diagnosis: string, patch: object|null, confidence: number }|null>}
 */
export async function diagnoseBuildFallback(context) {
  const prompt = buildDiagnosisPrompt(context);
  const result = await runOpencode(prompt);
  return typeof result?.diagnosis === 'string' ? result : null;
}
