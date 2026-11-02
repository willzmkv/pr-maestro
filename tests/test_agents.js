import { jest } from '@jest/globals';
import { buildDiagnosisPrompt, MAX_STDERR_CHARS } from '../src/prompts/build_diagnosis.js';
import { platformIdentifyPrompt } from '../src/prompts/platform_identify.js';

// We must mock child_process BEFORE importing any agent module.
// Jest ESM mocking: use jest.unstable_mockModule + dynamic import.
const mockSpawn = jest.fn();
jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
}));

// Import after mock is registered
const { diagnoseBuild, identifyPlatform } = await import('../src/agents/maestro.js');
const { diagnoseBuildFallback } = await import('../src/agents/opencode.js');

/**
 * Fake ChildProcess. Shared by every agent section below, so it lives at
 * module scope.
 */
function makeMockProcess() {
  const stdoutHandlers = {};
  const stderrHandlers = {};
  const processHandlers = {};
  return {
    stdout: {
      on: (event, fn) => { stdoutHandlers[event] = fn; },
    },
    stderr: {
      on: (event, fn) => { stderrHandlers[event] = fn; },
    },
    stdin: {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    },
    kill: jest.fn(),
    on: (event, fn) => { processHandlers[event] = fn; },
    _emit: (target, event, data) => {
      if (target === 'stdout') stdoutHandlers[event]?.(data);
      if (target === 'stderr') stderrHandlers[event]?.(data);
      if (target === 'process') processHandlers[event]?.(data);
    },
  };
}

/** JSON-RPC lines the client wrote to the fake process's stdin. */
function sentMessages(mockProc) {
  return mockProc.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
}

/** Emits one newline-terminated JSON-RPC message on the fake stdout. */
function emitJson(mockProc, message) {
  mockProc._emit('stdout', 'data', Buffer.from(JSON.stringify(message) + '\n'));
}

/** tools/call response whose single text block is `text`. */
function toolResult(text, extra = {}) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...extra } };
}

function spawnError(command) {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
}

