// Push locally-captured feedback events to the central Laya server.
//
// Machines that cannot reach the server (or ran with "feedback": false) fall back to a local
// ~/.local/state/laya-guard/training.jsonl. Run this once they are back online to fold that file into
// the central sink, so you never have to hand-merge datasets.
//
//   LAYAGUARD_TOKEN=… node laya-server/push-feedback.mjs ~/.local/state/laya-guard/training.jsonl
//   node laya-server/push-feedback.mjs training.jsonl http://192.168.1.50:8790/feedback
//
// Idempotency: the server appends every event, so pushing the same file twice duplicates it. The
// dataset builder de-duplicates by request_id, so duplicates are harmless for training; still, prefer
// pushing once and then truncating the local file.

import { readFileSync } from "node:fs";

const [file, endpointArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: node laya-server/push-feedback.mjs <events.jsonl> [endpoint]");
  process.exit(1);
}
const endpoint = endpointArg ?? "http://127.0.0.1:8790/feedback";
const token = process.env.LAYAGUARD_TOKEN ?? process.env.LAYA_TOKEN;

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
let ok = 0;
let failed = 0;
for (const line of lines) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: line,
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) ok++;
    else failed++;
  } catch {
    failed++;
  }
}
console.log(`pushed ${ok}/${lines.length} events to ${endpoint}${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
