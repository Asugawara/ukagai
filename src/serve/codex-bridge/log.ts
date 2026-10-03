import { join } from "node:path";
import { appendLogLine } from "../../log.js";

export type BridgeLog = (event: string, fields?: Record<string, string | number | undefined>) => void;

/**
 * `<data-dir>/codex-bridge.log`: one JSON line per connection event / decision step, same manner as hook.log.
 * Ids, status and error text only: never a plan, answer or explanation. Never throws.
 */
export function createBridgeLog(dataDir: string): BridgeLog {
  const path = join(dataDir, "codex-bridge.log");
  return (event, fields) => appendLogLine(path, event, fields);
}
