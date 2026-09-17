// pi extension: block/confirm dangerous tool calls, flag AI-directed text in tool results.
// Load with `pi -e ./extensions/jev-guard.ts`, `jev-guard install pi`, or `pi install git:github.com/leepokai/jev-guard`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessAction, scanContent, collectText } from "../src/guard.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    let r;
    try {
      r = await assessAction({ tool: event.toolName, input: event.input, cwd: ctx.cwd, agent: "pi" }, { signal: ctx.signal });
    } catch (err) {
      ctx.ui.notify(`jev-guard: ${(err as Error).message}`, "warning");
      return process.env.JEV_GUARD_FAIL_CLOSED ? { block: true, reason: `jev-guard unavailable: ${(err as Error).message}` } : undefined;
    }
    if (!r || r.level === "allow") return;
    if (r.level === "deny") return { block: true, reason: r.message };
    if (!ctx.hasUI) return { block: true, reason: `${r.message} (no UI to ask for approval, so blocked)` };
    const ok = await ctx.ui.confirm("jev-guard: approve this tool call?", r.message);
    if (!ok) return { block: true, reason: `User rejected: ${r.message}` };
  });

  pi.on("tool_result", async (event, ctx) => {
    let r;
    try {
      r = await scanContent({ text: collectText(event.content), tool: event.toolName, source: (event.input as any)?.url ?? (event.input as any)?.path }, { signal: ctx.signal });
    } catch (err) {
      ctx.ui.notify(`jev-guard: ${(err as Error).message}`, "warning");
      return;
    }
    if (!r?.flagged) return;
    ctx.ui.notify(r.message, "warning");
    return { content: [{ type: "text", text: `[${r.message}]` }, ...event.content] };
  });
}
