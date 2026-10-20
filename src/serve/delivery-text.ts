import { deliveryRef, PLAN_INSTRUCT_PREFIX, type Decision, type Instruction } from "../contract.js";
import { planInstructReason, planRejectedNoReason } from "../hook/decision.js";
import { REPLY_PREFIX } from "./terminal.js";

/** The hook's texts start with `[ukagai] `: the delivery text has its own lead, so only the body is used */
const body = (text: string): string => text.replace(/^\[ukagai\] /, "");

/**
 * The text the ukagai mod submits as a message once the human answered a decision registered for message delivery.
 * It always starts with `[ukagai] (ref <8 chars>) `: the hook reads the ref from the prompt, the server matches it to the decision.
 * Pure: the mod carries the string unchanged, so the wording is fixed by tests here and not in the mod.
 */
export function deliveryText(d: Pick<Decision, "id" | "kind" | "response">): string {
  const lead = `[ukagai] (ref ${deliveryRef(d.id)}) `;
  const r = d.response;
  const answers = r?.answers;
  if (d.kind === "answer_question" && answers) {
    // One line per question, in the order of `answers`. Both sides are JSON-quoted: newlines, quotes, multiSelect lists and
    // the "None of these — " / "Cannot answer — " answers go through unchanged and cannot be taken for another line
    const lines = Object.entries(answers).map(([q, a]) => `- ${JSON.stringify(q)}: ${JSON.stringify(a)}`);
    return `${lead}The human answered your question in the ukagai GUI:\n${lines.join("\n")}`;
  }
  if (d.kind === "approve_plan" && r) {
    // The approval is a grant for the same plan: the re-called ExitPlanMode is let through (and switched to auto when asked)
    if (r.instruct === true) return lead + body(planInstructReason(r.text ?? ""));
    if (r.approve === true) {
      return `${lead}The human approved your plan in the ukagai GUI. Call ExitPlanMode once more with the same plan, without editing the plan file first; it will be allowed.`;
    }
    if (r.approve === false) {
      const reason = r.reason?.trim();
      return reason
        ? `${lead}The human rejected your plan in the ukagai GUI: ${reason}\nYou are still in plan mode: revise the plan file, then call ExitPlanMode again.`
        : lead + body(planRejectedNoReason());
    }
  }
  return `${lead}The human answered in the ukagai GUI.`;
}

/**
 * The text the mod submits for an instruction (a progress checkpoint reply or a plan instruction): the same prefix the terminal line
 * has, behind the ref. `id` is the inbox item's id. Newlines in the human's text stay (a message is not a single terminal line).
 */
export function instructionText(id: string, ins: Pick<Instruction, "text" | "about">): string {
  return instructionParts(id, [ins]);
}

/** Several texts in one message: the ref once, then each text behind its own prefix, one per line block */
export function instructionParts(id: string, parts: Pick<Instruction, "text" | "about">[]): string {
  // The message already starts with `[ukagai] (ref …)`: the inner tag of each prefix is dropped
  const texts = parts.map((p) => `${body(p.about === "plan" ? PLAN_INSTRUCT_PREFIX : REPLY_PREFIX)} ${p.text.trim()}`).join("\n");
  return `[ukagai] (ref ${deliveryRef(id)}) ${texts}`;
}
