import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
let cached;
/** The pele object from the GUI's bundle, or null when it cannot be loaded. Read at most once per process. */
export function loadPele() {
    if (cached !== undefined)
        return cached;
    try {
        const code = readFileSync(fileURLToPath(new URL("../../public/vendor/pele.global.js", import.meta.url)), "utf8");
        const ctx = {};
        ctx["window"] = ctx;
        ctx["self"] = ctx;
        ctx["globalThis"] = ctx;
        vm.createContext(ctx);
        vm.runInContext(code, ctx);
        const pele = ctx["pele"];
        cached = pele && typeof pele.parse === "function" ? pele : null;
    }
    catch {
        cached = null;
    }
    return cached;
}
/** Parse errors of the Mermaid blocks (`line` is the block's own line number, as given by the caller) */
export function mermaidIssues(blocks, load = loadPele) {
    if (blocks.length === 0)
        return [];
    const pele = load();
    if (pele === null)
        return [];
    const out = [];
    for (const block of blocks) {
        try {
            pele.parse(block.source);
        }
        catch (err) {
            if (err instanceof pele.PeleError) {
                const message = err.message.split("\n").slice(0, 4).join("\n").slice(0, 300);
                out.push({ line: block.line, message });
            }
        }
    }
    return out;
}
//# sourceMappingURL=mermaid-check.js.map