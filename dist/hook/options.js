import { homedir } from "node:os";
import { join } from "node:path";
import { POLL_TIMEOUT_MS } from "../contract.js";
export function parseArgs(argv) {
    const opts = {
        agent: "claude",
        budgetSec: 590,
        observe: false,
        checkpoint: false,
        planContext: false,
        noAutostart: false,
        server: "http://127.0.0.1:4818",
        dataDir: join(homedir(), ".ukagai"),
        pollTimeoutMs: POLL_TIMEOUT_MS,
        retryWindowMs: 120_000,
        denyTemplate: "A",
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--observe")
            opts.observe = true;
        else if (a === "--checkpoint")
            opts.checkpoint = true;
        else if (a === "--plan-context")
            opts.planContext = true;
        else if (a === "--no-autostart")
            opts.noAutostart = true;
        else if (a === "--agent") {
            const v = next();
            if (v === "claude" || v === "codex")
                opts.agent = v;
        }
        else if (a === "--budget") {
            const n = Number(next());
            if (Number.isFinite(n) && n > 0)
                opts.budgetSec = n;
        }
        else if (a === "--server") {
            const v = next();
            if (v)
                opts.server = v.replace(/\/+$/, "");
        }
        else if (a === "--data-dir") {
            const v = next();
            if (v)
                opts.dataDir = v;
        }
        else if (a === "--poll-timeout-ms") {
            const n = Number(next());
            if (Number.isFinite(n) && n > 0)
                opts.pollTimeoutMs = n;
        }
        else if (a === "--retry-window-ms") {
            const n = Number(next());
            if (Number.isFinite(n) && n >= 0)
                opts.retryWindowMs = n;
        }
        else if (a === "--deny-template") {
            const v = next();
            if (v === "A" || v === "B")
                opts.denyTemplate = v;
        }
    }
    return opts;
}
//# sourceMappingURL=options.js.map