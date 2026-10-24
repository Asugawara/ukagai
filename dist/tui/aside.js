import { t } from "./i18n.js";
import { BOLD, CYAN, DIM, RED, RESET, YELLOW, renderMarkdown } from "./markdown.js";
import { truncate, width, wrap } from "./width.js";
/** Show only the latest entry of each `regenerate_of` chain */
export function visibleEntries(entries) {
    const replaced = new Set(entries.flatMap((e) => (e.regenerate_of ? [e.regenerate_of] : [])));
    return entries.filter((e) => !replaced.has(e.id));
}
/** The 3 fixed suggestions of an empty thread (no model call) */
export function suggestions(lang, kind, label) {
    const keys = kind === "plan" ? ["aside_sugg_p1", "aside_sugg_p2", "aside_sugg_p3"] : ["aside_sugg_q1", "aside_sugg_q2", "aside_sugg_q3"];
    return keys.map((k) => t(lang, k, { label }));
}
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** `32k tokens · $0.004` (the cost only when the server sent it); input_tokens is already the total input */
export function usageText(lang, u) {
    const total = u.input_tokens + u.output_tokens;
    return [t(lang, "aside_tokens", { n: kTokens(total) }), u.cost_usd !== undefined ? `$${u.cost_usd.toFixed(3)}` : ""].filter(Boolean).join(" · ");
}
/** `Read 2 files · Ran 1 command` */
export function traceText(lang, trace) {
    const n = (kind) => trace.filter((x) => x.kind === kind).length;
    const part = (kind, key) => {
        const c = n(kind);
        return c ? t(lang, c === 1 ? `aside_${key}_one` : `aside_${key}`, { n: c }) : "";
    };
    return [part("read", "read"), part("search", "search"), part("command", "command"), part("tool", "tool")].filter(Boolean).join(" · ");
}
/** Right-align wrapped text; `bar` closes each row (the user's side) */
function right(lines, w, bar) {
    return lines.map((l) => `${" ".repeat(Math.max(0, w - width(l) - 2))}${l} ${bar}`);
}
/** Right-align lines that open with a bar (the quote) */
function rightLead(lines, w, bar) {
    return lines.map((l) => `${" ".repeat(Math.max(0, w - width(l) - 2))}${bar} ${l}`);
}
/** The thread as lines wrapped to w, newest last */
export function threadLines(a, w) {
    const lang = a.lang;
    const out = [];
    if (!a.available) {
        out.push(...wrap(`${YELLOW}${a.reason ?? ""}${RESET}`, w));
        return out;
    }
    if (!a.entries.length) {
        out.push(`${BOLD}${t(lang, "aside_greeting")}${RESET}`, "");
        a.suggestions.forEach((s, i) => out.push(...wrap(`${CYAN}${i + 1}${RESET} ${s}`, w)));
        return out;
    }
    let prev;
    a.entries.forEach((e, i) => {
        if (prev !== undefined && e.decision_id !== prev) {
            const title = truncate(e.decision_title ?? e.decision_id, Math.max(4, w - 4));
            out.push("", `${DIM}── ${title} ──${RESET}`);
        }
        prev = e.decision_id;
        if (i > 0)
            out.push("");
        if (e.quote) {
            const q = wrap(e.quote.text.replace(/\s+/g, " "), Math.max(8, w - 6));
            const shown = q.slice(0, 2);
            if (q.length > 2)
                shown[1] = `${truncate(shown[1], Math.max(1, w - 9))}…`;
            out.push(...rightLead(shown.map((l) => `${DIM}${l}${RESET}`), w, `${DIM}┃${RESET}`));
        }
        out.push(...right(wrap(e.question, Math.max(8, w - 6)), w, `${CYAN}▌${RESET}`));
        out.push("");
        const trace = traceText(lang, e.trace);
        if (e.status === "running" && !e.answer && !trace)
            out.push(`${CYAN}●${RESET} ${DIM}${t(lang, "aside_thinking")}${RESET}`);
        else if (trace)
            out.push(`${CYAN}●${RESET} ${DIM}${truncate(trace, Math.max(1, w - 2))}${RESET}`);
        if (e.answer) {
            const body = renderMarkdown(e.answer, w, { lang });
            if (e.status === "running")
                body[body.length - 1] = `${body.at(-1) ?? ""} ${CYAN}●${RESET}`;
            out.push(...body);
        }
        if (e.status === "error") {
            for (const l of wrap(`${RED}${e.error ?? "error"}${RESET}`, w))
                out.push(l);
            if (i === a.entries.length - 1 && a.text === "")
                out.push(`${DIM}${t(lang, "aside_retry")}${RESET}`);
        }
        if (e.status === "cancelled")
            out.push(`${DIM}${t(lang, "aside_stopped")}${RESET}`);
        if (e.status === "done" && e.usage)
            out.push(`${DIM}${usageText(lang, e.usage)}${RESET}`);
    });
    return out;
}
/** The input rows under the thread: the attached quote (one row), then the prompt (the tail of the text when it is longer than the row) */
export function inputLines(a, w) {
    const out = [];
    if (a.quote)
        out.push(truncate(`${DIM}${t(a.lang, "aside_quote", { text: a.quote.text.replace(/\s+/g, " ") })}${RESET}`, w));
    const room = Math.max(1, w - 3);
    let text = Array.from(a.text);
    while (text.length > 1 && width(text.join("")) > room)
        text = text.slice(1);
    out.push(`${CYAN}›${RESET} ${text.join("")}▏`);
    return out;
}
//# sourceMappingURL=aside.js.map