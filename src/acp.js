// `jev-guard acp -- <agent command...>`: a stdio proxy between any ACP client (Zed, JetBrains, ...) and any ACP agent.
// Guards what flows through the client: terminal/create and fs/write_text_file are assessed before they are forwarded
// (ask → session/request_permission to the client), and fs/read_text_file / terminal/output results are scanned on the way
// back. Tools the agent runs on its own (its built-in web fetch, say) never pass through here and are not covered.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assessAction, scanContent, preview, MIN_SCAN_CHARS } from "./guard.js";

export function runProxy(cmd, args, { stdin = process.stdin, stdout = process.stdout, env = process.env, fetchImpl, onExit = (c) => process.exit(c) } = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env });
  const opts = { env, fetchImpl };
  const toClient = (m) => stdout.write(JSON.stringify(m) + "\n");
  const toAgent = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const warn = (err) => process.stderr.write(`jev-guard: ${err.message ?? err}\n`);

  let seq = 0;
  const ours = new Map();      // id of a request we sent to the client → resolve
  const agentReqs = new Map(); // id of an agent→client request we forwarded → method

  function askClient(method, params) {
    const id = `jev-guard:${++seq}`;
    return new Promise((resolve) => { ours.set(id, resolve); toClient({ jsonrpc: "2.0", id, method, params }); });
  }

  async function fromAgent(msg) {
    if (msg.method && msg.id !== undefined) {   // request agent → client
      const rejection = await guardRequest(msg);
      if (rejection) return toAgent(rejection);
      agentReqs.set(msg.id, msg.method);
    }
    toClient(msg);
  }

  async function guardRequest(msg) {
    const p = msg.params ?? {};
    let tool, input, kind;
    if (msg.method === "terminal/create") { tool = "Bash"; input = { command: [p.command, ...(p.args ?? [])].join(" "), cwd: p.cwd }; kind = "execute"; }
    else if (msg.method === "fs/write_text_file") { tool = "Write"; input = { file_path: p.path, content: p.content }; kind = "edit"; }
    else return null;
    let r;
    try { r = await assessAction({ tool, input, cwd: p.cwd, agent: "acp" }, opts); }
    catch (err) { warn(err); if (!env.JEV_GUARD_FAIL_CLOSED) return null; r = { level: "deny", message: `jev-guard unavailable: ${err.message}` }; }
    if (!r || r.level === "allow") return null;
    if (r.level === "ask") {
      const res = await askClient("session/request_permission", {
        sessionId: p.sessionId,
        toolCall: { toolCallId: `jev-guard-${seq + 1}`, title: `jev-guard: ${tool} ${preview(input)}`, kind, status: "pending", rawInput: input },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      });
      const o = res?.result?.outcome;
      if (o?.outcome === "selected" && o.optionId === "allow") return null;
      r.message = `User rejected: ${r.message}`;
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: r.message } };
  }

  async function fromClient(msg) {
    if (msg.id !== undefined && !msg.method) {   // response client → agent
      const mine = ours.get(msg.id);
      if (mine) { ours.delete(msg.id); return mine(msg); }
      const method = agentReqs.get(msg.id);
      agentReqs.delete(msg.id);
      if (method === "fs/read_text_file" || method === "terminal/output") await flagContent(msg, method);
    }
    toAgent(msg);
  }

  async function flagContent(msg, method) {
    const key = method === "fs/read_text_file" ? "content" : "output";
    const text = msg.result?.[key];
    if (typeof text !== "string" || text.length < MIN_SCAN_CHARS) return;
    try {
      const r = await scanContent({ text, tool: method, source: method }, opts);
      if (r?.flagged) msg.result[key] = `[${r.message}]\n\n${text}`;
    } catch (err) { warn(err); }
  }

  pipe(child.stdout, fromAgent, warn);
  pipe(stdin, fromClient, warn);
  stdin.on("end", () => child.stdin.end());
  child.on("exit", (code) => onExit(code ?? 0));
  return child;
}

// Sequential per direction so message order survives the async checks.
function pipe(stream, handler, warn) {
  let chain = Promise.resolve();
  createInterface({ input: stream }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return warn(`non-JSON line dropped: ${line.slice(0, 80)}`); }
    chain = chain.then(() => handler(msg)).catch(warn);
  });
}
