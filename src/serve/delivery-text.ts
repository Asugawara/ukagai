import { deliveryRef, PLAN_INSTRUCT_PREFIX, type Decision, type Instruction } from "../contract.js";
import { REPLY_PREFIX } from "./terminal.js";

/**
 * The text the ukagai mod submits as a message once the human answered a decision registered for message delivery.
 * It always starts with `[ukagai] (ref <8 chars>) `: the hook reads the ref from the prompt, the server matches it to the decision.
 * Pure: the mod carries the string unchanged, so the wording is fixed by tests here and not in the mod.
 */
export function deliveryText(d: Pick<Decision, "id" | "kind" | "response">): string {
  const lead = `[ukagai] (ref ${deliveryRef(d.id)}) `;
  const answers = d.response?.answers;
  if (d.kind === "answer_question" && answers) {
    // One line per question, in the order of `answers`. Both sides are JSON-quoted: newlines, quotes, multiSelect lists and
    // the "None of these — " / "Cannot answer — " answers go through unchanged and cannot be taken for another line
    const lines = Object.entries(answers).map(([q, a]) => `- ${JSON.stringify(q)}: ${JSON.stringify(a)}`);
    return `${lead}The human answered your question in the ukagai GUI:\n${lines.join("\n")}`;
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
  const body = parts.map((p) => `${p.about === "plan" ? PLAN_INSTRUCT_PREFIX : REPLY_PREFIX} ${p.text.trim()}`).join("\n");
  return `[ukagai] (ref ${deliveryRef(id)}) ${body}`;
}
