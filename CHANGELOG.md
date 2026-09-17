# Changelog

## 0.3.0 — 2026-09-18
- Context: every decision now sees the user's recent prompts, the agent's stated intent, recent decisions and flagged content (`src/context.js`, `src/session.js`). Two new questions: `user_requested` (turns ask into allow when the user asked for exactly that) and `from_untrusted` (denies a call that carries out an instruction planted in something the agent read). Prompt hooks on every host feed the memory; pi, OpenCode and ACP read the session directly.
- Instruction files: skills, plugins, rules and `CLAUDE.md`/`AGENTS.md` are checked with their own questions (`INSTRUCTION_QUESTIONS`) at session start, on `InstructionsLoaded`, when a `Skill` runs, when the agent reads one, and via `jev-guard scan-skills`; results cached by content hash.
- Third-party skill/plugin/MCP installs count as level-2 (ask) actions.
- OpenCode: expose `main` and `exports["./server"]`, which is what OpenCode's npm plugin loader resolves; `"plugin": ["jev-guard"]` now works from the registry.
- `check` / `scan` exit 3 with a one-line error instead of a stack trace when Jev is unreachable.

## 0.2.0 — 2026-09-17
- Adapters for Copilot CLI, Gemini CLI, Cursor and OpenCode; the hook script recognises each host's payload.
- Marketplace manifests: Claude Code (`.claude-plugin`), Codex (`.agents/plugins`), Copilot (Claude layout), Gemini (`gemini-extension.json`, asks for the key on install), Cursor (`.cursor-plugin`).
- `jev-guard key` stores the API key in `~/.jev-guard/config.json` for hosts that don't inherit a shell.
- `install` writes the absolute `node` path and refuses to run from the npx cache.
- Icon, works-with strip and launch video.

## 0.1.0 — 2026-09-17
- First release: PreToolUse risk Score + approval Noul (deny / ask / allow), PostToolUse injection / canary scan; Claude Code and Codex hooks, pi extension, ACP proxy; TypeSafe API or Vercel AI Gateway backend.
