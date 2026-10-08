import { REPLY_PREFIX } from "../serve/terminal.js";
/** Chronological list for the overlay: the first instruction (full text), then the recent ones. `recent` overlaps `first` when the session is short */
export function historyItems(h, replies = []) {
    if (!h)
        return [];
    // A reply typed into the terminal is an ordinary user record in the transcript: its checkpoint row stands for it
    const typed = (e) => e.text.startsWith(REPLY_PREFIX);
    const rest = (h.first && h.recent.length >= h.total ? h.recent.slice(1) : h.recent).filter((e) => !typed(e));
    const later = [...rest.map((e) => ({ first: false, ...e })), ...replies].sort((a, b) => a.at.localeCompare(b.at));
    return [...(h.first && !typed(h.first) ? [{ first: true, ...h.first }] : []), ...later];
}
/** Whitespace collapsed to single spaces (one line) */
export const oneLine = (s) => s.replace(/\s+/g, " ").trim();
//# sourceMappingURL=history.js.map