describe('buildDiagnosisPrompt', () => {
  const context = {
    game_id: 'sm64-us',
    stderr: 'gcc: error: missing audiofile\nmake: *** Error 1',
    build_log_path: '/tmp/pr-build-sm64.log',
  };

  test('returns a non-empty string', () => {
    const prompt = buildDiagnosisPrompt(context);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('includes game_id in the prompt', () => {
    const prompt = buildDiagnosisPrompt(context);
    expect(prompt).toContain('sm64-us');
  });

  test('includes stderr content in the prompt', () => {
    const prompt = buildDiagnosisPrompt(context);
    expect(prompt).toContain('gcc: error: missing audiofile');
  });

  test('includes build_log_path in the prompt', () => {
    const prompt = buildDiagnosisPrompt(context);
    expect(prompt).toContain('/tmp/pr-build-sm64.log');
  });

  test('requests JSON output with diagnosis and patch fields', () => {
    const prompt = buildDiagnosisPrompt(context);
    expect(prompt).toContain('diagnosis');
    expect(prompt).toContain('patch');
    expect(prompt).toContain('confidence');
  });

  test('keeps only the tail of very long stderr', () => {
    const head = 'EARLY-NOISE-LINE\n';
    const tail = 'gcc: error: the real failure';
    const stderr = head + 'x'.repeat(MAX_STDERR_CHARS * 2) + tail;
    const prompt = buildDiagnosisPrompt({ ...context, stderr });
    expect(prompt).toContain(tail);
    expect(prompt).not.toContain('EARLY-NOISE-LINE');
    expect(prompt).toContain('truncated');
    expect(prompt.length).toBeLessThan(MAX_STDERR_CHARS + 2000);
  });
});

describe('platformIdentifyPrompt', () => {
  const context = {
    device: '/dev/sr0',
    binary_sample_path: '/tmp/disc-sample.bin',
  };

  test('returns a non-empty string', () => {
    const prompt = platformIdentifyPrompt(context);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('includes device path in the prompt', () => {
    const prompt = platformIdentifyPrompt(context);
    expect(prompt).toContain('/dev/sr0');
  });

  test('includes binary_sample_path in the prompt', () => {
    const prompt = platformIdentifyPrompt(context);
    expect(prompt).toContain('/tmp/disc-sample.bin');
  });

  test('requests platform and confidence fields', () => {
    const prompt = platformIdentifyPrompt(context);
    expect(prompt).toContain('platform');
    expect(prompt).toContain('confidence');
  });
});

describe('maestro agent - diagnoseBuild', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const buildContext = {
    game_id: 'sm64-us',
    stderr: 'gcc: error: missing audiofile',
    build_log_path: '/tmp/build.log',
  };

  test('returns diagnosis object on successful MCP response', async () => {
    const mcpResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              diagnosis: 'Missing audiofile library',
              patch: { file: 'Makefile', line: 42, before: '-laudiofile', after: '$(shell pkg-config --libs audiofile)' },
              confidence: 0.87,
            }),
          },
        ],
      },
    };

    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild({
      game_id: 'sm64-us',
      stderr: 'gcc: error: missing audiofile',
      build_log_path: '/tmp/build.log',
    });

    // Simulate async response from MCP server
    setTimeout(() => {
      mockProc._emit('stdout', 'data', Buffer.from(JSON.stringify(mcpResponse) + '\n'));
      mockProc._emit('process', 'close', 0);
    }, 10);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result.diagnosis).toBe('Missing audiofile library');
    expect(result.confidence).toBe(0.87);
    expect(result.patch.file).toBe('Makefile');
  });

  test('returns null when process exits with error', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild({
      game_id: 'sm64-us',
      stderr: 'some error',
      build_log_path: '/tmp/build.log',
    });

    setTimeout(() => {
      mockProc._emit('process', 'close', 1);
    }, 10);

    const result = await promise;
    expect(result).toBeNull();
  });

  test('returns null when MCP response has error field', async () => {
    const mcpError = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'Provider unavailable' },
    };

    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild({
      game_id: 'sm64-us',
      stderr: 'some error',
      build_log_path: '/tmp/build.log',
    });

    setTimeout(() => {
      mockProc._emit('stdout', 'data', Buffer.from(JSON.stringify(mcpError) + '\n'));
      mockProc._emit('process', 'close', 0);
    }, 10);

    const result = await promise;
    expect(result).toBeNull();
  });

  test('spawns the Maestro MCP server.py with python3 over piped stdio', () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    diagnoseBuild(buildContext);
    mockProc._emit('process', 'close', 0);

    expect(mockSpawn).toHaveBeenCalledWith(
      'python3',
      [expect.stringMatching(/server\.py$/)],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  test('performs the MCP initialize handshake before calling maestro_consult', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);

    // Only `initialize` is sent until the server answers it.
    expect(sentMessages(mockProc)).toEqual([
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: expect.objectContaining({
          protocolVersion: expect.any(String),
          capabilities: {},
          clientInfo: expect.objectContaining({ name: 'pr-maestro' }),
        }),
      }),
    ]);

    emitJson(mockProc, {
      jsonrpc: '2.0',
      id: 0,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'maestro', version: '1' } },
    });

    const [, initialized, call] = sentMessages(mockProc);
    expect(initialized).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(call).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'maestro_consult',
        arguments: { prompt: expect.stringContaining('sm64-us'), provider: 'claude' },
      },
    });

    emitJson(mockProc, toolResult(JSON.stringify({ diagnosis: 'Missing lib', patch: null, confidence: 0.6 })));

    const result = await promise;
    expect(result).toEqual({ diagnosis: 'Missing lib', patch: null, confidence: 0.6 });
    // The server is shut down once the answer is in.
    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalled();
  });

  test('answers server ping requests and ignores server notifications', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);
    emitJson(mockProc, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } });
    emitJson(mockProc, { jsonrpc: '2.0', id: 7, method: 'ping' });

    expect(sentMessages(mockProc)).toContainEqual({ jsonrpc: '2.0', id: 7, result: {} });

    emitJson(mockProc, toolResult(JSON.stringify({ diagnosis: 'ok', patch: null, confidence: 0.5 })));
    expect((await promise).diagnosis).toBe('ok');
  });

  test('unwraps the real maestro_consult envelope and parses fenced JSON content', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const llmOutput = 'Here is my analysis:\n```json\n'
      + JSON.stringify({ diagnosis: 'audiofile headers missing', patch: null, confidence: 0.4 })
      + '\n```\n';
    const envelope = { ok: true, content: llmOutput, provider: 'claude', model: 'x', elapsed_ms: 12, stderr: null, truncated: false };

    const promise = diagnoseBuild(buildContext);
    // Split across chunks to exercise line buffering.
    const line = JSON.stringify(toolResult(JSON.stringify(envelope))) + '\n';
    mockProc._emit('stdout', 'data', Buffer.from(line.slice(0, 25)));
    mockProc._emit('stdout', 'data', Buffer.from(line.slice(25)));

    const result = await promise;
    expect(result).toEqual({ diagnosis: 'audiofile headers missing', patch: null, confidence: 0.4 });
  });

  test('returns null when the maestro_consult envelope reports ok=false', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);
    emitJson(mockProc, toolResult(JSON.stringify({ ok: false, content: '', error: "Provider 'claude' is not enabled." })));

    expect(await promise).toBeNull();
  });

  test('returns null when the tool result is flagged isError', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);
    emitJson(mockProc, toolResult('Error executing tool maestro_consult', { isError: true }));

    expect(await promise).toBeNull();
  });

  test('returns null when the answer has no diagnosis string', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);
    emitJson(mockProc, toolResult(JSON.stringify({ platform: 'n64', confidence: 0.9 })));

    expect(await promise).toBeNull();
  });

  test('returns null when python3/server.py cannot be spawned', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuild(buildContext);
    mockProc._emit('process', 'error', spawnError('python3'));
    mockProc._emit('process', 'close', -2);

    expect(await promise).toBeNull();
  });

  test('returns null and kills the server when it does not answer in time', async () => {
    jest.useFakeTimers();
    try {
      const mockProc = makeMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = diagnoseBuild(buildContext);
      jest.advanceTimersByTime(30000);

      expect(await promise).toBeNull();
      expect(mockProc.kill).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('maestro agent - identifyPlatform', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  test('sends the REA analysis to maestro_consult and returns the platform answer', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = identifyPlatform({
      device: '/dev/sr0',
      binary_sample_path: '/tmp/disc-sample.bin',
      rea_analysis: 'Architecture: MIPS R4300i',
    });
    emitJson(mockProc, { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18', capabilities: {} } });

    const call = sentMessages(mockProc).find((m) => m.method === 'tools/call');
    expect(call.params.name).toBe('maestro_consult');
    expect(call.params.arguments.prompt).toContain('MIPS R4300i');
    expect(call.params.arguments.prompt).toContain('/dev/sr0');

    emitJson(mockProc, toolResult(JSON.stringify({ platform: 'n64', confidence: 0.93, reasoning: 'N64 header' })));

    expect(await promise).toEqual({ platform: 'n64', confidence: 0.93, reasoning: 'N64 header' });
  });

  test('returns null when the answer has no platform string', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = identifyPlatform({ device: '/dev/sr0', binary_sample_path: '/tmp/x.bin' });
    emitJson(mockProc, toolResult(JSON.stringify({ diagnosis: 'not a platform answer' })));

    expect(await promise).toBeNull();
  });
});

describe('opencode agent - diagnoseBuildFallback', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const buildContext = {
    game_id: 'sm64-us',
    stderr: 'gcc: error: missing audiofile',
    build_log_path: '/tmp/build.log',
  };

  test('returns diagnosis when opencode outputs valid JSON', async () => {
    const jsonOutput = JSON.stringify({
      diagnosis: 'pkg-config audiofile not found',
      patch: { file: 'Makefile', line: 10, before: '-laudiofile', after: '$(pkg-config --libs audiofile)' },
      confidence: 0.72,
    });

    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback({
      game_id: 'sm64-us',
      stderr: 'gcc: error: missing audiofile',
      build_log_path: '/tmp/build.log',
    });

    setTimeout(() => {
      mockProc._emit('stdout', 'data', Buffer.from(jsonOutput + '\n'));
      mockProc._emit('process', 'close', 0);
    }, 10);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result.diagnosis).toBe('pkg-config audiofile not found');
    expect(result.confidence).toBe(0.72);
  });

  test('returns null when opencode exits non-zero', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback({
      game_id: 'sm64-us',
      stderr: 'error',
      build_log_path: '/tmp/build.log',
    });

    setTimeout(() => {
      mockProc._emit('process', 'close', 1);
    }, 10);

    const result = await promise;
    expect(result).toBeNull();
  });

  test('returns null when opencode outputs non-JSON text', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback({
      game_id: 'sm64-us',
      stderr: 'error',
      build_log_path: '/tmp/build.log',
    });

    setTimeout(() => {
      mockProc._emit('stdout', 'data', Buffer.from('I cannot determine the cause.\n'));
      mockProc._emit('process', 'close', 0);
    }, 10);

    const result = await promise;
    expect(result).toBeNull();
  });

  test('runs `opencode run <prompt>` with the prompt as a single positional argument', () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    diagnoseBuildFallback(buildContext);
    mockProc._emit('process', 'close', 1);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe('opencode');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('run');
    expect(args[1]).toContain('gcc: error: missing audiofile');
    expect(options).toEqual(expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('extracts JSON surrounded by prose and fences', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback(buildContext);
    mockProc._emit('stdout', 'data', Buffer.from('Sure!\n```json\n{"diagnosis": "x", "patch": null,'));
    mockProc._emit('stdout', 'data', Buffer.from(' "confidence": 0.3}\n```\n'));
    mockProc._emit('process', 'close', 0);

    expect(await promise).toEqual({ diagnosis: 'x', patch: null, confidence: 0.3 });
  });

  test('returns null when the JSON has no diagnosis string', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback(buildContext);
    mockProc._emit('stdout', 'data', Buffer.from('{"error": "rate limited"}\n'));
    mockProc._emit('process', 'close', 0);

    expect(await promise).toBeNull();
  });

  test('returns null when the opencode binary is missing', async () => {
    const mockProc = makeMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const promise = diagnoseBuildFallback(buildContext);
    mockProc._emit('process', 'error', spawnError('opencode'));
    mockProc._emit('process', 'close', -2);

    expect(await promise).toBeNull();
  });

  test('returns null and kills opencode when it does not finish in time', async () => {
    jest.useFakeTimers();
    try {
      const mockProc = makeMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = diagnoseBuildFallback(buildContext);
      jest.advanceTimersByTime(60000);

      expect(await promise).toBeNull();
      expect(mockProc.kill).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
