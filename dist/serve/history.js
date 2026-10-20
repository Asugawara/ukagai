import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { TRANSCRIPT_MAX_BYTES, isAllowedTranscriptPath } from "../contract.js";
export const HISTORY_MAX_BYTES = TRANSCRIPT_MAX_BYTES;
export const FIRST_MAX = 4000;
export const RECENT_MAX = 500;
export const RECENT_COUNT = 20;
const CACHE_TTL_MS = 5000;
const CACHE_MAX_ENTRIES = 50;
const cache = new Map();
const PASTED_TAG = /<\/?pasted_content\b[^>]*>/g;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Harness notices stored as `user` records (background task / monitor / subagent completions), not typed by a human */
const TASK_NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;
/** Lines produced by slash commands, local commands and `!` shell commands (input and output), not instructions to the agent */
const COMMAND_MARKER = /<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
const INTERRUPT_MARKER = /^\[Request interrupted by user/;
function cut(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
}
function originKind(rec) {
    const o = rec.origin;
    return typeof o === "object" && o !== null ? o.kind : undefined;
}
/** All text of a transcript `user` record (a string content, or the text blocks) */
function recordText(rec) {
    const msg = rec.message;
    if (!msg)
        return "";
    if (typeof msg.content === "string")
        return msg.content;
    if (!Array.isArray(msg.content))
        return "";
    const texts = [];
    for (const block of msg.content) {
        const b = block;
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
            texts.push(b.text);
    }
    return texts.join("\n");
}
/** The most a delivery check reads (what was appended since the claim is small; this only bounds a lost offset) */
const DELIVERY_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Whether the transcript has, from byte `offset` on, a message a plugin submitted (`origin.kind` "plugin") carrying
 * `[ukagai] (ref <ref>)`: the proof that a delivery reached the conversation. Unreadable or missing means false (a double
 * delivery is better than a lost answer). `path` is a decision's transcript, already checked when the decision was registered. Reads only what was appended since `offset`, at most 8 MiB
 */
export function transcriptHasDelivery(path, offset, ref) {
    let fd;
    try {
        const size = statSync(path).size;
        const start = Math.max(0, Math.min(offset, size), size - DELIVERY_SCAN_MAX_BYTES);
        if (size <= start)
            return false;
        fd = openSync(path, "r");
        const buf = Buffer.alloc(size - start);
        const n = readSync(fd, buf, 0, buf.length, start);
        const needle = `[ukagai] (ref ${ref})`;
        for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
            if (!line.includes('"type":"user"') || !line.includes(ref))
                continue;
            try {
                const rec = JSON.parse(line);
                if (rec.type === "user" && originKind(rec) === "plugin" && recordText(rec).includes(needle))
                    return true;
            }
            catch {
                // a broken line, or the first one cut by the offset
            }
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** The human-typed text of a transcript `user` record, or undefined if the line is not a human instruction */
function humanText(rec) {
    // Sidechains are subagent prompts, meta records are harness text (caveats, agent messages), compact summaries are written by the model
    if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true)
        return undefined;
    // A message a plugin submitted (the ukagai mod delivering an answer) is not something the human typed
    if (originKind(rec) === "plugin")
        return undefined;
    const msg = rec.message;
    if (!msg || msg.role !== "user")
        return undefined;
    let raw;
    if (typeof msg.content === "string")
        raw = msg.content;
    else if (Array.isArray(msg.content)) {
        const texts = [];
        for (const block of msg.content) {
            if (typeof block !== "object" || block === null)
                continue;
            const b = block;
            if (b.type === "text" && typeof b.text === "string")
                texts.push(b.text);
        }
        if (texts.length === 0)
            return undefined; // e.g. tool_result only
        raw = texts.join("\n");
    }
    else
        return undefined;
    if (COMMAND_MARKER.test(raw))
        return undefined;
    const text = raw.replace(SYSTEM_REMINDER, "").replace(TASK_NOTIFICATION, "").replace(PASTED_TAG, "").trim();
    if (!text || INTERRUPT_MARKER.test(text))
        return undefined;
    return text;
}
async function scan(path, maxBytes) {
    const stream = createReadStream(path, { encoding: "utf8", end: maxBytes - 1 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let ai_title;
    let total = 0;
    let first;
    let recent = [];
    try {
        for await (const line of rl) {
            // Cheap pre-filter: most lines are assistant output and tool results
            const isUser = line.includes('"type":"user"');
            if (!isUser && !line.includes('"type":"ai-title"'))
                continue;
            let obj;
            try {
                obj = JSON.parse(line);
            }
            catch {
                continue; // broken line, or the last line cut by the byte limit
            }
            if (typeof obj !== "object" || obj === null)
                continue;
            const rec = obj;
            if (rec.type === "ai-title") {
                if (typeof rec.aiTitle === "string" && rec.aiTitle)
                    ai_title = rec.aiTitle;
                continue;
            }
            if (rec.type !== "user")
                continue;
            const text = humanText(rec);
            if (text === undefined)
                continue;
            const at = typeof rec.timestamp === "string" ? rec.timestamp : "";
            total++;
            if (!first)
                first = { at, text: cut(text, FIRST_MAX) };
            recent.push({ at, text: cut(text, RECENT_MAX) });
            if (recent.length > RECENT_COUNT * 2)
                recent = recent.slice(-RECENT_COUNT);
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    return { ...(ai_title ? { ai_title } : {}), total, ...(first ? { first } : {}), recent: recent.slice(-RECENT_COUNT) };
}
export async function collectHistory(session, opts = {}) {
    const home = opts.home ?? homedir();
    const now = opts.now ?? Date.now;
    const empty = { session_id: session.session_id, total: 0, first: null, recent: [] };
    // Codex rollout format not examined yet: no history
    if (session.agent === "codex")
        return empty;
    const path = session.transcript_path;
    if (!isAllowedTranscriptPath(path, home))
        return empty;
    let mtimeMs;
    try {
        const st = statSync(path);
        if (!st.isFile())
            return empty;
        mtimeMs = st.mtimeMs;
    }
    catch {
        return empty;
    }
    const key = `${path}\0${mtimeMs}\0${session.session_id}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS)
        return hit.value;
    let value;
    try {
        const r = await scan(path, opts.maxBytes ?? HISTORY_MAX_BYTES);
        value = { session_id: session.session_id, ...(r.ai_title ? { ai_title: r.ai_title } : {}), total: r.total, first: r.first ?? null, recent: r.recent };
    }
    catch {
        return empty;
    }
    cache.set(key, { at: now(), value });
    if (cache.size > CACHE_MAX_ENTRIES)
        cache.delete(cache.keys().next().value);
    return value;
}
//# sourceMappingURL=history.js.map