// One fetch, two backends: TypeSafe's API when JEV_API_KEY is set, Vercel AI Gateway otherwise.
// Question ids are ours; types are TypeSafe's (noul / choice / score). Gateway calls noul "boolean".
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = join(homedir(), ".jev-guard", "config.json");

// Env first (CLIs inherit the shell); then ~/.jev-guard/config.json written by `jev-guard key`, which is what
// GUI hosts such as Cursor or Zed need since they don't see your shell profile.
export function backend(env = process.env) {
  if (env.JEV_API_KEY) return { kind: "typesafe", key: env.JEV_API_KEY };
  if (env.AI_GATEWAY_API_KEY) return { kind: "gateway", key: env.AI_GATEWAY_API_KEY, auth: "api-key" };
  if (env.VERCEL_OIDC_TOKEN) return { kind: "gateway", key: env.VERCEL_OIDC_TOKEN, auth: "oidc" };  // `vercel env pull`; expires in ~12h
  const cfg = readConfig(env);
  if (cfg.jevApiKey) return { kind: "typesafe", key: cfg.jevApiKey };
  if (cfg.aiGatewayApiKey) return { kind: "gateway", key: cfg.aiGatewayApiKey, auth: "api-key" };
  return null;
}

export function readConfig(env = process.env) {
  try { return JSON.parse(readFileSync(env.JEV_GUARD_CONFIG ?? CONFIG_FILE, "utf8")); } catch { return {}; }
}

/** @returns {Promise<Record<string, {p?: number, choice?: string, score?: number, probabilities?: Record<string, number>, confidence?: number}>>} */
export async function ask(state, questions, { env = process.env, fetchImpl = fetch, signal, timeoutMs = 20_000 } = {}) {
  const b = backend(env);
  if (!b) throw new Error("no credentials: run `jev-guard key <key>` or set JEV_API_KEY / AI_GATEWAY_API_KEY");
  const gw = b.kind === "gateway";
  const q = gw ? mapValues(questions, (x) => (x.type === "noul" ? { ...x, type: "boolean" } : x)) : questions;
  const request = () => fetchImpl(gw ? GATEWAY_URL : TYPESAFE_URL, {
    method: "POST",
    headers: gw
      ? { Authorization: `Bearer ${b.key}`, "Content-Type": "application/json", "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": b.auth, "ai-evaluation-model-specification-version": "4", "ai-model-id": env.JEV_MODEL ?? "typesafe-ai/jev" }
      : { Authorization: `Bearer ${b.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(gw
      ? { state, questions: q, providerOptions: { gateway: { zeroDataRetention: true } } }
      : { state, model: env.JEV_MODEL ?? "jev-latest", questions: q }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  let res = await request();
  for (let attempt = 0; (res.status === 429 || res.status >= 500) && attempt < 2; attempt++) {  // overloaded / rate-limited: brief backoff
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    res = await request();
  }
  if (!res.ok) throw new Error(`${b.kind} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const conf = body.providerMetadata?.typesafe?.confidence ?? {};
  return mapValues(body.answers, (a, id) => ({
    p: a.noul ?? a.probability, choice: a.choice, score: a.score, probabilities: a.probabilities,
    confidence: a.confidence ?? conf[id],
  }));
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k)]));
}
