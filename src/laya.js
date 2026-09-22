// Plugin-side client for the local Laya server. Same call signature and return shape as ./jev.js `ask`,
// so guard.js can run its shared policy unchanged — only the backend swaps (hosted Jev -> local Laya).
//
// The plugin itself has no dependencies: this is one fetch to 127.0.0.1.

export const DEFAULT_ENDPOINT = "http://127.0.0.1:8790/decide";

/** Where to send Laya requests. opts.endpoint > LAYA_ENDPOINT > default. */
export function layaEndpoint(env = process.env, endpoint) {
  return endpoint ?? env.LAYA_ENDPOINT ?? DEFAULT_ENDPOINT;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalize one Laya answer into Jev's answer shape ({ p, choice, score, probabilities, confidence }). */
function normalize(answer) {
  if (!answer || typeof answer !== "object") return undefined;
  const out = {};
  const p = num(answer.noul) ?? num(answer.p) ?? num(answer.probability);
  if (p !== undefined) out.p = p;
  if (typeof answer.choice === "string") out.choice = answer.choice;
  const score = num(answer.score);
  if (score !== undefined) out.score = score;
  if (answer.probabilities && typeof answer.probabilities === "object") out.probabilities = answer.probabilities;
  const confidence = num(answer.confidence);
  if (confidence !== undefined) out.confidence = confidence;
  if (answer.rl_agent) out.rl_agent = answer.rl_agent;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Ask the local Laya server. Resolves to { ...answers, _usage, _latencyMs } or throws on any failure.
 * @param {object} state
 * @param {object} questions Jev/Laya question map
 * @returns {Promise<Record<string, object>>}
 */
export async function layaAsk(state, questions, { env = process.env, fetchImpl = fetch, endpoint, timeoutMs, signal, debug, token, password } = {}) {
  const url = layaEndpoint(env, endpoint);
  const bearer = token ?? env.LAYAGUARD_TOKEN ?? env.LAYA_TOKEN;
  const pw = password ?? env.LAYAGUARD_PASSWORD;
  const authorization = bearer
    ? `Bearer ${bearer}`
    : pw
      ? `Basic ${Buffer.from(`laya:${pw}`).toString("base64")}`
      : undefined;
  const budget = AbortSignal.timeout(timeoutMs ?? +(env.LAYA_TIMEOUT_MS || 2500));
  const abort = signal ? AbortSignal.any([signal, budget]) : budget;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ state, questions }),
    signal: abort,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`laya HTTP ${res.status}: ${text.slice(0, 300)}`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`laya returned invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!body?.answers || typeof body.answers !== "object") throw new Error("laya response has no answers object");

  const answers = {};
  for (const [id, raw] of Object.entries(body.answers)) {
    const a = normalize(raw);
    if (a) answers[id] = a;
  }
  Object.defineProperty(answers, "_usage", { value: body.usage, enumerable: false });
  Object.defineProperty(answers, "_latencyMs", { value: body.latency_ms, enumerable: false });
  if (debug) Object.defineProperty(answers, "_raw", { value: body.answers, enumerable: false });
  return answers;
}
