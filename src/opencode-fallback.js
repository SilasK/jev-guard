// OpenCode adapter — fallback mode.
//
// OpenCode calls `permission.ask` ONLY when its native policy resolves to "ask". Native allow and deny
// never reach this hook, so by construction the classifier is consulted for exactly the ambiguous cases,
// and can never widen a native deny or second-guess a native allow.
//
//   native allow -> executes, classifier not consulted
//   native deny  -> blocked, classifier not consulted
//   native ask   -> classifier decides: allow (run) / deny (block) / uncertain (normal human prompt)
//
// The classifier is local Laya (or any OpenAI-compatible endpoint) behind the PermissionClassifier
// interface. Failures, timeouts, malformed output and low confidence all fall back to the human prompt.
//
// Config precedence: plugin options > environment > ~/.config/opencode/laya-guard.json > defaults.

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LayaClassifier, OpenAICompatibleLocalClassifier, resolveDecision, applyHardSafetyRules, DEFAULT_ALLOW } from "./classifier.js";
import { messagesFrom, slicesFrom, redactText, redact, clip } from "./laya-state.js";

export const CONFIG_FILE = join(homedir(), ".config", "opencode", "laya-guard.json");
const DEFAULT_AUDIT = join(homedir(), ".local", "state", "laya-guard", "audit.jsonl");
const DEFAULT_TRAINING = join(homedir(), ".local", "state", "laya-guard", "training.jsonl");
const DEFAULT_REPLIES = join(homedir(), ".local", "state", "laya-guard", "replies.jsonl");

const appendJsonl = (path, entry) => {
  if (!path) return;
  mkdir(dirname(path), { recursive: true })
    .then(() => appendFile(path, JSON.stringify(entry) + "\n"))
    .catch(() => {});
};

