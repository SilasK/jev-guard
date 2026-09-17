// Claude Code and Codex command hook: one JSON object on stdin, one on stdout. Same wire format for both;
// the only difference is that Codex has no PreToolUse "ask" yet, so ask-tier calls get a warning instead.
import { assessAction, scanContent, collectText, preview } from "./guard.js";

export async function handleHook(input, { agent = "claude", env = process.env, fetchImpl } = {}) {
  const opts = { env, fetchImpl };
  const event = input.hook_event_name;
  const source = input.tool_input?.url ?? input.tool_input?.file_path ?? input.tool_input?.command;

  if (event === "PreToolUse" || event === "PermissionRequest") {
    const r = await assessAction({ tool: input.tool_name, input: input.tool_input, cwd: input.cwd, agent }, opts);
    if (!r || r.level === "allow") return null;
    if (event === "PermissionRequest") {
      return r.level === "deny" ? { hookSpecificOutput: { hookEventName: event, decision: { behavior: "deny", message: r.message } } } : null;
    }
    if (r.level === "deny") return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: r.message } };
    if (agent === "codex") {  // ask unsupported (Codex 0.154): warn the model and the user, let the call proceed
      return { systemMessage: r.message, hookSpecificOutput: { hookEventName: event, additionalContext: `${r.message}. Confirm with the user before running this or anything similar.` } };
    }
    return { hookSpecificOutput: { hookEventName: event, permissionDecision: "ask", permissionDecisionReason: r.message } };
  }

  if (event === "PostToolUse") {
    const r = await scanContent({ text: collectText(input.tool_response), tool: input.tool_name, source: source && preview(source, 120) }, opts);
    if (!r?.flagged) return null;
    return { decision: "block", reason: r.message, systemMessage: r.message };
  }
  return null;
}

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, env = process.env) {
  const agent = argv[argv.indexOf("--agent") + 1] || "claude";
  const input = JSON.parse(await readAll(stdin));
  let out = null;
  try {
    out = await handleHook(input, { agent, env });
  } catch (err) {
    process.stderr.write(`jev-guard: ${err.message}\n`);
    if (env.JEV_GUARD_FAIL_CLOSED && input.hook_event_name === "PreToolUse") {  // default is fail-open: a dead API must not freeze the agent
      out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `jev-guard unavailable (${err.message}) and JEV_GUARD_FAIL_CLOSED is set` } };
    }
  }
  if (out) stdout.write(JSON.stringify(out));
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
