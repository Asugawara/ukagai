import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_MESSAGE = 200;

export type BridgeLog = (event: string, fields?: Record<string, string | number | undefined>) => void;

/**
 * `<data-dir>/codex-bridge.log`: one JSON line per connection event / decision step, same manner as hook.log.
 * Ids, status and error text only: never a plan, answer or explanation. Never throws.
 */
export function createBridgeLog(dataDir: string): BridgeLog {
  const path = join(dataDir, "codex-bridge.log");
  return (event, fields = {}) => {
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
      // logging must never break serve
    }
  };
}
