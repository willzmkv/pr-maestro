import net from 'net';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DEFAULT_SOCK_PATH = process.env.MAESTRO_SOCK_PATH || '/run/project-r/maestro.sock';

/**
 * Creates a Unix socket server that routes newline-delimited JSON requests
 * through the provided orchestrator.
 *
 * Each request line gets exactly one response line. Requests on the same
 * connection are handled one at a time, so responses come back in request
 * order.
 *
 * @param {{ handle: (request: object) => Promise<object> }} orchestrator
 * @param {string} [sockPath] - Path for the Unix socket (default: MAESTRO_SOCK_PATH env or /run/project-r/maestro.sock).
 *   Informational: the caller still calls `server.listen(sockPath)`.
 * @returns {net.Server}
 */
export function createServer(orchestrator, sockPath = DEFAULT_SOCK_PATH) {
  const server = net.createServer((socket) => {
    let buffer = '';
    let queue = Promise.resolve();

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) segment in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        queue = queue.then(() => handleLine(line, socket, orchestrator));
      }
    });

    socket.on('error', () => {
      // Client disconnected unexpectedly — nothing to do
    });
  });

  return server;
}

function writeLine(socket, message) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify(message) + '\n');
}

async function handleLine(line, socket, orchestrator) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeLine(socket, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  let response;
  try {
    response = await orchestrator.handle(request);
  } catch (err) {
    response = { type: 'error', message: err?.message ?? String(err) };
  }

  writeLine(socket, response);
}

/**
 * Starts the server with the real agent orchestrator. Called when this file
 * is run directly (not imported by tests).
 */
async function main() {
  // Dynamic import so tests never pull in real agent code
  const [{ createOrchestrator }, maestro, opencode, rea] = await Promise.all([
    import('./orchestrator.js'),
    import('./agents/maestro.js'),
    import('./agents/opencode.js'),
    import('./agents/rea.js'),
  ]);

  const agents = {
    maestro: { diagnoseBuild: maestro.diagnoseBuild, identifyPlatform: maestro.identifyPlatform },
    opencode: { diagnoseBuildFallback: opencode.diagnoseBuildFallback },
    rea: { analyzeBinary: rea.analyzeBinary },
  };

  const orchestrator = createOrchestrator(agents);
  const sockPath = process.env.MAESTRO_SOCK_PATH || '/run/project-r/maestro.sock';

  // Remove stale socket
  try { fs.unlinkSync(sockPath); } catch { /* ok */ }

  const server = createServer(orchestrator, sockPath);
  server.listen(sockPath, () => {
    console.log(`pr-maestro listening on ${sockPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      try { fs.unlinkSync(sockPath); } catch { /* ok */ }
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run main only when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('pr-maestro fatal error:', err);
    process.exit(1);
  });
}
