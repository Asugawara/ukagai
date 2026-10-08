import { join } from "node:path";
import { appendLogLine } from "../log.js";
let logPath;
/** Point the log at `<data-dir>/hook.log`. Until this is called, hookLog does nothing */
export function initHookLog(dataDir) {
    logPath = join(dataDir, "hook.log");
}
/**
 * One JSON line per abnormal exit / retry. Ids, status and error text only: never the question, answer or explanation.
 * Never throws (fail open).
 */
export function hookLog(event, fields = {}) {
    if (logPath)
        appendLogLine(logPath, event, fields);
}
//# sourceMappingURL=log.js.map