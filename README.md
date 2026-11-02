# pr-maestro

> Project-R AI bridge — Maestro MCP + REA + OpenCode orchestration for build diagnosis and platform identification.

**Language:** Node.js 22+ (ESM) · **Status:** Pre-alpha · [Implementation Plan](https://github.com/willzmkv/project-r-os/blob/main/ROADMAP.md#pr-maestro--ai-bridge)

## What it does

Provides AI-assisted build diagnosis (for pr-builder) and unknown-platform identification (for pr-mediad) over a local Unix socket. The AI agents are an optional layer: every agent failure degrades gracefully to a `null` answer, so the rest of Project-R keeps working without them.

```
build_diagnosis:   Maestro MCP (maestro_consult) ──null──▶ OpenCode CLI ──null──▶ diagnosis: null
identify_platform: REA MCP (Ghidra, optional) ──▶ Maestro MCP ──null──▶ platform: null
```

## Architecture

| File | Role |
|---|---|
| `src/server.js` | Unix socket server, newline-delimited JSON framing; knows nothing about agents |
| `src/orchestrator.js` | `createOrchestrator(agents)` — routes request types to agent chains, degradation rules |
| `src/agents/mcp_stdio.js` | Minimal stdio MCP client: `initialize` handshake → one `tools/call` → text result |
| `src/agents/maestro.js` | `diagnoseBuild`, `identifyPlatform` — spawns Maestro's `server.py`, calls `maestro_consult` |
| `src/agents/opencode.js` | `diagnoseBuildFallback` — runs `opencode run <prompt>` |
| `src/agents/rea.js` | `analyzeBinary` — spawns the REA MCP server, calls `rea_analyze_binary` |
| `src/prompts/*.js` | Pure prompt builders |
| `pr-maestro.service` | systemd unit |

Agents are spawned per request (no long-lived child processes) and never throw: spawn errors, non-zero exits, JSON-RPC/tool errors, unparseable answers and timeouts all resolve to `null`.

## IPC contract

pr-maestro owns this contract. Clients: pr-builder (`build_diagnosis`), pr-mediad (`identify_platform`).

### Transport

- **Socket:** Unix domain stream socket at `/run/project-r/maestro.sock` (override with `MAESTRO_SOCK_PATH`).
- **Framing:** UTF-8 newline-delimited JSON. Each request is one JSON object on one line terminated by `\n`; each request gets exactly one response line.
- **Connections:** a client may send several requests on one connection; they are processed one at a time and answered **in request order**. The server never closes a connection on its own — the client closes it.
- **Latency:** answers can take a while (LLM calls). Worst case with default timeouts: `build_diagnosis` ≈ 90 s (Maestro 30 s + OpenCode 60 s), `identify_platform` ≈ 150 s (REA 120 s + Maestro 30 s). Client timeouts should be at least that.
- Fields are not validated: a missing field is passed to the agents as `undefined`.

### `build_diagnosis` → `diagnosis_result`

Request:

```json
{"type": "build_diagnosis", "game_id": "sm64-us", "stderr": "gcc: error: missing audiofile\nmake: *** Error 1", "build_log_path": "/tmp/pr-build-sm64.log"}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"build_diagnosis"` | required |
| `game_id` | string | registry id; echoed back in the response |
| `stderr` | string | compiler/build stderr; only the last 16000 characters are sent to the agents |
| `build_log_path` | string | path to the full log, included in the prompt for reference (pr-maestro does not read it) |

Response:

```json
{"type": "diagnosis_result", "game_id": "sm64-us", "diagnosis": "Missing audiofile library", "patch": {"file": "Makefile", "line": 42, "before": "-laudiofile", "after": "$(shell pkg-config --libs audiofile)"}, "confidence": 0.87}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"diagnosis_result"` | |
| `game_id` | string | copied from the request |
| `diagnosis` | string \| null | one-sentence root cause; `null` when no agent produced a diagnosis |
| `patch` | object \| null | `{file, line, before, after}` — `file` relative to the project's source root, `line` a line number, `before`/`after` the text to replace. Proposed by an LLM and **not validated**: verify before applying. `null` when no concrete patch was proposed |
| `confidence` | number | 0.0–1.0; `0` when `diagnosis` is `null` |

### `identify_platform` → `platform_result`

Request:

```json
{"type": "identify_platform", "device": "/dev/sr0", "binary_sample_path": "/tmp/disc-sample.bin"}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"identify_platform"` | required |
| `device` | string | block device the media was read from |
| `binary_sample_path` | string | sample of the disc/ROM; must be readable by the pr-maestro service user (REA opens it) |

Response:

```json
{"type": "platform_result", "platform": "n64", "confidence": 0.93, "method": "rea_analysis"}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"platform_result"` | |
| `platform` | string \| null | one of `ps1 ps2 ps3 ps4 ps5 n64 snes nes gba gb gbc gamecube wii saturn dreamcast xbox xbox360 switch megadrive atari2600`, or `"unknown"`; `null` when no agent answered |
| `confidence` | number | 0.0–1.0; `0` when `platform` is `null` |
| `method` | string | currently always `"rea_analysis"` (the REA → Maestro chain; REA output is optional input to Maestro) |

### Errors

```json
{"type": "error", "message": "Invalid JSON"}
{"type": "error", "message": "Unknown request type: <type>"}
```

Agent unavailability is **not** an error: it yields a normal `diagnosis_result` / `platform_result` with `null` values.

### Example

```bash
echo '{"type":"build_diagnosis","game_id":"sm64-us","stderr":"gcc: error","build_log_path":"/tmp/test.log"}' \
  | nc -U /run/project-r/maestro.sock
```

## Configuration

Environment variables (set in `pr-maestro.service`, override in `/etc/project-r/maestro.env`):

| Variable | Default | Purpose |
|---|---|---|
| `MAESTRO_SOCK_PATH` | `/run/project-r/maestro.sock` | Unix socket path |
| `MAESTRO_MCP_PATH` | `/usr/local/lib/maestro-mcp/server.py` | Path to Maestro MCP `server.py` |
| `MAESTRO_PYTHON` | `python3` | Interpreter for `server.py` (e.g. a venv with `fastmcp`) |
| `MAESTRO_TIMEOUT_MS` | `30000` | Maestro MCP call timeout |
| `REA_MCP_CMD` | `rea-mcp` | Command that starts the REA MCP server on stdio |
| `REA_TIMEOUT_MS` | `120000` | REA analysis timeout (Ghidra is slow) |
| `OPENCODE_CMD` | `opencode` | OpenCode CLI command |
| `OPENCODE_TIMEOUT_MS` | `60000` | OpenCode call timeout |

No API keys are read or stored by pr-maestro; provider credentials belong to the Maestro / OpenCode installs.

## Development

Tests need Linux (Unix sockets). On a non-Linux host run them in a container, e.g.:

```bash
docker run --rm -v "$PWD:/src" -w /src project-r-dev bash -c "npm ci && npm test"
```

Tests mock `child_process`; they never start real Maestro, REA or OpenCode processes or call any LLM API.

## License

GPL-3.0
