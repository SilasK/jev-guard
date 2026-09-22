// Local HTTP server that exposes Laya (a Jev-compatible System-1 decision model) over a small JSON API.
//
// It is deliberately thin: the caller sends { state, questions } — the same shape TypeSafe Jev's
// `system_one` API uses — and gets back { model, answers, usage }. All policy lives in the plugin,
// never in this server, so the model can be swapped or upgraded without touching the guard.
//
//   GET  /health   -> { ok, model, maxLen, headMaxLen, modelDir, ready }
//   POST /decide   -> { state, questions } -> { model, answers, usage }
//   POST /warmup   -> run one throwaway forward pass so the first real call is fast
//
// Config (env):
//   LAYA_PORT         default 8790
//   LAYA_HOST         default 127.0.0.1; set 0.0.0.0 to serve the LAN, or keep loopback and tunnel
//   LAYAGUARD_TOKEN   if set, /decide, /feedback and /warmup require `Authorization: Bearer <token>`
//   LAYAGUARD_PASSWORD  if set, HTTP Basic auth with this password is also accepted (for humans)
//   LAYA_MODEL_DIR    load a local ONNX bundle instead of downloading from Hugging Face
//   LAYA_REPO         default receptron/laya-onnx
//   LAYA_SUBFOLDER    e.g. "multilingual" for the multilingual checkpoint
//   LAYA_CACHE        ONNX cache dir
//   LAYA_MAX_BODY     max request bytes, default 262144
//   LAYAGUARD_FEEDBACK_DIR  where POST /feedback appends training events, default
//                           ~/.local/state/laya-guard/feedback

import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Laya } from "@receptron/laya";

const PORT = Number(process.env.LAYA_PORT ?? 8790);
const HOST = process.env.LAYA_HOST ?? "127.0.0.1";
const MAX_BODY = Number(process.env.LAYA_MAX_BODY ?? 262144);
const TOKEN = process.env.LAYAGUARD_TOKEN ?? process.env.LAYA_TOKEN ?? "";
const PASSWORD = process.env.LAYAGUARD_PASSWORD ?? "";
const FEEDBACK_DIR = process.env.LAYAGUARD_FEEDBACK_DIR ?? join(homedir(), ".local", "state", "laya-guard", "feedback");

// Accept either the bearer token (used by the plugin) or HTTP Basic with the shared password (for
// humans / curl). If neither is configured the server is open, which is only safe on loopback.
const authorized = (req) => {
  if (!TOKEN && !PASSWORD) return true;
  const h = req.headers.authorization ?? "";
  if (TOKEN && h === `Bearer ${TOKEN}`) return true;
  if (PASSWORD && h.startsWith("Basic ")) {
    const pass = Buffer.from(h.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    if (pass === PASSWORD) return true;
  }
  return false;
};

let laya = null;
let loadError = null;

// Laya runs on ONNX Runtime and is not re-entrant in a useful way; one forward pass at a time keeps
// memory flat and latency predictable. Requests queue behind a single promise chain.
let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

async function load() {
  const t0 = Date.now();
  laya = await Laya.load({
    modelDir: process.env.LAYA_MODEL_DIR || undefined,
    repo: process.env.LAYA_REPO || undefined,
    subfolder: process.env.LAYA_SUBFOLDER || undefined,
    cacheDir: process.env.LAYA_CACHE || undefined,
  });
  console.error(`[laya-server] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s from ${laya.modelDir}`);
  console.error(`[laya-server] config ${JSON.stringify(laya.config)}`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isQuestions(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return false;
  const entries = Object.entries(q);
  if (!entries.length) return false;
  return entries.every(([, v]) => v && typeof v === "object" && ["choice", "score", "noul"].includes(v.type));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        ready: !!laya,
        loading: !laya && !loadError,
        error: loadError?.message ?? null,
        model: laya ? "laya" : null,
        modelDir: laya?.modelDir ?? null,
        maxLen: laya?.config?.max_len ?? null,
        headMaxLen: laya?.config?.head_max_len ?? null,
      });
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

    // Central training-data sink. Every machine's plugin POSTs its ask records and the human's
    // replies here, so one dataset accumulates regardless of how many OpenCode installs there are.
    if (url.pathname === "/feedback") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      await mkdir(FEEDBACK_DIR, { recursive: true });
      await appendFile(join(FEEDBACK_DIR, "events.jsonl"), JSON.stringify({ received_at: new Date().toISOString(), ...body }) + "\n");
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/warmup") {
      if (!laya) return json(res, 503, { error: "model not loaded", detail: loadError?.message });
      const r = await serialize(() => laya.systemOne({ warmup: true }, { ok: { type: "noul", instructions: "Is this a warmup?" } }));
      return json(res, 200, { ok: true, usage: r.usage });
    }

    if (url.pathname === "/decide" || url.pathname === "/system-one") {
      if (!laya) return json(res, 503, { error: "model not loaded", detail: loadError?.message });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const { state, questions } = body ?? {};
      if (state === undefined || state === null) return json(res, 400, { error: "missing state" });
      if (!isQuestions(questions)) return json(res, 400, { error: "questions must map ids to { type: choice|score|noul }" });
      const t0 = Date.now();
      const result = await serialize(() => laya.systemOne(state, questions));
      return json(res, 200, {
        model: "laya",
        answers: result.answers,
        usage: result.usage,
        latency_ms: Date.now() - t0,
      });
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    const status = err?.status ?? (err?.message?.includes("max_len") || err?.message?.includes("head_max_len") ? 400 : 500);
    return json(res, status, { error: err?.message ?? String(err) });
  }
});

load().then(
  () => server.listen(PORT, HOST, () => console.error(`[laya-server] listening on http://${HOST}:${PORT}`)),
  (err) => {
    loadError = err;
    console.error(`[laya-server] failed to load model: ${err?.message ?? err}`);
    // Still listen so /health can report the failure instead of the client seeing ECONNREFUSED.
    server.listen(PORT, HOST, () => console.error(`[laya-server] listening (degraded) on http://${HOST}:${PORT}`));
  },
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await laya?.close();
    } finally {
      process.exit(0);
    }
  });
}
