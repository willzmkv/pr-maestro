import { jest } from '@jest/globals';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createServer } from '../src/server.js';

const TEST_SOCK = path.join(os.tmpdir(), `pr-maestro-test-${process.pid}.sock`);

describe('Unix socket server', () => {
  let server;
  let mockOrchestrator;

  beforeEach((done) => {
    // Remove stale socket if it exists
    try { fs.unlinkSync(TEST_SOCK); } catch { /* ok */ }

    mockOrchestrator = {
      handle: jest.fn().mockResolvedValue({
        type: 'diagnosis_result',
        game_id: 'sm64-us',
        diagnosis: 'Mock diagnosis',
        patch: null,
        confidence: 0.9,
      }),
    };

    server = createServer(mockOrchestrator, TEST_SOCK);
    server.listen(TEST_SOCK, done);
  });

  afterEach((done) => {
    server.close(() => {
      try { fs.unlinkSync(TEST_SOCK); } catch { /* ok */ }
      done();
    });
  });

  function sendAndReceive(payload, callback) {
    const client = net.createConnection(TEST_SOCK);
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n').filter(Boolean);
      if (lines.length > 0) {
        client.destroy();
        callback(null, lines[0]);
      }
    });
    client.on('error', callback);
    client.on('connect', () => {
      client.write(JSON.stringify(payload) + '\n');
    });
  }

  /** Writes raw chunks, resolves with the first `count` parsed response lines. */
  function collectResponses(chunks, count) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(TEST_SOCK);
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n').filter(Boolean);
        if (lines.length >= count) {
          client.destroy();
          resolve(lines.slice(0, count).map((line) => JSON.parse(line)));
        }
      });
      client.on('error', reject);
      client.on('connect', async () => {
        for (const chunk of chunks) {
          client.write(chunk);
          await new Promise((r) => setTimeout(r, 5));
        }
      });
    });
  }

  test('responds with JSON on valid build_diagnosis request', (done) => {
    const request = {
      type: 'build_diagnosis',
      game_id: 'sm64-us',
      stderr: 'gcc: error',
      build_log_path: '/tmp/build.log',
    };

    sendAndReceive(request, (err, line) => {
      expect(err).toBeNull();
      const response = JSON.parse(line);
      expect(response.type).toBe('diagnosis_result');
      expect(response.game_id).toBe('sm64-us');
      done();
    });
  });

  test('passes parsed request object to orchestrator.handle', (done) => {
    const request = {
      type: 'build_diagnosis',
      game_id: 'sm64-us',
      stderr: 'some error',
      build_log_path: '/tmp/build.log',
    };

    sendAndReceive(request, () => {
      expect(mockOrchestrator.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'build_diagnosis', game_id: 'sm64-us' })
      );
      done();
    });
  });

  test('returns error JSON for malformed (non-JSON) input', (done) => {
    const client = net.createConnection(TEST_SOCK);
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n').filter(Boolean);
      if (lines.length > 0) {
        client.destroy();
        const response = JSON.parse(lines[0]);
        expect(response.type).toBe('error');
        expect(typeof response.message).toBe('string');
        done();
      }
    });

    client.on('connect', () => {
      client.write('this is not json\n');
    });
  });

  test('handles multiple requests on same connection', (done) => {
    const client = net.createConnection(TEST_SOCK);
    let buffer = '';
    const responses = [];

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n').filter(Boolean);
      lines.forEach((line) => {
        responses.push(JSON.parse(line));
      });

      if (responses.length >= 2) {
        client.destroy();
        expect(responses[0].type).toBe('diagnosis_result');
        expect(responses[1].type).toBe('diagnosis_result');
        done();
      }
    });

    const req = { type: 'build_diagnosis', game_id: 'sm64-us', stderr: 'e', build_log_path: '/tmp/b.log' };
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n');
      client.write(JSON.stringify(req) + '\n');
    });
  });

  test('returns error JSON when the orchestrator rejects (e.g. unknown type)', async () => {
    mockOrchestrator.handle.mockRejectedValueOnce(new Error('Unknown request type: bogus'));

    const [response] = await collectResponses([JSON.stringify({ type: 'bogus' }) + '\n'], 1);

    expect(response).toEqual({ type: 'error', message: 'Unknown request type: bogus' });
  });

  test('reassembles a request split across several chunks', async () => {
    const line = JSON.stringify({ type: 'build_diagnosis', game_id: 'sm64-us', stderr: 'e', build_log_path: '/b' }) + '\n';

    const [response] = await collectResponses([line.slice(0, 10), line.slice(10, 30), line.slice(30)], 1);

    expect(response.type).toBe('diagnosis_result');
    expect(mockOrchestrator.handle).toHaveBeenCalledTimes(1);
    expect(mockOrchestrator.handle).toHaveBeenCalledWith(expect.objectContaining({ game_id: 'sm64-us' }));
  });

  test('writes responses in request order even when an earlier request is slower', async () => {
    mockOrchestrator.handle.mockImplementation(async (req) => {
      if (req.game_id === 'slow') await new Promise((r) => setTimeout(r, 50));
      return { type: 'diagnosis_result', game_id: req.game_id, diagnosis: null, patch: null, confidence: 0 };
    });

    const slow = JSON.stringify({ type: 'build_diagnosis', game_id: 'slow', stderr: 'e', build_log_path: '/b' });
    const fast = JSON.stringify({ type: 'build_diagnosis', game_id: 'fast', stderr: 'e', build_log_path: '/b' });

    const responses = await collectResponses([`${slow}\n${fast}\n`], 2);

    expect(responses.map((r) => r.game_id)).toEqual(['slow', 'fast']);
  });
});
