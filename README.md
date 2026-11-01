# pr-maestro

> Project-R AI bridge — Maestro MCP + REA + OpenCode orchestration for build diagnosis and platform identification.

**Language:** Node.js 20+ (ESM) · **Status:** Pre-alpha · [Implementation Plan](https://github.com/willzmkv/project-r-os/blob/main/ROADMAP.md#pr-maestro--ai-bridge)

## What it does

Provides AI-assisted build diagnosis and platform identification to pr-builder and pr-mediad. Orchestrates three AI backends with graceful degradation:

```
Request → Maestro MCP (Claude+Codex+Gemini) → OpenCode (Groq/Ollama) → null
        → REA (Ghidra binary analysis) for platform identification
```

## Architecture

- `prompts.js` — buildDiagnosisPrompt, platformIdentifyPrompt templates
- `maestro.js` — Maestro MCP client (spawns server.py via stdio MCP)
- `opencode.js` — OpenCode CLI wrapper (Groq/Ollama fallback)
- `rea.js` — REA MCP client (Ghidra binary analysis via stdio MCP)
- `orchestrator.js` — degradation chain factory
- `server.js` — Unix socket server at `/run/project-r/maestro.sock`

## IPC Protocol

Newline-delimited JSON on `/run/project-r/maestro.sock`.

**Build diagnosis:**
```json
{"type": "build_diagnosis", "project_id": "sm64-us", "stderr": "..."}
```

**Response:**
```json
{"patch": "...", "explanation": "...", "confidence": 0.85}
```

## License

GPL-3.0
