import { open } from "node:fs/promises";
import { isClaudeTranscriptPath, type SessionSummary } from "../contract.js";

/** Only the head of a transcript is read: every line carries the session's slug */
export const SLUG_SCAN_BYTES = 256 * 1024;
/** A session whose last event is older is not "writing a plan" any more */
export const PLAN_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The top-level `slug` of the first transcript line that has one (a `slug` key nested in a tool input does not count) */
export function slugOfHead(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.includes('"slug"')) continue;
    try {
      const v = (JSON.parse(line) as { slug?: unknown }).slug;
      if (typeof v === "string" && v !== "") return v;
    } catch {
      // A line cut at the end of the scanned head, or not JSON
    }
  }
  return undefined;
}

type Entry = { size: number; slug: string | undefined };

/**
 * Which live Claude Code session writes a plan file. Claude Code names the plan after the session's slug and stamps
 * `"slug":"<name>"` on every transcript line, so the session is the one whose transcript carries the plan's name.
 */
export class PlanSessions {
  /** transcript path -> what its head said at `size`. A found slug is kept for good; an unknown one is looked up again only when the file grew within the scanned head */
  private slugs = new Map<string, Entry>();
  /** transcript path -> the read in flight (concurrent lookups of one transcript share it) */
  private reading = new Map<string, Promise<string | undefined>>();

  constructor(
    private listSessions: () => SessionSummary[],
    private home: string,
    private now: () => number = Date.now,
  ) {}

  /** The session id for a plan file name (`<slug>.md`), or undefined */
  async find(planName: string): Promise<string | undefined> {
    if (!planName.endsWith(".md")) return undefined;
    const slug = planName.slice(0, -3);
    for (const s of this.listSessions()) {
      if (s.state === "ended" || !s.transcript_path || !isClaudeTranscriptPath(s.transcript_path, this.home)) continue;
      if (this.now() - Date.parse(s.last_event_at) > PLAN_SESSION_MAX_AGE_MS) continue;
      if ((await this.slugOf(s.transcript_path)) === slug) return s.session_id;
    }
    return undefined;
  }

  private slugOf(path: string): Promise<string | undefined> {
    const known = this.slugs.get(path);
    if (known?.slug !== undefined) return Promise.resolve(known.slug);
    let job = this.reading.get(path);
    if (!job) {
      job = this.read(path).finally(() => this.reading.delete(path));
      this.reading.set(path, job);
    }
    return job;
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      const fh = await open(path, "r");
      try {
        const { size } = await fh.stat();
        const hit = this.slugs.get(path);
        // Still unknown: nothing new to find unless the file grew and the head is not full yet
        if (hit && (size === hit.size || hit.size >= SLUG_SCAN_BYTES)) return undefined;
        const buf = Buffer.alloc(Math.min(size, SLUG_SCAN_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const slug = slugOfHead(buf.toString("utf8", 0, bytesRead));
        if (size > 0) this.slugs.set(path, { size, slug });
        return slug;
      } finally {
        await fh.close();
      }
    } catch {
      return undefined;
    }
  }
}
