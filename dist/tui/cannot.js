/** Reasons offered under "Can't answer this…". `value` is what the agent receives (always English); `label` is the display string. */
export const CANNOT_REASONS = [
    { value: "Undefined terms", label: "cannot_terms" },
    { value: "Unclear", label: "cannot_unclear" },
    { value: "Too much at once", label: "cannot_much" },
];
/** Index of "Undefined terms" in CANNOT_REASONS */
export const CANNOT_TERMS = 0;
/** The initial reason: Undefined terms when suspicious tokens were found, else Unclear */
export const defaultCannotReason = (coined) => (coined.length ? CANNOT_TERMS : 1);
/** The picker's rows top to bottom: each reason, with the terms checklist directly under Undefined terms while that reason is in force */
export function cannotRows(index, termCount) {
    const rows = [];
    CANNOT_REASONS.forEach((_, i) => {
        rows.push({ kind: "reason", index: i });
        if (i === CANNOT_TERMS && index === CANNOT_TERMS)
            for (let j = 0; j < termCount; j++)
                rows.push({ kind: "term", index: j });
    });
    return rows;
}
/**
 * `Cannot answer — <reason>: <detail>`. For Undefined terms the detail is the checked terms plus any comma-separated
 * terms typed in the note; with none of them there is nothing to send (null). For the others the detail is the note (may be empty).
 */
export function cannotAnswer(index, terms, note) {
    const reason = CANNOT_REASONS[Math.max(0, Math.min(CANNOT_REASONS.length - 1, index))].value;
    const text = note.trim();
    if (index === CANNOT_TERMS) {
        const typed = text.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
        const all = [...new Set([...terms, ...typed])];
        return all.length ? `Cannot answer — ${reason}: ${all.join(", ")}` : null;
    }
    return `Cannot answer — ${reason}${text ? `: ${text}` : ""}`;
}
//# sourceMappingURL=cannot.js.map