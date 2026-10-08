import { join } from "node:path";
import { appendLogLine } from "../../log.js";
/**
 * `<data-dir>/codex-bridge.log`: one JSON line per connection event / decision step, same manner as hook.log.
 * Ids, status and error text only: never a plan, answer or explanation. Never throws.
 */
export function createBridgeLog(dataDir) {
    const path = join(dataDir, "codex-bridge.log");
    return (event, fields) => appendLogLine(path, event, fields);
}
//# sourceMappingURL=log.js.map