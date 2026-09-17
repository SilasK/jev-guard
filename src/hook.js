// Command hook for every agent that speaks "JSON on stdin → JSON on stdout": Claude Code, Codex, Copilot CLI
// (Claude-shaped payloads), Gemini CLI (BeforeTool/AfterTool) and Cursor (beforeShellExecution/…/postToolUse).
// The event name on stdin picks the dialect; `--agent codex|copilot` only matters where Claude-shaped agents differ.
import { assessAction, scanContent, collectText, preview } from "./guard.js";

// Which Claude-shaped host sent this? Copilot CLI stamps an ISO `timestamp`, Codex a `turn_id`; Claude Code has neither.
export function detectAgent(input) {
  if (typeof input.timestamp === "string") return "copilot";
  if (typeof input.turn_id === "string" && typeof input.model === "string") return "codex";
  return "claude";
}

export async function handleHook(input, { agent, env = process.env, fetchImpl } = {}) {
  agent ??= detectAgent(input);
  const opts = { env, fetchImpl };
  const event = input.hook_event_name;
  const assess = (tool, toolInput) => assessAction({ tool, input: toolInput, cwd: input.cwd, agent }, opts);
  const scan = (text, tool, toolInput) => scanContent({ text, tool, source: sourceOf(toolInput) }, opts);

  // ── Claude Code / Codex / Copilot CLI ───────────────────────────────────────────────────────────────────
  if (event === "PreToolUse" || event === "PermissionRequest") {
    const r = await assess(input.tool_name, input.tool_input);
    if (!r || r.level === "allow") return null;
    if (event === "PermissionRequest") {
      return r.level === "deny" ? { hookSpecificOutput: { hookEventName: event, decision: { behavior: "deny", message: r.message } } } : null;
    }
    const decision = (d) => ({ hookSpecificOutput: { hookEventName: event, permissionDecision: d, permissionDecisionReason: r.message } });
    if (agent === "copilot") return { permissionDecision: r.level, permissionDecisionReason: r.message, ...decision(r.level) };
    if (r.level === "deny") return decision("deny");
    if (agent === "codex") {  // ask unsupported (Codex 0.154): warn the model and the user, let the call proceed
      return { systemMessage: r.message, hookSpecificOutput: { hookEventName: event, additionalContext: `${r.message}. Confirm with the user before running this or anything similar.` } };
    }
    return decision("ask");
  }
  if (event === "PostToolUse") {
    const r = await scan(collectText(input.tool_response ?? input.tool_result), input.tool_name, input.tool_input);
    if (!r?.flagged) return null;
    if (agent === "copilot") return { additionalContext: r.message, hookSpecificOutput: { hookEventName: event, additionalContext: r.message } };
    return { decision: "block", reason: r.message, systemMessage: r.message };
  }

  // ── Gemini CLI ──────────────────────────────────────────────────────────────────────────────────────────
  if (event === "BeforeTool") {
    const r = await assess(input.tool_name, input.tool_input);
    if (!r || r.level === "allow") return null;
    if (r.level === "deny") return { decision: "deny", reason: r.message };
    return { systemMessage: r.message };  // BeforeTool has no ask and no additionalContext
  }
  if (event === "AfterTool") {
    const r = await scan(collectText(input.tool_response), input.tool_name, input.tool_input);
    if (!r?.flagged) return null;
    return { systemMessage: r.message, hookSpecificOutput: { hookEventName: event, additionalContext: r.message } };
  }

  // ── Cursor ──────────────────────────────────────────────────────────────────────────────────────────────
  // Permission hooks must always answer with valid JSON, or Cursor blocks the action.
  if (event === "beforeShellExecution" || event === "beforeMCPExecution" || event === "preToolUse") {
    const tool = event === "beforeShellExecution" ? "Shell"
      : event === "beforeMCPExecution" ? `mcp__${input.mcp_server_name ?? "mcp"}__${input.tool_name}` : input.tool_name;
    const toolInput = event === "beforeShellExecution" ? { command: input.command, cwd: input.cwd } : parseMaybe(input.tool_input);
    const r = await assess(tool, toolInput);
    if (!r || r.level === "allow") return { permission: "allow" };
    if (r.level === "ask" && event === "preToolUse") return { permission: "allow" };  // ask is accepted but not enforced there
    return { permission: r.level, user_message: r.message, agent_message: r.message };
  }
  if (event === "postToolUse") {
    const r = await scan(collectText(parseMaybe(input.tool_output)), input.tool_name, input.tool_input);
    return r?.flagged ? { additional_context: r.message } : {};
  }
  return null;
}

const CURSOR_PERMISSION_EVENTS = new Set(["beforeShellExecution", "beforeMCPExecution", "preToolUse"]);

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, env = process.env) {
  const input = JSON.parse(await readAll(stdin));
  const agent = argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : detectAgent(input);
  const event = input.hook_event_name;
  let out = null;
  try {
    out = await handleHook(input, { agent, env });
  } catch (err) {
    process.stderr.write(`jev-guard: ${err.message}\n`);
    const closed = !!env.JEV_GUARD_FAIL_CLOSED;  // default is fail-open: a dead API must not freeze the agent
    const reason = `jev-guard unavailable (${err.message}) and JEV_GUARD_FAIL_CLOSED is set`;
    if (CURSOR_PERMISSION_EVENTS.has(event)) out = closed ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" };
    else if (closed && event === "PreToolUse") out = agent === "copilot" ? { permissionDecision: "deny", permissionDecisionReason: reason }
      : { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } };
    else if (closed && event === "BeforeTool") out = { decision: "deny", reason };
  }
  if (out) stdout.write(JSON.stringify(out));
}

function sourceOf(toolInput) {
  const s = toolInput?.url ?? toolInput?.file_path ?? toolInput?.path ?? toolInput?.command;
  return s && preview(s, 120);
}

function parseMaybe(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let s = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (s += c));
    stream.on("end", () => resolve(s));
    stream.on("error", reject);
  });
}
