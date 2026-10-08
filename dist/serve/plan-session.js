import { open } from "node:fs/promises";
import { isClaudeTranscriptPath } from "../contract.js";
/**
 * Bytes read from the end, then from the start, of a transcript. Claude Code assigns the slug lazily, when the session first
 * enters plan mode: lines written before that have none, every later line carries it
 */
export const SLUG_SCAN_BYTES = 256 * 1024;
/** A session whose last event is older is not "writing a plan" any more */
export const PLAN_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** The top-level `slug` of the first transcript line that has one (a `slug` key nested in a tool input does not count) */
export function slugOfHead(text) {
    for (const line of text.split("\n")) {
        if (!line.includes('"slug"'))
            continue;
        try {
            const v = JSON.parse(line).slug;
            if (typeof v === "string" && v !== "")
                return v;
        }
        catch {
            // A line cut at the end of the scanned head, or not JSON
        }
    }
    return undefined;
}
/** `text` read from `start` of a file: the partial first line of a chunk that does not begin the file is dropped */
function completeLines(text, start) {
    if (start === 0)
        return text;
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
}
/**
 * Which live Claude Code session writes a plan file. Claude Code names the plan after the session's slug and stamps
 * `"slug":"<name>"` on every transcript line, so the session is the one whose transcript carries the plan's name.
 */
export class PlanSessions {
    listSessions;
    home;
    now;
    onSession;
    /** transcript path -> what its tail / head said at `size`. A found slug is kept for good; an unknown one is looked up again only when the file changed size (one tail read, the head only once) */
    slugs = new Map();
    /** plan name -> the session last found for it (undefined: looked up, none found) */
    seen = new Map();
    /** transcript path -> the read in flight (concurrent lookups of one transcript share it) */
    reading = new Map();
    constructor(listSessions, home, now = Date.now, 
    /** A plan that was looked up before now has a session (or another one): the UIs learn it without a file write */
    onSession) {
        this.listSessions = listSessions;
        this.home = home;
        this.now = now;
        this.onSession = onSession;
    }
    /** The session last found for a plan, without looking */
    cached(planName) {
        return this.seen.get(planName);
    }
    /** The plans last found for a session */
    plansOf(sessionId) {
        return [...this.seen].filter(([, id]) => id === sessionId).map(([name]) => name);
    }
    /** The session id for a plan file name (`<slug>.md`), or undefined */
    async find(planName) {
        const id = await this.lookup(planName);
        const had = this.seen.has(planName);
        const prev = this.seen.get(planName);
        this.seen.set(planName, id);
        if (had && id !== undefined && id !== prev)
            this.onSession?.(planName, id);
        return id;
    }
    async lookup(planName) {
        if (!planName.endsWith(".md"))
            return undefined;
        const slug = planName.slice(0, -3);
        for (const s of this.listSessions()) {
            if (s.state === "ended" || !s.transcript_path || !isClaudeTranscriptPath(s.transcript_path, this.home))
                continue;
            if (this.now() - Date.parse(s.last_event_at) > PLAN_SESSION_MAX_AGE_MS)
                continue;
            if ((await this.slugOf(s.transcript_path)) === slug)
                return s.session_id;
        }
        return undefined;
    }
    slugOf(path) {
        const known = this.slugs.get(path);
        if (known?.slug !== undefined)
            return Promise.resolve(known.slug);
        let job = this.reading.get(path);
        if (!job) {
            job = this.read(path).finally(() => this.reading.delete(path));
            this.reading.set(path, job);
        }
        return job;
    }
    async read(path) {
        try {
            const fh = await open(path, "r");
            try {
                const { size } = await fh.stat();
                const hit = this.slugs.get(path);
                // Still unknown: nothing new to find unless the file changed size
                if (hit && size === hit.size)
                    return undefined;
                let slug = await this.scan(fh, size, Math.max(0, size - SLUG_SCAN_BYTES));
                // The head never changes as the file grows: it is read once (a file up to one chunk long was read whole already)
                const headDone = hit?.headDone === true || size <= SLUG_SCAN_BYTES;
                if (slug === undefined && !headDone)
                    slug = await this.scan(fh, size, 0);
                if (size > 0)
                    this.slugs.set(path, { size, slug, headDone: true });
                return slug;
            }
            finally {
                await fh.close();
            }
        }
        catch {
            return undefined;
        }
    }
    /** The slug in the (at most SLUG_SCAN_BYTES long) chunk of the file that starts at `start` */
    async scan(fh, size, start) {
        const len = Math.min(size - start, SLUG_SCAN_BYTES);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        return slugOfHead(completeLines(buf.toString("utf8", 0, bytesRead), start));
    }
}
//# sourceMappingURL=plan-session.js.map