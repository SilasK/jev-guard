// OpenCode plugin. `jev-guard install opencode` drops a one-line shim into ~/.config/opencode/plugins/ that re-exports this.
// tool.execute.before throws to block; permission.ask (only fires for tools you set to "ask" in opencode.json)
// lets jev-guard auto-approve the safe calls and keep the prompt for the risky ones; tool.execute.after flags results.
import { assessAction, scanContent, preview } from "./guard.js";

export const JevGuard = async ({ client, directory }) => {
  const toast = (message, variant = "warning") =>
    client?.tui?.showToast?.({ body: { title: "jev-guard", message, variant, duration: 8000 } }).catch(() => {});
  const failOpen = (err) => {
    toast(err.message, "error");
    if (process.env.JEV_GUARD_FAIL_CLOSED) throw new Error(`jev-guard unavailable: ${err.message}`);
    return null;
  };

  return {
    "tool.execute.before": async (input, output) => {
      const r = await assessAction({ tool: input.tool, input: output.args, cwd: directory, agent: "opencode" }).catch(failOpen);
      if (!r || r.level === "allow") return;
      if (r.level === "deny") throw new Error(r.message);
      toast(`${r.message} (set permission.${input.tool} to "ask" in opencode.json to get a real prompt)`);
    },

    "permission.ask": async (input, output) => {
      const args = { ...(input.metadata ?? {}), pattern: input.pattern, title: input.title };
      const r = await assessAction({ tool: input.type, input: args, cwd: directory, agent: "opencode" }).catch(failOpen);
      if (!r) return;
      output.status = r.level;  // allow → no prompt, ask → prompt, deny → refused
      if (r.level !== "allow") toast(r.message);
    },

    "tool.execute.after": async (input, output) => {
      const r = await scanContent({ text: output.output, tool: input.tool, source: preview(input.args, 120) }).catch(() => null);
      if (!r?.flagged) return;
      toast(r.message);
      output.output = `[${r.message}]\n\n${output.output}`;
    },
  };
};
