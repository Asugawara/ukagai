import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
let cached;
function read() {
    try {
        // ../package.json from both src/ (tsx) and dist/
        const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
        return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/** This build's version (package.json), read lazily and never throwing */
export function getVersion() {
    return (cached ??= read());
}
export const VERSION = getVersion();
//# sourceMappingURL=version.js.map