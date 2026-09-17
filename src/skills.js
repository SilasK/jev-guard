// Sweep the instruction files an agent will obey — skills, plugins, rules, CLAUDE.md/AGENTS.md — for behavior their
// installer would not expect. Results are cached by content hash, so a session-start sweep costs nothing until a
// file changes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { INSTRUCTION_FILE, judgeInstructions, scanInstructions, thresholds } from "./guard.js";

const CACHE = () => process.env.JEV_GUARD_SCAN_CACHE ?? join(homedir(), ".jev-guard", "scan-cache.json");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "logos", "video", ".tmp", "tmp", "worktrees", "vendor_imports", "marketplaces", "repos"]);
const MAX_DEPTH = 7;

export function userRoots(home = homedir()) {
  return [".claude/skills", ".claude/plugins", ".claude/CLAUDE.md", ".codex", ".gemini/extensions", ".pi/agent", ".cursor", ".copilot", ".config/opencode", ".agents"].map((p) => join(home, p));
}
export function projectRoots(cwd = process.cwd()) {
  return ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".cursor", ".opencode", ".codex", ".gemini", ".agents", ".github/copilot-instructions.md", ".github/hooks", "skills"].map((p) => join(cwd, p));
}

export function findInstructionFiles(roots) {
  const out = new Set();
  const walk = (p, depth) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) { if (INSTRUCTION_FILE.test(p) || (/\.md$/i.test(p) && depth === 0)) out.add(p); return; }
    if (!st.isDirectory() || depth > MAX_DEPTH) return;
    for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(join(p, name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return [...out].sort();
}

/** @returns {Promise<Array<{file: string, flagged: boolean, kind?: string, p?: number, cached: boolean, error?: string}>>} */
export async function scanFiles(files, opts = {}, { concurrency = 6 } = {}) {
  const cache = readCache();
  const t = thresholds(opts.env ?? process.env);
  const results = [];
  let dirty = false;
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      let text;
      try { text = readFileSync(file, "utf8"); } catch (e) { results.push({ file, flagged: false, cached: false, error: e.message }); continue; }
      if (text.length < 200) continue;
      const key = createHash("sha1").update(text).digest("hex");
      // the cache keeps Jev's answer (kind, p); the verdict is recomputed so threshold changes apply to old scans
      if (cache[key]) { results.push({ file, ...cache[key], flagged: judgeInstructions(cache[key].kind, cache[key].p, t), cached: true }); continue; }
      try {
        const r = await scanInstructions({ text, source: file }, opts);
        const entry = { kind: r.kind, p: +r.p.toFixed(2), at: Date.now() };
        cache[key] = entry; dirty = true;
        results.push({ file, ...entry, flagged: r.flagged, message: r.message, cached: false });
        if (++scanned % 25 === 0) writeCache(cache);  // an interrupted sweep keeps what it paid for
      } catch (e) { results.push({ file, flagged: false, cached: false, error: e.message }); }
    }
  };
  let scanned = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  if (dirty) writeCache(cache);
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function readCache() { try { return JSON.parse(readFileSync(CACHE(), "utf8")); } catch { return {}; } }
function writeCache(cache) {
  const entries = Object.entries(cache).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, 5000);  // ponytail: cap, no LRU
  mkdirSync(dirname(CACHE()), { recursive: true, mode: 0o700 });
  writeFileSync(CACHE(), JSON.stringify(Object.fromEntries(entries)));
}
