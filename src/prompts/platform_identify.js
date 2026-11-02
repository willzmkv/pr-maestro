/**
 * Formats platform identification context into a prompt for AI agents.
 * @param {{ device: string, binary_sample_path: string, rea_analysis?: string }} context
 * @returns {string}
 */
export function platformIdentifyPrompt({ device, binary_sample_path, rea_analysis }) {
  const reaSection = rea_analysis
    ? `\nREA (Ghidra) static analysis output:\n\`\`\`\n${rea_analysis}\n\`\`\``
    : '';

  return `You are a video game platform identification expert. An unrecognized disc or ROM has been inserted into an arcade system.

Device: ${device}
Binary sample path: ${binary_sample_path}${reaSection}

Based on the binary structure, magic bytes, and any REA analysis provided, identify the gaming platform.

Known platforms: ps1, ps2, ps3, ps4, ps5, n64, snes, nes, gba, gb, gbc, gamecube, wii, saturn, dreamcast, xbox, xbox360, switch, megadrive, atari2600

Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "platform": "<platform identifier from the list above, or 'unknown'>",
  "confidence": <float between 0.0 and 1.0>,
  "reasoning": "<one sentence explaining the identification>"
}`;
}
