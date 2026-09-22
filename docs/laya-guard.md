# Laya Guard — fallback permission mode for OpenCode

A fork of jev-guard's OpenCode adapter that consults a **local Laya** classifier *only when OpenCode's
native permission policy resolves to `ask`*. Hosted Jev is not used. Native `allow` and `deny` are
authoritative and never reach the classifier.

```
OpenCode native permission decision
        |
        +-- allow  -> execute immediately; classifier NOT called
        +-- deny   -> deny immediately;    classifier NOT called
        +-- ask    -> permission.ask hook -> Laya
                         +-- deny  -> block
                         +-- allow -> execute without a prompt (allowlist only)
                         +-- ask / uncertain / error / timeout -> normal human prompt
```

The seam is OpenCode's `permission.ask` hook, which fires **only** for native `ask` and exposes a
mutable `output.status`. The plugin verifies `output.status === "ask"` on entry and returns immediately
otherwise, so a native `allow`/`deny` can never be influenced even if the hook were called.

## Components

| Piece | Path | Role |
| --- | --- | --- |
| Laya server | `laya-server/server.mjs` | Loads the ONNX model once, serves `POST /decide {state, questions}` |
| Classifier client | `src/laya.js` | One fetch to `127.0.0.1`; normalizes Laya answers to Jev's shape |
| State builder | `src/laya-state.js` | Action sentence + last user request, secrets redacted |
| Policy | `src/classifier.js` | `LayaClassifier`, validation, `classifyAction`, `resolveDecision`, hard safety |
| OpenCode plugin | `src/opencode-fallback.js` | `permission.ask` hook, audit log, config |

## Setup

1. **Run the Laya server** (loads ~1.7 GB of ONNX weights on first start, cached in
   `~/.cache/receptron-laya`):

   ```sh
   cd laya-server && npm install
   npm start          # or install the bundled unit:
   cp laya-guard-server.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now laya-guard-server
   curl -s localhost:8790/health
   ```

2. **Load the plugin.** Drop a shim in OpenCode's plugin dir (upstream's `install opencode` pattern):

   ```js
   // ~/.config/opencode/plugins/laya-guard.js
   export { JevGuardFallback } from "/absolute/path/to/jev-guard/src/opencode-fallback.js";
   ```

3. **Configure.** `~/.config/opencode/laya-guard.json` (see `resolveConfig` in `src/opencode-fallback.js`).
   Options passed as plugin-tuple options override the file; environment variables sit between.

4. **Make OpenCode ask.** The plugin only runs where native policy already says `ask`, so opt the tools
   you want guarded in `opencode.json`:

   ```json
   { "permission": { "bash": "ask" } }
   ```

   Tools left as native `allow` (e.g. `edit`) bypass the guard entirely — by design. Do not set `edit`/
   `write` to `ask` unless you accept that edits are never allowlisted and will always prompt.

5. **Restart OpenCode** (`systemctl --user restart opencode`) so the plugin is loaded.

## Configuration

```json
{
  "mode": "fallback",
  "backend": "laya",
  "endpoint": "http://127.0.0.1:8790/decide",
  "model": "local-laya",
  "token": "shared bearer token when the server is not loopback-only",
  "timeoutMs": 2500,
  "minConfidence": 0.6,
  "onError": "ask",
  "readOnly": "classify",
  "include": ["lastUser"],
  "denyAt": 0.5,
  "autoAllow": { "enabled": true, "patterns": ["bash:git status*"], "maxHarm": 0.2, "minUserAsked": 0, "readOnlyCommands": true },
  "contextAllow": { "enabled": true, "maxHarm": 0.2, "minTaskFit": 0.6 },
  "hardSafety": { "enabled": false, "allowOnly": [] },
  "auditLog": "/home/silask/.local/state/laya-guard/audit.jsonl",
  "debug": false
}
```

| Key | Meaning |
| --- | --- |
| `mode` | `fallback` (default) or `off` (loaded but inert) |
| `backend` | `laya` (local ONNX server) or `openai` (any OpenAI-compatible endpoint) |
| `include` | context slices: `lastUser` (default), `plan`, `opening`, `toolCalls` — see `docs/laya-context.md` |
| `token` | bearer token sent to the server (also `LAYAGUARD_TOKEN`) |
| `denyAt` | harm probability at/above which the call is blocked |
| `autoAllow` | allowlist approval; `enabled: false` disables all auto-approval; `readOnlyCommands` approves any un-chained read-only command that is not a sensitive path |
| `contextAllow` | read-only actions approved by `task_fit` (`minTaskFit`), even off the allowlist |
| `hardSafety` | optional model-independent layer: force a prompt for anything outside `allowOnly` |
| `readOnly` | `classify` (default — Laya decides read/glob/grep/ls too) or `allow` (skip them) |
| `auditLog` | JSONL path or `false` |

## Safety posture and known limits

Measured against the base checkpoint (`docs/laya-context.md`):

- **Deny works, allow is fragile.** Catastrophic commands (`rm -rf /`, `sudo rm -rf /etc`, exfiltration)
  score high and are blocked; subtler ones (`curl … | bash`) score low and are **not** denied. That is
  acceptable because a false negative only means the human prompt stays.
- **Reads are model-decided.** An external read (`read` tool or `cat ../file`) is approved when Laya
  says the user asked for it (`user_asked ≥ 0.5`) or it fits the task (`task_fit ≥ 0.6`); unrelated
  reads prompt. Measured: explicit "check the config in ../" → 0.74–0.80; unrelated → 0.04–0.12.
  Sensitive paths (`~/.ssh`, `~/.aws`, `.env`, `*.pem`, `/etc/shadow`, …) always prompt.
- **Mutations are never model-approved.** They need a code allowlist match, low harm, and no shell
  chaining (`&&`, `;`, `|`, `>`, `$(`).
- **Fail-safe by default.** Timeout, HTTP error, malformed JSON, missing fields, or out-of-range values
  all leave `output.status` as `ask`, i.e. OpenCode's normal prompt is shown.
- **Base checkpoint, not fine-tuned.** The 0.766-accuracy `laya-typed-decisions` checkpoint is not
  published as ONNX; switching to it (after exporting) is the main accuracy upgrade.

## Tests

```sh
npm test    # 40 tests: upstream suite + classifier policy + state builder + plugin integration
```

Plugin integration tests run against an in-process mock Laya server and assert: native `allow`/`deny`
are not classified; `ask` is classified exactly once; `allow`/`deny`/`ask` map to the right
`output.status`; chained commands are not allowlisted; server errors keep the prompt.
