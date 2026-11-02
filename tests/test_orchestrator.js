import { jest } from '@jest/globals';
import { createOrchestrator } from '../src/orchestrator.js';

describe('orchestrator - build_diagnosis routing', () => {
  const buildRequest = {
    type: 'build_diagnosis',
    game_id: 'sm64-us',
    stderr: 'gcc: error: missing audiofile',
    build_log_path: '/tmp/build.log',
  };

  test('uses maestro result when maestro succeeds', async () => {
    const maestroResult = { diagnosis: 'Missing lib', patch: null, confidence: 0.8 };
    const agents = {
      maestro: { diagnoseBuild: jest.fn().mockResolvedValue(maestroResult) },
      opencode: { diagnoseBuildFallback: jest.fn() },
      rea: { analyzeBinary: jest.fn() },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(buildRequest);

    expect(response.type).toBe('diagnosis_result');
    expect(response.game_id).toBe('sm64-us');
    expect(response.diagnosis).toBe('Missing lib');
    expect(agents.opencode.diagnoseBuildFallback).not.toHaveBeenCalled();
  });

  test('falls back to opencode when maestro returns null', async () => {
    const opencodeResult = { diagnosis: 'Fallback diagnosis', patch: null, confidence: 0.5 };
    const agents = {
      maestro: { diagnoseBuild: jest.fn().mockResolvedValue(null) },
      opencode: { diagnoseBuildFallback: jest.fn().mockResolvedValue(opencodeResult) },
      rea: { analyzeBinary: jest.fn() },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(buildRequest);

    expect(response.type).toBe('diagnosis_result');
    expect(response.diagnosis).toBe('Fallback diagnosis');
    expect(agents.opencode.diagnoseBuildFallback).toHaveBeenCalledTimes(1);
  });

  test('returns null diagnosis when both maestro and opencode fail', async () => {
    const agents = {
      maestro: { diagnoseBuild: jest.fn().mockResolvedValue(null) },
      opencode: { diagnoseBuildFallback: jest.fn().mockResolvedValue(null) },
      rea: { analyzeBinary: jest.fn() },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(buildRequest);

    expect(response.type).toBe('diagnosis_result');
    expect(response.game_id).toBe('sm64-us');
    expect(response.diagnosis).toBeNull();
  });
});

describe('orchestrator - identify_platform routing', () => {
  const identifyRequest = {
    type: 'identify_platform',
    device: '/dev/sr0',
    binary_sample_path: '/tmp/disc-sample.bin',
  };

  test('calls rea then maestro and returns platform result', async () => {
    const reaAnalysis = 'Architecture: MIPS R4300i. Strings: NINTENDO 64';
    const maestroResult = { platform: 'n64', confidence: 0.93, reasoning: 'N64 signature found' };
    const agents = {
      maestro: { identifyPlatform: jest.fn().mockResolvedValue(maestroResult) },
      opencode: { diagnoseBuildFallback: jest.fn() },
      rea: { analyzeBinary: jest.fn().mockResolvedValue(reaAnalysis) },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(identifyRequest);

    expect(response.type).toBe('platform_result');
    expect(response.platform).toBe('n64');
    expect(response.confidence).toBe(0.93);
    expect(response.method).toBe('rea_analysis');
    expect(agents.rea.analyzeBinary).toHaveBeenCalledWith('/tmp/disc-sample.bin');
    // Maestro should receive rea_analysis in context
    expect(agents.maestro.identifyPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ rea_analysis: reaAnalysis })
    );
  });

  test('still calls maestro even when rea returns null (no Ghidra)', async () => {
    const maestroResult = { platform: 'ps1', confidence: 0.7, reasoning: 'SYSTEM.CNF detected' };
    const agents = {
      maestro: { identifyPlatform: jest.fn().mockResolvedValue(maestroResult) },
      opencode: { diagnoseBuildFallback: jest.fn() },
      rea: { analyzeBinary: jest.fn().mockResolvedValue(null) },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(identifyRequest);

    expect(response.platform).toBe('ps1');
    expect(agents.maestro.identifyPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ rea_analysis: undefined })
    );
  });

  test('returns null platform when maestro also fails', async () => {
    const agents = {
      maestro: { identifyPlatform: jest.fn().mockResolvedValue(null) },
      opencode: { diagnoseBuildFallback: jest.fn() },
      rea: { analyzeBinary: jest.fn().mockResolvedValue(null) },
    };

    const orchestrator = createOrchestrator(agents);
    const response = await orchestrator.handle(identifyRequest);

    expect(response.type).toBe('platform_result');
    expect(response.platform).toBeNull();
    expect(response.confidence).toBe(0);
  });

  test('throws for unknown request type', async () => {
    const agents = {
      maestro: { diagnoseBuild: jest.fn(), identifyPlatform: jest.fn() },
      opencode: { diagnoseBuildFallback: jest.fn() },
      rea: { analyzeBinary: jest.fn() },
    };

    const orchestrator = createOrchestrator(agents);
    await expect(
      orchestrator.handle({ type: 'unknown_type', game_id: 'x' })
    ).rejects.toThrow('Unknown request type: unknown_type');
  });
});
