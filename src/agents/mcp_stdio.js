import { spawn } from 'child_process';

/** MCP protocol revision announced in `initialize`; servers may negotiate down. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const INIT_ID = 0;
const CALL_ID = 1;

/**
 * Spawns an MCP server that speaks JSON-RPC over stdio (newline-delimited),
 * performs the MCP lifecycle handshake (`initialize` → response →
 * `notifications/initialized`), calls one tool, and returns the text of the
 * first `text` content block in the tool result.
 *
 * Never throws or rejects. Spawn failures, early exits, JSON-RPC errors,
 * tool errors (`isError`), missing text content and timeouts all resolve to
 * `null`, so callers can degrade gracefully. The server process is stopped as
 * soon as the call settles.
 *
 * @param {object} options
 * @param {string} options.command - Executable to spawn
 * @param {string[]} [options.args] - Arguments for the executable
 * @param {string} options.toolName - MCP tool name to call
 * @param {object} options.toolArgs - Arguments for the tool
 * @param {number} options.timeoutMs - Overall deadline for the whole exchange
 * @returns {Promise<string|null>}
 */
export function callMcpTool({ command, args = [], toolName, toolArgs, timeoutMs }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let exited = false;
    let initialized = false;
    let buffer = '';
    let timer = null;

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        try { proc.stdin.end(); } catch { /* already closed */ }
        try { proc.kill(); } catch { /* already gone */ }
      }
      resolve(value);
    }

    function send(message) {
      try {
        proc.stdin.write(JSON.stringify(message) + '\n');
      } catch {
        finish(null);
      }
    }

    function handleMessage(msg) {
      // Server-initiated request or notification.
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined && msg.id !== null) {
          send(msg.method === 'ping'
            ? { jsonrpc: '2.0', id: msg.id, result: {} }
            : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
        return;
      }

      if (msg.id === INIT_ID && !initialized) {
        if (msg.error) {
          finish(null);
          return;
        }
        initialized = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({
          jsonrpc: '2.0',
          id: CALL_ID,
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        });
        return;
      }

      if (msg.id === CALL_ID) {
        if (msg.error || msg.result?.isError) {
          finish(null);
          return;
        }
        const content = Array.isArray(msg.result?.content) ? msg.result.content : [];
        const textContent = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
        finish(textContent ? textContent.text : null);
      }
    }

    function handleLine(line) {
      if (settled || !line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // Not JSON-RPC (stray output) — ignore.
      }
      if (msg && typeof msg === 'object') handleMessage(msg);
    }

    timer = setTimeout(() => finish(null), timeoutMs);

    proc.on('error', () => {
      // Spawn failure (e.g. ENOENT) or kill failure.
      finish(null);
    });

    proc.on('close', () => {
      exited = true;
      handleLine(buffer);
      buffer = '';
      finish(null); // No-op if an answer already arrived.
    });

    proc.stdin.on('error', () => {
      // EPIPE when the server exits before reading; 'close' follows.
    });

    proc.stderr.on('data', () => {
      // Drain stderr (MCP servers log there) so the pipe never fills up.
    });

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });

    send({
      jsonrpc: '2.0',
      id: INIT_ID,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pr-maestro', version: '0.1.0' },
      },
    });
  });
}
