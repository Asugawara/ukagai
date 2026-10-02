import { PreToolUseInput } from "../contract.js";
import { Client } from "./client.js";
import { observeDecisionTool, observedEvent, permissionRequest, sessionContext, stopDecision } from "./context-hooks.js";
import { handleDecision } from "./decision.js";
import { parseArgs } from "./options.js";

/** Stop hook 全体の上限 */
const STOP_TOTAL_MS = 1900;
const DECISION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function write(out: Record<string, unknown> | null | undefined): void {
  if (out) process.stdout.write(JSON.stringify(out));
}

/** フェイルオープン: どの経路でも例外は握りつぶし、常に 0 を返す */
export async function run(argv: string[]): Promise<number> {
  process.stdout.on("error", () => {});
  const startedAt = Date.now();
  try {
    const opts = parseArgs(argv);
    const raw: unknown = JSON.parse(await readStdin());
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return 0;
    const input = raw as Record<string, unknown>;
    const ev = input["hook_event_name"];
    const tool = input["tool_name"];
    const client = new Client(opts.server, opts.dataDir);
    const isDecisionTool = typeof tool === "string" && DECISION_TOOLS.has(tool);

    if (opts.observe && isDecisionTool && (ev === "PreToolUse" || ev === "PostToolUse")) {
      await observeDecisionTool(input, client);
    } else if (ev === "PreToolUse" && isDecisionTool) {
      const parsed = PreToolUseInput.safeParse(input);
      if (parsed.success) write(await handleDecision(parsed.data, opts, client, startedAt));
    } else if (ev === "PermissionRequest") {
      write(await permissionRequest(input, client));
    } else if (ev === "SessionStart" || ev === "SubagentStart") {
      write(await sessionContext(input, opts));
    } else if (ev === "Stop") {
      const out = opts.observe ? null : stopDecision(input);
      await Promise.race([observedEvent(input, client), new Promise<void>((r) => setTimeout(r, STOP_TOTAL_MS).unref())]);
      write(out);
    } else {
      await observedEvent(input, client);
    }
  } catch (err) {
    try {
      process.stderr.write(`ukagai hook: ${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // 何もしない
    }
  }
  return 0;
}
