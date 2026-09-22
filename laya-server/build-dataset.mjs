// Join the central feedback events into a labeled dataset for fine-tuning Laya.
//
//   node laya-server/build-dataset.mjs [events.jsonl] [out.jsonl]
//
// Each `ask` event is joined with the `reply` event that shares its request_id. A reply only exists
// when the guard fell through to OpenCode's human prompt, so the dataset is exactly the ambiguous set
// worth learning from: the calls the model could not decide.
//
//   reply "once" | "always"  -> the human allowed it   (label allow)
//   reply "reject"           -> the human blocked it   (label deny)
//
// The script also prints how often the model's decision agreed with the human — the number to move
// before widening auto-approval.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Multiple input files are merged and de-duplicated by request_id, so events collected on separate
// machines (or from the local fallback files) can be combined in one pass:
//
//   node laya-server/build-dataset.mjs --out dataset.jsonl a/events.jsonl b/events.jsonl ~/…/training.jsonl
//
const DEFAULT_EVENTS = join(homedir(), ".local", "state", "laya-guard", "feedback", "events.jsonl");
const argv = process.argv.slice(2);
let outPath = "dataset.jsonl";
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outPath = argv[++i];
  else inputs.push(argv[i]);
}
if (!inputs.length) inputs.push(DEFAULT_EVENTS);

const lines = [];
for (const file of inputs) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`skipping ${file}: ${err.message}`);
    continue;
  }
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {
      /* ignore partial lines */
    }
  }
}

const asks = new Map();
const replies = new Map();
for (const e of lines) {
  if (e.kind === "ask" && e.request_id) asks.set(e.request_id, e);
  else if (e.kind === "reply" && e.request_id) replies.set(e.request_id, e);
}

const label = (reply) => (reply === "once" || reply === "always" ? "allow" : reply === "reject" ? "deny" : null);

const dataset = [];
let agree = 0;
let labeled = 0;
const confusion = {};
for (const [id, ask] of asks) {
  const reply = replies.get(id)?.reply;
  const human = label(reply);
  if (human) {
    labeled++;
    const key = `${ask.jev_decision ?? "none"}->${human}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (ask.jev_decision === human) agree++;
  }
  dataset.push({
    request_id: id,
    tool: ask.tool,
    args: ask.args,
    state: ask.state,
    answers: ask.answers,
    jev_decision: ask.jev_decision,
    effective_decision: ask.effective_decision,
    human_reply: reply ?? null,
    label: human,
  });
}

writeFileSync(outPath, dataset.map((d) => JSON.stringify(d)).join("\n") + "\n");
console.log(`events: ${lines.length}  asks: ${asks.size}  replies: ${replies.size}  labeled: ${labeled}`);
console.log(`model/human agreement on labeled prompts: ${labeled ? ((agree / labeled) * 100).toFixed(1) : "n/a"}%`);
console.log("confusion (model->human):", JSON.stringify(confusion));
console.log(`wrote ${dataset.length} rows to ${outPath}`);
console.log("\nNote: `reject` on a call the model allowed is the signal to raise that call's harm score;");
console.log("`allow` on a call the model wanted to prompt is the signal for the user_asked/task_fit heads.");
