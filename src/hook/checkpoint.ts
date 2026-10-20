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

/** PreToolUse output carrying the human's reply to a progress recap, or null when there is none */
export async function checkpointInstruction(
  input: Record<string, unknown>,
  client: Client,
): Promise<Record<string, unknown> | null> {
  const sessionId = input["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  // The main agent (no agent_id) is also held back while an answer is on its way as a message; a subagent's tools are not
  const main = input["agent_id"] === undefined;
  const taken = main
    ? await client.takeInstructionOrWaiting(sessionId, CHECKPOINT_TIMEOUT_MS)
    : await client.takeInstruction(sessionId, CHECKPOINT_TIMEOUT_MS).then((i) => (i ? { instruction: i } : null));
  if (taken && "waiting" in taken) {
    const what = taken.waiting.kind === "approve_plan" ? "Your plan in ukagai is not decided yet" : "Your question in ukagai is not answered yet";
    return denyOutput({ line: denyLine(`${what}: end your turn, the answer arrives as a message`), context: WAITING_CONTEXT });
  }
  const ins = taken?.instruction;
  if (!ins) return null;
  const text = ins.text.trim();
  if (ins.kind === "stop") {
    return denyOutput({
      line: denyLine("The human read your progress recap and asked you to stop"),
      context: text === "" ? STOP_REASON : `${STOP_REASON}\nThe human adds: ${text}`,
    });
  }
  if (text === "") return null;
  const lead = ins.about === "plan" ? PLAN_INSTRUCT_PREFIX : "[ukagai] The human read your progress recap and says:";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `${lead} ${text}\n${INSTRUCT_SUFFIX}`,
    },
  };
}
