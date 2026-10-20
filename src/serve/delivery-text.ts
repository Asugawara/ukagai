import { deliveryRef, type Decision } from "../contract.js";

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
