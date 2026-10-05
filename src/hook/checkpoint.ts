import { PLAN_INSTRUCT_PREFIX } from "../contract.js";
import type { Client } from "./client.js";

/** The common path is a single 404; the hook as a whole must stay well under a second */
export const CHECKPOINT_TIMEOUT_MS = 700;

const INSTRUCT_SUFFIX = "Follow this before continuing; do not ask for confirmation of this message.";
const STOP_REASON =
  "[ukagai] The human read your progress recap and asked you to stop. Do not run more tools: write a short status (done / in progress / next) and end your turn.";

/** PreToolUse output carrying the human's reply to a progress recap, or null when there is none */
export async function checkpointInstruction(
  input: Record<string, unknown>,
  client: Client,
): Promise<Record<string, unknown> | null> {
  const sessionId = input["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const ins = await client.takeInstruction(sessionId, CHECKPOINT_TIMEOUT_MS);
  if (!ins) return null;
  const text = ins.text.trim();
  if (ins.kind === "stop") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: text === "" ? STOP_REASON : `${STOP_REASON}\nThe human adds: ${text}`,
      },
    };
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
