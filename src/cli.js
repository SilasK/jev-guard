#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);

const USAGE = `jev-guard — prompt-injection and dangerous-action guard for coding agents, powered by Jev

  jev-guard hook [--agent claude|codex]   Claude Code / Codex command hook (JSON on stdin → JSON on stdout)
  jev-guard acp -- <agent command...>     ACP proxy: jev-guard acp -- claude-agent-acp
  jev-guard check <tool> '<json input>'   Assess one tool call, e.g. check Bash '{"command":"rm -rf /"}'
  jev-guard scan [file]                   Scan a file (or stdin) for AI-directed instructions
  jev-guard install claude|codex|pi       Register the hook/extension in that agent's user config

Credentials: JEV_API_KEY (console.typesafe.ai) or AI_GATEWAY_API_KEY (Vercel AI Gateway).`;

switch (cmd) {
  case "hook": {
    const { main } = await import("./hook.js");
    await main(rest);
    break;
  }
  case "acp": {
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    if (!args.length) die("acp needs an agent command after --");
    const { runProxy } = await import("./acp.js");
    runProxy(args[0], args.slice(1));
    break;
  }
  case "check": {
    const { assessAction } = await import("./guard.js");
    const r = await assessAction({ tool: rest[0], input: rest[1] ? JSON.parse(rest[1]) : {}, cwd: process.cwd() });
    console.log(r ? `${r.level.toUpperCase()}  ${r.message}` : "SKIPPED  read-only tool");
    process.exitCode = r?.level === "deny" ? 2 : r?.level === "ask" ? 1 : 0;
    break;
  }
  case "scan": {
    const { scanContent } = await import("./guard.js");
    const text = rest[0] ? readFileSync(rest[0], "utf8") : readFileSync(0, "utf8");
    const r = await scanContent({ text, tool: "scan", source: rest[0] });
    console.log(r ? `${r.flagged ? "FLAGGED" : "CLEAN"}  ${r.message}` : "SKIPPED  too short to scan");
    process.exitCode = r?.flagged ? 2 : 0;
    break;
  }
  case "install":
    install(rest[0]);
    break;
  default:
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
}

function install(target) {
  const cli = join(ROOT, "src", "cli.js");
  const entry = (extra) => ({ matcher: ".*", hooks: [{ type: "command", command: `node "${cli}" hook${extra}`, timeout: 30 }] });
  const notOurs = (list) => (list ?? []).filter((g) => !JSON.stringify(g).includes("jev-guard"));
  if (target === "claude" || target === "codex") {
    const file = target === "claude" ? join(homedir(), ".claude", "settings.json") : join(homedir(), ".codex", "hooks.json");
    const cfg = readJson(file);
    cfg.hooks ??= {};
    const extra = target === "codex" ? " --agent codex" : "";
    for (const ev of ["PreToolUse", "PostToolUse"]) cfg.hooks[ev] = [...notOurs(cfg.hooks[ev]), entry(extra)];
    writeJson(file, cfg);
    console.log(`jev-guard: hooks written to ${file}${target === "codex" ? "\nRun /hooks inside Codex to trust them." : ""}`);
  } else if (target === "pi") {
    const file = join(homedir(), ".pi", "agent", "settings.json");
    const cfg = readJson(file);
    const ext = join(ROOT, "extensions", "jev-guard.ts");
    cfg.extensions = [...(cfg.extensions ?? []).filter((p) => !p.includes("jev-guard")), ext];
    writeJson(file, cfg);
    console.log(`jev-guard: extension registered in ${file}`);
  } else die("install target must be claude, codex or pi (ACP is configured in the editor: see README)");
}

function readJson(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; }
function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2) + "\n"); }
function die(msg) { console.error(`jev-guard: ${msg}\n\n${USAGE}`); process.exit(1); }
