# Making Laya good enough to trust

The base ONNX checkpoint is the only one `@receptron/laya` publishes, and it is explicitly weak:
"base checkpoints are near chance on typed-decisions zero-shot … a fast base to specialise, not a
zero-shot decision engine." Out of the box it is a **coarse harm detector**, which is why the guard
only lets it *block* and puts read-only approval behind a code rule rather than the model.

To move past that, in increasing order of effort:

## 0. What already helps (done, no training)

Measured in `docs/laya-context.md`:

- natural-language sentence state instead of a JSON object (AUC 0.60 → 0.93);
- a narrow binary `noul` harm question instead of `score`/`choice` (`choice` was worse than random);
- action + last user request as the context slices (opening message hurt);
- a model-independent "un-chained read-only command is safe, except sensitive paths" rule, so routine
  reads like `cat ~/.cloudflare/config.yml` never prompt while `cat ~/.ssh/id_rsa` still does.

## 1. Recalibrate the probabilities

The model card: "Ships over-confident … refitting one temperature per (question type, option count)
moves mean ECE 0.466 → 0.081." The ONNX bundle carries `temperature_by_options`, but you cannot refit
it in the JS package — you need the Python reference and your own labeled data. Until then, treat the
threshold (`denyAt`) as a tuned decision boundary, not as a calibrated probability, and tune it on
your own audit log.

## 2. Export the fine-tuned `laya-typed-decisions` checkpoint to ONNX

That checkpoint scores 0.766 (security incidents 0.766) versus the base's near-chance. It is not in
`receptron/laya-onnx`, but the export script can build it:

```sh
# in a checkout of github.com/receptron/laya
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python torch transformers safetensors onnx onnxscript onnxruntime huggingface_hub
# fetch the typed-decisions subfolder of convaiinnovations/laya (see export_onnx.py for exact patterns)
.venv/bin/python export/export_onnx.py model ../onnx-typed
```

Then run the server against it and re-run the eval:

```sh
LAYAPORT=8791 LAYA_MODEL_DIR=/path/to/onnx-typed node laya-server/server.mjs
node docs/laya-eval.mjs        # point the script at :8791 to compare
```

Note the checkpoint expects its own framing; re-validate the question wording on it before trusting
the numbers.

## 3. Fine-tune Laya on your own tool calls (the real fix)

This trains **Laya** — the checkpoint's encoder and decision head — not a separate model. Data
collection is already running: every native-`ask` call is posted to the server's `/feedback` sink
(central across machines), and the human's prompt answer is stored alongside it. See
[`laya-retrain.md`](laya-retrain.md) for the pipeline and `laya-server/build-dataset.mjs` for the join.

- Train with Laya's recipe (RLCD: strictly-proper scoring rules) or plain supervised labels on the
  decision head, then export to ONNX as in step 2.
- Recalibrate temperature per question type on a held-out slice.
- Target before widening auto-approval: harm AUC ≥ 0.95 **and zero** false negatives on your
  dangerous-command set, with `task_fit` accurate enough to carry the `.cloudflare`-style cases.
- Do it later, on the RTX 3090 Ti or Ubelix — not in the plugin, and not while the guard is serving.

## 4. Or use a small local instruct model for the *reasoning* questions

The context-dependent judgment ("is reading `.cloudflare` a reasonable step for this task?") is where a
7B-class instruct model is much stronger than an encoder. The `OpenAICompatibleLocalClassifier` backend
already speaks to any OpenAI-compatible endpoint (you run `llama-server`/`ollama` locally):

```json
{ "backend": "openai", "endpoint": "http://localhost:8082/v1/chat/completions", "model": "Bonsai-2-27B-MTP" }
```

It trades ~150 ms for seconds per call, so use it only for the `ask` cases (which is exactly when the
fallback runs). A common setup: Laya blocks the obvious, the LLM adjudicates the ambiguous, code owns
the read-only allowlist.

## Guardrails while improving

- Keep `denyAt` conservative and re-run `node docs/laya-eval.mjs` after every change.
- Never turn on model-based auto-approval for mutating actions; the read-only rule is the safe ceiling.
- Log first, trust later: the audit log is your training set and your rollback evidence.
