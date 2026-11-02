/**
 * Maximum number of stderr characters embedded in the prompt. Compiler
 * errors that matter are almost always at the end of the output, so we keep
 * the tail. This also keeps the prompt well under Linux's 128 KiB
 * single-argument limit (MAX_ARG_STRLEN), since OpenCode receives the prompt
 * as a CLI argument.
 */
export const MAX_STDERR_CHARS = 16000;

/**
 * Returns the tail of `stderr`, prefixed with a marker when it was cut.
 * @param {string} stderr
 * @returns {string}
 */
function tailStderr(stderr) {
  const text = String(stderr ?? '');
  if (text.length <= MAX_STDERR_CHARS) return text;
  const dropped = text.length - MAX_STDERR_CHARS;
  return `[... ${dropped} earlier characters truncated; see the full build log ...]\n`
    + text.slice(-MAX_STDERR_CHARS);
}

/**
 * Formats build error context into a prompt for AI agents.
 * @param {{ game_id: string, stderr: string, build_log_path: string }} context
 * @returns {string}
 */
export function buildDiagnosisPrompt({ game_id, stderr, build_log_path }) {
  return `You are a build system expert helping diagnose a compilation failure for a retro game decompilation project.

Game ID: ${game_id}
Build log: ${build_log_path}

Compiler stderr output:
\`\`\`
${tailStderr(stderr)}
\`\`\`

Analyze this build failure and respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "diagnosis": "<one sentence describing the root cause>",
  "patch": {
    "file": "<relative path to file needing change>",
    "line": <line number>,
    "before": "<current content>",
    "after": "<corrected content>"
  },
  "confidence": <float between 0.0 and 1.0>
}

If you cannot determine a specific patch, set "patch" to null and lower the confidence accordingly.`;
}
