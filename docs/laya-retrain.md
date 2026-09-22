# Retraining Laya on your own permission decisions

We retrain **Laya itself** — the checkpoint's encoder plus its decision head — using Laya's own
recipe. "ModernBERT" is only the name of Laya's encoder architecture; there is no separate BERT model
in this picture. The output is a new Laya ONNX bundle, and the guard loads it unchanged.

## Who does what, and when

| Stage | Where | When |
| --- | --- | --- |
| Collect permission decisions | every machine running the plugin → central `/feedback` | **now, automatic** |
| Build the labeled dataset | the Laya server host | on demand |
| Fine-tune + recalibrate | the RTX 3090 Ti (or Ubelix HPC) | **later**, when the RTX is free |
| Export ONNX + serve | the Laya server host | after training |

Training is a manual, offline step you run; nothing trains while the guard is serving.

## What gets collected

For every native-`ask` call, the plugin POSTs one `ask` event and (when the human answers the prompt)
one `reply` event to the server's `POST /feedback`. They share a `request_id`.

`ask`:
```json
{ "kind":"ask", "request_id":"…", "session_id":"…", "native_permission":"ask",
  "permission":{"type":"bash","pattern":null,"title":"npm publish"},
  "tool":"bash", "args":{"command":"npm publish"}, "working_directory":"/p",
  "state":"The coding agent wants to run this shell command: npm publish.\n…",
  "answers":{"harm":{"p":0.07},"user_asked":{"p":0.31},"task_fit":{"p":0.75}},
  "stats":{"harmP":0.07,"userAskedP":0.31,"taskFitP":0.75},
  "jev_decision":"ask", "effective_decision":"ask", "source":"jev", "latency_ms":253,
  "slices":{"opening":"…","last_user":"…","agent_plan":"…"}, "recent_tool_calls":["read a","edit b"] }
```

`reply` (from OpenCode's `permission.replied`) — **this is the user acceptance the plugin retains**:
`{ "kind":"reply", "request_id":"…", "reply":"reject" }` (or `"once"` / `"always"`).

`state`/`answers` are exactly what Laya saw and answered. `slices` and `recent_tool_calls` are extra
context that is **not** sent to Laya; they are stored so you can re-run offline experiments over other
slice choices without re-collecting. Disable with `"captureSlices": false`.

Only the state we already send to Laya is stored, and it is redacted (`src/laya-state.js`): credential
values, token-shaped strings and credential-named keys are masked before they leave the process. No
file contents, no environment variables, no full conversation. Set `"capture": false` in
`laya-guard.json` to turn collection off.

Central storage lives at `LAYAGUARD_FEEDBACK_DIR` (default
`~/.local/state/laya-guard/feedback/events.jsonl` on the server).

## Several OpenCode servers — no manual merge needed

All machines point their plugin at the same Laya server, so every `ask` and `reply` lands in the one
central `events.jsonl`. You do **not** combine datasets by hand.

If a machine cannot reach the server (offline, or `"feedback": false`), the plugin writes a local
fallback (`~/.local/state/laya-guard/training.jsonl`). Fold it back in when online:

```sh
LAYAGUARD_TOKEN=… node laya-server/push-feedback.mjs ~/.local/state/laya-guard/training.jsonl
```

If you would rather keep files separate, `build-dataset.mjs` merges any number of event files and
de-duplicates by `request_id`, so overlapping copies are safe:

```sh
node laya-server/build-dataset.mjs --out dataset.jsonl \
  ~/.local/state/laya-guard/feedback/events.jsonl \
  /backup/laptop/training.jsonl /backup/desktop/training.jsonl
```

The `request_id` is unique per permission request and the `session_id` disambiguates sessions, so
records from different servers never collide.

## Build the dataset

```sh
node laya-server/build-dataset.mjs --out dataset.jsonl \
  ~/.local/state/laya-guard/feedback/events.jsonl
```

It joins asks with replies by `request_id` and prints the metric that matters:

```
events: 4  asks: 2  replies: 1  labeled: 1
model/human agreement on labeled prompts: 0.0%
confusion (model->human): {"ask->deny":1}
```

A reply only exists when the guard fell through to the human prompt, so the dataset is exactly the
ambiguous set worth learning from:

- `reply: "reject"` on a call the model allowed or prompted → the harm head should score it higher.
- `reply: "once" | "always"` on a call the model wanted to prompt → the `user_asked` / `task_fit`
  heads should score it higher.

## Train and export

Follow Laya's own fine-tuning recipe (RLCD — strictly proper scoring rules on the decision head),
then export the ONNX bundle. The concrete steps, checkpoint choice and calibration notes are in
[`laya-improvements.md`](laya-improvements.md) sections 2–3. In short:

1. Fine-tune the Laya checkpoint on `dataset.jsonl` (labels derived from `human_reply`).
2. Refit the per-question temperature on a held-out slice.
3. `export_onnx.py` → a bundle with `laya.onnx`, `laya.onnx.data`, `laya_config.json`, `tokenizer/`.
4. Point the server at it and restart:

   ```sh
   # laya-guard.env
   LAYA_MODEL_DIR=/path/to/onnx-retrained
   systemctl --user restart laya-guard-server
   ```

5. Re-run `node docs/laya-eval.mjs` (pointed at the server) and re-check agreement with
   `build-dataset.mjs` before widening auto-approval.

## Retention

- `events.jsonl` grows with every prompted call; rotate or archive it periodically.
- It contains command lines and file paths (redacted), so treat it like a log: `chmod 600`, and keep it
  on the server, not in a repo.
- Back it up before retraining — it is the only copy of the labels.
