import { appendFileSync, renameSync, statSync } from "node:fs";

const MAX_BYTES = 1024 * 1024;
const MAX_MESSAGE = 200;

/**
 * One JSON line (`at`, `pid`, `event`, then the fields; strings cut at 200 characters) appended to `path`,
 * which is rotated to `<path>.1` past 1 MB. Never throws: logging must not break its caller.
 */
export function appendLogLine(path: string, event: string, fields: Record<string, string | number | undefined> = {}): void {
  try {
    const rec: Record<string, string | number> = { at: new Date().toISOString(), pid: process.pid, event };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      rec[k] = typeof v === "string" ? v.slice(0, MAX_MESSAGE) : v;
    }
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(path, JSON.stringify(rec) + "\n");
  } catch {
    // swallowed on purpose
  }
}
