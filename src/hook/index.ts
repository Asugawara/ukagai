import { PreToolUseInput } from "../contract.js";
import { Client } from "./client.js";
import { observeDecisionTool, observedEvent, permissionRequest, sessionContext } from "./context-hooks.js";
import { planContext } from "./plan-context.js";
import { checkpointInstruction } from "./checkpoint.js";
import { openGuard } from "./open-guard.js";
import { codexInput, codexPermissionRequest, codexPreToolUse, codexStop } from "./codex.js";
import { handleDecision } from "./decision.js";
import { hookLog, initHookLog } from "./log.js";
import { parseArgs } from "./options.js";

const DECISION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function write(out: Record<string, unknown> | null | undefined): void {
  if (out) process.stdout.write(JSON.stringify(out));
}

/** Fail open: swallow every exception and always return 0 */
export async function run(argv: string[]): Promise<number> {
  process.stdout.on("error", () => {});
  const startedAt = Date.now();
  let sessionId: string | undefined;
  try {
    // Kill switch: a global hook can be silenced for a test session
    if (process.env["UKAGAI_DISABLE"] === "1") return 0;
    const opts = parseArgs(argv);
    initHookLog(opts.dataDir);
    const raw: unknown = JSON.parse(await readStdin());
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return 0;
    if (opts.agent === "codex") return await runCodex(codexInput(raw as Record<string, unknown>), opts, startedAt);
    const input = raw as Record<string, unknown>;
    if (typeof input["session_id"] === "string") sessionId = input["session_id"];
    const ev = input["hook_event_name"];
    const tool = input["tool_name"];
    const client = new Client(opts.server, opts.dataDir);
    const isDecisionTool = typeof tool === "string" && DECISION_TOOLS.has(tool);

    if (opts.planContext) {
      if (!opts.observe) write(planContext(input, opts.dataDir));
    } else if (opts.checkpoint) {
      if (ev === "PreToolUse" && !isDecisionTool) {
        let denied: Record<string, unknown> | null = null;
        try {
          denied = openGuard(input, opts.dataDir);
        } catch {
          // fail open
        }
        write(denied ?? (await checkpointInstruction(input, client)));
      }
    } else if (opts.observe && isDecisionTool && (ev === "PreToolUse" || ev === "PostToolUse")) {
      await observeDecisionTool(input, client);
    } else if (ev === "PreToolUse" && isDecisionTool) {
      const parsed = PreToolUseInput.safeParse(input);
      if (parsed.success) write(await handleDecision(parsed.data, opts, client, startedAt));
    } else if (ev === "PermissionRequest") {
      write(await permissionRequest(input, client));
    } else if (ev === "SessionStart" || ev === "SubagentStart") {
      write(await sessionContext(input, opts));
    } else {
      await observedEvent(input, client, opts.dataDir);
    }
  } catch (err) {
    hookLog("hook_exception", {
      session_id: sessionId,
      elapsed_s: Math.round((Date.now() - startedAt) / 100) / 10,
      message: err instanceof Error ? err.message : String(err),
    });
    try {
      process.stderr.write(`ukagai hook: ${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // nothing to do
    }
  }
  return 0;
}

/** Codex events. Same dispatch as Claude, with the Codex-specific tool and Stop handling */
async function runCodex(input: Record<string, unknown>, opts: ReturnType<typeof parseArgs>, startedAt: number): Promise<number> {
  const ev = input["hook_event_name"];
  const client = new Client(opts.server, opts.dataDir);
  if (ev === "PreToolUse") {
    if (input["tool_name"] === "request_user_input" && !opts.observe) write(await codexPreToolUse(input, opts, client, startedAt));
  } else if (ev === "PermissionRequest") {
    if (!opts.observe) write(await codexPermissionRequest(input, opts, client, startedAt));
  } else if (ev === "SessionStart") {
    write(await sessionContext(input, opts));
  } else if (ev === "Stop") {
    write(await codexStop(input, opts, client, startedAt));
  } else {
    await observedEvent(input, client, opts.dataDir);
  }
  return 0;
}
