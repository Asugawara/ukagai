import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_MESSAGE = 200;

let logPath: string | undefined;

/** Point the log at `<data-dir>/hook.log`. Until this is called, hookLog does nothing */
export function initHookLog(dataDir: string): void {
  logPath = join(dataDir, "hook.log");
}

/**
 * One JSON line per abnormal exit / retry. Ids, status and error text only: never the question, answer or explanation.
 * Never throws (fail open).
 */
export function hookLog(event: string, fields: Record<string, string | number | undefined> = {}): void {
  if (!logPath) return;
  try {
    const rec: Record<string, string | number> = { at: new Date().toISOString(), pid: process.pid, event };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      rec[k] = typeof v === "string" ? v.slice(0, MAX_MESSAGE) : v;
    }
    try {
      if (statSync(logPath).size > MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(logPath, JSON.stringify(rec) + "\n");
  } catch {
    // logging must never break the hook
  }
}
