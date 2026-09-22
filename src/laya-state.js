// Builds the compact state that Laya gets to see.
//
// Laya is a ModernBERT encoder: the state is truncated to max_len (512 tokens, ~320 after the question
// header), so "the whole conversation" is neither possible nor useful. What we send is the result of
// measurements in this repo (see docs/laya-context.md):
//
//   * the action, as a natural-language sentence — JSON with tool-ish keys made the base checkpoint
//     score `rm -rf /` and `git status` almost identically (near-chance, AUC ~0.6)
//   * the user's most recent request — improved harm separation (AUC 0.92 -> 0.96) and lowered the
//     highest safe score
//   * the agent's stated plan — roughly neutral; off by default
//   * the opening message — actively hurt (AUC 0.83); off by default
//
// Everything is clipped to a per-slice character budget and secrets are redacted before they leave the process.

const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|bearer|private[-_]?key|access[-_]?key|client[-_]?secret|cookie|session[-_]?id)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|aria[A-Za-z0-9]{20,}|[A-Fa-f0-9]{40,})/g;
const ENV_ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|\S+)/gi;

export const DEFAULT_LIMITS = {
  action: 400,
  lastUser: 320,
  agentPlan: 240,
  opening: 200,
  cwd: 120,
  toolCalls: 3,
};

export const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

/** Mask secrets in a free-text string (command lines, prose). */
export function redactText(s) {
  if (typeof s !== "string") return s;
  return s.replace(ENV_ASSIGN, (m, key) => `${key}=[redacted]`).replace(SECRET_VALUE, "[redacted]");
}

/** Recursively redact a tool-argument value. Keys that name credentials become "[redacted]". */
export function redact(value, depth = 0) {
  if (depth > 8) return "[deep]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** Extract only the text-bearing parts of a message; tool calls/results are summarized elsewhere. */
function textOfContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Turn the SDK's session messages into { role, text } entries. */
export function messagesFrom(entries) {
  const out = [];
  for (const e of entries ?? []) {
    const m = e.message ?? e;
    const role = m.role ?? e.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOfContent(m.content) || textOfContent(e.parts);
    if (text) out.push({ role, text });
  }
  return out;
}

/** The context slices. First user message = session goal; last of each = current intent/plan. */
export function slicesFrom(messages) {
  const users = messages.filter((m) => m.role === "user");
  const assistants = messages.filter((m) => m.role === "assistant");
  return {
    opening: users[0]?.text,
    lastUser: users.at(-1)?.text,
    agentPlan: assistants.at(-1)?.text,
  };
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** A natural-language description of the tool call — the sentence Laya scores. */
export function describeAction(tool, input) {
  const name = String(tool ?? "").toLowerCase();
  const a = input && typeof input === "object" ? input : {};
  if (name === "bash" || name === "shell" || name === "run_shell_command") {
    return `run this shell command: ${str(a.command ?? a.cmd ?? a.commandLine ?? JSON.stringify(a))}`;
  }
  if (name === "edit" || name === "write" || name === "patch" || name === "multiedit" || name === "apply_patch" || name === "notebookedit") {
    const path = a.filePath ?? a.path ?? a.file_path ?? "a file";
    const verb = name === "edit" ? "edit" : "write";
    return `${verb} the file ${str(path)}`;
  }
  if (name === "read" || name === "glob" || name === "grep" || name === "list") {
    return `${name} ${str(a.filePath ?? a.path ?? a.pattern ?? "")}`.trim();
  }
  if (name === "webfetch" || name === "websearch") return `fetch ${str(a.url ?? a.query ?? "")}`.trim();
  return `call the ${name} tool with ${clip(redactText(JSON.stringify(a)), 240)}`;
}

/**
 * Assemble the state Laya sees. Returns a plain string: measured better than a JSON object for this
 * checkpoint. Never includes full history, file contents, or env vars.
 * @returns {string}
 */
export function buildLayaState({ tool, input, cwd, slices = {}, recentToolCalls = [], limits = {}, include = ["lastUser"] } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const lines = [`The coding agent wants to ${clip(redactText(describeAction(tool, input)), L.action)}.`];
  const dir = typeof cwd === "string" ? clip(cwd, L.cwd) : "";
  if (dir) lines.push(`Working directory: ${dir}.`);
  if (include.includes("lastUser")) {
    const lastUser = clip(redactText(slices.lastUser), L.lastUser);
    if (lastUser) lines.push(`The user's most recent request was: ${lastUser}`);
  }
  if (include.includes("plan")) {
    const plan = clip(redactText(slices.agentPlan), L.agentPlan);
    if (plan) lines.push(`The agent said it was doing: ${plan}`);
  }
  if (include.includes("opening")) {
    const opening = clip(redactText(slices.opening), L.opening);
    if (opening) lines.push(`The session started with: ${opening}`);
  }
  if (include.includes("toolCalls") && recentToolCalls.length) {
    lines.push(`Recent actions: ${recentToolCalls.slice(-L.toolCalls).map((c) => clip(redactText(c), 100)).join("; ")}`);
  }
  return lines.join("\n");
}
