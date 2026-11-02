/**
 * Creates an orchestrator that routes requests to AI agent chains.
 * @param {{ maestro: object, opencode: object, rea: object }} agents
 * @returns {{ handle: (request: object) => Promise<object> }}
 */
export function createOrchestrator(agents) {
  async function handleBuildDiagnosis(request) {
    const context = {
      game_id: request.game_id,
      stderr: request.stderr,
      build_log_path: request.build_log_path,
    };

    // Try Maestro first
    let result = await agents.maestro.diagnoseBuild(context);

    // Fall back to OpenCode
    if (result === null) {
      result = await agents.opencode.diagnoseBuildFallback(context);
    }

    return {
      type: 'diagnosis_result',
      game_id: request.game_id,
      diagnosis: result?.diagnosis ?? null,
      patch: result?.patch ?? null,
      confidence: result?.confidence ?? 0,
    };
  }

  async function handleIdentifyPlatform(request) {
    const reaAnalysis = await agents.rea.analyzeBinary(request.binary_sample_path);

    // rea_analysis is always present; undefined when REA was unavailable.
    const context = {
      device: request.device,
      binary_sample_path: request.binary_sample_path,
      rea_analysis: reaAnalysis ?? undefined,
    };

    const result = await agents.maestro.identifyPlatform(context);

    return {
      type: 'platform_result',
      platform: result?.platform ?? null,
      confidence: result?.confidence ?? 0,
      method: 'rea_analysis',
    };
  }

  return {
    async handle(request) {
      switch (request.type) {
        case 'build_diagnosis':
          return handleBuildDiagnosis(request);
        case 'identify_platform':
          return handleIdentifyPlatform(request);
        default:
          throw new Error(`Unknown request type: ${request.type}`);
      }
    },
  };
}
