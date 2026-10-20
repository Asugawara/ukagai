import { PLAN_INSTRUCT_PREFIX } from "../contract.js";
import type { Client } from "./client.js";
import { denyLine, denyOutput } from "./deny.js";

/** The common path is a single 404; the hook as a whole must stay well under a second */
export const CHECKPOINT_TIMEOUT_MS = 700;

const INSTRUCT_SUFFIX = "Follow this before continuing; do not ask for confirmation of this message.";
const STOP_REASON =
  "[ukagai] The human read your progress recap and asked you to stop. Do not run more tools: write a short status (done / in progress / next) and end your turn.";

const WAITING_CONTEXT =
  "[ukagai] Your question or plan in ukagai is still open: its answer has not reached you yet. Do not run tools now: end your turn. The answer will arrive as a message that starts with [ukagai].";

const ASK_REASON =
  "[ukagai] You chose auto mode when approving the plan: ukagai answers this prompt and switches the session to auto mode.";
const ASK_OUTPUT = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: ASK_REASON } };
/** Tools whose prompt the PermissionRequest hook can answer to switch modes; acceptEdits never prompts for these without the ask below */
const MODE_SWITCH_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * PreToolUse output carrying the human's reply to a progress recap, or null when there is none.
 * Also carries the plan-approval auto switch: Claude Code restores the pre-plan mode (often acceptEdits), where Edit/Write
 * never prompt, so on the first main-agent edit it asks (once per approval), which lets the PermissionRequest hook switch to auto
 */
export async function checkpointInstruction(
  input: Record<string, unknown>,
  client: Client,
): Promise<Record<string, unknown> | null> {
  const sessionId = input["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const tool = input["tool_name"];
  const mayAsk = typeof tool === "string" && MODE_SWITCH_TOOLS.has(tool) && input["agent_id"] === undefined;
  const mode = input["permission_mode"];
  const prompting = mode === "acceptEdits" || mode === "default";
  // The server answers true once per record, so an unanswered prompt is not repeated on every edit.
  // In auto the human already got what they wanted: drop the record rather than let it answer an unrelated prompt later
  // The main agent (no agent_id) is also held back while an answer is on its way as a message; a subagent's tools are not
  const main = input["agent_id"] === undefined;
  const [taken, ask] = await Promise.all([
    main
      ? client.takeInstructionOrWaiting(sessionId, CHECKPOINT_TIMEOUT_MS)
      : client.takeInstruction(sessionId, CHECKPOINT_TIMEOUT_MS).then((i) => (i ? { instruction: i } : null)),
    mayAsk && prompting
      ? client.askModeSwitch(sessionId, CHECKPOINT_TIMEOUT_MS)
      : mayAsk && mode === "auto"
        ? client.consumeModeSwitch(sessionId, CHECKPOINT_TIMEOUT_MS).then(() => false)
        : false,
  ]);
  if (taken && "waiting" in taken) {
    return denyOutput({ line: denyLine("Your question in ukagai is not answered yet: end your turn, the answer arrives as a message"), context: WAITING_CONTEXT });
  }
  const ins = taken?.instruction;
  if (!ins) return ask ? ASK_OUTPUT : null;
  const text = ins.text.trim();
  if (ins.kind === "stop") {
    return denyOutput({
      line: denyLine("The human read your progress recap and asked you to stop"),
      context: text === "" ? STOP_REASON : `${STOP_REASON}\nThe human adds: ${text}`,
    });
  }
  if (text === "") return ask ? ASK_OUTPUT : null;
  const lead = ins.about === "plan" ? PLAN_INSTRUCT_PREFIX : "[ukagai] The human read your progress recap and says:";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `${lead} ${text}\n${INSTRUCT_SUFFIX}`,
      ...(ask ? { permissionDecision: "ask", permissionDecisionReason: ASK_REASON } : {}),
    },
  };
}
