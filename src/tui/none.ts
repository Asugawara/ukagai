import type { MessageKey } from "./i18n.js";

/** Reasons offered under "None of these…". `value` is what the agent receives (always English); `label` is the display string. */
export const NONE_TYPES: { value: string; label: MessageKey }[] = [
  { value: "Missing option", label: "none_missing" },
  { value: "Wrong premise", label: "none_premise" },
  { value: "Need more evidence", label: "none_evidence" },
  { value: "Ask me later", label: "none_later" },
];

/** `None of these — <type>: <text>` (the `: <text>` part only when a note was typed) */
export function noneAnswer(index: number, text: string): string {
  const type = NONE_TYPES[Math.max(0, Math.min(NONE_TYPES.length - 1, index))]!.value;
  const note = text.trim();
  return `None of these — ${type}${note ? `: ${note}` : ""}`;
}