function loadConfigFile(env) {
  try {
    return JSON.parse(readFileSync(env.LAYAGUARD_CONFIG ?? CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Secrets live here, never in the git-synced config: a local file that is merged over the shared
// config. Keeps a strong token out of any repository.
const LOCAL_CONFIG_FILE = join(homedir(), ".config", "opencode", "laya-guard.local.json");
function loadLocalConfig(env) {
  try {
    return JSON.parse(readFileSync(env.LAYAGUARD_LOCAL_CONFIG ?? LOCAL_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Merge defaults < shared config < local secret file < env < plugin options. */
export function resolveConfig(options = {}, env = process.env) {
  const file = loadConfigFile(env);
  const local = loadLocalConfig(env);
  const fromEnv = {};
  if (env.LAYAGUARD_MODE) fromEnv.mode = env.LAYAGUARD_MODE;
  if (env.LAYA_ENDPOINT) fromEnv.endpoint = env.LAYA_ENDPOINT;
  if (env.LAYAGUARD_MIN_CONFIDENCE) fromEnv.minConfidence = Number(env.LAYAGUARD_MIN_CONFIDENCE);
  if (env.LAYAGUARD_AUDIT) fromEnv.auditLog = env.LAYAGUARD_AUDIT === "1" ? true : env.LAYAGUARD_AUDIT;
  if (env.LAYAGUARD_TOKEN) fromEnv.token = env.LAYAGUARD_TOKEN;
  if (env.LAYAGUARD_PASSWORD) fromEnv.password = env.LAYAGUARD_PASSWORD;
  if (env.LAYAGUARD_FEEDBACK_TOKEN) fromEnv.feedbackToken = env.LAYAGUARD_FEEDBACK_TOKEN;

  const cfg = {
    mode: "fallback",
    backend: "laya",
    endpoint: "http://127.0.0.1:8790/decide",
    model: "local-laya",
    token: undefined,
    password: undefined,
    timeoutMs: 2500,
    minConfidence: 0.6,
    onError: "ask",
    readOnly: "classify",
    debug: false,
    auditLog: DEFAULT_AUDIT,
    capture: true,
    captureSlices: true,
    trainingLog: DEFAULT_TRAINING,
    repliesLog: DEFAULT_REPLIES,
    feedback: true,
    feedbackEndpoint: undefined,
    feedbackToken: undefined,
    feedbackTimeoutMs: 1500,
    include: ["lastUser"],
    denyAt: 0.5,
    autoAllow: { enabled: true, patterns: DEFAULT_ALLOW, maxHarm: 0.2, minUserAsked: 0, readOnlyCommands: false },
    contextAllow: { enabled: true, maxHarm: 0.2, minTaskFit: 0.6, minUserAsked: 0.5 },
    hardSafety: { enabled: false, allowOnly: [] },
    ...file,
    ...local,
    ...fromEnv,
    ...options,
  };
  cfg.autoAllow = { enabled: true, patterns: DEFAULT_ALLOW, maxHarm: 0.2, minUserAsked: 0, readOnlyCommands: false, ...file.autoAllow, ...local.autoAllow, ...options.autoAllow };
  cfg.contextAllow = { enabled: true, maxHarm: 0.2, minTaskFit: 0.6, minUserAsked: 0.5, ...file.contextAllow, ...local.contextAllow, ...options.contextAllow };
  cfg.hardSafety = { enabled: false, allowOnly: [], ...file.hardSafety, ...local.hardSafety, ...options.hardSafety };
  return cfg;
}

function makeClassifier(cfg) {
  const common = { endpoint: cfg.endpoint, timeoutMs: cfg.timeoutMs, debug: cfg.debug, env: process.env, token: cfg.token, password: cfg.password, capture: cfg.capture };
  if (cfg.backend === "openai") return new OpenAICompatibleLocalClassifier({ ...common, model: cfg.model });
  const policy = { denyAt: cfg.denyAt, autoAllow: cfg.autoAllow, contextAllow: cfg.contextAllow };
  return new LayaClassifier({ ...common, limits: cfg.limits, include: cfg.include, policy, skipReadOnly: cfg.readOnly !== "classify" });
}

/** Pull the session's messages once per short window; the SDK call is local but not free. */
function makeContextLoader(client) {
  const cache = new Map();
  // `calls` is keyed by callID so the hook can recover the real tool name and arguments for the
  // permission request — Permission.metadata is often thin, and knowing the actual tool is what lets
  // a `read` of an external path be recognised as read-only.
  return async (sessionID, force = false) => {
    if (!sessionID || !client?.session?.messages) return {};
    const hit = cache.get(sessionID);
    if (!force && hit && Date.now() - hit.at < 2000) return hit.value;
    let value = {};
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const entries = res?.data ?? [];
      const slices = slicesFrom(messagesFrom(entries));
      const recent_tool_calls = [];
      const calls = {};
      for (const e of entries.slice(-30)) {
        for (const part of e.parts ?? []) {
          if (part?.type !== "tool" || !part.tool) continue;
          const args = part.state?.input ?? {};
          const id = part.callID ?? part.state?.callID ?? part.id;
          if (id) calls[id] = { tool: part.tool, args };
          const arg = args.command ?? args.filePath ?? args.path ?? args.pattern ?? JSON.stringify(args);
          recent_tool_calls.push(`${part.tool} ${clip(redactText(String(arg)), 100)}`);
        }
      }
      value = { slices, recent_tool_calls, calls };
    } catch {
      value = {};
    }
    cache.set(sessionID, { at: Date.now(), value });
    return value;
  };
}

const audit = (cfg, entry) => {
  if (!cfg.auditLog) return;
  appendJsonl(typeof cfg.auditLog === "string" ? cfg.auditLog : DEFAULT_AUDIT, entry);
};

/** Where training events go: the server's /feedback, derived from the /decide endpoint by default. */
function feedbackEndpoint(cfg) {
  if (cfg.feedbackEndpoint) return cfg.feedbackEndpoint;
  const base = String(cfg.endpoint ?? "").replace(/\/decide\/?$/, "");
  return base ? `${base}/feedback` : undefined;
}

/**
 * Send one training event to the central sink. Fire-and-forget: never delays the permission hook, and
 * falls back to a local JSONL so data is not lost when the server is unreachable.
 */
async function postFeedback(cfg, record) {
  const entry = { ts: new Date().toISOString(), ...record };
  const url = cfg.feedback ? feedbackEndpoint(cfg) : undefined;
  if (!url) {
    appendJsonl(cfg.trainingLog, entry);
    return;
  }
  // Feedback can go to a different server than /decide (e.g. decide locally on a Mac, centralize
  // training data on the gamer), so it has its own optional credential.
  const feedbackToken = cfg.feedbackToken ?? cfg.token;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(feedbackToken ? { authorization: `Bearer ${feedbackToken}` } : {}) },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(cfg.feedbackTimeoutMs ?? 1500),
    });
    if (!res.ok) throw new Error(`feedback HTTP ${res.status}`);
  } catch {
    appendJsonl(cfg.trainingLog, entry);
  }
}

/** The tool arguments from a Permission object: metadata is the richest source, title the fallback. */
export function permissionArgs(input) {
  const meta = input?.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const args = { ...meta };
  if (input?.pattern !== undefined) args.pattern = input.pattern;
  if (!args.command && !args.filePath && !args.path && input?.title) args.title = input.title;
  return args;
}

/**
 * OpenCode plugin. `mode: "off"` loads but does nothing; `mode: "fallback"` (default) implements the
 * ask -> classifier -> allow/deny/ask pipeline described above.
 */
export const JevGuardFallback = async ({ client, directory } = {}, options = {}) => {
  const cfg = resolveConfig(options);
  if (cfg.mode === "off") return {};

  const classifier = makeClassifier(cfg);
  const contextFor = makeContextLoader(client);
  const toast = (message, variant = "warning") =>
    client?.tui?.showToast?.({ body: { title: "laya-guard", message, variant, duration: 8000 } }).catch(() => {});

  return {
    "permission.ask": async (input, output) => {
      // Native allow/deny must never reach us. If OpenCode ever calls this hook with a resolved
      // status, return without a classifier call — that is the whole safety invariant.
      if (output.status !== "ask") return;

      const started = Date.now();
      const native = "ask";
      let jev = null;
      let ctx = {};
      let resolvedTool = input.type;
      let resolvedArgs = permissionArgs(input);
      try {
        ctx = await contextFor(input.sessionID);
        let call = input.callID ? ctx.calls?.[input.callID] : undefined;
        if (input.callID && !call) {
          ctx = await contextFor(input.sessionID, true); // the part may have appeared after the cache window
          call = ctx.calls?.[input.callID];
        }
        if (call) {
          resolvedTool = call.tool;
          resolvedArgs = call.args;
        }
        const action = { tool: resolvedTool, arguments: resolvedArgs };
        jev = await classifier.evaluate({
          tool: resolvedTool,
          arguments: resolvedArgs,
          working_directory: directory,
          session_id: input.sessionID,
          slices: ctx.slices,
          recent_tool_calls: ctx.recent_tool_calls,
        });
        jev = applyHardSafetyRules(action, jev, cfg.hardSafety);
      } catch (err) {
        // Unavailable, timeout, malformed: preserve the human prompt exactly as OpenCode would show it.
        jev = null;
        if (cfg.debug) toast(`classifier error: ${err?.message ?? err}`, "error");
      }

      const effective = resolveDecision(native, jev, { minConfidence: cfg.minConfidence });

      audit(cfg, {
        timestamp: new Date().toISOString(),
        session_id: input.sessionID,
        tool: resolvedTool,
        action: clip(JSON.stringify(resolvedArgs ?? {}), 300),
        native_decision: native,
        jev_decision: jev?.valid ? jev.decision : null,
        confidence: jev?.confidence ?? null,
        risk: jev?.risk ?? null,
        harm: jev?.stats?.harmP ?? null,
        user_asked: jev?.stats?.userAskedP ?? null,
        task_fit: jev?.stats?.taskFitP ?? null,
        effective_decision: effective.decision,
        source: effective.source,
        reason: jev?.valid ? jev.reason : null,
        latency_ms: Date.now() - started,
      });

      // Training capture: the exact state we sent, Laya's raw answers, and the decision. Joined later
      // with the human's reply (permission.replied) to form a labeled example. Redacted, fire-and-forget.
      if (cfg.capture) {
        postFeedback(cfg, {
          kind: "ask",
          request_id: input.id ?? null,
          session_id: input.sessionID,
          native_permission: native,
          permission: { type: input.type, pattern: input.pattern ?? null, title: input.title ?? null },
          tool: resolvedTool,
          args: redact(resolvedArgs ?? {}),
          working_directory: directory,
          // Exactly what Laya saw, and the raw answers it gave.
          state: jev?._state ?? null,
          answers: jev?._answers
            ? { harm: jev._answers.harm ?? null, user_asked: jev._answers.user_asked ?? null, task_fit: jev._answers.task_fit ?? null }
            : null,
          stats: jev?.stats ?? null,
          jev_decision: jev?.valid ? jev.decision : null,
          effective_decision: effective.decision,
          source: effective.source,
          latency_ms: Date.now() - started,
          // Extra context, NOT sent to Laya: lets us re-run offline experiments over other slice
          // choices (opening / plan / tool calls) without re-collecting. Redacted; disable with
          // "captureSlices": false.
          ...(cfg.captureSlices === false
            ? {}
            : {
                slices: {
                  opening: redactText(ctx.slices?.opening ?? "") || null,
                  last_user: redactText(ctx.slices?.lastUser ?? "") || null,
                  agent_plan: redactText(ctx.slices?.agentPlan ?? "") || null,
                },
                recent_tool_calls: (ctx.recent_tool_calls ?? []).map((c) => redactText(c)),
              }),
        });
      }

      if (effective.decision === "allow") {
        output.status = "allow";
        return;
      }
      if (effective.decision === "deny") {
        output.status = "deny";
        return;
      }
      // ask: leave output.status as "ask" so OpenCode shows its normal once/always/reject prompt.
    },

    // The human's answer to the prompt is the ground-truth label. It arrives as an event, keyed by the
    // same request id we logged with the ask record.
    event: async ({ event }) => {
      if (!cfg.capture || event?.type !== "permission.replied") return;
      const p = event.properties ?? {};
      postFeedback(cfg, { kind: "reply", request_id: p.requestID ?? null, session_id: p.sessionID ?? null, reply: p.reply ?? null });
    },
  };
};
