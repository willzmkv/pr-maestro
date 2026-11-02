import { buildDiagnosisPrompt, MAX_STDERR_CHARS } from '../src/prompts/build_diagnosis.js';
import { platformIdentifyPrompt } from '../src/prompts/platform_identify.js';

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
