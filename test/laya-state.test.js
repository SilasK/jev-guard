import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redact, buildLayaState, describeAction, messagesFrom, slicesFrom, clip } from "../src/laya-state.js";

test("redactText masks env-style secrets and token shapes", () => {
  assert.match(redactText("API_KEY=supersecret123 run"), /API_KEY=\[redacted\]/);
  assert.ok(!redactText("token ghp_abcdefghijklmnopqrstuvwxyz0123456789").includes("ghp_"));
  assert.ok(!redactText("Authorization: Bearer sk-abcdefghijklmnopqrstuv").includes("sk-abcdef"));
  assert.equal(redactText("git status"), "git status");
});

test("redact masks credential-named keys, keeps other args", () => {
  const out = redact({ command: "git status", apiKey: "abc", nested: { password: "x", keep: "y" } });
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.nested.password, "[redacted]");
  assert.equal(out.nested.keep, "y");
  assert.equal(out.command, "git status");
});

test("describeAction produces a natural-language sentence", () => {
  assert.equal(describeAction("bash", { command: "git status" }), "run this shell command: git status");
  assert.equal(describeAction("edit", { filePath: "/p/a.ts" }), "edit the file /p/a.ts");
  assert.equal(describeAction("write", { filePath: "/p/a.ts" }), "write the file /p/a.ts");
});

test("buildLayaState defaults to action + last user request only", () => {
  const state = buildLayaState({
    tool: "bash",
    input: { command: "git push origin main" },
    cwd: "/home/silask/proj",
    slices: { opening: "OPENING TEXT", lastUser: "push it up", agentPlan: "PLAN TEXT" },
  });
  assert.match(state, /run this shell command: git push origin main/);
  assert.match(state, /The user's most recent request was: push it up/);
  assert.ok(!state.includes("OPENING TEXT"), "opening is excluded by default (it hurt AUC)");
  assert.ok(!state.includes("PLAN TEXT"), "plan is excluded by default");
});

test("buildLayaState can include opening/plan/toolCalls on request", () => {
  const state = buildLayaState({
    tool: "bash",
    input: { command: "rm -rf /" },
    slices: { opening: "OPEN", lastUser: "LAST", agentPlan: "PLAN" },
    recentToolCalls: ["read a", "edit b"],
    include: ["opening", "lastUser", "plan", "toolCalls"],
  });
  assert.match(state, /OPEN/);
  assert.match(state, /PLAN/);
  assert.match(state, /Recent actions: read a; edit b/);
});

test("messagesFrom and slicesFrom pick the right slices", () => {
  const entries = [
    { info: { role: "user" }, parts: [{ type: "text", text: "first" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working" }, { type: "tool", tool: "read" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "last" }] },
  ];
  const m = messagesFrom(entries);
  assert.deepEqual(m, [
    { role: "user", text: "first" },
    { role: "assistant", text: "working" },
    { role: "user", text: "last" },
  ]);
  assert.deepEqual(slicesFrom(m), { opening: "first", lastUser: "last", agentPlan: "working" });
});

test("clip truncates with an ellipsis and normalizes whitespace", () => {
  assert.equal(clip("a   b\n c", 100), "a b c");
  assert.ok(clip("x".repeat(50), 10).endsWith("…"));
});
